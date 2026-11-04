import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BID_VALUES, nextBid, matadors, nullValue, normalizeGame, scoreGame, gameLabel, baseValue,
} from '../src/game/scoring.js';
import { GameError } from '../src/game/errors.js';

const herz = (extra = {}) => ({ type: 'suit', trump: 'herz', hand: false, schneiderAnnounced: false, schwarzAnnounced: false, ouvert: false, ...extra });
const kreuz = (extra = {}) => ({ ...herz(extra), trump: 'kreuz' });
const grand = (extra = {}) => ({ ...herz(extra), type: 'grand', trump: undefined });

/** 12 Karten: gewünschte Trümpfe + Füllkarten, die nie Trumpf sind (Pik/Karo-Farbkarten ohne Buben) */
const FILLER = ['pik-7', 'pik-8', 'pik-9', 'pik-D', 'pik-K', 'karo-7', 'karo-8', 'karo-9', 'karo-D', 'karo-K', 'karo-10', 'karo-A'];
const twelve = (...cards) => [...cards, ...FILLER].slice(0, 12);

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof GameError && e.code === code);

describe('Reizwerte', () => {
  test('beginnen mit 18, 20, 22, 23, 24, 27, 30, 33, 35, 36, 40', () => {
    assert.deepEqual(BID_VALUES.slice(0, 11), [18, 20, 22, 23, 24, 27, 30, 33, 35, 36, 40]);
  });

  test('enthalten Null-Werte, Grand-Vielfache und enden bei 264', () => {
    for (const v of [23, 35, 46, 59, 48, 72, 96, 120, 144, 168, 192, 216, 240, 264]) assert.ok(BID_VALUES.includes(v), v);
    assert.equal(BID_VALUES.at(-1), 264);
    assert.ok(!BID_VALUES.includes(19) && !BID_VALUES.includes(21) && !BID_VALUES.includes(25));
  });

  test('aufsteigend ohne Doppelte', () => {
    assert.deepEqual([...BID_VALUES].sort((a, b) => a - b), BID_VALUES);
    assert.equal(new Set(BID_VALUES).size, BID_VALUES.length);
  });

  test('nextBid', () => {
    assert.equal(nextBid(0), 18);
    assert.equal(nextBid(18), 20);
    assert.equal(nextBid(22), 23);
    assert.equal(nextBid(24), 27);
    assert.equal(nextBid(264), null);
  });
});

describe('Spitzen (mit/ohne)', () => {
  test('mit 1: nur Kreuz-Bube', () => {
    assert.deepEqual(matadors(twelve('kreuz-B', 'herz-B'), herz()), { count: 1, with: true });
  });

  test('mit 4 im Grand: alle Buben', () => {
    assert.deepEqual(matadors(twelve('kreuz-B', 'pik-B', 'herz-B', 'karo-B'), grand()), { count: 4, with: true });
  });

  test('ohne 2: Kreuz- und Pik-Bube fehlen', () => {
    assert.deepEqual(matadors(twelve('herz-B', 'herz-A'), herz()), { count: 2, with: false });
  });

  test('Farbspiel: Spitzen laufen über die Buben in die Trumpffarbe weiter', () => {
    const cards = twelve('kreuz-B', 'pik-B', 'herz-B', 'karo-B', 'herz-A', 'herz-10', 'herz-9');
    assert.deepEqual(matadors(cards, herz()), { count: 6, with: true }, 'K fehlt → mit 6');
  });

  test('ohne 11: kein einziger Trumpf', () => {
    assert.deepEqual(matadors(twelve(), herz()), { count: 11, with: false });
  });

  test('mit 11: alle Trümpfe', () => {
    const all = ['kreuz-B', 'pik-B', 'herz-B', 'karo-B', 'herz-A', 'herz-10', 'herz-K', 'herz-D', 'herz-9', 'herz-8', 'herz-7', 'pik-7'];
    assert.deepEqual(matadors(all, herz()), { count: 11, with: true });
  });
});

describe('Null-Werte', () => {
  test('Null 23, Null Hand 35, Null Ouvert 46, Null Ouvert Hand 59', () => {
    assert.equal(nullValue({ type: 'null', hand: false, ouvert: false }), 23);
    assert.equal(nullValue({ type: 'null', hand: true, ouvert: false }), 35);
    assert.equal(nullValue({ type: 'null', hand: false, ouvert: true }), 46);
    assert.equal(nullValue({ type: 'null', hand: true, ouvert: true }), 59);
  });

  test('gewonnen ohne Stich, verloren mit Stich (−2×)', () => {
    const nullHand = { type: 'null', hand: true, ouvert: false };
    assert.equal(scoreGame({ game: nullHand, bid: 18, declarerCards: [], declarerPoints: 0, declarerTricks: 0 }).score, 35);
    const lost = scoreGame({ game: nullHand, bid: 18, declarerCards: [], declarerPoints: 4, declarerTricks: 1 });
    assert.equal(lost.won, false);
    assert.equal(lost.score, -70);
  });
});

describe('Spielwert Farbe/Grand', () => {
  const play = (game, cards, points, tricks = 6, bid = 18) =>
    scoreGame({ game, bid, declarerCards: cards, declarerPoints: points, declarerTricks: tricks });

  test('Herz mit 1: 10 × 2 = 20', () => {
    const r = play(herz(), twelve('kreuz-B'), 70);
    assert.equal(r.multiplier, 2);
    assert.equal(r.value, 20);
    assert.equal(r.score, 20);
    assert.deepEqual(r.levels.map((l) => l.label), ['mit 1', 'Spiel']);
  });

  test('Kreuz ohne 2 Hand: 12 × 4 = 48', () => {
    assert.equal(play(kreuz({ hand: true }), twelve('herz-B'), 70).value, 48);
  });

  test('Grand mit 4: 24 × 5 = 120', () => {
    assert.equal(play(grand(), twelve('kreuz-B', 'pik-B', 'herz-B', 'karo-B'), 80).value, 120);
  });

  test('Schneider erspielt zählt eine Stufe', () => {
    const r = play(herz(), twelve('kreuz-B'), 95, 8);
    assert.equal(r.schneider, true);
    assert.equal(r.value, 30);
  });

  test('Schwarz erspielt: Schneider + Schwarz', () => {
    const r = play(herz(), twelve('kreuz-B'), 120, 10);
    assert.deepEqual(r.levels.map((l) => l.label), ['mit 1', 'Spiel', 'Schneider', 'Schwarz']);
    assert.equal(r.value, 40);
  });

  test('61 Augen gewinnt, 60 verliert (−2×)', () => {
    assert.equal(play(herz(), twelve('kreuz-B'), 61).won, true);
    const lost = play(herz(), twelve('kreuz-B'), 60);
    assert.equal(lost.won, false);
    assert.equal(lost.score, -40);
  });

  test('verloren im Schneider: Schneider-Stufe zählt auch gegen den Alleinspieler', () => {
    const r = play(herz(), twelve('kreuz-B'), 30, 2);
    assert.equal(r.won, false);
    assert.equal(r.value, 30);
    assert.equal(r.score, -60);
  });

  test('Schneider angesagt (Hand): +Schneider +angesagt; nicht erreicht → verloren', () => {
    const game = herz({ hand: true, schneiderAnnounced: true });
    const ok = play(game, twelve('kreuz-B'), 92, 8);
    assert.equal(ok.won, true);
    assert.equal(ok.value, 10 * (1 + 1 + 1 + 1 + 1)); // mit 1, Spiel, Hand, Schneider, angesagt
    const failed = play(game, twelve('kreuz-B'), 85, 8);
    assert.equal(failed.won, false);
    assert.equal(failed.value, 50, 'Wert enthält die Ansage trotzdem');
    assert.equal(failed.score, -100);
  });

  test('Schwarz angesagt: alle Stiche nötig', () => {
    const game = grand({ hand: true, schneiderAnnounced: true, schwarzAnnounced: true });
    const cards = twelve('kreuz-B');
    assert.equal(play(game, cards, 120, 10).value, 24 * 7); // mit 1, Spiel, Hand, Schn., Schn. ang., Schw., Schw. ang.
    assert.equal(play(game, cards, 118, 9).won, false);
  });

  test('Ouvert (Hand): alle Ansagen + Ouvert', () => {
    const game = normalizeGame({ type: 'grand', ouvert: true }, { hand: true });
    const r = play(game, twelve('kreuz-B', 'pik-B'), 120, 10);
    assert.equal(r.multiplier, 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1); // mit 2, Spiel, Hand, Schn., ang., Schw., ang., Ouvert
    assert.equal(r.value, 24 * 9);
  });

  test('überreizt: gereizt 36, Herz mit 1 (= 20) → verloren mit 40, also −80', () => {
    const r = play(herz(), twelve('kreuz-B'), 90, 7, 36);
    assert.equal(r.overbid, true);
    assert.equal(r.won, false);
    assert.equal(r.value, 40);
    assert.equal(r.score, -80);
  });

  test('nicht überreizt, wenn Schneider den Wert hebt', () => {
    // gereizt 30, Herz mit 1 = 20 – mit Schneider 30 → reicht genau
    const r = play(herz(), twelve('kreuz-B'), 91, 8, 30);
    assert.equal(r.overbid, false);
    assert.equal(r.won, true);
    assert.equal(r.value, 30);
  });

  test('überreizt im Grand: nächstes Vielfaches von 24', () => {
    const r = play(grand(), twelve('kreuz-B'), 80, 7, 50);
    assert.equal(r.value, 72);
    assert.equal(r.score, -144);
  });

  test('Grundwerte', () => {
    assert.deepEqual(['karo', 'herz', 'pik', 'kreuz'].map((t) => baseValue({ type: 'suit', trump: t })), [9, 10, 11, 12]);
    assert.equal(baseValue({ type: 'grand' }), 24);
  });
});

describe('Ansage prüfen (normalizeGame)', () => {
  test('Schwarz angesagt schließt Schneider angesagt ein, Ouvert schließt beides ein', () => {
    assert.equal(normalizeGame({ type: 'grand', schwarzAnnounced: true }, { hand: true }).schneiderAnnounced, true);
    const o = normalizeGame({ type: 'suit', trump: 'pik', ouvert: true }, { hand: true });
    assert.equal(o.schwarzAnnounced && o.schneiderAnnounced, true);
  });

  test('Ansagen und Ouvert (außer Null) nur bei Handspiel', () => {
    throwsCode(() => normalizeGame({ type: 'grand', schneiderAnnounced: true }, { hand: false }), 'NUR_HAND');
    throwsCode(() => normalizeGame({ type: 'grand', ouvert: true }, { hand: false }), 'NUR_HAND');
    assert.deepEqual(normalizeGame({ type: 'null', ouvert: true }, { hand: false }), { type: 'null', hand: false, ouvert: true });
  });

  test('ungültige Spiele', () => {
    for (const bad of [null, {}, { type: 'ramsch' }, { type: 'suit', trump: 'blau' }]) {
      throwsCode(() => normalizeGame(bad, { hand: false }), 'SPIEL_UNGUELTIG');
    }
  });

  test('nur bekannte Felder werden übernommen', () => {
    const g = normalizeGame({ type: 'suit', trump: 'karo', evil: 1, schneiderAnnounced: 'ja' }, { hand: true });
    assert.deepEqual(g, { type: 'suit', trump: 'karo', hand: true, schneiderAnnounced: false, schwarzAnnounced: false, ouvert: false });
  });

  test('Bezeichnungen', () => {
    assert.equal(gameLabel(normalizeGame({ type: 'suit', trump: 'herz' }, { hand: true })), 'Herz Hand');
    assert.equal(gameLabel(normalizeGame({ type: 'grand', schneiderAnnounced: true }, { hand: true })), 'Grand Hand Schneider angesagt');
    assert.equal(gameLabel(normalizeGame({ type: 'null', ouvert: true }, { hand: true })), 'Null Ouvert Hand');
    assert.equal(gameLabel(normalizeGame({ type: 'suit', trump: 'pik', ouvert: true }, { hand: true })), 'Pik Hand Ouvert');
  });
});
