'use strict';
// Spielraum im Browser. Der Server entscheidet alles – dieses Skript zeigt nur an
// und schickt Wünsche ("Platz nehmen", "Spiel starten") an den Server.

(() => {
  const BASE = document.querySelector('meta[name="base-path"]').content;
  const ROOM_ID = document.body.dataset.room;

  // ?profil=a erlaubt mehrere Identitäten im selben Browser (zum lokalen Testen mit 3 Tabs).
  // Ohne Profil teilen sich alle Tabs eines Browsers dasselbe localStorage → dieselbe Person.
  const profile = (new URLSearchParams(location.search).get('profil') || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const suffix = profile ? `:${profile}` : '';
  const TOKEN_KEY = `spielekarte:token:${ROOM_ID}${suffix}`;
  const NAME_KEY = `spielekarte:name${suffix}`;

  // localStorage kann blockiert sein (privater Modus) → nie abstürzen
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* egal */ } },
    remove: (k) => { try { localStorage.removeItem(k); } catch { /* egal */ } },
  };

  const $ = (id) => document.getElementById(id);
  const VIEWS = ['view-connecting', 'view-name', 'view-room', 'view-replaced'];
  const show = (view) => VIEWS.forEach((v) => { $(v).hidden = v !== view; });

  let state = null;
  let replaced = false; // true, wenn ein anderer Tab den Platz übernommen hat

  // ---------- Verbindung ----------

  const socket = io({ path: `${BASE}/socket.io` });

  /** emit mit Antwort (Ack) als Promise, inkl. Timeout */
  const request = (event, data = {}) =>
    new Promise((resolve) => {
      socket.timeout(8000).emit(event, data, (err, res) =>
        resolve(err ? { ok: false, code: 'TIMEOUT', message: 'Keine Antwort vom Server.' } : res));
    });

  async function join(name) {
    const res = await request('room:join', { roomId: ROOM_ID, name, token: store.get(TOKEN_KEY) });
    if (res.ok) {
      store.set(TOKEN_KEY, res.token);
      if (name) store.set(NAME_KEY, name);
    } else if (res.code === 'TOKEN_UNBEKANNT') {
      store.remove(TOKEN_KEY); // z. B. nach Server-Neustart
      showNameForm();
    }
    return res;
  }

  socket.on('connect', () => {
    setConnection(true);
    if (replaced) return;
    if (store.get(TOKEN_KEY)) join();
    else showNameForm();
  });

  socket.on('disconnect', () => setConnection(false));

  socket.on('room:state', (next) => {
    state = next;
    render();
  });

  socket.on('session:replaced', () => {
    replaced = true;
    state = null;
    show('view-replaced');
  });

  function setConnection(online) {
    const el = $('conn');
    el.dataset.state = online ? 'on' : 'off';
    el.querySelector('span').textContent = online ? 'verbunden' : 'getrennt …';
  }

  // ---------- Name eingeben ----------

  function showNameForm() {
    show('view-name');
    const input = $('name-input');
    if (!input.value) input.value = store.get(NAME_KEY) || '';
    input.focus();
  }

  $('name-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('name-input').value.trim();
    $('name-error').textContent = '';
    if (!name) return;
    const res = await join(name);
    if (!res.ok) $('name-error').textContent = res.message;
  });

  // ---------- Anzeige ----------

  function render() {
    if (!state || replaced) return;
    if (!state.you) return showNameForm();
    show('view-room');

    const { you, seats, spectators, status } = state;
    const lobby = status === 'lobby';
    const seated = you.seat !== null;

    // Plätze
    const list = $('seats');
    list.replaceChildren(...seats.map((p, i) => seatItem(p, i, you, lobby && !seated)));

    // Zuschauer
    $('spectators').replaceChildren(...spectators.map((p) => personItem(p, p.id === you.id)));
    $('spec-count').textContent = spectators.length ? `(${spectators.length})` : '';
    $('spec-empty').hidden = spectators.length > 0;

    // Buttons + Hinweise
    $('banner-running').hidden = lobby;
    $('btn-start').hidden = !state.canStart;
    $('btn-stop').hidden = lobby || !seated;
    $('btn-leave-seat').hidden = !lobby || !seated;
    $('btn-leave').hidden = !lobby && seated;
    $('start-hint').textContent = lobby ? startHint(seats, seated, state.canStart) : '';
  }

  function startHint(seats, seated, canStart) {
    if (canStart) return 'Alle da – los geht’s!';
    const missing = seats.filter((s) => s === null).length;
    if (missing > 0) return `Noch ${missing} ${missing === 1 ? 'Spieler fehlt' : 'Spieler fehlen'} – lade sie mit der Karte ein.`;
    if (seats.some((s) => !s.connected)) return 'Warte, bis alle wieder verbunden sind.';
    if (!seated) return 'Ein Spieler am Tisch startet das Spiel.';
    return '';
  }

  function seatItem(person, index, you, canTake) {
    const li = document.createElement('li');
    li.className = 'seat';
    const label = document.createElement('span');
    label.className = 'seat-no';
    label.textContent = `Platz ${index + 1}`;
    li.append(label);

    if (!person) {
      li.classList.add('free');
      const free = document.createElement('span');
      free.className = 'seat-name muted';
      free.textContent = 'frei';
      li.append(free);
      if (canTake) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-small btn-gold-outline';
        btn.textContent = 'Platz nehmen';
        btn.dataset.seat = String(index);
        li.append(btn);
      }
      return li;
    }

    li.append(...personParts(person, person.id === you.id));
    if (person.id === you.id) li.classList.add('me');
    if (!person.connected) li.classList.add('offline');
    return li;
  }

  function personItem(person, isMe) {
    const li = document.createElement('li');
    li.className = 'person';
    if (isMe) li.classList.add('me');
    if (!person.connected) li.classList.add('offline');
    li.append(...personParts(person, isMe));
    return li;
  }

  /** Name + Badges. textContent statt innerHTML → Namen können kein HTML einschleusen. */
  function personParts(person, isMe) {
    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = person.name;
    const parts = [name];
    if (isMe) parts.push(badge('du', 'badge-me'));
    if (!person.connected) parts.push(badge('getrennt', 'badge-off'));
    return parts;
  }

  function badge(text, cls) {
    const b = document.createElement('span');
    b.className = `badge ${cls}`;
    b.textContent = text;
    return b;
  }

  // ---------- Aktionen ----------

  async function act(event, data) {
    const res = await request(event, data);
    if (!res.ok) toast(res.message);
    return res;
  }

  $('seats').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-seat]');
    if (btn) act('seat:take', { seat: Number(btn.dataset.seat) });
  });
  $('btn-start').addEventListener('click', () => act('game:start'));
  $('btn-stop').addEventListener('click', () => {
    if (confirm('Spiel wirklich beenden?')) act('game:stop');
  });
  $('btn-leave-seat').addEventListener('click', () => act('seat:leave'));

  $('btn-leave').addEventListener('click', async () => {
    if (!confirm('Raum verlassen? Dein Platz wird frei.')) return;
    const res = await act('room:leave');
    if (res.ok) {
      store.remove(TOKEN_KEY);
      state = null;
      showNameForm();
    }
  });

  $('btn-reclaim').addEventListener('click', () => {
    replaced = false;
    show('view-connecting');
    join();
  });

  $('btn-share').addEventListener('click', async () => {
    const url = `${location.origin}${BASE}/k/${ROOM_ID}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Skat-Runde', text: 'Komm an meinen Tisch!', url });
      } else {
        await navigator.clipboard.writeText(url);
        toast('Link kopiert');
      }
    } catch {
      /* Teilen abgebrochen */
    }
  });

  let toastTimer;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }
})();
