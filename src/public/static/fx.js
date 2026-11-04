'use strict';
// Animationen der Spielekarte (window.SkatFX).
// GRUNDREGEL: Alles hier ist nur Show. Nichts verändert oder verzögert den Spielstand –
// der Server bleibt maßgeblich, die Oberfläche ist schon fertig gezeichnet, bevor eine Animation startet.
// Technik: Web Animations API, ausschließlich transform/opacity (läuft auf der Grafikkarte, auch auf älteren Handys flüssig).

(() => {
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE = 'cubic-bezier(.2,.8,.2,1)';
  const mid = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const safe = (promise) => promise.catch(() => {}); // abgebrochene Animationen sind kein Fehler

  // ---------- Ton (optional, standardmäßig aus) ----------

  const SOUND_KEY = 'spielekarte:ton';
  let audio = null;
  const sound = {
    get on() {
      try { return localStorage.getItem(SOUND_KEY) === 'an'; } catch { return false; }
    },
    set on(value) {
      try { localStorage.setItem(SOUND_KEY, value ? 'an' : 'aus'); } catch { /* egal */ }
      if (value) this.unlock();
    },
    /** Browser erlauben Ton erst nach einer Berührung – beim Einschalten freischalten */
    unlock() {
      try {
        audio ??= new AudioContext();
        if (audio.state === 'suspended') audio.resume();
      } catch { /* kein Ton möglich */ }
    },
    /** Leises Karten-Rascheln: kurzes, abklingendes, gefiltertes Rauschen – ohne Audiodatei */
    rustle(seconds = 0.09, volume = 0.05) {
      if (!this.on || !audio) return;
      try {
        const length = Math.floor(audio.sampleRate * seconds);
        const buffer = audio.createBuffer(1, length, audio.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
        const src = audio.createBufferSource();
        src.buffer = buffer;
        const filter = audio.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 2600 + Math.random() * 1200;
        const gain = audio.createGain();
        gain.gain.value = volume;
        src.connect(filter).connect(gain).connect(audio.destination);
        src.start();
      } catch { /* egal */ }
    },
  };

  // ---------- Kleine Effekte ----------

  /** Karte vom alten Ort (Rect) an ihren neuen Platz fliegen lassen (FLIP-Technik). */
  function flyFrom(el, fromRect, { duration = 380, rotate = 0 } = {}) {
    if (!el) return Promise.resolve();
    if (!fromRect || reduced()) return fadeIn(el);
    const to = el.getBoundingClientRect();
    const a = mid(fromRect);
    const b = mid(to);
    const scale = to.width ? fromRect.width / to.width : 1;
    return safe(el.animate(
      [{ transform: `translate(${a.x - b.x}px, ${a.y - b.y}px) scale(${scale}) rotate(${rotate}deg)` }, { transform: 'none' }],
      { duration, easing: EASE },
    ).finished);
  }

  function fadeIn(el, duration = 180) {
    return safe(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration }).finished);
  }

  /** Die Karten eines fertigen Stichs rutschen zum Gewinner und verschwinden. */
  function sweepTo(cards, targetRect, { delay = 900 } = {}) {
    if (!targetRect || cards.length === 0) return;
    const t = mid(targetRect);
    cards.forEach((el, i) => {
      const c = mid(el.getBoundingClientRect());
      el.animate(
        [{ transform: 'none', opacity: 1 }, { transform: `translate(${t.x - c.x}px, ${t.y - c.y}px) scale(0.35)`, opacity: 0 }],
        { duration: reduced() ? 120 : 420, delay: delay + i * 50, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' },
      );
    });
  }

  /** Kurzes Gold-/Neon-Funkeln über einem Element. */
  function sparkle(host, { count = 20, y = '35%' } = {}) {
    if (!host || reduced()) return;
    const layer = document.createElement('div');
    layer.className = 'fx-sparkle';
    host.append(layer);
    for (let i = 0; i < count; i++) {
      const spark = document.createElement('i');
      spark.className = `fx-spark${i % 3 === 0 ? ' mint' : ''}`;
      spark.style.top = y;
      layer.append(spark);
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const dist = 50 + Math.random() * 70;
      spark.animate(
        [
          { transform: 'translate(0, 0) scale(0.2)', opacity: 0 },
          { transform: `translate(${Math.cos(angle) * dist * 0.5}px, ${Math.sin(angle) * dist * 0.5}px) scale(1.2)`, opacity: 1, offset: 0.35 },
          { transform: `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px) scale(0)`, opacity: 0 },
        ],
        { duration: 900 + Math.random() * 400, delay: Math.random() * 150, easing: 'ease-out', fill: 'forwards' },
      );
    }
    setTimeout(() => layer.remove(), 1600);
  }

  /** Siegertreppchen: Stufen wachsen von unten herauf. */
  function podiumRise(steps) {
    if (reduced()) return steps.forEach((s) => fadeIn(s));
    steps.forEach((step, i) => {
      step.animate([{ transform: 'translateY(60px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 600, delay: 150 + i * 180, easing: EASE, fill: 'backwards' });
    });
  }

  // ---------- Misch-Show vor dem Geben ----------

  /** Deterministischer Zufall: alle Handys wählen für dieselbe Runde denselben Trick. */
  function pickTrick(seedText) {
    let h = 0;
    for (const ch of seedText) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 4;
  }

  /**
   * Misch-Show (≈ 3,2 s): Einsammeln → Riffle → Trick → Abheben → Geben im Skat-Rhythmus 3 – Skat 2 – 4 – 3.
   * Gemischt wird echt auf dem Server – das hier ist nur Show. Antippen überspringt.
   * @param {object} o
   * @param {{ me?: DOMRect, left?: DOMRect, right?: DOMRect }} o.targets  wohin gegeben wird
   * @param {string[]} o.order       Plätze in Geb-Reihenfolge ab Vorhand, z. B. ['left', 'right', 'me']
   * @param {string} o.cutter        Name dessen, der abhebt
   * @param {string} o.seed          z. B. Karten-ID + Runde
   * @param {string[]} o.myCards     eigene Karten (werden beim Ankommen umgedreht)
   * @param {() => HTMLElement} o.makeBack
   * @param {(card: string) => HTMLElement} o.makeFront
   * @returns {Promise<void>}
   */
  function shuffle(o) {
    const stage = document.createElement('div');
    stage.className = 'fx-stage';
    stage.setAttribute('aria-hidden', 'true');
    const skip = document.createElement('p');
    skip.className = 'fx-skip';
    skip.textContent = 'Antippen zum Überspringen';
    stage.append(skip);
    document.body.append(stage);

    const W = window.innerWidth;
    const H = window.innerHeight;
    const c = { x: W / 2, y: H * 0.42 };
    const cardW = 64;
    const cardH = 93;
    const anims = [];

    /** Karte mittig auf den Stapelpunkt legen; Bewegung nur per transform */
    const place = (el) => {
      el.style.left = `${c.x - cardW / 2}px`;
      el.style.top = `${c.y - cardH / 2}px`;
      stage.append(el);
      el._t = 'translate(0px, 0px) rotate(0deg)';
      return el;
    };
    /** Von der aktuellen Lage zu `transform` – zeitlich hintereinander, deshalb fill: forwards */
    const to = (el, transform, { at, duration = 300, easing = EASE, opacity } = {}) => {
      const from = { transform: el._t };
      const end = { transform };
      if (opacity !== undefined) { from.opacity = el._o ?? 1; end.opacity = opacity; el._o = opacity; }
      const a = el.animate([from, end], { duration, delay: at, easing, fill: 'forwards' });
      anims.push(a);
      el._t = transform;
      return a;
    };
    const keyframes = (el, frames, { at, duration, easing = 'ease-in-out' }) => {
      const a = el.animate(frames, { duration, delay: at, easing, fill: 'forwards' });
      anims.push(a);
      return a;
    };
    const rel = (rect) => (rect ? { x: mid(rect).x - c.x, y: mid(rect).y - c.y } : null);
    const timers = [];
    const later = (ms, fn) => timers.push(setTimeout(fn, ms));

    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      timers.forEach(clearTimeout);
      anims.forEach((a) => a.cancel());
      safe(stage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160 }).finished).then(() => {
        stage.remove();
        done();
      });
    };
    stage.addEventListener('pointerdown', end);

    // Weniger Bewegung: nur kurz den Stapel einblenden
    if (reduced()) {
      place(o.makeBack());
      later(450, end);
      return finished;
    }

    const N = 12;
    const deck = Array.from({ length: N }, () => place(o.makeBack()));
    const spots = [rel(o.targets.left), rel(o.targets.right), rel(o.targets.me)].filter(Boolean);
    const rnd = (a, b) => a + Math.random() * (b - a);

    // 1. Einsammeln: Karten fliegen von den Plätzen/vom Rand zum Stapel
    deck.forEach((el, i) => {
      const s = spots.length ? spots[i % spots.length] : { x: rnd(-W / 2, W / 2), y: rnd(-H / 3, H / 3) };
      el._t = `translate(${s.x + rnd(-40, 40)}px, ${s.y + rnd(-30, 30)}px) rotate(${rnd(-50, 50)}deg)`;
      to(el, `translate(0px, ${-i * 0.6}px) rotate(${rnd(-3, 3)}deg)`, { at: i * 18, duration: 330 });
    });

    // 2. Riffle-Shuffle: teilen, dann abwechselnd ineinander rauschen
    const T2 = 380; // Zeitplan gesamt ≈ 3,2 s
    deck.forEach((el, i) => {
      const left = i % 2 === 0;
      to(el, `translate(${left ? -46 : 46}px, ${-i * 0.6}px) rotate(${left ? -9 : 9}deg)`, { at: T2, duration: 190 });
    });
    later(T2 + 200, () => sound.rustle(0.35, 0.06));
    deck.forEach((el, i) => {
      to(el, `translate(0px, ${-i * 0.6}px) rotate(0deg)`, { at: T2 + 200 + i * 22, duration: 140, easing: 'ease-in' });
    });

    // 3. Zufälliger Trick (für alle Handys gleich)
    const T3 = T2 + 200 + N * 22 + 60; // ≈ 900 ms, jeder Trick dauert ≈ 800 ms
    const trick = pickTrick(o.seed);
    if (trick === 0) {
      // Karten-Fächer, der sich wie ein Rad dreht
      deck.forEach((el, i) => {
        const angle = -75 + (150 / (N - 1)) * i;
        to(el, `rotate(${angle}deg) translateY(-62px)`, { at: T3, duration: 200 });
        to(el, `rotate(${angle + 360}deg) translateY(-62px)`, { at: T3 + 210, duration: 420, easing: 'ease-in-out' });
        to(el, 'rotate(360deg) translateY(0px)', { at: T3 + 640, duration: 160 }); // 360 statt 0: nicht zurückdrehen
      });
    } else if (trick === 1) {
      // Wasserfall / Bridge: Karten biegen sich hoch und fallen nacheinander zurück
      deck.forEach((el, i) => {
        keyframes(el, [
          { transform: el._t },
          { transform: `translate(${(i - N / 2) * 6}px, ${-120 - i * 3}px) rotate(${-14 + i * 2}deg)`, offset: 0.45 },
          { transform: el._t },
        ], { at: T3 + i * 30, duration: 460 });
      });
    } else if (trick === 2) {
      // Karten springen im Bogen von einer Hand zur anderen
      deck.forEach((el, i) => {
        to(el, `translate(-78px, ${-i * 0.6}px) rotate(-8deg)`, { at: T3, duration: 160 });
        keyframes(el, [
          { transform: `translate(-78px, ${-i * 0.6}px) rotate(-8deg)` },
          { transform: `translate(0px, ${-105 - (i % 3) * 8}px) rotate(170deg)`, offset: 0.5 },
          { transform: `translate(78px, ${-i * 0.6}px) rotate(352deg)` },
        ], { at: T3 + 170 + i * 22, duration: 300 });
        el._t = `translate(78px, ${-i * 0.6}px) rotate(352deg)`;
        to(el, `translate(0px, ${-i * 0.6}px) rotate(360deg)`, { at: T3 + 720, duration: 80 });
        el._t = `translate(0px, ${-i * 0.6}px) rotate(0deg)`;
      });
    } else {
      // Funkeln über dem Stapel
      deck.forEach((el, i) => {
        keyframes(el, [
          { transform: el._t },
          { transform: `${el._t} rotate(${i % 2 ? 6 : -6}deg) scale(1.04)` },
          { transform: el._t },
        ], { at: T3 + i * 15, duration: 420 });
      });
      later(T3, () => {
        const host = document.createElement('div');
        host.className = 'fx-sparkle';
        host.style.top = `${c.y - H * 0.4}px`;
        stage.append(host);
        sparkle(host, { count: 26, y: '40%' });
      });
    }

    // 4. Abheben: obere Hälfte kurz zur Seite und wieder darunter, Name blinkt
    const T4 = T3 + 800;
    const label = document.createElement('p');
    label.className = 'fx-label';
    label.style.top = `${c.y + cardH / 2 + 22}px`;
    label.textContent = `${o.cutter} hebt ab`;
    stage.append(label);
    keyframes(label, [{ opacity: 0 }, { opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }, { opacity: 0 }], { at: T4, duration: 600 });
    deck.slice(N / 2).forEach((el, i) => {
      to(el, `translate(58px, ${-30 - i}px) rotate(7deg)`, { at: T4, duration: 180 });
      to(el, `translate(0px, ${-i * 0.6}px) rotate(0deg)`, { at: T4 + 300, duration: 180 });
    });

    // 5. Geben im Skat-Rhythmus: 3 – Skat 2 – 4 – 3, eigene Karten drehen sich um
    const T5 = T4 + 480;
    const skatSpot = { x: -0.28 * Math.min(W, 520), y: 30 };
    const packets = [];
    for (const [size, who] of [[3, 'order'], [2, 'skat'], [4, 'order'], [3, 'order']]) {
      if (who === 'skat') packets.push({ to: 'skat', size });
      else o.order.forEach((pos) => packets.push({ to: pos, size }));
    }
    let myIndex = 0;
    packets.forEach((p, k) => {
      const at = T5 + k * 70;
      const target = p.to === 'skat' ? skatSpot : rel(o.targets[p.to]) ?? { x: 0, y: H * 0.4 };
      const fly = place(o.makeBack());
      fly.style.zIndex = String(100 + k);
      later(at, () => sound.rustle(0.06, 0.04));
      const spread = p.to === 'me' ? (myIndex - 4.5) * 14 : 0;
      to(fly, `translate(${target.x + spread}px, ${target.y}px) rotate(${rnd(-8, 8)}deg) scale(${p.to === 'me' ? 1 : 0.6})`, { at, duration: 240 });
      if (p.to === 'me' && o.myCards.length) {
        // Umdrehen: Rückseite schrumpft auf 0 (scaleX), Vorderseite wächst daraus
        const card = o.myCards[Math.min(myIndex, o.myCards.length - 1)];
        const front = place(o.makeFront(card));
        front.style.zIndex = String(101 + k);
        front._t = `translate(${target.x + spread}px, ${target.y}px) scaleX(0)`;
        front.style.opacity = '0';
        to(fly, `translate(${target.x + spread}px, ${target.y}px) scaleX(0)`, { at: at + 245, duration: 100, easing: 'ease-in' });
        keyframes(front, [
          { transform: front._t, opacity: 1 },
          { transform: `translate(${target.x + spread}px, ${target.y}px) scaleX(1)`, opacity: 1 },
        ], { at: at + 345, duration: 110, easing: 'ease-out' });
      }
      if (p.to === 'me') myIndex += p.size;
    });
    // Stapel leert sich beim Geben
    deck.forEach((el, i) => to(el, `${el._t} scale(0.9)`, { at: T5 + i * 55, duration: 180, opacity: 0 }));

    const total = T5 + packets.length * 70 + 420; // ≈ 3,2 s
    later(total, end);
    return finished;
  }

  window.SkatFX = { flyFrom, fadeIn, sweepTo, sparkle, podiumRise, shuffle, sound, reduced };
})();
