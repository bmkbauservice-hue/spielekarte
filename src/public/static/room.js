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
  let lastStatus = null;
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

  // Neue Version auf dem Server (Deploy)? → Seite neu laden. Das Token bleibt im localStorage, der Platz auch.
  const APP_VERSION = document.querySelector('meta[name="app-version"]').content;
  socket.on('app:version', (version) => {
    if (version !== APP_VERSION) location.reload();
  });

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

    // Lobby
    $('lobby').hidden = !lobby;
    $('btn-start').hidden = !state.canStart;
    renderHouseRuleSwitches(seated && lobby);
    $('btn-leave-seat').hidden = !lobby || !seated;
    $('btn-leave').hidden = !lobby && seated;
    $('start-hint').textContent = lobby ? startHint(seats, seated, state.canStart) : '';

    // Spiel
    const newDeal = isNewDeal();
    $('game').hidden = status !== 'running' || !state.game;
    if (status === 'running' && state.game) renderGame(state.game, seated);
    if (newDeal) playShuffle();
    $('summary').hidden = status !== 'summary';
    if (status === 'summary') renderSummary(seated);
    // Beim Wechsel in die Abendwertung nach oben scrollen, damit man sie sofort sieht
    if (status === 'summary' && lastStatus !== 'summary') window.scrollTo({ top: 0, behavior: 'smooth' });
    lastStatus = status;
    renderScores();
    renderVote(seated);
  }

  // ---------- Spiel-Anzeige ----------

  const VS = '︎'; // Text-Darstellung: ♠︎ statt bunter Emoji-Karte
  const SUIT_SYMBOL = { kreuz: `♣${VS}`, pik: `♠${VS}`, herz: `♥${VS}`, karo: `♦${VS}` };
  const SUIT_NAME = { kreuz: 'Kreuz', pik: 'Pik', herz: 'Herz', karo: 'Karo' };
  const RANK_NAME = { B: 'Bube', D: 'Dame', K: 'König', A: 'Ass' };
  const NULL_VALUES = { plain: 23, hand: 35, ouvert: 46, ouvertHand: 59 }; // nur für den Hinweis beim Ansagen
  /** `wert ?? ersatz` für ältere Safaris (iOS 13 kennt ?? und ?. nicht) */
  const or = (value, fallback) => (value === null || value === undefined ? fallback : value);
  const nameOf = (seat) => (state.seats[seat] ? state.seats[seat].name : `Platz ${seat + 1}`);
  const isMe = (seat) => seat === state.you.seat;
  // Fehlt fx.js (z. B. Ladefehler), läuft das Spiel trotzdem – nur ohne Animationen
  const noop = () => Promise.resolve();
  const FX = window.SkatFX || {
    flyFrom: noop, fadeIn: noop, sweepTo: noop, sparkle: noop, podiumRise: noop, shuffle: noop, cleanup: noop,
    reduced: () => true, sound: { on: false, rustle: noop, unlock: noop },
  };

  // Zustand nur im Browser (bis der Server ihn bestätigt)
  let handMode = false;            // Alleinspieler hat "Hand spielen" gewählt
  let choice = null;               // gewähltes Spiel in der Ansage: { type, trump }
  const discardPick = new Set();   // zum Drücken angetippte Karten

  /** Aus wessen Sicht wird der Tisch gezeichnet? Spieler: eigener Platz unten; Zuschauer: Platz 1 unten. */
  const viewSeat = () => or(state.you.seat, 0);
  /** Position eines Platzes relativ zu mir: links sitzt, wer nach mir dran ist (Uhrzeigersinn). */
  const posOf = (seat) => (seat === viewSeat() ? 'me' : seat === (viewSeat() + 1) % 3 ? 'left' : 'right');
  const seatAt = (pos) => (pos === 'me' ? viewSeat() : pos === 'left' ? (viewSeat() + 1) % 3 : (viewSeat() + 2) % 3);
  /** Bildschirm-Rechteck eines Platzes (für Animationen) */
  const rectOf = (pos) => {
    const el = pos === 'me' ? (state.game && state.game.hand ? $('hand') : $('me-line')) : $(`opp-${pos}`);
    return el && el.offsetParent ? el.getBoundingClientRect() : null;
  };

  function renderGame(game, seated) {
    const mySeat = state.you.seat;
    const meDeclarer = game.declarer !== null && isMe(game.declarer);
    const myTurn = game.phase === 'playing' && game.turn === mySeat;
    if (game.phase !== 'skat') handMode = false;
    if (game.phase !== 'skat' && game.phase !== 'declaring') choice = null;
    if (game.phase !== 'discard') discardPick.clear();

    // Vor dem Neuzeichnen merken, wo die Handkarten lagen – für den Flug zum Tisch
    const handRects = new Map([...$('hand').querySelectorAll('.card[data-card]')].map((el) => [el.dataset.card, el.getBoundingClientRect()]));

    renderHead(game);
    renderOpponents(game, mySeat);
    renderTable(game, handRects);
    renderMeLine(game, mySeat);

    // Ouvert: offene Karten des Alleinspielers für die anderen
    $('open-hand').hidden = !game.openHand || meDeclarer;
    if (game.openHand && !meDeclarer) {
      $('open-hand-title').textContent = `Offene Karten von ${nameOf(game.declarer)}`;
      $('open-hand-cards').replaceChildren(...game.openHand.map((c) => cardElement(c)));
    }

    const mine = game.turn === mySeat && game.turn !== null;
    $('game-status').textContent = statusText(game, mySeat);
    $('game-status').classList.toggle('my-turn', mine);
    $('status-pill').classList.toggle('my-turn', mine);
    $('status-pill').hidden = game.phase === 'finished' || game.phase === 'passed';

    renderBidding(game, mySeat);
    renderHouseRulesInGame(game, mySeat, meDeclarer);
    $('skat-choice').hidden = !(game.phase === 'skat' && meDeclarer && !handMode);
    $('skat-choice-info').textContent = `Gereizt bis ${game.bid}. Mit dem Skat bekommst du 2 Karten dazu und drückst 2 – Hand zählt eine Stufe mehr.`;
    $('discard').hidden = !(game.phase === 'discard' && meDeclarer);
    $('btn-discard').disabled = discardPick.size !== 2;
    renderDeclare(game, meDeclarer);
    $('passed').hidden = game.phase !== 'passed';
    $('btn-redeal').hidden = !seated;
    renderResult(game, seated);
    renderHand(game, myTurn, meDeclarer);

    $('btn-abort').hidden = !seated || !!state.vote;
    $('btn-end').hidden = !seated || !!state.vote;
  }

  /** Kopfzeile: "Grand · Stich 4 von 10" + "Alleinspieler: Kalle · gereizt bis 48" */
  function renderHead(game) {
    const played = game.tricksWon.reduce((a, b) => a + b, 0);
    let eyebrow;
    if (game.phase === 'bidding') eyebrow = `Reizen · Runde ${state.round}`;
    else if (game.phase === 'passed') eyebrow = `Runde ${state.round} · eingepasst`;
    else if (game.phase === 'playing') eyebrow = `${game.label} · Stich ${Math.min(played + 1, 10)} von 10`;
    else eyebrow = `${game.label || 'Ansage folgt'} · Runde ${state.round}`;
    $('game-info').textContent = eyebrow;

    const sub = $('game-sub');
    sub.replaceChildren();
    if (game.declarer !== null && game.phase !== 'bidding') {
      const b = document.createElement('b');
      b.textContent = isMe(game.declarer) ? 'du' : nameOf(game.declarer);
      sub.append('Alleinspieler: ', b, ` · gereizt bis ${game.bid}`);
      const type = game.game ? game.game.type : null;
      if (type === 'null') sub.append(' · kein Trumpf');
      else if (type === 'grand') sub.append(' · nur Buben Trumpf');
      else if (type === 'suit') sub.append(` · ${SUIT_SYMBOL[game.game.trump]} ist Trumpf`);
    } else {
      sub.textContent = `Geber: ${nameOf(game.dealer)} · ${nameOf(game.forehand)} spielt aus`;
    }
  }

  function roleOf(game, seat) {
    if (seat === game.declarer) return 'Alleinspieler';
    if (game.declarer !== null && state.you.seat !== null && !isMe(game.declarer) && !isMe(seat)) return 'dein Partner';
    if (game.phase === 'bidding' && game.bidding.passed.includes(seat)) return 'hat gepasst';
    return seat === game.forehand ? 'Vorhand' : seat === game.middle ? 'Mittelhand' : 'Hinterhand · Geber';
  }

  /** Gegner oben: Kartenrücken (Anzahl), Name, Rolle, Badges, Puls wenn dran */
  function renderOpponents(game, mySeat) {
    for (const pos of ['left', 'right']) {
      const seat = seatAt(pos);
      const el = $(`opp-${pos}`);
      const person = state.seats[seat];
      el.classList.toggle('turn', game.turn === seat);
      const backs = document.createElement('div');
      backs.className = 'opp-backs';
      backs.setAttribute('aria-label', `${game.handCounts[seat]} Karten`);
      for (let i = 0; i < Math.min(game.handCounts[seat], 12); i++) backs.append(backElement(true));
      const name = document.createElement('div');
      name.className = 'opp-name';
      const dot = document.createElement('i');
      dot.className = `dot${seat === game.declarer ? ' solo' : roleOf(game, seat) === 'dein Partner' ? ' partner' : ''}`;
      const label = document.createElement('span');
      label.textContent = nameOf(seat);
      name.append(dot, label);
      const role = document.createElement('div');
      role.className = 'opp-role';
      const tricks = game.tricksWon[seat];
      role.textContent = roleOf(game, seat) + (game.phase === 'playing' || game.phase === 'finished' ? ` · ${tricks} ${tricks === 1 ? 'Stich' : 'Stiche'}` : '');
      const badges = document.createElement('div');
      badges.className = 'opp-badges';
      if (seat === game.kontraBy) badges.append(badge('Kontra', 'badge-kontra'));
      if (seat === game.declarer && game.re) badges.append(badge('Re', 'badge-kontra'));
      if (person && !person.connected) badges.append(badge('getrennt', 'badge-off'));
      el.replaceChildren(backs, name, role, badges);
      void mySeat;
    }
  }

  function renderMeLine(game, mySeat) {
    const el = $('me-line');
    el.replaceChildren();
    const seat = viewSeat();
    const b = document.createElement('b');
    b.textContent = mySeat === null ? nameOf(seat) : 'Du';
    const tricks = game.tricksWon[seat];
    el.append(b, ` · ${roleOf(game, seat)}`);
    if (game.phase === 'playing' || game.phase === 'finished') el.append(` · ${tricks} ${tricks === 1 ? 'Stich' : 'Stiche'}`);
    if (seat === game.kontraBy) el.append(badge('Kontra', 'badge-kontra'));
    if (seat === game.declarer && game.re) el.append(badge('Re', 'badge-kontra'));
    if (mySeat === null) el.append(badge('Zuschauer', 'badge-dealer'));
  }

  // ----- Tisch: Stich, Skat, Animationen -----

  let tableKey = null;
  let shownOnTable = new Set();

  function renderTable(game, handRects) {
    const showTable = !['bidding', 'passed'].includes(game.phase);
    $('table').hidden = !showTable;
    $('table').classList.toggle('bock', game.bock);
    if (!showTable) { tableKey = null; shownOnTable = new Set(); return; }

    // Skat liegt auf dem Tisch, solange ihn niemand aufgenommen hat
    const skatOnTable = !game.skatTaken && game.phase !== 'finished';
    $('table-skat').hidden = !skatOnTable;
    if (skatOnTable && !$('table-skat').querySelector('.card')) {
      $('table-skat').querySelector('.cards').replaceChildren(backElement(true), backElement(true));
    }

    const declTricks = game.declarer !== null ? game.tricksWon[game.declarer] : 0;
    const defTricks = game.tricksWon.reduce((a, b) => a + b, 0) - declTricks;
    $('table-tricks').hidden = game.phase !== 'playing' || game.declarer === null;
    $('table-tricks').replaceChildren('Stiche', document.createElement('br'), Object.assign(document.createElement('b'), {
      textContent: `${isMe(game.declarer) ? 'Du' : nameOf(game.declarer)} ${declTricks} · Gegner ${defTricks}`,
    }));

    const showLast = game.trick.length === 0 && game.lastTrick !== null;
    const cards = showLast ? game.lastTrick.cards : game.trick;
    $('trick-label').textContent = showLast
      ? `${isMe(game.lastTrick.winner) ? 'Du stichst' : `${nameOf(game.lastTrick.winner)} sticht`}`
      : game.phase === 'playing' && cards.length === 0 ? `${nameOf(game.turn)} spielt aus` : '';

    // Nur neu zeichnen, wenn sich die Karten auf dem Tisch wirklich geändert haben
    const key = `${showLast ? 'L' : 'C'}:${cards.map((t) => `${t.seat}${t.card}`).join(',')}`;
    if (key === tableKey) return;
    tableKey = key;

    const before = shownOnTable;
    shownOnTable = new Set(cards.map((t) => `${t.seat}:${t.card}`));
    const slots = cards.map(({ seat, card }) => {
      const slot = document.createElement('div');
      slot.className = `slot pos-${posOf(seat)}`;
      if (showLast && seat === game.lastTrick.winner) slot.classList.add('winner');
      const name = document.createElement('span');
      name.className = 'slot-name';
      name.textContent = isMe(seat) ? 'du' : nameOf(seat);
      const el = cardElement(card);
      slot.append(el, name);
      return { slot, el, seat, card, isNew: !before.has(`${seat}:${card}`) };
    });
    $('trick').replaceChildren(...slots.map((s) => s.slot));

    // Karte ausspielen: fliegt aus der Hand (bzw. vom Platz des Gegners) in die Tischmitte
    for (const s of slots.filter((x) => x.isNew)) {
      const from = isMe(s.seat) ? handRects.get(s.card) : rectOf(posOf(s.seat));
      FX.flyFrom(s.el, from, { rotate: isMe(s.seat) ? 0 : posOf(s.seat) === 'left' ? -20 : 20 });
      FX.sound.rustle();
    }
    // Stich komplett: die drei Karten rutschen zum Gewinner
    if (showLast && slots.some((x) => x.isNew)) {
      FX.sweepTo(slots.map((x) => x.el), rectOf(posOf(game.lastTrick.winner)), { delay: 1000 });
    }
  }

  function statusText(game, mySeat) {
    const d = game.declarer !== null ? nameOf(game.declarer) : '';
    const mine = game.turn === mySeat;
    switch (game.phase) {
      case 'bidding':
        if (game.bidding.passed.includes(mySeat)) return 'Du hast gepasst.';
        return mine ? 'Du bist beim Reizen dran.' : `${nameOf(game.turn)} überlegt …`;
      case 'skat': return mine ? 'Du hast das Reizen gewonnen!' : `${d} entscheidet: Skat oder Hand …`;
      case 'discard': return mine ? 'Wähle 2 Karten zum Drücken.' : `${d} drückt …`;
      case 'declaring': return mine ? 'Sag dein Spiel an.' : `${d} sagt an …`;
      case 'gift':
        if (game.gift.awaitingDeclarer) return mine ? 'Dir wird das Spiel geschenkt!' : `${d} entscheidet über das Geschenk …`;
        return isMe(game.declarer) ? 'Die Gegenspieler überlegen, ob sie schenken …' : 'Schenken oder spielen?';
      case 'playing': {
        if (!mine) return `${nameOf(game.turn)} ist dran …`;
        if (game.trick.length === 0) return 'Du bist dran – spiel aus!';
        const lead = game.trick[0].card;
        const follow = game.legal.length < game.hand.length;
        if (!follow) return 'Du bist dran – du darfst jede Karte spielen.';
        const isTrumpLead = lead.endsWith('-B') || (game.game.type === 'suit' && lead.startsWith(game.game.trump));
        return isTrumpLead && game.game.type !== 'null'
          ? 'Du bist dran – Trumpf ist gefragt, du musst bedienen.'
          : `Du bist dran – ${SUIT_NAME[lead.split('-')[0]]} ausgespielt, du musst bedienen.`;
      }
      default: return '';
    }
  }

  // ----- Reizen: roter Filz, großes Gebot, Reizwerte-Leiste -----

  // Reizwerte wie in src/game/scoring.js (nur für die Anzeige der Leiste)
  const BID_VALUES = (() => {
    const v = new Set([23, 35, 46, 59]);
    for (const base of [9, 10, 11, 12]) for (let m = 2; m <= 18; m++) v.add(base * m);
    for (let m = 2; m <= 11; m++) v.add(24 * m);
    return [...v].sort((a, b) => a - b);
  })();
  const BID_WORDS = { bid: (v) => `${v}`, hold: () => 'Ja', pass: () => 'passe' };

  function renderBidding(game, mySeat) {
    const b = game.bidding;
    $('bidding').hidden = game.phase !== 'bidding';
    if (game.phase !== 'bidding') return;
    const mine = b.turn === mySeat;
    const who = (seat) => (isMe(seat) ? 'du' : nameOf(seat));

    // Wer sagt, wer hört, wer hat gepasst
    const info = $('bid-info');
    info.replaceChildren();
    if (b.stage === 3) {
      info.append(`Niemand hat gereizt – ${who(b.speaker)} (Vorhand) darf 18 spielen oder einpassen.`);
    } else {
      const s = document.createElement('b');
      s.textContent = who(b.speaker);
      const l = document.createElement('b');
      l.textContent = who(b.listener);
      info.append(s, isMe(b.speaker) ? ' sagst · ' : ' sagt · ', l, isMe(b.listener) ? ' hörst' : ' hört');
      if (b.passed.length) info.append(` · ${b.passed.map(who).join(', ')} ${b.passed.length === 1 && !isMe(b.passed[0]) ? 'hat' : 'haben'} gepasst`);
    }

    // Großes Gebot
    const value = b.role === 'listener' ? b.value : b.value || null;
    $('bid-value').textContent = value ? String(value) : '–';
    $('bid-value').classList.toggle('empty', !value);
    if (b.role === 'listener') {
      $('bid-who').textContent = `${isMe(b.speaker) ? 'Du bietest' : `${nameOf(b.speaker)} bietet`}`;
      $('bid-question').textContent = mine ? 'Hältst du mit?' : `${nameOf(b.listener)} überlegt …`;
    } else if (b.role === 'forehand') {
      $('bid-who').textContent = 'Noch kein Gebot';
      $('bid-question').textContent = mine ? 'Spielst du für 18?' : `${nameOf(b.speaker)} überlegt …`;
    } else {
      $('bid-who').textContent = b.value ? 'Gehalten bei' : 'Noch kein Gebot';
      $('bid-question').textContent = mine ? `Weiter mit ${b.pendingValue}?` : `${nameOf(b.speaker)} überlegt …`;
    }

    // Leiste: vergangene grau, aktueller gold
    const current = b.role === 'listener' ? b.value : or(b.pendingValue, b.value);
    const i = Math.max(0, BID_VALUES.indexOf(current));
    const shown = BID_VALUES.slice(Math.max(0, i - 4), Math.max(0, i - 4) + 14);
    $('bid-ladder').replaceChildren(...shown.map((v) => {
      const li = document.createElement('li');
      li.textContent = v;
      if (v < current) li.className = 'past';
      else if (v === current) li.className = 'now';
      return li;
    }));

    $('bid-history').replaceChildren(...b.history.slice(-6).map((h) => {
      const li = document.createElement('li');
      li.textContent = `${who(h.seat)}: ${BID_WORDS[h.action](h.value)}`;
      return li;
    }));

    $('bid-actions').hidden = !mine;
    if (!mine) return;
    const go = $('btn-bid-go');
    go.disabled = false;
    if (b.role === 'listener') {
      go.textContent = `Ja – ${b.pendingValue}`;
      go.dataset.action = 'hold';
    } else if (b.role === 'forehand') {
      go.textContent = '18 spielen';
      go.dataset.action = 'bid';
    } else {
      go.textContent = `Sage ${b.pendingValue}`;
      go.dataset.action = 'bid';
      go.disabled = b.pendingValue === null;
    }
    $('btn-bid-pass').textContent = b.role === 'forehand' ? 'Einpassen' : 'Passe';
  }

  // ----- Ansage -----

  function renderDeclare(game, meDeclarer) {
    const visible = meDeclarer && ((game.phase === 'skat' && handMode) || game.phase === 'declaring');
    $('declare').hidden = !visible;
    if (!visible) return;
    const hand = game.phase === 'skat';
    $('declare-title').textContent = hand ? 'Handspiel – welches Spiel?' : 'Welches Spiel spielst du?';
    $('btn-declare-back').hidden = !hand;

    for (const btn of $('declare-types').querySelectorAll('button')) {
      const selected = choice && btn.dataset.type === choice.type && or(btn.dataset.trump, null) === or(choice.trump, null);
      btn.classList.toggle('selected', !!selected);
      btn.setAttribute('aria-pressed', String(!!selected));
    }
    const isNull = !!choice && choice.type === 'null';
    // Schneider/Schwarz ansagen nur im Handspiel (nicht Null); Ouvert: Null immer, sonst nur Hand
    $('opt-schneider-row').hidden = !hand || isNull || !choice;
    $('opt-schwarz-row').hidden = !hand || isNull || !choice;
    $('opt-ouvert-row').hidden = !choice || (!isNull && !hand);
    if ($('opt-ouvert').checked && !isNull) { $('opt-schneider').checked = true; $('opt-schwarz').checked = true; }
    if ($('opt-schwarz').checked) $('opt-schneider').checked = true;

    let hint = `Gereizt bis ${game.bid}.`;
    if (isNull) {
      const ouvert = $('opt-ouvert').checked;
      const value = ouvert ? (hand ? NULL_VALUES.ouvertHand : NULL_VALUES.ouvert) : (hand ? NULL_VALUES.hand : NULL_VALUES.plain);
      hint += ` Dieses Null ist ${value} wert${value < game.bid ? ' – zu niedrig!' : '.'}`;
    }
    $('declare-hint').textContent = hint;
    $('btn-declare').disabled = !choice;
  }

  function declareSpec() {
    const hidden = (id) => $(id).closest('label').hidden;
    return {
      ...choice,
      schneiderAnnounced: !hidden('opt-schneider') && $('opt-schneider').checked,
      schwarzAnnounced: !hidden('opt-schwarz') && $('opt-schwarz').checked,
      ouvert: !hidden('opt-ouvert') && $('opt-ouvert').checked,
    };
  }

  // ----- Hand: überlappend, nur neu zeichnen bei Änderung -----

  let handKey = null;

  function renderHand(game, myTurn, meDeclarer) {
    const hand = $('hand');
    const discarding = game.phase === 'discard' && meDeclarer;
    const cards = or(game.hand, []);
    hand.hidden = !game.hand || cards.length === 0; // nach dem letzten Stich keine leere Lücke
    const legal = new Set(game.legal);
    const width = hand.clientWidth || 358;
    const cardW = Math.min(76, Math.max(54, Math.round(width / 5.4)));
    const step = cards.length > 1 ? Math.min(cardW * 0.9, (width - cardW) / (cards.length - 1)) : 0;
    const offset = Math.max(0, (width - (cardW + step * (cards.length - 1))) / 2);

    const key = [width, myTurn, discarding, cards.join(','), [...legal].join(','), [...discardPick].join(',')].join('|');
    if (key === handKey) return;
    const firstDeal = handKey !== null && handKey.split('|')[3] === '' && cards.length > 0;
    handKey = key;

    hand.style.setProperty('--hand-w', `${cardW}px`);
    hand.replaceChildren(...cards.map((card, i) => {
      const el = cardElement(card, 'button');
      const playable = discarding || (myTurn && legal.has(card));
      el.type = 'button';
      el.dataset.card = card;
      el.disabled = !playable;
      el.style.left = `${offset + i * step}px`;
      el.style.zIndex = String(i + 1);
      el.classList.toggle('playable', playable && !discarding);
      el.classList.toggle('pickable', discarding);
      el.classList.toggle('selected', discardPick.has(card));
      el.classList.toggle('blocked', myTurn && !playable);
      return el;
    }));
    if (firstDeal) [...hand.children].forEach((el) => FX.fadeIn(el, 220));

    $('hand-hint').textContent = discarding
      ? `${discardPick.size} von 2 zum Drücken gewählt`
      : myTurn ? 'Spielbare Karten sind hervorgehoben – antippen zum Ausspielen' : '';
  }

  /**
   * Kartenvorderseite (CSS, keine Bilddatei): große Eck-Indizes oben links (Wert + Symbol untereinander),
   * B/D/K mit Buchstabe im Goldrahmen, Zahlen und Ass mit großem Symbol, kleines Symbol unten rechts.
   */
  function cardElement(card, tag = 'div') {
    const [suit, rank] = card.split('-');
    const el = document.createElement(tag);
    el.className = `card s-${suit}`;
    el.setAttribute('aria-label', `${SUIT_NAME[suit]} ${or(RANK_NAME[rank], rank)}`);
    const sym = SUIT_SYMBOL[suit];
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.setAttribute('aria-hidden', 'true');
    idx.append(Object.assign(document.createElement('b'), { textContent: rank }), Object.assign(document.createElement('i'), { textContent: sym }));
    const centre = document.createElement('span');
    centre.setAttribute('aria-hidden', 'true');
    if (['B', 'D', 'K'].includes(rank)) {
      centre.className = 'court';
      const frame = document.createElement('span');
      frame.append(Object.assign(document.createElement('b'), { textContent: rank }), Object.assign(document.createElement('i'), { textContent: sym }));
      centre.append(frame);
    } else {
      centre.className = 'pip';
      centre.textContent = sym;
    }
    const br = Object.assign(document.createElement('span'), { className: 'corner-br', textContent: sym });
    br.setAttribute('aria-hidden', 'true');
    el.append(idx, centre, br);
    return el;
  }

  /** Kartenrückseite: Rautenmuster, doppelter Goldrahmen, MKDIR-Logo mit „Design“ im Oval (plain = ohne Logo, für kleine Karten) */
  function backElement(plain = false) {
    const el = document.createElement('div');
    el.className = `card back${plain ? ' plain' : ''}`;
    el.setAttribute('aria-hidden', 'true');
    if (!plain) {
      const oval = document.createElement('span');
      oval.className = 'back-oval';
      const img = document.createElement('img');
      img.src = `${BASE}/static/img/logo-mkdir.webp?v=${APP_VERSION}`;
      img.alt = '';
      oval.append(img, Object.assign(document.createElement('span'), { textContent: 'Design' }));
      el.append(oval);
    }
    return el;
  }

  // ----- Misch-Show beim neuen Geben -----

  let lastDealKey = null;

  /** Neue Runde gegeben? (nicht beim ersten Laden oder Neuladen der Seite) */
  function isNewDeal() {
    const key = state.status === 'running' && state.game ? `${state.round}` : null;
    const fresh = key !== null && lastDealKey !== undefined && lastDealKey !== key && state.game.phase === 'bidding';
    const firstLoad = lastDealKey === null && key !== null && lastStatus === null;
    lastDealKey = key;
    return fresh && !firstLoad;
  }

  function playShuffle() {
    const game = state.game;
    const order = [game.forehand, game.middle, game.rear].map(posOf);
    FX.shuffle({
      targets: { me: rectOf('me'), left: rectOf('left'), right: rectOf('right') },
      order,
      cutter: isMe(game.middle) ? 'Du' : nameOf(game.middle), // abheben: rechts vom Geber
      seed: `${ROOM_ID}:${state.round}`,
      myCards: or(game.hand, []),
      makeBack: () => backElement(false),
      makeFront: (card) => cardElement(card),
    });
  }

  // ----- Ergebnis -----

  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

  function renderResult(game, seated) {
    const r = game.result;
    $('result').hidden = !r;
    if (!r) return;
    const me = isMe(game.declarer);
    const who = me ? 'Du' : nameOf(game.declarer);
    const verb = r.won ? (me ? 'gewinnst' : 'gewinnt') : (me ? 'verlierst' : 'verliert');
    $('result-title').textContent = `${who} ${verb} ${r.label}${r.gift ? ' – geschenkt' : ''}${r.won ? '!' : '.'}`;
    $('result').classList.toggle('won', r.won);
    $('result').classList.toggle('lost', !r.won);
    $('result-score').textContent = `${signed(r.score)} Punkte`;

    // Rechenweg: "mit 2 + Spiel + Hand = 4 × 10 = 40 · × Kontra 2 = 80"
    const factors = r.factors.map((f) => ` × ${f.label} ${f.factor}`).join('');
    const after = factors ? `${factors} = ${r.value}` : '';
    $('result-value').textContent = game.game.type === 'null'
      ? `${r.label} = ${r.baseResultValue}${after}${r.won ? '' : ' · verloren zählt doppelt'}`
      : `${r.levels.map((l) => l.label).join(' + ')} = ${r.multiplier} × ${r.base} = ${r.multiplier * r.base}`
        + (r.overbid || r.raisedToBid ? ` → gewertet mit ${r.baseResultValue}` : '') + after + (r.won ? '' : ' · verloren zählt doppelt');
    $('result-reason').textContent = r.won ? `Gereizt bis ${r.bid}.` : `Verloren: ${r.reason}. Gereizt bis ${r.bid}.`;
    $('result-points').textContent = r.gift
      ? 'Die Gegenspieler haben geschenkt – keine Karte gespielt.'
      : game.game.type === 'null'
      ? `${r.declarerTricks === 0 ? 'Kein Stich' : `${r.declarerTricks} Stich(e)`} für den Alleinspieler`
      : `Alleinspieler: ${r.declarerPoints} Augen\nGegenspieler: ${r.defenderPoints} Augen`
        + (r.schwarz ? ' · Schwarz!' : r.schneider ? ' · Schneider!' : '');
    $('result-skat').replaceChildren(...or(game.skat, []).map((c) => cardElement(c)));
    $('result-discarded-line').hidden = !game.skatTaken;
    $('result-discarded').replaceChildren(...or(game.discarded, []).map((c) => cardElement(c)));
    $('btn-next').hidden = !seated;
    $('result-wait').hidden = seated;
    // Spiel gewonnen: kurzes Gold-Funkeln (einmal pro Runde)
    if (r.won && sparkledRound !== state.round) {
      sparkledRound = state.round;
      requestAnimationFrame(() => FX.sparkle($('result'), { y: '22%' }));
    }
  }
  let sparkledRound = null;

  // ----- Punkteliste -----

  function renderScores() {
    const { rounds, totals } = state.scores;
    $('scores').hidden = rounds.length === 0;
    if (rounds.length === 0) return;
    const cell = (tag, text, cls) => {
      const el = document.createElement(tag);
      el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
    $('scores-head').replaceChildren(cell('th', '#'), cell('th', 'Spiel'), ...state.seats.map((_, i) => cell('th', nameOf(i))));
    $('scores-body').replaceChildren(...rounds.map((row) => {
      const tr = document.createElement('tr');
      const marks = [row.bock && 'Bock', row.kontraBy !== null && (row.re ? 'Re' : 'Kontra'), row.gift && 'geschenkt'].filter(Boolean);
      tr.append(cell('td', row.round), cell('td', [row.label, ...marks].join(' · '), 'label'));
      if (row.bock) tr.className = 'bock-row';
      for (let seat = 0; seat < 3; seat++) {
        const mine = row.declarer === seat;
        tr.append(cell('td', mine ? signed(row.score) : '', mine ? (row.won ? 'plus' : 'minus') : ''));
      }
      return tr;
    }));
    $('scores-total').replaceChildren(cell('td', ''), cell('td', 'Summe'), ...totals.map((t) => cell('td', signed(t))));
    $('scores-sf').replaceChildren(cell('td', ''), cell('td', 'Seeger-Fabian'), ...state.scores.seegerFabian.map((t) => cell('td', signed(t))));
  }

  // ----- Abendwertung -----

  function duration(ms) {
    const min = Math.round(ms / 60000);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
  }

  function renderSummary(seated) {
    const s = state.summary;
    $('summary-meta').textContent =
      `${s.games} ${s.games === 1 ? 'Spiel' : 'Spiele'}, davon ${s.passed} eingepasst`
      + (state.houseRules.bock ? ` und ${s.bockGames} Bock` : '') + ` · Dauer ${duration(s.durationMs)}`;
    const ranked = [...s.players].sort((a, b) => a.place - b.place || a.seat - b.seat);
    renderPodium(ranked);
    $('summary-players').replaceChildren(...ranked.map((p) => {
      const li = document.createElement('li');
      li.className = `sp place-${p.place}`;
      const head = document.createElement('div');
      head.className = 'sp-head';
      const place = document.createElement('span');
      place.className = 'sp-place';
      place.textContent = `${p.place}.`;
      const name = document.createElement('span');
      name.className = 'sp-name';
      name.textContent = p.name;
      const pts = document.createElement('span');
      pts.className = 'sp-points';
      pts.textContent = signed(p.points);
      head.append(place, name, pts);
      const details = document.createElement('p');
      details.className = 'sp-details';
      details.textContent = [
        `Seeger-Fabian ${signed(p.seegerFabian)}`,
        `${p.declarerGames}× Alleinspieler (${p.won} gewonnen, ${p.lost} verloren)`,
        p.best ? `Bestes Spiel: ${p.best.label} (${p.best.value})` : 'Noch kein Spiel gewonnen',
        ...(state.houseRules.kontra
          ? [`Kontra ${p.kontra.said}× (${p.kontra.won} gewonnen)`, `Re ${p.re.said}× (${p.re.won} gewonnen)`, `${p.bockGames} Bock-Spiele`]
          : []),
      ].join(' · ');
      li.append(head, details);
      return li;
    }));
    $('btn-new-evening').hidden = !seated;
    $('btn-to-lobby').hidden = !seated;
  }

  let podiumKey = null;
  /** Siegertreppchen: Platz 2 – 1 – 3 nebeneinander, wächst beim ersten Anzeigen herauf */
  function renderPodium(ranked) {
    const key = ranked.map((p) => `${p.seat}:${p.points}`).join(',');
    if (key === podiumKey) return;
    podiumKey = key;
    const steps = [ranked[1], ranked[0], ranked[2]].filter(Boolean).map((p) => {
      const step = document.createElement('div');
      step.className = `podium-step place-${p.place}`;
      const who = Object.assign(document.createElement('span'), { className: 'who', textContent: p.name });
      const pts = Object.assign(document.createElement('span'), { className: 'pts', textContent: signed(p.points) });
      const block = Object.assign(document.createElement('div'), { className: 'podium-block', textContent: String(p.place) });
      step.append(who, pts, block);
      return step;
    });
    $('podium').replaceChildren(...steps);
    FX.podiumRise(steps);
    if (ranked[0]) FX.sparkle($('podium'), { y: '20%' });
  }

  // ----- Abstimmung (Abbrechen / Abend beenden) -----

  const VOTE_TEXT = { abort: 'das Spiel abbrechen', end: 'den Abend beenden' };
  let voteDeadline = 0;
  let prevVote = null;
  let voteTicker = null;

  function renderVote(seated) {
    const vote = state.vote;
    if (prevVote && !vote && state.status === 'running') {
      toast(state.voteRejectedBy !== null ? `${nameOf(state.voteRejectedBy)} hat abgelehnt.` : 'Abstimmung abgelaufen.');
    }
    prevVote = vote;
    $('abort-banner').hidden = !vote;
    clearInterval(voteTicker);
    if (!vote) return;
    voteDeadline = Date.now() + vote.remainingMs;
    $('abort-buttons').hidden = !(seated && !vote.yes.includes(state.you.seat));
    const update = () => {
      const secs = Math.max(0, Math.ceil((voteDeadline - Date.now()) / 1000));
      const waiting = vote.waitingFor.map(nameOf).join(', ');
      $('abort-text').textContent = `${nameOf(vote.by)} möchte ${VOTE_TEXT[vote.kind]}. Noch ${secs} s. Warte auf: ${waiting}.`;
    };
    update();
    voteTicker = setInterval(update, 1000);
  }

  // ----- Hausregeln -----

  function renderHouseRuleSwitches(editable) {
    const rules = state.houseRules;
    for (const input of document.querySelectorAll('.house-rules input[data-rule]')) {
      input.checked = rules[input.dataset.rule];
      input.disabled = !editable || (input.dataset.rule === 'bock' && !rules.kontra);
    }
  }

  function renderHouseRulesInGame(game, mySeat, meDeclarer) {
    // Bock-Anzeige für alle
    $('bock-line').hidden = state.bockRemaining === 0;
    $('bock-line').textContent = `Bock: noch ${state.bockRemaining} ${state.bockRemaining === 1 ? 'Spiel' : 'Spiele'}`
      + (game.bock ? ' · diese Runde zählt doppelt' : '');

    // Kontra / Re – nur, wenn der Server es gerade erlaubt
    $('btn-kontra').hidden = !game.canKontra;
    $('btn-re').hidden = !game.canRe;
    $('kontra-row').hidden = !game.canKontra && !game.canRe;

    // Schenken
    const gift = game.gift;
    const show = game.phase === 'gift' && mySeat !== null;
    $('gift').hidden = !show;
    if (!show) return;
    const defender = !meDeclarer;
    const answered = gift.offers[mySeat] !== null;
    $('gift-offer').hidden = !(defender && !answered && !gift.awaitingDeclarer);
    $('gift-answer').hidden = !(meDeclarer && gift.awaitingDeclarer);
    if (meDeclarer && gift.awaitingDeclarer) {
      $('gift-title').textContent = 'Beide schenken dir das Spiel';
      $('gift-info').textContent = 'Annehmen: sofort gewonnen mit dem einfachen Spielwert. Ablehnen: normal spielen – dann ist Schneider Pflicht.';
    } else if (defender) {
      $('gift-title').textContent = 'Schenken?';
      $('gift-info').textContent = answered
        ? 'Du schenkst. Warte auf den anderen Gegenspieler …'
        : `Nur wenn beide schenken, wird ${nameOf(game.declarer)} gefragt.`;
    } else {
      $('gift-title').textContent = 'Schenken?';
      $('gift-info').textContent = 'Die Gegenspieler entscheiden, ob sie dir das Spiel schenken.';
    }
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
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.className = 'seat-body';
    const label = document.createElement('span');
    label.className = 'seat-no';
    label.textContent = `Platz ${index + 1}`;

    if (!person) {
      li.classList.add('free');
      avatar.textContent = '+';
      const free = document.createElement('span');
      free.className = 'seat-name muted';
      free.textContent = `Platz ${index + 1} ist frei`;
      label.textContent = 'Warten auf Spieler …';
      body.append(free, label);
      li.append(avatar, body);
      if (canTake) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-small btn-gold-outline';
        btn.textContent = 'Platz nehmen';
        btn.dataset.seat = String(index);
        li.append(btn);
      }
      return li;
    }

    const initial = Array.from(person.name)[0];
    avatar.textContent = initial ? initial.toUpperCase() : '?';
    body.append(...personParts(person, person.id === you.id), label);
    li.append(avatar, body);
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
    if (isMe) name.append(' ', badge('du', 'badge-me'));
    if (!person.connected) name.append(' ', badge('getrennt', 'badge-off'));
    return [name];
  }

  function badge(text, cls) {
    const b = document.createElement('span');
    b.className = `badge ${cls}`;
    b.textContent = text;
    return b;
  }

  // ---------- Aktionen ----------

  // Ton (standardmäßig aus)
  const soundBtn = $('btn-sound');
  const syncSound = () => soundBtn.setAttribute('aria-pressed', String(FX.sound.on));
  syncSound();
  soundBtn.addEventListener('click', () => {
    FX.sound.on = !FX.sound.on;
    syncSound();
    FX.sound.rustle(0.2, 0.06);
    toast(FX.sound.on ? 'Ton an – leises Karten-Rascheln' : 'Ton aus');
  });

  // Hand passt sich an Breite an (Drehen des Handys)
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { handKey = null; if (state) render(); }, 150);
  });

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
  $('btn-leave-seat').addEventListener('click', () => act('seat:leave'));

  // Hausregeln
  document.querySelector('.house-rules').addEventListener('change', () => {
    const rules = {};
    for (const input of document.querySelectorAll('.house-rules input[data-rule]')) rules[input.dataset.rule] = input.checked;
    act('rules:set', rules);
  });
  $('btn-kontra').addEventListener('click', () => act('game:kontra'));
  $('btn-re').addEventListener('click', () => act('game:re'));
  $('btn-gift-yes').addEventListener('click', () => act('game:gift', { yes: true }));
  $('btn-gift-no').addEventListener('click', () => act('game:gift', { yes: false }));
  $('btn-gift-accept').addEventListener('click', () => act('game:gift-answer', { accept: true }));
  $('btn-gift-refuse').addEventListener('click', () => {
    if (confirm('Geschenk ablehnen? Dann musst du Schneider machen (mindestens 90 Augen).')) act('game:gift-answer', { accept: false });
  });

  // Reizen
  $('btn-bid-go').addEventListener('click', (e) => act('game:bid', { action: e.currentTarget.dataset.action }));
  $('btn-bid-pass').addEventListener('click', () => act('game:bid', { action: 'pass' }));

  // Skat oder Hand
  $('btn-skat').addEventListener('click', () => act('game:skat'));
  $('btn-hand').addEventListener('click', () => { handMode = true; render(); });
  $('btn-declare-back').addEventListener('click', () => { handMode = false; choice = null; render(); });

  // Drücken
  $('btn-discard').addEventListener('click', () => act('game:discard', { cards: [...discardPick] }));

  // Ansage: erst Spiel wählen, Optionen setzen, dann "Ansagen"
  $('declare-types').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-type]');
    if (!btn) return;
    choice = { type: btn.dataset.type, ...(btn.dataset.trump ? { trump: btn.dataset.trump } : {}) };
    render();
  });
  for (const id of ['opt-schneider', 'opt-schwarz', 'opt-ouvert']) $(id).addEventListener('change', render);
  $('btn-declare').addEventListener('click', async () => {
    const res = await act('game:declare', declareSpec());
    if (res.ok) for (const id of ['opt-schneider', 'opt-schwarz', 'opt-ouvert']) $(id).checked = false;
  });

  // Hand: beim Drücken Karten auswählen, sonst spielen.
  // Doppeltippen verhindern: bis zur Antwort des Servers keine zweite Karte schicken.
  let playing = false;
  $('hand').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-card]');
    if (!btn || btn.disabled || playing) return;
    const card = btn.dataset.card;
    if (state.game.phase === 'discard') {
      if (discardPick.has(card)) discardPick.delete(card);
      else if (discardPick.size < 2) discardPick.add(card);
      render();
      return;
    }
    playing = true;
    await act('game:play', { card });
    playing = false;
  });

  $('btn-next').addEventListener('click', () => act('game:next'));
  $('btn-redeal').addEventListener('click', () => act('game:next'));

  // Abbrechen nur gemeinsam
  $('btn-abort').addEventListener('click', () => {
    if (confirm('Abbruch vorschlagen? Alle drei müssen innerhalb von 60 Sekunden zustimmen.')) act('vote:request', { kind: 'abort' });
  });
  $('btn-end').addEventListener('click', () => {
    if (confirm('Abend beenden und Wertung zeigen? Alle drei müssen zustimmen.')) act('vote:request', { kind: 'end' });
  });
  $('btn-abort-yes').addEventListener('click', () => act('vote:cast', { agree: true }));
  $('btn-abort-no').addEventListener('click', () => act('vote:cast', { agree: false }));
  $('btn-new-evening').addEventListener('click', () => act('evening:new'));
  $('btn-to-lobby').addEventListener('click', () => act('evening:lobby'));

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
