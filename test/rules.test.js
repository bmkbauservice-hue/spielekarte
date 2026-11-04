import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, shuffle, parseCard, sumPoints, cardPoints, isCard } from '../src/game/cards.js';
import {
  isTrump, effectiveSuit, legalCards, trickWinner, cardStrength, evaluate, sortHand, isValidGame, TRUMP,
} from '../src/game/rules.js';

const GRAND = { type: 'grand' };
const HERZ = { type: 'suit', trump: 'herz' };
const KREUZ = { type: 'suit', trump: 'kreuz' };
const NULL = { type: 'null' };

describe('Blatt', () => {
  test('32 verschiedene Karten', () => {
    const deck = createDeck();
    assert.equal(deck.length, 32);
    assert.equal(new Set(deck).size, 32);
  });

  test('Augen im ganzen Blatt = 120', () => assert.equal(sumPoints(createDeck()), 120));

  test('Augenwerte A 11, 10 10, K 4, D 3, B 2, 9/8/7 = 0', () => {
    assert.deepEqual(
      ['herz-A', 'herz-10', 'herz-K', 'herz-D', 'herz-B', 'herz-9', 'herz-8', 'herz-7'].map(cardPoints),
      [11, 10, 4, 3, 2, 0, 0, 0],
    );
  });

  test('parseCard erkennt nur echte Karten', () => {
    assert.deepEqual(parseCard('pik-10'), { suit: 'pik', rank: '10' });
    for (const bad of ['pik-1', 'blau-A', 'herz-A-x', '', null, 7]) assert.equal(isCard(bad), false, String(bad));
  });

  test('Mischen ist eine Permutation und verändert das Original nicht', () => {
    const deck = createDeck();
    const copy = [...deck];
    const mixed = shuffle(deck);
    assert.deepEqual(deck, copy);
    assert.deepEqual([...mixed].sort(), [...deck].sort());
  });

  test('Mischen nutzt den übergebenen Zufall (Fisher-Yates)', () => {
    // randomInt liefert immer 0 → jede Karte tauscht mit Position 0
    const mixed = shuffle(['a', 'b', 'c'], () => 0);
    assert.deepEqual(mixed, ['b', 'c', 'a']);
  });

  test('Mischen ist tatsächlich zufällig', () => {
    const first = shuffle(createDeck()).join();
    const differs = Array.from({ length: 5 }, () => shuffle(createDeck()).join()).some((s) => s !== first);
    assert.ok(differs);
  });
});

describe('Trumpf', () => {
  test('Grand: nur die 4 Buben sind Trumpf', () => {
    const trumps = createDeck().filter((c) => isTrump(c, GRAND));
    assert.deepEqual(trumps.sort(), ['herz-B', 'karo-B', 'kreuz-B', 'pik-B']);
  });

  test('Farbspiel: 4 Buben + 7 Karten der Trumpffarbe = 11 Trümpfe', () => {
    const trumps = createDeck().filter((c) => isTrump(c, HERZ));
    assert.equal(trumps.length, 11);
    assert.ok(trumps.includes('kreuz-B'));
    assert.ok(trumps.includes('herz-7'));
    assert.ok(!trumps.includes('pik-A'));
  });

  test('Buben-Reihenfolge: Kreuz > Pik > Herz > Karo', () => {
    for (const game of [GRAND, HERZ, KREUZ]) {
      const s = (c) => cardStrength(c, game);
      assert.ok(s('kreuz-B') > s('pik-B'));
      assert.ok(s('pik-B') > s('herz-B'));
      assert.ok(s('herz-B') > s('karo-B'));
    }
  });

  test('Farbspiel Herz: Trumpf-Reihenfolge B, B, B, B, A, 10, K, D, 9, 8, 7', () => {
    const order = ['kreuz-B', 'pik-B', 'herz-B', 'karo-B', 'herz-A', 'herz-10', 'herz-K', 'herz-D', 'herz-9', 'herz-8', 'herz-7'];
    const sorted = [...order].reverse().sort((a, b) => cardStrength(b, HERZ) - cardStrength(a, HERZ));
    assert.deepEqual(sorted, order);
  });

  test('der kleinste Bube schlägt das Trumpf-Ass', () => {
    assert.ok(cardStrength('karo-B', HERZ) > cardStrength('herz-A', HERZ));
  });

  test('Bube gehört zum Trumpf, nicht zu seiner Farbe', () => {
    assert.equal(effectiveSuit('pik-B', HERZ), TRUMP);
    assert.equal(effectiveSuit('pik-B', GRAND), TRUMP);
    assert.equal(effectiveSuit('pik-A', HERZ), 'pik');
    assert.equal(effectiveSuit('herz-7', HERZ), TRUMP);
    assert.equal(effectiveSuit('herz-7', GRAND), 'herz');
  });

  test('isValidGame', () => {
    assert.ok(isValidGame(GRAND));
    assert.ok(isValidGame(HERZ));
    assert.ok(isValidGame(NULL));
    for (const bad of [null, {}, { type: 'ramsch' }, { type: 'suit' }, { type: 'suit', trump: 'blau' }, 'grand']) {
      assert.equal(isValidGame(bad), false, JSON.stringify(bad));
    }
  });
});

describe('Bedienpflicht', () => {
  test('erste Karte im Stich: alles erlaubt', () => {
    const hand = ['herz-A', 'pik-7', 'kreuz-B'];
    assert.deepEqual(legalCards(hand, [], HERZ), hand);
  });

  test('Farbe muss bedient werden', () => {
    const hand = ['pik-7', 'pik-K', 'herz-A', 'karo-10'];
    assert.deepEqual(legalCards(hand, ['pik-A'], HERZ), ['pik-7', 'pik-K']);
  });

  test('Bube bedient NICHT seine aufgedruckte Farbe', () => {
    // Pik ausgespielt, ich habe nur den Pik-Buben → der ist Trumpf, also bin ich "frei" in Pik
    const hand = ['pik-B', 'herz-A', 'karo-10'];
    assert.deepEqual(legalCards(hand, ['pik-A'], HERZ), hand);
    assert.deepEqual(legalCards(hand, ['pik-A'], GRAND), hand);
  });

  test('Trumpf ausgespielt: Trumpf bedienen – Buben zählen dazu', () => {
    const hand = ['karo-B', 'herz-7', 'pik-A'];
    assert.deepEqual(legalCards(hand, ['herz-10'], HERZ), ['karo-B', 'herz-7']);
  });

  test('Bube ausgespielt im Grand: Bube bedienen', () => {
    const hand = ['karo-B', 'kreuz-A', 'kreuz-10'];
    assert.deepEqual(legalCards(hand, ['pik-B'], GRAND), ['karo-B']);
  });

  test('Bube ausgespielt im Farbspiel: jeder Trumpf bedient', () => {
    const hand = ['herz-9', 'kreuz-A'];
    assert.deepEqual(legalCards(hand, ['kreuz-B'], HERZ), ['herz-9']);
  });

  test('Herz ausgespielt im Grand: Herz-Bube ist kein Herz', () => {
    const hand = ['herz-B', 'pik-7'];
    assert.deepEqual(legalCards(hand, ['herz-A'], GRAND), hand);
  });

  test('frei in der Farbe: abwerfen oder trumpfen erlaubt', () => {
    const hand = ['herz-7', 'karo-A', 'kreuz-B'];
    assert.deepEqual(legalCards(hand, ['pik-10', 'pik-K'], HERZ), hand);
  });
});

describe('Stichgewinner', () => {
  test('höchste Karte der ausgespielten Farbe gewinnt', () => {
    assert.equal(trickWinner(['pik-K', 'pik-A', 'pik-7'], HERZ), 1);
  });

  test('10 schlägt König, Ass schlägt 10', () => {
    assert.equal(trickWinner(['karo-K', 'karo-10', 'karo-9'], HERZ), 1);
    assert.equal(trickWinner(['karo-10', 'karo-K', 'karo-A'], HERZ), 2);
  });

  test('Dame schlägt 9, König schlägt Dame', () => {
    assert.equal(trickWinner(['kreuz-9', 'kreuz-D', 'kreuz-8'], GRAND), 1);
    assert.equal(trickWinner(['kreuz-D', 'kreuz-K', 'kreuz-9'], HERZ), 1);
  });

  test('abgeworfenes Ass einer Fremdfarbe gewinnt nicht', () => {
    assert.equal(trickWinner(['pik-7', 'karo-A', 'kreuz-A'], HERZ), 0);
  });

  test('kleinster Trumpf schlägt jede Farbkarte', () => {
    assert.equal(trickWinner(['pik-A', 'herz-7', 'pik-10'], HERZ), 1);
  });

  test('höherer Trumpf gewinnt, Bube schlägt Trumpf-Ass', () => {
    assert.equal(trickWinner(['herz-A', 'herz-10', 'karo-B'], HERZ), 2);
    assert.equal(trickWinner(['karo-B', 'kreuz-B', 'pik-B'], HERZ), 1);
  });

  test('Grand: Bube sticht, Farbe der Trumpffarbe ist normale Farbe', () => {
    assert.equal(trickWinner(['herz-A', 'herz-10', 'karo-B'], GRAND), 2);
    assert.equal(trickWinner(['herz-K', 'herz-A', 'herz-10'], GRAND), 1);
  });

  test('Farbspiel Kreuz: Pik-Bube sticht Kreuz-Ass', () => {
    assert.equal(trickWinner(['kreuz-A', 'pik-B', 'kreuz-10'], KREUZ), 1);
  });
});

describe('Auswertung', () => {
  test('61 Augen gewinnt, 60 verliert', () => {
    assert.equal(evaluate(61, 5).won, true);
    assert.equal(evaluate(60, 5).won, false);
    assert.equal(evaluate(60, 5).defenderPoints, 60);
  });

  test('Schneider und Schwarz', () => {
    assert.equal(evaluate(90, 8).schneider, true);
    assert.equal(evaluate(89, 8).schneider, false);
    assert.equal(evaluate(30, 2).schneider, true);
    assert.equal(evaluate(31, 2).schneider, false);
    assert.equal(evaluate(120, 10).schwarz, true);
    assert.equal(evaluate(0, 0).schwarz, true);
    assert.equal(evaluate(120, 9).schwarz, false, '120 Augen ohne alle Stiche ist nicht schwarz');
  });
});

describe('Sortierung', () => {
  test('Trümpfe zuerst, dann Kreuz, Pik, Herz, Karo – jeweils stärkste zuerst', () => {
    const hand = ['karo-7', 'herz-A', 'pik-B', 'kreuz-10', 'herz-7', 'kreuz-B', 'pik-K', 'karo-A'];
    assert.deepEqual(sortHand(hand, HERZ), ['kreuz-B', 'pik-B', 'herz-A', 'herz-7', 'kreuz-10', 'pik-K', 'karo-A', 'karo-7']);
    assert.deepEqual(sortHand(hand, GRAND), ['kreuz-B', 'pik-B', 'kreuz-10', 'pik-K', 'herz-A', 'herz-7', 'karo-A', 'karo-7']);
  });
});

describe('Null-Spiel', () => {
  test('kein Trumpf – auch Buben nicht', () => {
    assert.equal(createDeck().filter((c) => isTrump(c, NULL)).length, 0);
    assert.equal(effectiveSuit('kreuz-B', NULL), 'kreuz');
  });

  test('Reihenfolge 7 8 9 10 B D K A', () => {
    const order = ['herz-7', 'herz-8', 'herz-9', 'herz-10', 'herz-B', 'herz-D', 'herz-K', 'herz-A'];
    const sortedCards = [...order].reverse().sort((a, b) => cardStrength(a, NULL) - cardStrength(b, NULL));
    assert.deepEqual(sortedCards, order);
  });

  test('Bube bedient seine aufgedruckte Farbe', () => {
    const hand = ['pik-B', 'herz-A', 'kreuz-7'];
    assert.deepEqual(legalCards(hand, ['pik-A'], NULL), ['pik-B']);
  });

  test('Bube ausgespielt: dieselbe Farbe bedienen, nicht andere Buben', () => {
    const hand = ['karo-B', 'kreuz-9', 'kreuz-A'];
    assert.deepEqual(legalCards(hand, ['kreuz-B'], NULL), ['kreuz-9', 'kreuz-A']);
  });

  test('Stichgewinner: höchste Karte der Farbe, 10 verliert gegen Bube', () => {
    assert.equal(trickWinner(['herz-10', 'herz-B', 'herz-9'], NULL), 1);
    assert.equal(trickWinner(['herz-9', 'herz-10', 'herz-8'], NULL), 1);
    assert.equal(trickWinner(['pik-7', 'kreuz-B', 'herz-A'], NULL), 0, 'Buben stechen nicht');
  });

  test('Sortierung im Null: nach Farbe, Buben stehen in ihrer Farbe', () => {
    const hand = ['kreuz-B', 'herz-10', 'kreuz-A', 'herz-B', 'kreuz-10'];
    assert.deepEqual(sortHand(hand, NULL), ['kreuz-A', 'kreuz-B', 'kreuz-10', 'herz-B', 'herz-10']);
  });
});
