import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Room, RoomError, normalizeRoomId, cleanName, MAX_SPECTATORS } from '../src/rooms/room.js';
import { RoomRegistry } from '../src/rooms/registry.js';
import { SkatGame, GameError } from '../src/game/game.js';
import { createDeck } from '../src/game/cards.js';

/** Steuerbare Uhr für Tests */
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

/** Raum mit n verbundenen Spielern */
function roomWith(n, options) {
  const room = new Room('TEST01', options);
  const players = [];
  for (let i = 0; i < n; i++) {
    const { player } = room.join({ name: `Spieler ${i + 1}` });
    room.connect(player.token);
    players.push(player);
  }
  return { room, players };
}

const throwsCode = (fn, code) =>
  assert.throws(fn, (err) => err instanceof RoomError && err.code === code);

describe('normalizeRoomId', () => {
  test('wandelt in Großbuchstaben um', () => assert.equal(normalizeRoomId(' muju01 '), 'MUJU01'));
  test('lehnt Sonderzeichen, zu kurz und zu lang ab', () => {
    for (const bad of ['ab', 'mu/ju', '../x', 'a'.repeat(17), '', null, 42]) {
      assert.equal(normalizeRoomId(bad), null, String(bad));
    }
  });
});

describe('cleanName', () => {
  test('kürzt Leerraum', () => assert.equal(cleanName('  Max   Mustermann '), 'Max Mustermann'));
  test('entfernt Steuerzeichen', () => assert.equal(cleanName('Ma\u0000x​'), 'Max'));
  test('begrenzt auf 20 Zeichen', () => assert.equal(cleanName('x'.repeat(50)).length, 20));
  test('zählt Emoji als ein Zeichen', () => assert.equal(Array.from(cleanName('🂡'.repeat(25))).length, 20));
  test('leer oder kein Text → null', () => {
    for (const bad of ['', '   ', '\u0000', undefined, 5, {}]) assert.equal(cleanName(bad), null);
  });
});

describe('Room – Plätze', () => {
  test('die ersten 3 bekommen Platz 0, 1, 2; der 4. wird Zuschauer', () => {
    const { room, players } = roomWith(4);
    assert.deepEqual(players.map((p) => p.seat), [0, 1, 2, null]);
    assert.equal(room.spectators().length, 1);
  });

  test('ohne gültigen Namen kein Beitritt', () => {
    const room = new Room('TEST01');
    throwsCode(() => room.join({ name: '   ' }), 'NAME_UNGUELTIG');
  });

  test('gleiches Token = gleicher Spieler, gleicher Platz (Neuladen)', () => {
    const { room, players } = roomWith(2);
    room.disconnect(players[1].token);
    const { player, resumed } = room.join({ token: players[1].token });
    assert.equal(resumed, true);
    assert.equal(player.seat, 1);
    assert.equal(player.id, players[1].id);
    assert.equal(room.players.size, 2);
  });

  test('unbekanntes Token ohne Namen → TOKEN_UNBEKANNT', () => {
    const room = new Room('TEST01');
    throwsCode(() => room.join({ token: 'gibt-es-nicht' }), 'TOKEN_UNBEKANNT');
  });

  test('unbekanntes Token mit Namen → neuer Spieler mit NEUEM Token', () => {
    const room = new Room('TEST01');
    const { player } = room.join({ token: 'selbst-ausgedacht', name: 'Eve' });
    assert.notEqual(player.token, 'selbst-ausgedacht');
  });

  test('Platz freigeben und wieder nehmen', () => {
    const { room, players } = roomWith(4);
    const [, second, , watcher] = players;
    room.leaveSeat(second.token);
    assert.equal(second.seat, null);
    room.takeSeat(watcher.token, 1);
    assert.equal(watcher.seat, 1);
    throwsCode(() => room.takeSeat(second.token, 1), 'PLATZ_BELEGT');
    throwsCode(() => room.takeSeat(second.token, 7), 'PLATZ_UNGUELTIG');
    throwsCode(() => room.takeSeat(watcher.token, 0), 'SITZT_SCHON');
  });

  test('ohne Platznummer wird der erste freie genommen', () => {
    const { room, players } = roomWith(4);
    room.leaveSeat(players[0].token);
    room.takeSeat(players[3].token);
    assert.equal(players[3].seat, 0);
  });

  test('Zuschauer-Limit', () => {
    const room = new Room('TEST01');
    for (let i = 0; i < 3 + MAX_SPECTATORS; i++) room.join({ name: `P${i}` });
    throwsCode(() => room.join({ name: 'Zuviel' }), 'RAUM_VOLL');
  });

  test('Raum verlassen gibt Platz frei', () => {
    const { room, players } = roomWith(3);
    room.leave(players[0].token);
    assert.equal(room.seats[0], null);
    assert.equal(room.players.has(players[0].token), false);
  });
});

describe('Room – Spielstart', () => {
  test('mit 2 Spielern nicht startbar', () => {
    const { room, players } = roomWith(2);
    assert.equal(room.isReady(), false);
    throwsCode(() => room.start(players[0].token), 'NICHT_BEREIT');
  });

  test('nicht startbar, wenn ein Spieler getrennt ist', () => {
    const { room, players } = roomWith(3);
    room.disconnect(players[2].token);
    assert.equal(room.stateFor(players[0].token).canStart, false);
    throwsCode(() => room.start(players[0].token), 'NICHT_BEREIT');
  });

  test('Zuschauer darf nicht starten', () => {
    const { room, players } = roomWith(4);
    assert.equal(room.stateFor(players[3].token).canStart, false);
    throwsCode(() => room.start(players[3].token), 'NUR_SPIELER');
  });

  test('mit 3 verbundenen Spielern startbar; danach sind Plätze gesperrt', () => {
    const { room, players } = roomWith(4);
    assert.equal(room.stateFor(players[0].token).canStart, true);
    room.start(players[0].token);
    assert.equal(room.status, 'running');
    throwsCode(() => room.leaveSeat(players[0].token), 'SPIEL_LAEUFT');
    throwsCode(() => room.leave(players[1].token), 'SPIEL_LAEUFT');
    throwsCode(() => room.start(players[0].token), 'SPIEL_LAEUFT');
    // Neuer Gast während des Spiels wird Zuschauer
    const { player } = room.join({ name: 'Spät' });
    assert.equal(player.seat, null);
  });
});

describe('Room – Sichtbarkeit (server-authoritative)', () => {
  test('stateFor enthält keine Tokens', () => {
    const { room, players } = roomWith(4);
    const json = JSON.stringify(room.stateFor(players[0].token));
    for (const p of players) assert.equal(json.includes(p.token), false);
  });

  test('stateFor zeigt den eigenen Platz', () => {
    const { room, players } = roomWith(4);
    assert.equal(room.stateFor(players[2].token).you.seat, 2);
    assert.equal(room.stateFor(players[3].token).you.seat, null);
    assert.equal(room.stateFor('fremd').you, null);
    assert.deepEqual(room.stateFor(players[0].token).seats.map((s) => s.name), ['Spieler 1', 'Spieler 2', 'Spieler 3']);
  });
});

describe('Aufräumen', () => {
  test('in der Lobby: lange getrennte Spieler verlieren ihren Platz', () => {
    const now = fakeClock();
    const { room, players } = roomWith(3, { now });
    room.disconnect(players[0].token);
    now.advance(5_000);
    assert.equal(room.removeStale(10_000), 0, 'noch innerhalb der Frist');
    now.advance(10_000);
    assert.equal(room.removeStale(10_000), 1);
    assert.equal(room.seats[0], null);
  });

  test('im laufenden Spiel bleiben Tisch-Spieler, Zuschauer werden entfernt', () => {
    const now = fakeClock();
    const { room, players } = roomWith(4, { now });
    room.start(players[0].token);
    room.disconnect(players[0].token);
    room.disconnect(players[3].token);
    now.advance(60_000);
    assert.equal(room.removeStale(10_000), 1);
    assert.equal(room.seats[0], players[0].token);
    assert.equal(room.players.has(players[3].token), false);
  });

  test('Registry: gleiche ID = gleicher Raum, leere Räume werden gelöscht', () => {
    const now = fakeClock();
    const reg = new RoomRegistry({ now, playerIdleMs: 1_000 });
    const room = reg.getOrCreate('ABC');
    assert.equal(reg.getOrCreate('ABC'), room);
    const { player } = room.join({ name: 'Anna' });
    room.connect(player.token);
    reg.sweep();
    assert.equal(reg.get('ABC'), room, 'verbundener Spieler hält den Raum offen');
    room.disconnect(player.token);
    now.advance(2_000);
    reg.sweep();
    assert.equal(reg.get('ABC'), undefined);
  });

  test('Registry: Höchstzahl an Räumen', () => {
    const reg = new RoomRegistry({ maxRooms: 2 });
    reg.getOrCreate('AAA');
    reg.getOrCreate('BBB');
    assert.throws(() => reg.getOrCreate('CCC'), (e) => e.code === 'SERVER_VOLL');
  });
});

describe('Room – Skat-Runde', () => {
  // Unsortiertes Standardblatt: Platz 1 (Vorhand bei Geber 3) bekommt die ersten 10 Karten
  const fixed = { createGame: (opts) => new SkatGame({ ...opts, deck: createDeck() }) };
  const gameThrows = (fn, code) => assert.throws(fn, (e) => e instanceof GameError && e.code === code);

  /** Runde 1: Mittelhand (Platz 2) und Hinterhand (Platz 3) passen, Vorhand (Platz 1) spielt 18 */
  function forehandAt18(room, tokens) {
    room.bid(tokens[1], 'pass');
    room.bid(tokens[2], 'pass');
    room.bid(tokens[0], 'bid');
  }

  /** Runde zu Ende spielen – jeweils mit der ersten erlaubten Karte */
  function playOut(room, tokens) {
    while (room.game.phase === 'playing') {
      const seat = room.game.turn;
      room.playCard(tokens[seat], room.stateFor(tokens[seat]).game.legal[0]);
    }
  }

  test('Start gibt Karten; erste Runde: Platz 3 gibt, Mittelhand (Platz 2) reizt zuerst', () => {
    const { room, players } = roomWith(3, fixed);
    room.start(players[0].token);
    const view = room.stateFor(players[0].token);
    assert.equal(view.round, 1);
    assert.equal(view.game.phase, 'bidding');
    assert.equal(view.game.dealer, 2);
    assert.equal(view.game.turn, 1);
    assert.equal(view.game.hand.length, 10);
    assert.deepEqual(view.scores, { rounds: [], totals: [0, 0, 0], seegerFabian: [0, 0, 0] });
  });

  test('jeder Spieler sieht nur seine eigenen Karten, Zuschauer keine', () => {
    const { room, players } = roomWith(4);
    room.start(players[0].token);
    const hands = room.game.hands;
    for (const seat of [0, 1, 2]) {
      const json = JSON.stringify(room.stateFor(players[seat].token));
      const foreign = [...hands.filter((_, i) => i !== seat).flat(), ...room.game.skat];
      for (const card of foreign) assert.equal(json.includes(`"${card}"`), false, `Platz ${seat} sieht ${card}`);
    }
    const spectator = room.stateFor(players[3].token);
    assert.equal(spectator.game.hand, null);
    for (const card of createDeck()) assert.equal(JSON.stringify(spectator).includes(`"${card}"`), false);
  });

  test('Reizen, Skat, Drücken, Ansage, Spielen – mit Berechtigungen', () => {
    const { room, players } = roomWith(4, fixed);
    const tokens = players.map((p) => p.token);
    const [a, b, , watcher] = tokens;
    throwsCode(() => room.bid(a, 'pass'), 'KEIN_SPIEL');
    room.start(a);

    throwsCode(() => room.bid(watcher, 'pass'), 'NUR_SPIELER');
    gameThrows(() => room.bid(a, 'pass'), 'NICHT_DRAN');
    forehandAt18(room, tokens);
    gameThrows(() => room.pickUpSkat(b), 'NICHT_ALLEINSPIELER');
    room.pickUpSkat(a);
    const hand = room.stateFor(a).game.hand;
    assert.equal(hand.length, 12);
    room.discard(a, hand.slice(-2));
    room.declare(a, { type: 'grand' });
    throwsCode(() => room.nextRound(a), 'RUNDE_LAEUFT');
    playOut(room, tokens);

    const result = room.stateFor(watcher).game.result;
    assert.equal(result.declarerPoints + result.defenderPoints, 120);
    assert.equal(room.scores.length, 1);
    assert.equal(room.scores[0].score, result.score);
  });

  test('Punkteliste: +Spielwert / −2× Spielwert, eingepasst = 0, genau ein Eintrag pro Runde', () => {
    const { room, players } = roomWith(3);
    const tokens = players.map((p) => p.token);
    room.start(tokens[0]);

    // Runde 1: Vorhand spielt Grand Hand
    forehandAt18(room, tokens);
    room.declare(tokens[0], { type: 'grand' });
    playOut(room, tokens);
    const r1 = room.game.result;
    room.stateFor(tokens[0]); // mehrfaches Lesen trägt nichts doppelt ein
    assert.equal(room.scores.length, 1);
    assert.equal(r1.score, r1.won ? r1.value : -2 * r1.value);

    // Runde 2: eingepasst (Geber 0 → Vorhand 1, Mittelhand 2, Hinterhand 0)
    room.nextRound(tokens[1]);
    room.bid(tokens[2], 'pass');
    room.bid(tokens[0], 'pass');
    room.bid(tokens[1], 'pass');
    assert.equal(room.game.phase, 'passed');
    assert.deepEqual(room.scores[1], { round: 2, declarer: null, label: 'eingepasst', bid: null, value: 0, score: 0, won: null });

    // Summen
    const totals = room.stateFor(tokens[2]).scores.totals;
    assert.deepEqual(totals, [r1.score, 0, 0]);

    // Runde 3: nach dem Einpassen gibt der Nächste
    room.nextRound(tokens[0]);
    assert.equal(room.game.dealer, 1);
    assert.equal(room.round, 3);
  });

  test('Geber rückt weiter → Vorhand wechselt reihum', () => {
    const { room, players } = roomWith(3);
    const tokens = players.map((p) => p.token);
    room.start(tokens[0]);
    const forehands = [];
    for (let r = 0; r < 3; r++) {
      forehands.push(room.game.forehand);
      const g = room.game;
      g.bid(g.middle, 'pass');
      g.bid(g.rear, 'pass');
      g.bid(g.forehand, 'pass');
      room.nextRound(tokens[0]);
    }
    assert.deepEqual(forehands, [0, 1, 2]);
  });

  test('Neustart leert die Punkteliste', () => {
    const { room, players } = roomWith(3);
    const t = players.map((p) => p.token);
    room.start(t[0]);
    room.bid(t[1], 'pass'); room.bid(t[2], 'pass'); room.bid(t[0], 'pass');
    assert.equal(room.scores.length, 1);
    for (const token of t) room.requestVote(token, 'abort');
    room.start(t[0]);
    assert.equal(room.scores.length, 0);
  });
});

describe('Room – Abstimmungen nur gemeinsam', () => {
  function running(options) {
    const now = fakeClock();
    const { room, players } = roomWith(4, { now, voteMs: 60_000, absentMs: 120_000, ...options });
    room.start(players[0].token);
    return { room, now, t: players.map((p) => p.token) };
  }

  test('ein einzelner Spieler kann nicht abbrechen', () => {
    const { room, t } = running();
    room.requestVote(t[0], 'abort');
    assert.equal(room.status, 'running');
    const vote = room.stateFor(t[1]).vote;
    assert.deepEqual(vote.yes, [0]);
    assert.deepEqual(vote.waitingFor, [1, 2]);
    assert.equal(vote.remainingMs, 60_000);
  });

  test('alle drei stimmen zu → zurück in die Lobby', () => {
    const { room, t } = running();
    room.requestVote(t[0], 'abort');
    room.castVote(t[1], true);
    assert.equal(room.status, 'running');
    room.castVote(t[2], true);
    assert.equal(room.status, 'lobby');
    assert.equal(room.game, null);
    assert.equal(room.stateFor(t[0]).vote, null);
  });

  test('einer lehnt ab → Abstimmung beendet, Spiel läuft weiter', () => {
    const { room, t } = running();
    room.requestVote(t[0], 'abort');
    room.castVote(t[1], false);
    assert.equal(room.vote, null);
    assert.equal(room.stateFor(t[0]).voteRejectedBy, 1);
    throwsCode(() => room.castVote(t[2], true), 'KEINE_ABSTIMMUNG');
    assert.equal(room.status, 'running');
  });

  test('Abstimmung läuft nach 60 s ab', () => {
    const { room, now, t } = running();
    room.requestVote(t[0], 'abort');
    room.castVote(t[1], true);
    now.advance(59_999);
    assert.ok(room.stateFor(t[0]).vote);
    now.advance(1);
    assert.equal(room.stateFor(t[0]).vote, null);
    assert.equal(room.expireVote(), true);
    throwsCode(() => room.castVote(t[2], true), 'KEINE_ABSTIMMUNG');
    assert.equal(room.status, 'running');
  });

  test('Zuschauer dürfen nicht abstimmen', () => {
    const { room, t } = running();
    throwsCode(() => room.requestVote(t[3], 'abort'), 'NUR_SPIELER');
    room.requestVote(t[0], 'abort');
    throwsCode(() => room.castVote(t[3], true), 'NUR_SPIELER');
  });

  test('wer länger als 2 min getrennt ist, blockiert nicht – kürzer schon', () => {
    const { room, now, t } = running();
    room.disconnect(t[2]);
    now.advance(60_000);
    room.requestVote(t[0], 'abort');
    room.castVote(t[1], true);
    assert.equal(room.status, 'running', 'erst 1 min weg → zählt noch');
    room.expireVote();
    now.advance(61_000); // jetzt > 2 min getrennt
    room.requestVote(t[0], 'abort');
    room.castVote(t[1], true);
    assert.equal(room.status, 'lobby');
  });
});

describe('Room – Abend beenden und Abendwertung', () => {
  function evening() {
    const now = fakeClock();
    const { room, players } = roomWith(3, { now });
    const t = players.map((p) => p.token);
    room.start(t[0]);
    return { room, now, t };
  }

  /** Eine Runde: Vorhand spielt Grand Hand mit jeweils der ersten erlaubten Karte */
  function playRound(room, t) {
    const g = room.game;
    room.bid(t[g.middle], 'pass');
    room.bid(t[g.rear], 'pass');
    room.bid(t[g.forehand], 'bid');
    room.declare(t[g.forehand], { type: 'grand' });
    while (room.game.phase === 'playing') {
      room.playCard(t[room.game.turn], room.game.legalFor(room.game.turn)[0]);
    }
  }

  test('braucht alle drei; danach dieselbe Wertung für alle', () => {
    const { room, now, t } = evening();
    playRound(room, t);
    room.nextRound(t[0]);
    now.advance(90 * 60_000);

    room.requestVote(t[1], 'end');
    room.castVote(t[0], true);
    assert.equal(room.status, 'running', 'zwei von drei reichen nicht');
    room.castVote(t[2], true);
    assert.equal(room.status, 'summary');
    assert.equal(room.game, null);

    const views = t.map((token) => room.stateFor(token).summary);
    assert.deepEqual(views[0], views[2], 'alle sehen dieselbe Zusammenfassung');
    const s = views[0];
    assert.equal(s.games, 1, 'nur abgeschlossene Runden zählen');
    assert.equal(s.durationMs, 90 * 60_000);
    assert.deepEqual(s.players.map((p) => p.name), ['Spieler 1', 'Spieler 2', 'Spieler 3']);
    assert.equal(s.players[0].declarerGames, 1);
    assert.equal(s.players[0].points, room.scores[0].score);
  });

  test('Abbrechen und Abend beenden laufen nicht gleichzeitig', () => {
    const { room, t } = evening();
    room.requestVote(t[0], 'abort');
    throwsCode(() => room.requestVote(t[1], 'end'), 'ABSTIMMUNG_LAEUFT');
    throwsCode(() => room.requestVote(t[1], 'quatsch'), 'ABSTIMMUNG_UNGUELTIG');
  });

  test('"Neuer Abend" setzt alles auf null, "Lobby" gibt die Plätze frei', () => {
    const { room, now, t } = evening();
    playRound(room, t);
    for (const token of t) room.requestVote(token, 'end');
    assert.equal(room.status, 'summary');
    throwsCode(() => room.leaveSeat(t[0]), 'SPIEL_LAEUFT');

    now.advance(1000);
    room.start(t[2]); // Neuer Abend
    assert.equal(room.status, 'running');
    assert.deepEqual(room.scores, []);
    assert.equal(room.summary, null);
    assert.equal(room.round, 1);
    assert.equal(room.eveningStartedAt, now());

    for (const token of t) room.requestVote(token, 'end');
    room.backToLobby(t[1]);
    assert.equal(room.status, 'lobby');
    assert.equal(room.stateFor(t[0]).summary, null);
    room.leaveSeat(t[0]);
    throwsCode(() => room.backToLobby(t[1]), 'KEINE_WERTUNG');
  });

  test('Live-Liste enthält Seeger-Fabian als Zusatzspalte', () => {
    const { room, t } = evening();
    playRound(room, t);
    const { totals, seegerFabian } = room.stateFor(t[0]).scores;
    const r = room.scores[0];
    assert.equal(totals[0], r.score);
    assert.equal(seegerFabian[0], r.won ? r.score + 50 : r.score - 50);
    assert.equal(seegerFabian[1], r.won ? 0 : 40);
  });
});
