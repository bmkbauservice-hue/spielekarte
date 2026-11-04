'use strict';
// Animationen der Spielekarte (window.SkatFX).
// GRUNDREGEL: Alles hier ist nur Show. Nichts verändert oder verzögert den Spielstand –
// der Server bleibt maßgeblich, die Oberfläche ist schon fertig gezeichnet, bevor eine Animation startet.
//
// Robustheit (iPhone-Bugfix):
// - Läuft auch ohne Web Animations API (dann wird einfach nichts animiert).
// - Overlays (Misch-Bühne) können den Bildschirm NIE dauerhaft blockieren: Antippen, Fehler,
//   Seite unsichtbar (Handy gesperrt) und eine harte Notbremse nach 5 s entfernen sie direkt.
// - Nur Syntax, die Safari ab iOS 13 versteht (kein ?., ??, ??= – ein Test prüft das).

(function () {
  var EASE = 'cubic-bezier(.2,.8,.2,1)';
  var MAX_STAGE_MS = 5000;   // harte Notbremse für die Misch-Bühne
  var FADE_MS = 160;         // Ausblenden der Bühne; entfernt wird spätestens nach FADE_MS + 140 ms

  var canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function mid(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  /** Punkt in den sichtbaren Bereich ziehen – nichts darf über den Rand ragen,
      sonst wird die Seite breiter und iOS-Safari zoomt (Karten werden unerreichbar). */
  function inView(p) {
    var w = document.documentElement.clientWidth || window.innerWidth;
    return { x: clamp(p.x, 40, w - 40), y: p.y };
  }

  /** Promise sicher abwarten – auch wenn es fehlt, undefined ist oder abgebrochen wird */
  function safe(promise) {
    if (promise && typeof promise.then === 'function') return promise.then(function () {}, function () {});
    return Promise.resolve();
  }

  /** element.animate mit Netz: ohne API oder bei Fehler → null statt Absturz */
  function run(el, frames, options) {
    if (!canAnimate || !el) return null;
    try { return el.animate(frames, options); } catch (e) { return null; }
  }
  function finished(anim) { return safe(anim && anim.finished); }

  // ---------- Ton (optional, standardmäßig aus) ----------

  var SOUND_KEY = 'spielekarte:ton';
  var audio = null;
  var sound = {
    get on() {
      try { return localStorage.getItem(SOUND_KEY) === 'an'; } catch (e) { return false; }
    },
    set on(value) {
      try { localStorage.setItem(SOUND_KEY, value ? 'an' : 'aus'); } catch (e) { /* egal */ }
      if (value) this.unlock();
    },
    /** Browser erlauben Ton erst nach einer Berührung – beim Einschalten freischalten */
    unlock: function () {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext; // ältere Safaris: webkitAudioContext
        if (!audio && Ctx) audio = new Ctx();
        if (audio && audio.state === 'suspended') audio.resume();
      } catch (e) { /* kein Ton möglich */ }
    },
    /** Leises Karten-Rascheln: kurzes, abklingendes, gefiltertes Rauschen – ohne Audiodatei */
    rustle: function (seconds, volume) {
      if (!this.on || !audio) return;
      try {
        var length = Math.floor(audio.sampleRate * (seconds || 0.09));
        var buffer = audio.createBuffer(1, length, audio.sampleRate);
        var data = buffer.getChannelData(0);
        for (var i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
        var src = audio.createBufferSource();
        src.buffer = buffer;
        var filter = audio.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 2600 + Math.random() * 1200;
        var gain = audio.createGain();
        gain.gain.value = volume || 0.05;
        src.connect(filter);
        filter.connect(gain);
        gain.connect(audio.destination);
        src.start();
      } catch (e) { /* egal */ }
    },
  };

  // ---------- Kleine Effekte ----------

  function fadeIn(el, duration) {
    return finished(run(el, [{ opacity: 0 }, { opacity: 1 }], { duration: duration || 180 }));
  }

  /** Karte vom alten Ort (Rect) an ihren neuen Platz fliegen lassen (FLIP-Technik). */
  function flyFrom(el, fromRect, opts) {
    var o = opts || {};
    if (!el) return Promise.resolve();
    if (!fromRect || reduced()) return fadeIn(el);
    try {
      var to = el.getBoundingClientRect();
      var a = inView(mid(fromRect));
      var b = mid(to);
      // Startgröße begrenzen: Gegnerkarten starten vom ganzen Gegnerplatz (≈ 180 px) – ohne Grenze wären sie 3× so groß
      var scale = clamp(to.width ? fromRect.width / to.width : 1, 0.4, 1.3);
      return finished(run(el,
        [{ transform: 'translate(' + (a.x - b.x) + 'px, ' + (a.y - b.y) + 'px) scale(' + scale + ') rotate(' + (o.rotate || 0) + 'deg)' }, { transform: 'none' }],
        { duration: o.duration || 380, easing: EASE }));
    } catch (e) {
      return Promise.resolve();
    }
  }

  /** Die Karten eines fertigen Stichs rutschen zum Gewinner und verschwinden. */
  function sweepTo(cards, targetRect, opts) {
    var delay = (opts && opts.delay) || 900;
    if (!targetRect || !cards || cards.length === 0) return;
    try {
      var t = inView(mid(targetRect));
      cards.forEach(function (el, i) {
        var c = mid(el.getBoundingClientRect());
        var anim = run(el,
          [{ transform: 'none', opacity: 1 }, { transform: 'translate(' + (t.x - c.x) + 'px, ' + (t.y - c.y) + 'px) scale(0.35)', opacity: 0 }],
          { duration: reduced() ? 120 : 420, delay: delay + i * 50, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
        // Danach unsichtbar an den Platz zurück – verschobene Karten würden sonst die Seite verbreitern
        if (anim) anim.onfinish = function () { el.style.opacity = '0'; try { anim.cancel(); } catch (e) { /* egal */ } };
      });
    } catch (e) { /* egal – die Karten bleiben dann einfach liegen */ }
  }

  /** Kurzes Gold-/Neon-Funkeln über einem Element. Die Ebene verschwindet immer per Timer. */
  function sparkle(host, opts) {
    var o = opts || {};
    if (!host || reduced() || !canAnimate) return;
    var layer = document.createElement('div');
    layer.className = 'fx-sparkle';
    setTimeout(function () { if (layer.parentNode) layer.parentNode.removeChild(layer); }, 1600);
    try {
      host.appendChild(layer);
      var count = o.count || 20;
      for (var i = 0; i < count; i++) {
        var spark = document.createElement('i');
        spark.className = 'fx-spark' + (i % 3 === 0 ? ' mint' : '');
        spark.style.top = o.y || '35%';
        layer.appendChild(spark);
        var angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
        var dist = 50 + Math.random() * 70;
        run(spark, [
          { transform: 'translate(0, 0) scale(0.2)', opacity: 0 },
          { transform: 'translate(' + Math.cos(angle) * dist * 0.5 + 'px, ' + Math.sin(angle) * dist * 0.5 + 'px) scale(1.2)', opacity: 1, offset: 0.35 },
          { transform: 'translate(' + Math.cos(angle) * dist + 'px, ' + Math.sin(angle) * dist + 'px) scale(0)', opacity: 0 },
        ], { duration: 900 + Math.random() * 400, delay: Math.random() * 150, easing: 'ease-out', fill: 'forwards' });
      }
    } catch (e) { /* egal */ }
  }

  /** Siegertreppchen: Stufen wachsen von unten herauf. */
  function podiumRise(steps) {
    try {
      steps.forEach(function (step, i) {
        if (reduced()) fadeIn(step);
        else run(step, [{ transform: 'translateY(60px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
          { duration: 600, delay: 150 + i * 180, easing: EASE, fill: 'backwards' });
      });
    } catch (e) { /* egal */ }
  }

  // ---------- Misch-Show vor dem Geben ----------

  /** Deterministischer Zufall: alle Handys wählen für dieselbe Runde denselben Trick. */
  function pickTrick(seedText) {
    var h = 0;
    for (var i = 0; i < seedText.length; i++) h = (h * 31 + seedText.charCodeAt(i)) >>> 0;
    return h % 4;
  }

  /** Alle Misch-Bühnen sofort entfernen (Notfall, z. B. aus dem globalen Fehlerfänger). */
  function cleanup() {
    var stages = document.querySelectorAll('.fx-stage');
    for (var i = 0; i < stages.length; i++) if (stages[i].parentNode) stages[i].parentNode.removeChild(stages[i]);
  }

  /**
   * Misch-Show (≈ 3,2 s): Einsammeln → Riffle → Trick → Abheben → Geben im Skat-Rhythmus 3 – Skat 2 – 4 – 3.
   * Gemischt wird echt auf dem Server – das hier ist nur Show. Antippen überspringt.
   * Die Bühne verschwindet garantiert: am Ende, beim Antippen, bei jedem Fehler, wenn die Seite
   * unsichtbar wird, spätestens aber nach 5 s (Notbremse).
   * @returns {Promise<void>}
   */
  function shuffle(o) {
    if (!canAnimate || !document.body) return Promise.resolve(); // ohne Animations-API: keine Show

    var stage = document.createElement('div');
    var timers = [];
    var anims = [];
    var over = false;
    var resolveDone;
    var done = new Promise(function (resolve) { resolveDone = resolve; });

    function removeStage() {
      if (stage.parentNode) stage.parentNode.removeChild(stage);
    }
    function onHidden() { if (document.hidden) end(); }
    function end() {
      if (over) return;
      over = true;
      timers.forEach(clearTimeout);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', end);
      anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* egal */ } });
      // Ausblenden ist nur Kosmetik – entfernt wird per Timer, unabhängig davon, ob die Animation fertig meldet
      run(stage, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: 'forwards' });
      setTimeout(function () { removeStage(); resolveDone(); }, FADE_MS + 40);
    }

    // Diese Wege beenden die Show IMMER – sie werden vor allem anderen eingerichtet
    var brake = setTimeout(function () { end(); removeStage(); resolveDone(); }, MAX_STAGE_MS);
    done.then(function () { clearTimeout(brake); });
    stage.addEventListener('pointerdown', end);
    stage.addEventListener('touchstart', end, { passive: true }); // ältere iPhones ohne Pointer Events
    stage.addEventListener('click', end);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', end);

    try {
      stage.className = 'fx-stage';
      stage.setAttribute('aria-hidden', 'true');
      var skip = document.createElement('p');
      skip.className = 'fx-skip';
      skip.textContent = 'Antippen zum Überspringen';
      stage.appendChild(skip);
      document.body.appendChild(stage);
      if (document.hidden) { end(); return done; }
      choreograph(o, stage, anims, timers, end);
    } catch (e) {
      // Jeder Fehler beendet die Show sofort – lieber keine Animation als ein blockierter Bildschirm
      end();
      removeStage();
    }
    return done;
  }

  /** Der eigentliche Ablauf der Misch-Show (alle Zeiten in ms ab Start). */
  function choreograph(o, stage, anims, timers, end) {
    var W = window.innerWidth;
    var H = window.innerHeight;
    var c = { x: W / 2, y: H * 0.42 };
    var cardW = 64;
    var cardH = 93;
    var targets = o.targets || {};

    function later(ms, fn) {
      timers.push(setTimeout(function () { try { fn(); } catch (e) { end(); } }, ms));
    }
    function place(el) {
      el.style.left = (c.x - cardW / 2) + 'px';
      el.style.top = (c.y - cardH / 2) + 'px';
      stage.appendChild(el);
      el._t = 'translate(0px, 0px) rotate(0deg)';
      return el;
    }
    /** Von der aktuellen Lage zu `transform` – zeitlich hintereinander, deshalb fill: forwards */
    function to(el, transform, opt) {
      var from = { transform: el._t };
      var dest = { transform: transform };
      if (opt.opacity !== undefined) { from.opacity = el._o === undefined ? 1 : el._o; dest.opacity = opt.opacity; el._o = opt.opacity; }
      var a = run(el, [from, dest], { duration: opt.duration || 300, delay: opt.at, easing: opt.easing || EASE, fill: 'forwards' });
      if (a) anims.push(a);
      el._t = transform;
      return a;
    }
    function keyframes(el, frames, opt) {
      var a = run(el, frames, { duration: opt.duration, delay: opt.at, easing: opt.easing || 'ease-in-out', fill: 'forwards' });
      if (a) anims.push(a);
      return a;
    }
    function rel(rect) { return rect ? { x: mid(rect).x - c.x, y: mid(rect).y - c.y } : null; }
    function rnd(a, b) { return a + Math.random() * (b - a); }

    // Weniger Bewegung: nur kurz den Stapel einblenden
    if (reduced()) {
      place(o.makeBack());
      later(450, end);
      return;
    }

    var N = 12;
    var deck = [];
    for (var n = 0; n < N; n++) deck.push(place(o.makeBack()));
    var spots = [rel(targets.left), rel(targets.right), rel(targets.me)].filter(Boolean);

    // 1. Einsammeln: Karten fliegen von den Plätzen/vom Rand zum Stapel
    deck.forEach(function (el, i) {
      var s = spots.length ? spots[i % spots.length] : { x: rnd(-W / 2, W / 2), y: rnd(-H / 3, H / 3) };
      el._t = 'translate(' + (s.x + rnd(-40, 40)) + 'px, ' + (s.y + rnd(-30, 30)) + 'px) rotate(' + rnd(-50, 50) + 'deg)';
      to(el, 'translate(0px, ' + (-i * 0.6) + 'px) rotate(' + rnd(-3, 3) + 'deg)', { at: i * 18, duration: 330 });
    });

    // 2. Riffle-Shuffle: teilen, dann abwechselnd ineinander rauschen
    var T2 = 380; // Zeitplan gesamt ≈ 3,2 s
    deck.forEach(function (el, i) {
      var left = i % 2 === 0;
      to(el, 'translate(' + (left ? -46 : 46) + 'px, ' + (-i * 0.6) + 'px) rotate(' + (left ? -9 : 9) + 'deg)', { at: T2, duration: 190 });
    });
    later(T2 + 200, function () { sound.rustle(0.35, 0.06); });
    deck.forEach(function (el, i) {
      to(el, 'translate(0px, ' + (-i * 0.6) + 'px) rotate(0deg)', { at: T2 + 200 + i * 22, duration: 140, easing: 'ease-in' });
    });

    // 3. Zufälliger Trick (für alle Handys gleich), je ≈ 800 ms
    var T3 = T2 + 200 + N * 22 + 60;
    var trick = pickTrick(String(o.seed || ''));
    if (trick === 0) {
      // Karten-Fächer, der sich wie ein Rad dreht
      deck.forEach(function (el, i) {
        var angle = -75 + (150 / (N - 1)) * i;
        to(el, 'rotate(' + angle + 'deg) translateY(-62px)', { at: T3, duration: 200 });
        to(el, 'rotate(' + (angle + 360) + 'deg) translateY(-62px)', { at: T3 + 210, duration: 420, easing: 'ease-in-out' });
        to(el, 'rotate(360deg) translateY(0px)', { at: T3 + 640, duration: 160 }); // 360 statt 0: nicht zurückdrehen
      });
    } else if (trick === 1) {
      // Wasserfall / Bridge: Karten biegen sich hoch und fallen nacheinander zurück
      deck.forEach(function (el, i) {
        keyframes(el, [
          { transform: el._t },
          { transform: 'translate(' + (i - N / 2) * 6 + 'px, ' + (-120 - i * 3) + 'px) rotate(' + (-14 + i * 2) + 'deg)', offset: 0.45 },
          { transform: el._t },
        ], { at: T3 + i * 30, duration: 460 });
      });
    } else if (trick === 2) {
      // Karten springen im Bogen von einer Hand zur anderen
      deck.forEach(function (el, i) {
        to(el, 'translate(-78px, ' + (-i * 0.6) + 'px) rotate(-8deg)', { at: T3, duration: 160 });
        keyframes(el, [
          { transform: 'translate(-78px, ' + (-i * 0.6) + 'px) rotate(-8deg)' },
          { transform: 'translate(0px, ' + (-105 - (i % 3) * 8) + 'px) rotate(170deg)', offset: 0.5 },
          { transform: 'translate(78px, ' + (-i * 0.6) + 'px) rotate(352deg)' },
        ], { at: T3 + 170 + i * 22, duration: 300 });
        el._t = 'translate(78px, ' + (-i * 0.6) + 'px) rotate(352deg)';
        to(el, 'translate(0px, ' + (-i * 0.6) + 'px) rotate(360deg)', { at: T3 + 720, duration: 80 });
        el._t = 'translate(0px, ' + (-i * 0.6) + 'px) rotate(0deg)';
      });
    } else {
      // Funkeln über dem Stapel
      deck.forEach(function (el, i) {
        keyframes(el, [
          { transform: el._t },
          { transform: el._t + ' rotate(' + (i % 2 ? 6 : -6) + 'deg) scale(1.04)' },
          { transform: el._t },
        ], { at: T3 + i * 15, duration: 420 });
      });
      later(T3, function () {
        var host = document.createElement('div');
        host.className = 'fx-sparkle';
        host.style.top = (c.y - H * 0.4) + 'px';
        stage.appendChild(host);
        sparkle(host, { count: 26, y: '40%' });
      });
    }

    // 4. Abheben: obere Hälfte kurz zur Seite und wieder darunter, Name blinkt
    var T4 = T3 + 800;
    var label = document.createElement('p');
    label.className = 'fx-label';
    label.style.top = (c.y + cardH / 2 + 22) + 'px';
    label.textContent = (o.cutter || '') + ' hebt ab';
    stage.appendChild(label);
    keyframes(label, [{ opacity: 0 }, { opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }, { opacity: 0 }], { at: T4, duration: 600 });
    deck.slice(N / 2).forEach(function (el, i) {
      to(el, 'translate(58px, ' + (-30 - i) + 'px) rotate(7deg)', { at: T4, duration: 180 });
      to(el, 'translate(0px, ' + (-i * 0.6) + 'px) rotate(0deg)', { at: T4 + 300, duration: 180 });
    });

    // 5. Geben im Skat-Rhythmus: 3 – Skat 2 – 4 – 3, eigene Karten drehen sich um
    var T5 = T4 + 480;
    var skatSpot = { x: -0.28 * Math.min(W, 520), y: 30 };
    var order = o.order || [];
    var myCards = o.myCards || [];
    var packets = [];
    [[3, 'order'], [2, 'skat'], [4, 'order'], [3, 'order']].forEach(function (p) {
      if (p[1] === 'skat') packets.push({ to: 'skat', size: p[0] });
      else order.forEach(function (pos) { packets.push({ to: pos, size: p[0] }); });
    });
    var myIndex = 0;
    packets.forEach(function (p, k) {
      var at = T5 + k * 70;
      var target = p.to === 'skat' ? skatSpot : (rel(targets[p.to]) || { x: 0, y: H * 0.4 });
      var fly = place(o.makeBack());
      fly.style.zIndex = String(100 + k);
      later(at, function () { sound.rustle(0.06, 0.04); });
      var spread = p.to === 'me' ? (myIndex - 4.5) * 14 : 0;
      var pos = 'translate(' + (target.x + spread) + 'px, ' + target.y + 'px)';
      to(fly, pos + ' rotate(' + rnd(-8, 8) + 'deg) scale(' + (p.to === 'me' ? 1 : 0.6) + ')', { at: at, duration: 240 });
      if (p.to === 'me' && myCards.length) {
        // Umdrehen: Rückseite schrumpft auf 0 (scaleX), Vorderseite wächst daraus
        var front = place(o.makeFront(myCards[Math.min(myIndex, myCards.length - 1)]));
        front.style.zIndex = String(101 + k);
        front.style.opacity = '0';
        to(fly, pos + ' scaleX(0)', { at: at + 245, duration: 100, easing: 'ease-in' });
        keyframes(front, [
          { transform: pos + ' scaleX(0)', opacity: 1 },
          { transform: pos + ' scaleX(1)', opacity: 1 },
        ], { at: at + 345, duration: 110, easing: 'ease-out' });
      }
      if (p.to === 'me') myIndex += p.size;
    });
    // Stapel leert sich beim Geben
    deck.forEach(function (el, i) { to(el, el._t + ' scale(0.9)', { at: T5 + i * 55, duration: 180, opacity: 0 }); });

    later(T5 + packets.length * 70 + 420, end); // ≈ 3,2 s
  }

  window.SkatFX = {
    flyFrom: flyFrom, fadeIn: fadeIn, sweepTo: sweepTo, sparkle: sparkle, podiumRise: podiumRise,
    shuffle: shuffle, cleanup: cleanup, sound: sound, reduced: reduced, canAnimate: canAnimate,
  };
})();
