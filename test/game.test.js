import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { SkatGame, GameError } from '../src/game/game.js';
import { createDeck, sumPoints, SUITS } from '../src/game/cards.js';
import { nullValue } from '../src/game/scoring.js';

const HERZ = { type: 'suit', trump: 'herz' };

// Feste Verteilung. Geber = Platz 2 → Vorhand 0, Mittelhand 1, Hinterhand 2.
const HAND_0 = ['kreuz-B', 'pik-B', 'herz-A', 'herz-10', 'herz-K', 'pik-A', 'pik-8', 'kreuz-A', 'kreuz-10', 'karo-A'];
const HAND_1 = ['herz-B', 'herz-D', 'herz-9', 'pik-K', 'pik-7', 'pik-D', 'kreuz-K', 'kreuz-D', 'karo-10', 'karo-K'];
const HAND_2 = ['karo-B', 'herz-8', 'herz-7', 'kreuz-9', 'kreuz-8', 'kreuz-7', 'karo-D', 'karo-9', 'karo-8', 'karo-7']; // kein Pik!
const SKAT = ['pik-10', 'pik-9']; // 10 Augen im Skat
const V = 0, M = 1, H = 2;
const fixedGame = () => new SkatGame({ dealer: 2, deck: [...HAND_0, ...HAND_1, ...HAND_2, ...SKAT] });

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof GameError && e.code === code);
const sorted = (cards) => [...cards].sort();

/** Mittel- und Hinterhand passen, Vorhand spielt für 18 → Platz 0 ist Alleinspieler */
function forehandAt18(g) {
  g.bid(M, 'pass');
  g.bid(H, 'pass');
  g.bid(V, 'bid');
  return g;
}

/** Mittelhand reizt bis `value` (Vorhand hält, passt dann), Hinterhand passt */
function middleWins(g, steps) {
  for (let i = 0; i < steps; i++) {
    g.bid(M, 'bid');
    if (i < steps - 1) g.bid(V, 'hold');
  }
  g.bid(V, 'pass');
  g.bid(H, 'pass');
  return g;
}

/** Spielt die Runde zu Ende; `pick` wählt aus den erlaubten Karten. */
function playOut(game, pick = (legal) => legal[0]) {
  while (game.phase === 'playing') game.play(game.turn, pick(game.legalFor(game.turn)));
}

describe('Geben', () => {
  test('10 Karten je Spieler, 2 im Skat, alle 32 verschieden', () => {
    const g = new SkatGame();
    assert.deepEqual(g.hands.map((h) => h.length), [10, 10, 10]);
    assert.equal(g.skat.length, 2);
    assert.deepEqual(sorted([...g.hands.flat(), ...g.skat]), sorted(createDeck()));
  });

  test('Vorhand links vom Geber, Mittelhand ist zuerst beim Reizen dran', () => {
    for (const [dealer, forehand, middle] of [[0, 1, 2], [1, 2, 0], [2, 0, 1]]) {
      const g = new SkatGame({ dealer });
      assert.equal(g.forehand, forehand);
      assert.equal(g.middle, middle);
      assert.equal(g.rear, dealer);
      assert.equal(g.phase, 'bidding');
      assert.equal(g.turn, middle);
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

describe('Reizen im Spiel', () => {
  test('vor dem Reizen-Ende keine Ansage, kein Skat, keine Karte', () => {
    const g = fixedGame();
    throwsCode(() => g.declare(V, HERZ), 'FALSCHE_PHASE');
    throwsCode(() => g.pickUpSkat(V), 'FALSCHE_PHASE');
    throwsCode(() => g.play(V, 'herz-A'), 'FALSCHE_PHASE');
  });

  test('Reiz-Sieger wird Alleinspieler mit dem gereizten Wert', () => {
    const g = middleWins(fixedGame(), 3);
    assert.equal(g.phase, 'skat');
    assert.equal(g.declarer, M);
    assert.equal(g.bidValue, 22);
    assert.equal(g.turn, M);
  });

  test('alle passen → eingepasst', () => {
    const g = fixedGame();
    g.bid(M, 'pass');
    g.bid(H, 'pass');
    g.bid(V, 'pass');
    assert.equal(g.phase, 'passed');
    assert.equal(g.turn, null);
    assert.equal(g.declarer, null);
  });

  test('Spitzen werden mit Skat gezählt (12 Karten)', () => {
    const g = forehandAt18(fixedGame());
    assert.deepEqual(sorted(g.declarerCards), sorted([...HAND_0, ...SKAT]));
  });
});

describe('Handspiel', () => {
  test('Ansage direkt nach dem Reizen = Hand; Skat bleibt liegen', () => {
    const g = forehandAt18(fixedGame());
    g.declare(V, { ...HERZ, schneiderAnnounced: true });
    assert.equal(g.game.hand, true);
    assert.equal(g.game.schneiderAnnounced, true);
    assert.equal(g.skatTaken, false);
    assert.equal(g.hands[V].length, 10);
    assert.equal(g.phase, 'playing');
    assert.equal(g.turn, V, 'Vorhand spielt aus');
  });

  test('nur der Alleinspieler sagt an', () => {
    const g = forehandAt18(fixedGame());
    throwsCode(() => g.declare(M, HERZ), 'NICHT_ALLEINSPIELER');
    throwsCode(() => g.pickUpSkat(M), 'NICHT_ALLEINSPIELER');
  });

  test('Skat zählt für den Alleinspieler', () => {
    const g = forehandAt18(fixedGame());
    g.declare(V, HERZ);
    playOut(g);
    assert.equal(g.result.skatPoints, 10);
    assert.equal(g.result.declarerPoints, sumPoints(g.won[V]) + 10);
    assert.equal(g.result.declarerPoints + g.result.defenderPoints, 120);
    assert.equal(g.result.label, 'Herz Hand');
    assert.equal(g.result.levels[0].label, 'mit 2');
  });
});

describe('Skat aufnehmen und drücken', () => {
  test('Alleinspieler bekommt 12 Karten, drückt 2, sagt dann an (kein Hand)', () => {
    const g = forehandAt18(fixedGame());
    g.pickUpSkat(V);
    assert.equal(g.phase, 'discard');
    assert.equal(g.hands[V].length, 12);
    throwsCode(() => g.declare(V, HERZ), 'FALSCHE_PHASE');

    throwsCode(() => g.discard(V, ['pik-10']), 'DRUECKEN_UNGUELTIG');
    throwsCode(() => g.discard(V, ['pik-10', 'pik-10']), 'DRUECKEN_UNGUELTIG');
    throwsCode(() => g.discard(V, ['pik-10', 'herz-B']), 'DRUECKEN_UNGUELTIG', 'fremde Karte');
    throwsCode(() => g.discard(M, ['pik-K', 'pik-7']), 'NICHT_ALLEINSPIELER');

    g.discard(V, ['kreuz-10', 'pik-10']);
    assert.equal(g.hands[V].length, 10);
    assert.equal(g.phase, 'declaring');
    throwsCode(() => g.declare(V, { ...HERZ, schneiderAnnounced: true }), 'NUR_HAND');
    g.declare(V, HERZ);
    assert.equal(g.game.hand, false);
  });

  test('gedrückte Karten zählen für den Alleinspieler, nicht der ursprüngliche Skat', () => {
    const g = forehandAt18(fixedGame());
    g.pickUpSkat(V);
    g.discard(V, ['kreuz-10', 'karo-A']); // 21 Augen gedrückt
    g.declare(V, HERZ);
    playOut(g);
    assert.equal(g.result.skatPoints, 21);
    assert.equal(g.result.declarerPoints, sumPoints(g.won[V]) + 21);
  });

  test('Null Ouvert geht auch nach dem Aufnehmen', () => {
    const g = forehandAt18(fixedGame());
    g.pickUpSkat(V);
    g.discard(V, ['kreuz-B', 'pik-B']);
    g.declare(V, { type: 'null', ouvert: true });
    assert.deepEqual(g.game, { type: 'null', hand: false, ouvert: true });
  });
});

describe('Null', () => {
  test('Null unter dem Reizwert darf nicht angesagt werden', () => {
    const g = middleWins(fixedGame(), 5); // gereizt bis 24
    assert.equal(g.bidValue, 24);
    g.pickUpSkat(M);
    g.discard(M, ['herz-B', 'herz-D']);
    throwsCode(() => g.declare(M, { type: 'null' }), 'NULL_ZU_NIEDRIG');
    g.declare(M, { type: 'null', ouvert: true }); // 46 ≥ 24 ist erlaubt
    assert.equal(nullValue(g.game), 46);
  });

  test('Runde endet sofort, wenn der Alleinspieler einen Stich bekommt', () => {
    const g = forehandAt18(fixedGame());
    g.declare(V, { type: 'null' }); // Null Hand = 35
    g.play(V, 'kreuz-A');
    g.play(M, 'kreuz-K');
    g.play(H, 'kreuz-9');
    assert.equal(g.phase, 'finished');
    assert.equal(g.result.won, false);
    assert.equal(g.result.value, 35);
    assert.equal(g.result.score, -70);
  });

  test('im Null bedient der Bube seine Farbe', () => {
    const g = forehandAt18(fixedGame());
    g.declare(V, { type: 'null' });
    g.play(V, 'herz-10');
    // Mittelhand hat herz-B, herz-D, herz-9 – der Bube zählt als Herz
    assert.deepEqual(sorted(g.legalFor(M)), ['herz-9', 'herz-B', 'herz-D']);
  });
});

describe('Stiche spielen', () => {
  test('Vorhand spielt aus, Bedienpflicht, Trumpf sticht, Gewinner spielt aus', () => {
    const g = forehandAt18(fixedGame());
    g.declare(V, HERZ);
    throwsCode(() => g.play(M, 'pik-7'), 'NICHT_DRAN');
    g.play(V, 'pik-A');
    assert.deepEqual(sorted(g.legalFor(M)), ['pik-7', 'pik-D', 'pik-K']);
    throwsCode(() => g.play(M, 'herz-9'), 'BEDIENPFLICHT');
    throwsCode(() => g.play(M, 'kreuz-B'), 'KARTE_FEHLT');
    g.play(M, 'pik-7');
    assert.equal(g.legalFor(H).length, 10, 'Hinterhand ist frei in Pik');
    g.play(H, 'herz-7');
    assert.equal(g.lastTrick.winner, H);
    assert.equal(g.turn, H, 'Stichgewinner spielt aus');
    assert.deepEqual(g.tricksWon, [0, 0, 1]);
  });

  test('nach dem Ende keine Karte mehr', () => {
    const g = forehandAt18(fixedGame());
    g.declare(V, HERZ);
    playOut(g);
    throwsCode(() => g.play(V, 'herz-A'), 'FALSCHE_PHASE');
  });
});

describe('Sichtbarkeit (server-authoritative)', () => {
  const others = (seat) => [HAND_0, HAND_1, HAND_2].filter((_, i) => i !== seat).flat();
  const sees = (view, card) => JSON.stringify(view).includes(`"${card}"`);

  test('beim Reizen: nur eigene Karten, kein Skat', () => {
    const g = fixedGame();
    for (const seat of [0, 1, 2]) {
      const view = g.viewFor(seat);
      for (const card of [...others(seat), ...SKAT]) assert.equal(sees(view, card), false, `Platz ${seat} sieht ${card}`);
    }
  });

  test('nach dem Aufnehmen sieht nur der Alleinspieler den Skat; Gedrücktes bleibt geheim', () => {
    const g = forehandAt18(fixedGame());
    g.pickUpSkat(V);
    assert.ok(sees(g.viewFor(V), 'pik-10'));
    assert.equal(sees(g.viewFor(M), 'pik-10'), false);
    assert.equal(sees(g.viewFor(null), 'pik-10'), false);
    g.discard(V, ['pik-10', 'pik-9']);
    g.declare(V, HERZ);
    assert.deepEqual(g.viewFor(V).discarded, ['pik-10', 'pik-9']);
    assert.equal(g.viewFor(M).discarded, null);
  });

  test('Zuschauer sehen keine Handkarten', () => {
    const view = fixedGame().viewFor(null);
    assert.equal(view.hand, null);
    for (const card of createDeck()) assert.equal(sees(view, card), false);
  });

  test('Ouvert: Karten des Alleinspielers liegen für alle offen – sonst nicht', () => {
    const g = forehandAt18(fixedGame());
    g.declare(V, { type: 'null', ouvert: true });
    assert.deepEqual(sorted(g.viewFor(M).openHand), sorted(HAND_0));
    assert.deepEqual(sorted(g.viewFor(null).openHand), sorted(HAND_0));

    const normal = forehandAt18(fixedGame());
    normal.declare(V, HERZ);
    assert.equal(normal.viewFor(M).openHand, null);
  });

  test('Skat und Ergebnis erst am Ende', () => {
    const g = forehandAt18(fixedGame());
    g.declare(V, HERZ);
    assert.equal(g.viewFor(M).skat, null);
    assert.equal(g.viewFor(M).result, null);
    playOut(g);
    assert.deepEqual(g.viewFor(null).skat, SKAT);
    assert.equal(typeof g.viewFor(M).result.score, 'number');
  });

  test('Sicht ist eine Kopie – Änderungen daran ändern das Spiel nicht', () => {
    const g = forehandAt18(fixedGame());
    g.declare(V, HERZ);
    const view = g.viewFor(V);
    view.hand.length = 0;
    view.game.trump = 'pik';
    view.bidding.passed.push(V);
    assert.equal(g.hands[V].length, 10);
    assert.equal(g.game.trump, 'herz');
    assert.deepEqual(g.bidding.passed, [M, H]);
  });
});

describe('Simulation: 400 zufällige Runden mit Reizen, Skat, allen Spielarten', () => {
  test('Karten, Augen und Wertung bleiben immer stimmig', () => {
    const pick = (list) => list[randomInt(list.length)];
    const games = [
      { type: 'grand' }, ...SUITS.map((trump) => ({ type: 'suit', trump })),
      { type: 'null' }, { type: 'null', ouvert: true },
    ];
    let finished = 0;
    for (let n = 0; n < 400; n++) {
      const g = new SkatGame({ dealer: n % 3 });

      while (g.phase === 'bidding') {
        const role = g.bidding.role;
        const go = role === 'listener' ? 'hold' : 'bid';
        g.bid(g.turn, randomInt(3) === 0 || g.bidding.value >= 60 ? 'pass' : go);
      }
      if (g.phase === 'passed') continue;

      if (randomInt(2) === 0) {
        g.pickUpSkat(g.declarer);
        const hand = g.hands[g.declarer];
        const a = pick(hand);
        g.discard(g.declarer, [a, pick(hand.filter((c) => c !== a))]);
      }
      const allowed = games.filter((s) => s.type !== 'null' || nullValue({ ...s, hand: g.phase === 'skat' }) >= g.bidValue);
      g.declare(g.declarer, pick(allowed));

      const played = [];
      while (g.phase === 'playing') {
        const legal = g.legalFor(g.turn);
        assert.ok(legal.length > 0);
        const card = pick(legal);
        played.push(card);
        g.play(g.turn, card);
      }
      finished++;

      const pile = g.skatTaken ? g.discarded : g.skat;
      const r = g.result;
      assert.equal(r.score, r.won ? r.value : -2 * r.value, 'gewonnen +Wert, verloren −2×Wert');
      assert.ok(r.value > 0);
      if (g.game.type === 'null' && played.length < 30) {
        assert.equal(r.won, false, 'vorzeitiges Ende nur bei Stich des Alleinspielers');
        continue;
      }
      assert.equal(played.length, 30);
      assert.deepEqual(sorted([...played, ...pile]), sorted(createDeck()), 'jede Karte genau einmal');
      assert.equal(sumPoints(g.won.flat()) + sumPoints(pile), 120);
      assert.equal(g.tricksWon.reduce((a, b) => a + b, 0), 10);
      if (g.game.type !== 'null' && !r.overbid) assert.equal(r.value, r.base * r.multiplier);
      if (r.overbid) assert.ok(r.value >= g.bidValue && r.value % r.base === 0);
    }
    assert.ok(finished > 100, `genug gespielte Runden (${finished})`);
  });
});
