import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEvening, seegerFabianTotals, simpleTotals, placements } from '../src/game/stats.js';

const won = (round, declarer, label, value) => ({ round, declarer, label, bid: 18, value, score: value, won: true });
const lost = (round, declarer, label, value) => ({ round, declarer, label, bid: 18, value, score: -2 * value, won: false });
const passed = (round) => ({ round, declarer: null, label: 'eingepasst', bid: null, value: 0, score: 0, won: null });

// Ein kleiner Abend: Anna gewinnt Grand (48) und Herz (20), Ben verliert Pik (22), einmal eingepasst, Cem gewinnt Null (23)
const ROWS = [won(1, 0, 'Grand', 48), lost(2, 1, 'Pik', 22), passed(3), won(4, 0, 'Herz', 20), won(5, 2, 'Null', 23)];
const NAMES = ['Anna', 'Ben', 'Cem'];

describe('Einfache Liste', () => {
  test('gewonnen +Wert, verloren −2×Wert, eingepasst 0', () => {
    assert.deepEqual(simpleTotals(ROWS), [68, -44, 23]);
  });
});

describe('Seeger-Fabian', () => {
  test('gewonnen +50, verloren −50 und je +40 für die Gegenspieler', () => {
    // Anna: 48+50 + 20+50 + 40 (Ben verliert) = 208
    // Ben:  −44−50 = −94
    // Cem:  40 (Ben verliert) + 23+50 = 113
    assert.deepEqual(seegerFabianTotals(ROWS), [208, -94, 113]);
  });

  test('eingepasst zählt nichts', () => {
    assert.deepEqual(seegerFabianTotals([passed(1)]), [0, 0, 0]);
  });
});

describe('Platzierung', () => {
  test('nach Punkten, Gleichstand teilt sich den Platz', () => {
    assert.deepEqual(placements([68, -44, 23]), [1, 3, 2]);
    assert.deepEqual(placements([10, 10, 5]), [1, 1, 3]);
    assert.deepEqual(placements([0, 0, 0]), [1, 1, 1]);
  });
});

describe('Abendwertung', () => {
  const summary = summarizeEvening({ rows: ROWS, names: NAMES, startedAt: 1_000, endedAt: 1_000 + 65 * 60_000 });

  test('pro Spieler: Punkte, Seeger-Fabian, Platz', () => {
    assert.deepEqual(summary.players.map((p) => [p.name, p.points, p.seegerFabian, p.place]), [
      ['Anna', 68, 208, 1],
      ['Ben', -44, -94, 3],
      ['Cem', 23, 113, 2],
    ]);
  });

  test('Spiele als Alleinspieler, gewonnen, verloren', () => {
    assert.deepEqual(summary.players.map((p) => [p.declarerGames, p.won, p.lost]), [[2, 2, 0], [1, 0, 1], [1, 1, 0]]);
  });

  test('bestes Spiel = höchster gewonnener Spielwert', () => {
    assert.deepEqual(summary.players[0].best, { label: 'Grand', value: 48, round: 1 });
    assert.equal(summary.players[1].best, null, 'nur verloren → kein bestes Spiel');
    assert.deepEqual(summary.players[2].best, { label: 'Null', value: 23, round: 5 });
  });

  test('gesamt: Spiele, eingepasst, Dauer', () => {
    assert.equal(summary.games, 5);
    assert.equal(summary.passed, 1);
    assert.equal(summary.durationMs, 65 * 60_000);
  });

  test('leerer Abend', () => {
    const empty = summarizeEvening({ rows: [], names: NAMES, startedAt: 5, endedAt: 5 });
    assert.equal(empty.games, 0);
    assert.deepEqual(empty.players.map((p) => p.place), [1, 1, 1]);
    assert.equal(empty.players[0].best, null);
  });

  test('Summe der einfachen Liste stimmt mit den Zeilen überein', () => {
    const total = summary.players.reduce((s, p) => s + p.points, 0);
    assert.equal(total, ROWS.reduce((s, r) => s + r.score, 0));
  });
});
