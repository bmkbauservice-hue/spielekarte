'use strict';
// Chat + Sprachnachrichten im Browser. Alles Fremde wird nur per textContent angezeigt – nie als HTML.
//
// Sprachnachrichten funktionieren wie bei WhatsApp: gedrückt halten = aufnehmen, loslassen = senden,
// wegwischen = abbrechen. Hochladen und Abholen laufen per HTTP mit dem Spieler-Token im Header.
// Deshalb kann <audio> die Datei nicht selbst laden: Sie wird geholt und als blob:-Adresse abgespielt.

(() => {
  const MAX_RECORD_MS = 30000;
  const MIN_RECORD_MS = 500;      // kürzer = versehentliches Antippen
  const SWIPE_CANCEL_PX = 70;
  const MAX_MESSAGES = 200;       // wie auf dem Server
  // Erst AAC im MP4-Container: Das spielen iPhone und Android beide ab. Die Reihenfolge ist Absicht:
  // Schlichtes "audio/mp4" kommt zuletzt, denn Chrome nimmt ohne AAC-Encoder dann OPUS IN MP4 auf – von dem niemand
  // sicher sagen kann, welches iPhone es abspielt. Es bleibt nur für alte Safaris, die sowieso nur AAC können.
  const RECORD_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

  const $ = (id) => document.getElementById(id);
  const clock = (ms) => {
    const secs = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  };
  const timeOf = (at) => new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  function pickRecordType() {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null; // z. B. ohne HTTPS
    return RECORD_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || null;
  }

  /** Ganz kurze Stille als WAV – siehe unlockAudio() */
  function silentWavUrl() {
    const samples = 800; // 0,1 s bei 8 kHz, 8 Bit
    const bytes = new Uint8Array(44 + samples).fill(128);
    const view = new DataView(bytes.buffer);
    const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);    // PCM
    view.setUint16(22, 1, true);    // Mono
    view.setUint32(24, 8000, true);
    view.setUint32(28, 8000, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    text(36, 'data');
    view.setUint32(40, samples, true);
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  }

  /**
   * @param {object} deps
   * @param {string} deps.base
   * @param {string} deps.roomId
   * @param {*} deps.socket
   * @param {(event: string, data?: object) => Promise<object>} deps.request
   * @param {() => string|null} deps.getToken
   * @param {{ get: Function, set: Function }} deps.store
   * @param {string} deps.readKey  localStorage-Schlüssel für "bis hierher gelesen"
   * @param {(message: string) => void} deps.toast
   */
  function init({ base, roomId, socket, request, getToken, store, readKey, toast }) {
    const btnChat = $('btn-chat');
    const panel = $('chat-panel');
    const list = $('chat-list');
    const input = $('chat-input');
    const mic = $('btn-mic');
    const hint = $('chat-hint');

    let messages = [];
    let myId = null;
    let lastRead = Number(store.get(readKey)) || 0;

    // ---------- Liste ----------

    const isOpen = () => !panel.hidden;
    const isNearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const scrollDown = () => { list.scrollTop = list.scrollHeight; };

    function metaElement(m) {
      const meta = document.createElement('p');
      meta.className = 'chat-meta';
      const name = Object.assign(document.createElement('b'), { textContent: m.name });
      const time = Object.assign(document.createElement('time'), { textContent: timeOf(m.at) });
      meta.append(name, time);
      return meta;
    }

    function messageElement(m) {
      const li = document.createElement('li');
      li.className = `chat-msg${m.from === myId ? ' mine' : ''}`;
      li.dataset.seq = String(m.seq);
      li.append(metaElement(m));
      if (m.kind === 'voice') {
        li.append(voiceElement(m));
      } else {
        const text = document.createElement('p');
        text.className = 'chat-text';
        text.textContent = m.text;
        li.append(text);
      }
      return li;
    }

    function renderAll() {
      voiceUi.clear();
      list.replaceChildren(...messages.map(messageElement));
      $('chat-empty').hidden = messages.length > 0;
      if (playingId) paintVoice(playingId, audio.paused ? 'idle' : 'playing');
      updateUnread();
    }

    // ---------- Ungelesen ----------

    function updateUnread() {
      if (isOpen() && messages.length > 0) {
        lastRead = Math.max(lastRead, messages[messages.length - 1].seq);
        store.set(readKey, String(lastRead));
      }
      const unread = messages.filter((m) => m.seq > lastRead && m.from !== myId).length;
      const badge = $('chat-unread');
      badge.hidden = unread === 0;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      btnChat.classList.toggle('has-unread', unread > 0);
      btnChat.setAttribute('aria-label', unread > 0 ? `Chat öffnen, ${unread} ungelesen` : 'Chat öffnen');
    }

    function setOpen(open) {
      panel.hidden = !open;
      btnChat.setAttribute('aria-expanded', String(open));
      if (open) {
        fitViewport();
        scrollDown();
      }
      updateUnread();
    }

    btnChat.addEventListener('click', () => setOpen(!isOpen()));
    $('btn-chat-close').addEventListener('click', () => setOpen(false));

    // iOS schiebt die Bildschirmtastatur über fest positionierte Elemente → Panel darüber halten
    function fitViewport() {
      const vv = window.visualViewport;
      if (!vv || !isOpen()) return;
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      panel.style.transform = covered > 0 ? `translateY(${-Math.round(covered)}px)` : '';
      panel.style.maxHeight = covered > 0 ? `${Math.round(vv.height)}px` : '';
      if (covered > 0) scrollDown();
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitViewport);
      window.visualViewport.addEventListener('scroll', fitViewport);
    }

    // ---------- Nachrichten vom Server ----------

    socket.on('chat:history', (history) => {
      messages = history;
      // Raum wurde neu angelegt (Nummern beginnen wieder bei 1)? Dann ist die alte Marke wertlos.
      const newest = messages.length > 0 ? messages[messages.length - 1].seq : 0;
      if (lastRead > newest && newest > 0) lastRead = 0;
      renderAll();
      if (isOpen()) scrollDown();
    });

    socket.on('chat:message', (message) => {
      const stick = isNearBottom() || message.from === myId;
      messages.push(message);
      list.append(messageElement(message));
      if (messages.length > MAX_MESSAGES) {
        forgetVoice(messages.shift());
        list.firstElementChild.remove();
      }
      $('chat-empty').hidden = true;
      if (isOpen() && stick) scrollDown();
      updateUnread();
    });

    socket.on('chat:removed', (seqs) => {
      messages.filter((m) => seqs.includes(m.seq)).forEach(forgetVoice);
      messages = messages.filter((m) => !seqs.includes(m.seq));
      renderAll();
    });

    socket.on('chat:cleared', reset);

    function reset() {
      messages.forEach(forgetVoice);
      messages = [];
      renderAll();
    }

    // ---------- Text senden ----------

    async function sendText(text) {
      const res = await request('chat:send', { text });
      if (!res.ok) toast(res.message);
      return res.ok;
    }

    $('chat-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      // Erst leeren, dann senden – bei einem Fehler kommt der Text zurück, solange nichts Neues getippt wurde
      input.value = '';
      if (!(await sendText(text)) && !input.value) input.value = text;
    });

    $('chat-quick').addEventListener('click', (event) => {
      const chip = event.target.closest('button');
      if (chip) sendText(chip.textContent);
    });

    // ---------- Sprachnachricht abspielen ----------

    const audio = new Audio();
    audio.preload = 'auto';
    /** @type {Map<string, { button: Element, bar: HTMLElement, time: Element, durationMs: number }>} */
    const voiceUi = new Map();
    const blobUrls = new Map(); // id → blob:-Adresse (einmal geladen, nicht nochmal herunterladen)
    let playingId = null;
    let unlocking = false;      // gerade läuft nur die Stille aus unlockAudio()
    let loadTicket = 0;         // zählt hoch: alte Downloads erkennen, die keiner mehr braucht
    let silentUrl = null;

    function voiceElement(m) {
      const box = document.createElement('div');
      box.className = 'voice';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'voice-play';
      const track = document.createElement('span');
      track.className = 'voice-track';
      const bar = document.createElement('span');
      bar.className = 'voice-bar';
      track.append(bar);
      const time = Object.assign(document.createElement('span'), { className: 'voice-time', textContent: clock(m.voice.durationMs) });
      box.append(button, track, time);
      voiceUi.set(m.voice.id, { button, bar, time, durationMs: m.voice.durationMs });
      paintVoice(m.voice.id, 'idle');
      button.addEventListener('click', () => togglePlay(m.voice.id));
      return box;
    }

    const PLAY_ICON = { idle: '▶︎', loading: '…', playing: '❚❚', gone: '–' };
    const PLAY_LABEL = { idle: 'Sprachnachricht abspielen', loading: 'Wird geladen', playing: 'Anhalten', gone: 'Nicht verfügbar' };

    function paintVoice(id, state, label) {
      const ui = voiceUi.get(id);
      if (!ui) return;
      ui.button.textContent = PLAY_ICON[state];
      ui.button.setAttribute('aria-label', PLAY_LABEL[state]);
      ui.button.disabled = state === 'gone';
      ui.button.classList.toggle('playing', state === 'playing');
      if (label) ui.time.textContent = label;
    }

    function resetProgress(id) {
      const ui = voiceUi.get(id);
      if (!ui) return;
      ui.bar.style.transform = 'scaleX(0)';
      ui.time.textContent = clock(ui.durationMs);
    }

    function stopPlaying() {
      loadTicket++;
      unlocking = false;
      audio.pause();
      if (playingId) {
        paintVoice(playingId, 'idle');
        resetProgress(playingId);
      }
      playingId = null;
    }

    function forgetVoice(message) {
      if (message.kind !== 'voice') return;
      const { id } = message.voice;
      if (playingId === id) stopPlaying();
      if (blobUrls.has(id)) URL.revokeObjectURL(blobUrls.get(id));
      blobUrls.delete(id);
      voiceUi.delete(id);
    }

    /**
     * iOS spielt nur ab, wenn play() direkt im Antippen aufgerufen wird. Nach dem Download wäre es dafür zu spät.
     * Deshalb startet das Antippen sofort kurze Stille: Damit ist dieses <audio> freigeschaltet, und die echte
     * Aufnahme darf danach auf demselben Element laufen.
     */
    function unlockAudio() {
      if (!silentUrl) silentUrl = silentWavUrl();
      unlocking = true;
      audio.src = silentUrl;
      const started = audio.play();
      if (started) started.catch(() => { /* egal – Rückfall ist "nochmal tippen" in startAudio() */ });
    }

    function startAudio(id) {
      unlocking = false;
      audio.src = blobUrls.get(id);
      const started = audio.play();
      paintVoice(id, 'playing');
      if (started) {
        started.catch((err) => {
          if (playingId !== id) return;
          // Die Aufnahme ist jetzt geladen: Beim nächsten Antippen läuft sie direkt in der Geste.
          if (err.name === 'NotAllowedError') {
            playingId = null;
            paintVoice(id, 'idle', 'nochmal tippen');
          } else if (err.name !== 'AbortError') {
            playbackFailed();
          }
        });
      }
    }

    function playbackFailed() {
      if (!playingId) return;
      const id = playingId;
      playingId = null;
      paintVoice(id, 'idle', 'nicht abspielbar');
      toast('Dieses Gerät kann diese Aufnahme nicht abspielen.');
    }

    async function togglePlay(id) {
      if (playingId === id && !unlocking && audio.src) {
        // Gleiche Nachricht: anhalten bzw. dort weitermachen
        if (audio.paused) {
          const resumed = audio.play();
          if (resumed) resumed.catch(playbackFailed);
          paintVoice(id, 'playing');
        } else {
          audio.pause();
          paintVoice(id, 'idle');
        }
        return;
      }
      stopPlaying();
      playingId = id;
      if (blobUrls.has(id)) return startAudio(id);

      unlockAudio(); // muss VOR dem ersten await passieren – siehe oben
      paintVoice(id, 'loading');
      const ticket = ++loadTicket;
      try {
        const res = await fetch(`${base}/k/${roomId}/voice/${id}`, { headers: { 'X-Player-Token': getToken() || '' } });
        if (!res.ok) {
          const gone = res.status === 404;
          if (ticket === loadTicket) playingId = null;
          paintVoice(id, gone ? 'gone' : 'idle', gone ? 'nicht mehr da' : undefined);
          if (!gone) toast('Sprachnachricht konnte nicht geladen werden.');
          return;
        }
        const blob = await res.blob();
        // Inzwischen geleert oder entfernt? Dann nichts mehr merken.
        if (!voiceUi.has(id)) return;
        if (!blobUrls.has(id)) blobUrls.set(id, URL.createObjectURL(blob));
        if (ticket === loadTicket) startAudio(id);
      } catch {
        if (ticket !== loadTicket) return;
        playingId = null;
        paintVoice(id, 'idle');
        toast('Sprachnachricht konnte nicht geladen werden.');
      }
    }

    audio.addEventListener('timeupdate', () => {
      const ui = playingId && !unlocking ? voiceUi.get(playingId) : null;
      if (!ui || !ui.durationMs) return;
      const ms = audio.currentTime * 1000;
      ui.bar.style.transform = `scaleX(${Math.min(1, ms / ui.durationMs)})`;
      ui.time.textContent = clock(ms);
    });
    audio.addEventListener('ended', () => {
      if (!unlocking && playingId) stopPlaying();
    });
    audio.addEventListener('error', () => {
      if (!unlocking && playingId && audio.getAttribute('src')) playbackFailed();
    });

    // ---------- Sprachnachricht aufnehmen ----------

    const recordType = pickRecordType();
    mic.hidden = !recordType; // kein MediaRecorder → kein Mikro-Knopf, Text-Chat geht trotzdem
    /** laufende Aufnahme (auch solange die Mikro-Erlaubnis noch offen ist) */
    let rec = null;

    function showRecording(on, text) {
      $('chat-rec').hidden = !on;
      mic.classList.toggle('recording', on);
      if (text) $('chat-rec-hint').textContent = text;
    }

    function showHint(text) {
      hint.textContent = text;
      hint.hidden = !text;
    }

    function micProblem(err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showHint(denied
        ? 'Das Mikro ist nicht erlaubt – der Text-Chat geht weiter. Du kannst es in den Browser-Einstellungen freigeben.'
        : 'Das Mikro lässt sich gerade nicht öffnen – der Text-Chat geht weiter.');
    }

    const stopTracks = (stream) => stream.getTracks().forEach((track) => track.stop());

    async function pressMic(event) {
      if (rec) return;
      const session = { held: true, x: event.clientX, y: event.clientY, stream: null, recorder: null, chunks: [], startedAt: 0, ticker: null, cancelled: false };
      rec = session;
      showHint('');
      showRecording(true, 'Mikro wird geöffnet …');
      $('chat-rec-time').textContent = '0:00';
      try {
        // Hier fragt der Browser beim ersten Mal nach der Erlaubnis – vorher nie
        session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        rec = null;
        showRecording(false);
        micProblem(err);
        return;
      }
      if (!session.held) {
        // Beim Bestätigen der Erlaubnis ist der Finger meist schon weg → nichts Halbes senden
        stopTracks(session.stream);
        if (!session.cancelled) showHint('Das Mikro ist bereit – jetzt gedrückt halten und sprechen.');
        return;
      }
      try {
        session.recorder = new MediaRecorder(session.stream, { mimeType: recordType, audioBitsPerSecond: 48000 });
        session.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) session.chunks.push(e.data); };
        session.recorder.onstop = () => finishRecording(session);
        session.recorder.onerror = () => endRecording(session, true);
        session.recorder.start();
      } catch (err) {
        stopTracks(session.stream);
        rec = null;
        showRecording(false);
        micProblem(err);
        return;
      }
      session.startedAt = Date.now();
      showRecording(true, 'Loslassen = senden · wegwischen = abbrechen');
      session.ticker = setInterval(() => {
        const ms = Date.now() - session.startedAt;
        $('chat-rec-time').textContent = clock(ms);
        if (ms >= MAX_RECORD_MS) endRecording(session, false);
      }, 200);
    }

    /** Aufnahme beenden: cancel = true verwirft sie, sonst wird sie gesendet. */
    function endRecording(session, cancel) {
      session.held = false;
      session.cancelled = cancel;
      clearInterval(session.ticker);
      showRecording(false);
      if (rec === session) rec = null;
      session.durationMs = session.startedAt ? Date.now() - session.startedAt : 0;
      if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    }

    async function finishRecording(session) {
      stopTracks(session.stream); // erst jetzt: geht das Mikro vorher aus, fehlt auf iOS das Ende der Aufnahme
      if (session.cancelled) return;
      if (session.durationMs < MIN_RECORD_MS) {
        showHint('Zum Aufnehmen gedrückt halten.');
        return;
      }
      await uploadVoice(new Blob(session.chunks, { type: session.recorder.mimeType || recordType }), session.durationMs);
    }

    async function uploadVoice(blob, durationMs) {
      showHint('Sprachnachricht wird gesendet …');
      let problem = null;
      try {
        const res = await fetch(`${base}/k/${roomId}/voice`, {
          method: 'POST',
          headers: {
            'Content-Type': (blob.type || recordType).split(';')[0],
            'X-Player-Token': getToken() || '',
            'X-Voice-Duration': String(Math.min(durationMs, MAX_RECORD_MS)),
          },
          body: blob,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          problem = data.message || 'Sprachnachricht konnte nicht gesendet werden.';
        }
      } catch {
        problem = 'Keine Verbindung – Sprachnachricht wurde nicht gesendet.';
      }
      showHint('');
      if (problem) toast(problem);
    }

    mic.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      try { mic.setPointerCapture(event.pointerId); } catch { /* egal: ohne geht es auch, nur Wischen wird ungenauer */ }
      pressMic(event);
    });
    mic.addEventListener('pointermove', (event) => {
      if (!rec) return;
      if (Math.hypot(event.clientX - rec.x, event.clientY - rec.y) > SWIPE_CANCEL_PX) {
        endRecording(rec, true);
        toast('Aufnahme verworfen');
      }
    });
    mic.addEventListener('pointerup', () => { if (rec) endRecording(rec, false); });
    mic.addEventListener('pointercancel', () => { if (rec) endRecording(rec, true); });
    // Langes Drücken darf auf dem Handy kein Kontextmenü und keine Textauswahl auslösen
    mic.addEventListener('contextmenu', (event) => event.preventDefault());
    mic.addEventListener('touchstart', (event) => event.preventDefault(), { passive: false });
    // Handy gesperrt oder App gewechselt → verwerfen statt heimlich weiter aufzunehmen
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && rec) endRecording(rec, true);
    });

    return {
      /** Der Knopf gehört nur in den Spielraum, nicht auf die Namensseite. */
      setVisible(visible) {
        btnChat.hidden = !visible;
        if (!visible && isOpen()) setOpen(false);
      },
      setMe(id) {
        if (id === myId) return;
        myId = id;
        renderAll();
      },
      reset,
    };
  }

  window.SkatChat = { init, pickRecordType };
})();
