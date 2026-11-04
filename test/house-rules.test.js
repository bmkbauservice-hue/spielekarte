import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHouseRules, valueFactor, applyFactors, nextBockCount, triggersBock,
  canSayKontra, canSayRe, giftAllowed, giftValue, BOCK_GAMES_PER_TRIGGER, DEFAULT_HOUSE_RULES,
} from '../src/game/house-rules.js';

const ON = { kontra: true, bock: true, schenken: true };

describe('Hausregeln einschalten', () => {
  test('Standard: alles aus', () => {
    assert.deepEqual(DEFAULT_HOUSE_RULES, { kontra: false, bock: false, schenken: false });
    assert.deepEqual(normalizeHouseRules(), DEFAULT_HOUSE_RULES);
    assert.deepEqual(normalizeHouseRules(null), DEFAULT_HOUSE_RULES);
  });

  test('nur echte Booleans, unbekannte Schalter fallen weg', () => {
    assert.deepEqual(normalizeHouseRules({ kontra: 'ja', schenken: true, ramsch: true }), { kontra: false, bock: false, schenken: true });
  });

  test('Bock nur zusammen mit Kontra/Re', () => {
    assert.equal(normalizeHouseRules({ bock: true }).bock, false);
    assert.equal(normalizeHouseRules({ kontra: true, bock: true }).bock, true);
  });
});

describe('Faktoren', () => {
  test('Kontra ×2, Re ×4, Bock ×2 zusätzlich', () => {
    assert.equal(valueFactor({}), 1);
    assert.equal(valueFactor({ kontra: true }), 2);
    assert.equal(valueFactor({ kontra: true, re: true }), 4);
    assert.equal(valueFactor({ bock: true }), 2);
    assert.equal(valueFactor({ kontra: true, bock: true }), 4, 'Kontra im Bock = ×4');
    assert.equal(valueFactor({ kontra: true, re: true, bock: true }), 8);
  });

  test('applyFactors rechnet Wert und Punkte neu – verloren weiter −2×', () => {
    const won = applyFactors({ won: true, value: 48, score: 48 }, { kontra: true });
    assert.equal(won.value, 96);
    assert.equal(won.score, 96);
    assert.deepEqual(won.factors, [{ label: 'Kontra', factor: 2 }]);
    const lost = applyFactors({ won: false, value: 48, score: -96 }, { kontra: true, bock: true });
    assert.equal(lost.value, 192);
    assert.equal(lost.score, -384);
  });
});

describe('Bock-Zähler', () => {
  test('Kontra verloren → 9 Bock-Spiele', () => {
    assert.equal(triggersBock({ kontra: true, re: false, won: false }), true);
    assert.equal(nextBockCount(0, { wasBock: false, triggered: true }), BOCK_GAMES_PER_TRIGGER);
    assert.equal(BOCK_GAMES_PER_TRIGGER, 9);
  });

  test('Re gewonnen → kein Bock', () => {
    assert.equal(triggersBock({ kontra: true, re: true, won: true }), false);
  });

  test('ohne Kontra/Re kein Auslöser, auch wenn verloren', () => {
    assert.equal(triggersBock({ kontra: false, re: false, won: false }), false);
  });

  test('ein Bock-Spiel verbraucht eins – auch eingepasst', () => {
    assert.equal(nextBockCount(9, { wasBock: true, triggered: false }), 8);
    assert.equal(nextBockCount(1, { wasBock: true, triggered: false }), 0);
    assert.equal(nextBockCount(0, { wasBock: false, triggered: false }), 0);
  });

  test('zweiter Auslöser im Bock → Restzähler +9 (hinten anhängen, kein Stapeln)', () => {
    // 5 übrig, dieses Bock-Spiel verbraucht eins, Auslöser hängt 9 an → 13
    assert.equal(nextBockCount(5, { wasBock: true, triggered: true }), 13);
  });
});

describe('Wer darf Kontra/Re sagen?', () => {
  const state = (extra) => ({ rules: ON, phase: 'playing', declarer: 0, kontraBy: null, re: false, cardsPlayed: [0, 0, 0], ...extra });

  test('Gegenspieler vor seiner ersten Karte', () => {
    assert.equal(canSayKontra(state(), 1), true);
    assert.equal(canSayKontra(state(), 0), false, 'nicht der Alleinspieler');
    assert.equal(canSayKontra(state({ cardsPlayed: [1, 1, 0] }), 1), false, 'schon eine Karte gespielt');
    assert.equal(canSayKontra(state({ cardsPlayed: [1, 1, 0] }), 2), true, 'der andere noch nicht');
    assert.equal(canSayKontra(state({ kontraBy: 2 }), 1), false, 'nur ein Kontra');
    assert.equal(canSayKontra(state({ rules: { ...ON, kontra: false } }), 1), false, 'Hausregel aus');
    assert.equal(canSayKontra(state({ phase: 'gift' }), 1), false, 'nicht beim Schenken');
  });

  test('Re nur nach Kontra, nur Alleinspieler, vor seiner ersten Karte', () => {
    assert.equal(canSayRe(state(), 0), false, 'ohne Kontra kein Re');
    assert.equal(canSayRe(state({ kontraBy: 1 }), 0), true);
    assert.equal(canSayRe(state({ kontraBy: 1 }), 1), false);
    assert.equal(canSayRe(state({ kontraBy: 1, cardsPlayed: [1, 0, 0] }), 0), false);
    assert.equal(canSayRe(state({ kontraBy: 1, re: true }), 0), false);
  });
});

describe('Schenken', () => {
  const twelve = ['kreuz-B', 'pik-B', 'pik-7', 'pik-8', 'pik-9', 'pik-D', 'pik-K', 'karo-7', 'karo-8', 'karo-9', 'karo-D', 'karo-K'];

  test('nur Farbe/Grand ohne Ansagen und Ouvert', () => {
    assert.equal(giftAllowed(ON, { type: 'grand' }), true);
    assert.equal(giftAllowed(ON, { type: 'null' }), false);
    assert.equal(giftAllowed(ON, { type: 'suit', trump: 'herz', schneiderAnnounced: true }), false);
    assert.equal(giftAllowed(ON, { type: 'grand', ouvert: true }), false);
    assert.equal(giftAllowed({ ...ON, schenken: false }, { type: 'grand' }), false);
  });

  test('einfacher Spielwert: Spitzen + Spiel (+ Hand), ohne Schneider', () => {
    assert.equal(giftValue({ game: { type: 'grand', hand: false }, bid: 18, declarerCards: twelve }).value, 24 * 3);
    assert.equal(giftValue({ game: { type: 'grand', hand: true }, bid: 18, declarerCards: twelve }).value, 24 * 4);
  });

  test('unter dem Reizwert → kleinstes Vielfaches, das den Reizwert erreicht', () => {
    // Herz mit 2 = 30, gereizt 36 → 40
    const r = giftValue({ game: { type: 'suit', trump: 'herz', hand: false }, bid: 36, declarerCards: twelve });
    assert.equal(r.value, 40);
    assert.equal(r.raisedToBid, true);
  });
});
