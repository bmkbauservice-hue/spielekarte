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
    $('game').hidden = lobby || !state.game;
    if (!lobby && state.game) renderGame(state.game, seated);
    $('summary').hidden = status !== 'summary';
    if (status === 'summary') renderSummary(seated);
    // Beim Wechsel in die Abendwertung nach oben scrollen, damit man sie sofort sieht
    if (status === 'summary' && lastStatus !== 'summary') window.scrollTo({ top: 0, behavior: 'smooth' });
    lastStatus = status;
    renderScores();
    renderVote(seated);
  }

  // ---------- Spiel-Anzeige ----------

  const SUIT_SYMBOL = { kreuz: '♣', pik: '♠', herz: '♥', karo: '♦' };
  const SUIT_NAME = { kreuz: 'Kreuz', pik: 'Pik', herz: 'Herz', karo: 'Karo' };
  const RANK_NAME = { B: 'Bube', D: 'Dame', K: 'König', A: 'Ass' };
  const NULL_VALUES = { plain: 23, hand: 35, ouvert: 46, ouvertHand: 59 }; // nur für den Hinweis beim Ansagen
  const nameOf = (seat) => state.seats[seat]?.name ?? `Platz ${seat + 1}`;
  const isMe = (seat) => seat === state.you.seat;

  // Zustand nur im Browser (bis der Server ihn bestätigt)
  let handMode = false;            // Alleinspieler hat "Hand spielen" gewählt
  let choice = null;               // gewähltes Spiel in der Ansage: { type, trump }
  const discardPick = new Set();   // zum Drücken angetippte Karten

  function renderGame(game, seated) {
    const mySeat = state.you.seat;
    const meDeclarer = game.declarer !== null && isMe(game.declarer);
    const myTurn = game.phase === 'playing' && game.turn === mySeat;
    if (game.phase !== 'skat') handMode = false;
    if (game.phase !== 'skat' && game.phase !== 'declaring') choice = null;
    if (game.phase !== 'discard') discardPick.clear();

    $('game-info').textContent = infoLine(game);
    $('game-players').replaceChildren(...state.seats.map((_, seat) => playerRow(game, seat, mySeat)));

    // Tisch: aktueller Stich – oder, wenn der gerade voll wurde, der letzte Stich
    const inPlay = game.phase === 'playing' || game.phase === 'finished';
    const showLast = game.trick.length === 0 && game.lastTrick !== null;
    const cards = showLast ? game.lastTrick.cards : game.trick;
    $('table').hidden = !inPlay;
    $('table').classList.toggle('bock', game.bock);
    $('trick-label').textContent = showLast ? `Letzter Stich – ${nameOf(game.lastTrick.winner)} sticht` : 'Aktueller Stich';
    $('trick').classList.toggle('last', showLast);
    $('trick').replaceChildren(...cards.map(({ seat, card }) => trickSlot(seat, card, showLast && seat === game.lastTrick.winner)));

    // Ouvert: offene Karten des Alleinspielers für die anderen
    $('open-hand').hidden = !game.openHand || meDeclarer;
    if (game.openHand && !meDeclarer) {
      $('open-hand-title').textContent = `Offene Karten von ${nameOf(game.declarer)}`;
      $('open-hand-cards').replaceChildren(...game.openHand.map((c) => cardElement(c)));
    }

    const status = $('game-status');
    status.textContent = statusText(game, mySeat);
    status.classList.toggle('my-turn', game.turn === mySeat && game.turn !== null);

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

  function infoLine(game) {
    const parts = [`Runde ${state.round}`];
    if (game.phase === 'bidding') parts.push('Reizen');
    else if (game.phase === 'passed') parts.push('eingepasst');
    else {
      parts.push(game.label || 'Ansage folgt');
      parts.push(`${nameOf(game.declarer)} spielt (${game.bid})`);
    }
    if (game.game?.type === 'null') parts.push('kein Trumpf');
    else if (game.game?.type === 'grand') parts.push('nur Buben Trumpf');
    else if (game.game?.type === 'suit') parts.push(`${SUIT_SYMBOL[game.game.trump]} ist Trumpf`);
    return parts.join(' · ');
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
      case 'playing':
        if (!mine) return `${nameOf(game.turn)} ist dran …`;
        return game.trick.length === 0 ? 'Du bist dran – spiel aus!' : 'Du bist dran!';
      default: return '';
    }
  }

  function playerRow(game, seat, mySeat) {
    const li = document.createElement('li');
    li.className = 'gp';
    if (seat === game.turn) li.classList.add('turn');
    if (seat === mySeat) li.classList.add('me');
    const person = state.seats[seat];

    const name = document.createElement('span');
    name.className = 'gp-name';
    name.textContent = nameOf(seat);
    const meta = document.createElement('span');
    meta.className = 'gp-meta';
    const tricks = game.tricksWon[seat];
    meta.textContent = game.phase === 'playing' || game.phase === 'finished'
      ? `${game.handCounts[seat]} Karten · ${tricks} ${tricks === 1 ? 'Stich' : 'Stiche'}`
      : `${game.handCounts[seat]} Karten`;

    const position = seat === game.forehand ? 'Vorhand' : seat === game.middle ? 'Mittelhand' : 'Hinterhand · Geber';
    li.append(name);
    if (seat === mySeat) li.append(badge('du', 'badge-me'));
    if (seat === game.declarer) li.append(badge('Alleinspieler', 'badge-solo'));
    else li.append(badge(position, 'badge-dealer'));
    if (seat === game.kontraBy) li.append(badge('Kontra', 'badge-kontra'));
    if (seat === game.declarer && game.re) li.append(badge('Re', 'badge-kontra'));
    if (game.phase === 'bidding' && game.bidding.passed.includes(seat)) li.append(badge('passe', 'badge-off'));
    if (person && !person.connected) li.append(badge('getrennt', 'badge-off'));
    li.append(meta);
    return li;
  }

  // ----- Reizen -----

  const BID_WORDS = { bid: (v) => `${v}`, hold: () => 'Ja', pass: () => 'passe' };

  function renderBidding(game, mySeat) {
    const b = game.bidding;
    $('bidding').hidden = game.phase !== 'bidding';
    if (game.phase !== 'bidding') return;

    $('bid-info').textContent = b.stage === 3
      ? `Niemand hat gereizt. ${nameOf(b.speaker)} (Vorhand) darf 18 spielen oder einpassen.`
      : `${nameOf(b.speaker)} sagt, ${nameOf(b.listener)} hört · Stand: ${b.value || '–'}`;
    $('bid-history').replaceChildren(...b.history.slice(-6).map((h) => {
      const li = document.createElement('li');
      li.textContent = `${nameOf(h.seat)}: ${BID_WORDS[h.action](h.value)}`;
      return li;
    }));

    const mine = b.turn === mySeat;
    $('bid-actions').hidden = !mine;
    if (!mine) return;
    const go = $('btn-bid-go');
    go.disabled = false;
    if (b.role === 'listener') {
      go.textContent = `Ja (${b.pendingValue})`;
      go.dataset.action = 'hold';
    } else if (b.role === 'forehand') {
      go.textContent = '18 spielen';
      go.dataset.action = 'bid';
    } else {
      go.textContent = b.value === 0 ? `${b.pendingValue} sagen` : `Weiter: ${b.pendingValue}`;
      go.dataset.action = 'bid';
      go.disabled = b.pendingValue === null;
    }
    $('btn-bid-pass').textContent = b.role === 'forehand' ? 'Passe (einpassen)' : 'Passe';
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
      const selected = choice && btn.dataset.type === choice.type && (btn.dataset.trump ?? null) === (choice.trump ?? null);
      btn.classList.toggle('selected', !!selected);
    }
    const isNull = choice?.type === 'null';
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

  // ----- Hand -----

  function renderHand(game, myTurn, meDeclarer) {
    const discarding = game.phase === 'discard' && meDeclarer;
    const legal = new Set(game.legal);
    $('hand').hidden = !game.hand;
    $('hand').replaceChildren(...(game.hand ?? []).map((card) => {
      const el = cardElement(card, 'button');
      const playable = discarding || (myTurn && legal.has(card));
      el.dataset.card = card;
      el.disabled = !playable;
      el.classList.toggle('playable', playable && !discarding);
      el.classList.toggle('pickable', discarding);
      el.classList.toggle('selected', discardPick.has(card));
      el.classList.toggle('blocked', myTurn && !playable);
      return el;
    }));
  }

  function trickSlot(seat, card, winner) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    if (winner) slot.classList.add('winner');
    const label = document.createElement('span');
    label.className = 'slot-name';
    label.textContent = nameOf(seat);
    slot.append(cardElement(card), label);
    return slot;
  }

  /** Karte als einfacher Platzhalter: große Eck-Indizes (B, D, K, A, 10 …) + Farbsymbol. */
  function cardElement(card, tag = 'div') {
    const [suit, rank] = card.split('-');
    const el = document.createElement(tag);
    el.className = `card s-${suit}`;
    el.setAttribute('aria-label', `${SUIT_NAME[suit]} ${RANK_NAME[rank] ?? rank}`);
    const corner = (pos) => {
      const idx = document.createElement('span');
      idx.className = `idx idx-${pos}`;
      const r = document.createElement('b');
      r.textContent = rank;
      const s = document.createElement('i');
      s.textContent = SUIT_SYMBOL[suit];
      idx.append(r, s);
      return idx;
    };
    const pip = document.createElement('span');
    pip.className = 'pip';
    pip.textContent = SUIT_SYMBOL[suit];
    el.append(corner('tl'), pip, corner('br'));
    return el;
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
    $('result-skat').replaceChildren(...(game.skat ?? []).map((c) => cardElement(c)));
    $('result-discarded-line').hidden = !game.skatTaken;
    $('result-discarded').replaceChildren(...(game.discarded ?? []).map((c) => cardElement(c)));
    $('btn-next').hidden = !seated;
    $('result-wait').hidden = seated;
  }

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
    const min = Math.round(ms / 60_000);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
  }

  function renderSummary(seated) {
    const s = state.summary;
    $('summary-meta').textContent =
      `${s.games} ${s.games === 1 ? 'Spiel' : 'Spiele'}, davon ${s.passed} eingepasst`
      + (state.houseRules.bock ? ` und ${s.bockGames} Bock` : '') + ` · Dauer ${duration(s.durationMs)}`;
    const ranked = [...s.players].sort((a, b) => a.place - b.place || a.seat - b.seat);
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
