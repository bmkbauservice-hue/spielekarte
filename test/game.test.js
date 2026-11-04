import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { SkatGame, GameError } from '../src/game/game.js';
import { createDeck, sumPoints, SUITS } from '../src/game/cards.js';

const HERZ = { type: 'suit', trump: 'herz' };

// Feste Verteilung. Geber = Platz 2 → Vorhand (und Alleinspieler) = Platz 0.
const HAND_0 = ['kreuz-B', 'pik-B', 'herz-A', 'herz-10', 'herz-K', 'pik-A', 'pik-8', 'kreuz-A', 'kreuz-10', 'karo-A'];
const HAND_1 = ['herz-B', 'herz-D', 'herz-9', 'pik-K', 'pik-7', 'pik-D', 'kreuz-K', 'kreuz-D', 'karo-10', 'karo-K'];
const HAND_2 = ['karo-B', 'herz-8', 'herz-7', 'kreuz-9', 'kreuz-8', 'kreuz-7', 'karo-D', 'karo-9', 'karo-8', 'karo-7']; // kein Pik!
const SKAT = ['pik-10', 'pik-9']; // 10 Augen im Skat
const fixedGame = () => new SkatGame({ dealer: 2, deck: [...HAND_0, ...HAND_1, ...HAND_2, ...SKAT] });

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof GameError && e.code === code);
const sorted = (cards) => [...cards].sort();

describe('Geben', () => {
  test('10 Karten je Spieler, 2 im Skat, alle 32 verschieden', () => {
    const g = new SkatGame();
    assert.deepEqual(g.hands.map((h) => h.length), [10, 10, 10]);
    assert.equal(g.skat.length, 2);
    assert.deepEqual(sorted([...g.hands.flat(), ...g.skat]), sorted(createDeck()));
  });

  test('Vorhand sitzt links vom Geber und ist Alleinspieler', () => {
    for (const [dealer, forehand] of [[0, 1], [1, 2], [2, 0]]) {
      const g = new SkatGame({ dealer });
      assert.equal(g.forehand, forehand);
      assert.equal(g.declarer, forehand);
      assert.equal(g.turn, forehand, 'Alleinspieler ist zuerst mit der Ansage dran');
    }
  });

  test('feste Verteilung landet bei den richtigen Plätzen', () => {
    const g = fixedGame();
    assert.deepEqual(g.hands, [HAND_0, HAND_1, HAND_2]);
    assert.deepEqual(g.skat, SKAT);
  });

  test('ungültiges Test-Blatt wird abgelehnt', () => {
    assert.throws(() => new SkatGame({ deck: createDeck().slice(1) }));
    assert.throws(() => new SkatGame({ deck: [...createDeck().slice(1), 'herz-A'] }));
  });
});

describe('Ansage', () => {
  test('nur der Alleinspieler, nur einmal, nur gültige Spiele', () => {
    const g = fixedGame();
    throwsCode(() => g.declare(1, HERZ), 'NICHT_ALLEINSPIELER');
    throwsCode(() => g.declare(0, { type: 'null' }), 'SPIEL_UNGUELTIG');
    throwsCode(() => g.play(0, 'pik-A'), 'FALSCHE_PHASE');
    g.declare(0, HERZ);
    assert.equal(g.phase, 'playing');
    assert.deepEqual(g.game, HERZ);
    throwsCode(() => g.declare(0, { type: 'grand' }), 'FALSCHE_PHASE');
  });

  test('übergebenes Objekt wird kopiert (keine Fremd-Felder)', () => {
    const g = fixedGame();
    g.declare(0, { type: 'grand', trump: 'herz', evil: true });
    assert.deepEqual(g.game, { type: 'grand' });
  });
});

describe('Stiche spielen', () => {
  test('Vorhand spielt aus, Bedienpflicht, Trumpf sticht, Gewinner spielt aus', () => {
    const g = fixedGame();
    g.declare(0, HERZ);
    throwsCode(() => g.play(1, 'pik-7'), 'NICHT_DRAN');
    g.play(0, 'pik-A');

    // Platz 1 hat Pik → muss bedienen
    assert.deepEqual(sorted(g.legalFor(1)), ['pik-7', 'pik-D', 'pik-K']);
    throwsCode(() => g.play(1, 'herz-9'), 'BEDIENPFLICHT');
    throwsCode(() => g.play(1, 'kreuz-B'), 'KARTE_FEHLT');
    g.play(1, 'pik-7');

    // Platz 2 hat kein Pik → alles erlaubt, er trumpft mit Herz 7
    assert.equal(g.legalFor(2).length, 10);
    g.play(2, 'herz-7');

    assert.equal(g.lastTrick.winner, 2);
    assert.equal(g.turn, 2, 'Stichgewinner spielt aus');
    assert.deepEqual(g.trick, []);
    assert.deepEqual(g.tricksWon, [0, 0, 1]);
    assert.equal(sumPoints(g.won[2]), 11);
  });

  test('wer nicht dran ist, hat keine spielbaren Karten', () => {
    const g = fixedGame();
    g.declare(0, HERZ);
    assert.equal(g.legalFor(0).length, 10);
    assert.deepEqual(g.legalFor(1), []);
    assert.deepEqual(g.legalFor(2), []);
  });

  test('Skat zählt für den Alleinspieler', () => {
    const g = fixedGame();
    g.declare(0, HERZ);
    playOut(g, (legal) => legal[0]);
    assert.equal(g.phase, 'finished');
    assert.equal(g.result.skatPoints, 10);
    assert.equal(g.result.declarerPoints, sumPoints(g.won[0]) + 10);
    assert.equal(g.result.declarerPoints + g.result.defenderPoints, 120);
    throwsCode(() => g.play(0, 'herz-A'), 'FALSCHE_PHASE');
  });
});

describe('Sichtbarkeit (server-authoritative)', () => {
  test('ein Spieler sieht nur seine eigenen Karten – keine fremden, keinen Skat', () => {
    const g = fixedGame();
    const views = [0, 1, 2].map((s) => JSON.stringify(g.viewFor(s)));
    const foreign = (seat) => [...[HAND_0, HAND_1, HAND_2].filter((_, i) => i !== seat).flat(), ...SKAT];
    for (const seat of [0, 1, 2]) {
      for (const card of foreign(seat)) assert.equal(views[seat].includes(`"${card}"`), false, `Platz ${seat} sieht ${card}`);
    }
    assert.deepEqual(sorted(g.viewFor(1).hand), sorted(HAND_1));
  });

  test('Zuschauer sehen keine Handkarten', () => {
    const g = fixedGame();
    const view = g.viewFor(null);
    assert.equal(view.hand, null);
    assert.deepEqual(view.legal, []);
    for (const card of createDeck()) assert.equal(JSON.stringify(view).includes(`"${card}"`), false);
    assert.deepEqual(view.handCounts, [10, 10, 10]);
  });

  test('gespielte Karten im Stich sind für alle sichtbar', () => {
    const g = fixedGame();
    g.declare(0, HERZ);
    g.play(0, 'pik-A');
    assert.deepEqual(g.viewFor(null).trick, [{ seat: 0, card: 'pik-A' }]);
  });

  test('Skat und Ergebnis erst am Ende', () => {
    const g = fixedGame();
    g.declare(0, HERZ);
    assert.equal(g.viewFor(0).skat, null);
    assert.equal(g.viewFor(0).result, null);
    playOut(g, (legal) => legal[0]);
    assert.deepEqual(g.viewFor(null).skat, SKAT);
    assert.equal(typeof g.viewFor(1).result.won, 'boolean');
  });

  test('Sicht ist eine Kopie – Änderungen daran ändern das Spiel nicht', () => {
    const g = fixedGame();
    g.declare(0, HERZ);
    const view = g.viewFor(0);
    view.hand.length = 0;
    view.game.trump = 'pik';
    view.tricksWon[0] = 99;
    assert.equal(g.hands[0].length, 10);
    assert.equal(g.game.trump, 'herz');
    assert.equal(g.tricksWon[0], 0);
  });

  test('Hand ist nach dem Spiel sortiert (Trümpfe zuerst)', () => {
    const g = fixedGame();
    g.declare(0, HERZ);
    assert.deepEqual(g.viewFor(0).hand.slice(0, 5), ['kreuz-B', 'pik-B', 'herz-A', 'herz-10', 'herz-K']);
  });
});

describe('Simulation: 500 zufällige Spiele', () => {
  test('immer 10 Stiche, 120 Augen, jede Karte genau einmal, nur erlaubte Karten', () => {
    const games = [{ type: 'grand' }, ...SUITS.map((trump) => ({ type: 'suit', trump }))];
    for (let n = 0; n < 500; n++) {
      const g = new SkatGame({ dealer: n % 3 });
      g.declare(g.declarer, games[randomInt(games.length)]);
      const played = [];

      while (g.phase === 'playing') {
        const seat = g.turn;
        const legal = g.legalFor(seat);
        assert.ok(legal.length > 0, 'wer dran ist, hat immer eine spielbare Karte');
        assert.ok(legal.every((c) => g.hands[seat].includes(c)), 'erlaubte Karten sind auf der Hand');
        const illegal = g.hands[seat].find((c) => !legal.includes(c));
        if (illegal) throwsCode(() => g.play(seat, illegal), 'BEDIENPFLICHT');
        const card = legal[randomInt(legal.length)];
        g.play(seat, card);
        played.push(card);
      }

      assert.equal(played.length, 30);
      assert.deepEqual(sorted([...played, ...g.skat]), sorted(createDeck()));
      assert.equal(g.tricksWon.reduce((a, b) => a + b, 0), 10);
      assert.equal(g.won.flat().length + g.skat.length, 32);
      assert.equal(sumPoints(g.won.flat()) + sumPoints(g.skat), 120);
      assert.equal(g.result.declarerPoints + g.result.defenderPoints, 120);
      assert.equal(g.result.won, g.result.declarerPoints >= 61);
    }
  });
});

/** Spielt die Runde zu Ende; `pick` wählt aus den erlaubten Karten. */
function playOut(game, pick) {
  while (game.phase === 'playing') game.play(game.turn, pick(game.legalFor(game.turn)));
}
