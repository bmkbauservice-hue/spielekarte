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

  test('Spiel beenden führt zurück in die Lobby', () => {
    const { room, players } = roomWith(3);
    room.start(players[0].token);
    room.stop(players[1].token);
    assert.equal(room.status, 'lobby');
    throwsCode(() => room.stop(players[1].token), 'KEIN_SPIEL');
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

  test('Start gibt Karten; erste Runde: Platz 3 gibt, Platz 1 ist Alleinspieler', () => {
    const { room, players } = roomWith(3, fixed);
    room.start(players[0].token);
    const view = room.stateFor(players[0].token);
    assert.equal(view.round, 1);
    assert.equal(view.game.phase, 'declaring');
    assert.equal(view.game.dealer, 2);
    assert.equal(view.game.declarer, 0);
    assert.equal(view.game.hand.length, 10);
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

  test('ansagen, spielen, neue Runde – mit den richtigen Berechtigungen', () => {
    const { room, players } = roomWith(4, fixed);
    const [a, b, c, watcher] = players.map((p) => p.token);
    throwsCode(() => room.declare(a, { type: 'grand' }), 'KEIN_SPIEL');
    room.start(a);

    throwsCode(() => room.declare(watcher, { type: 'grand' }), 'NUR_SPIELER');
    gameThrows(() => room.declare(b, { type: 'grand' }), 'NICHT_ALLEINSPIELER');
    room.declare(a, { type: 'grand' });
    throwsCode(() => room.nextRound(a), 'RUNDE_LAEUFT');

    // Runde mit jeweils der ersten erlaubten Karte zu Ende spielen
    const bySeat = [a, b, c];
    while (room.game.phase === 'playing') {
      const seat = room.game.turn;
      room.playCard(bySeat[seat], room.stateFor(bySeat[seat]).game.legal[0]);
    }
    const result = room.stateFor(watcher).game.result;
    assert.equal(result.declarerPoints + result.defenderPoints, 120);

    throwsCode(() => room.nextRound(watcher), 'NUR_SPIELER');
    room.nextRound(c);
    assert.equal(room.round, 2);
    assert.equal(room.game.dealer, 0, 'Geber rückt weiter');
    assert.equal(room.game.declarer, 1, 'Alleinspieler wechselt reihum');
  });

  test('Alleinspieler rotiert über drei Runden durch alle Plätze', () => {
    const { room, players } = roomWith(3);
    room.start(players[0].token);
    const declarers = [];
    for (let r = 0; r < 3; r++) {
      declarers.push(room.game.declarer);
      room.game.declare(room.game.declarer, { type: 'grand' });
      while (room.game.phase === 'playing') room.game.play(room.game.turn, room.game.legalFor(room.game.turn)[0]);
      room.nextRound(players[0].token);
    }
    assert.deepEqual(declarers, [0, 1, 2]);
  });

  test('Spiel beenden verwirft die Runde', () => {
    const { room, players } = roomWith(3);
    room.start(players[0].token);
    room.stop(players[1].token);
    assert.equal(room.game, null);
    assert.equal(room.stateFor(players[0].token).game, null);
  });
});
