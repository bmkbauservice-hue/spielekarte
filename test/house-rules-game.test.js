// Hausregeln im Spielablauf: Kontra/Re, Bock-Faktor, Schenken.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SkatGame, GameError } from '../src/game/game.js';

const HAND_0 = ['kreuz-B', 'pik-B', 'herz-A', 'herz-10', 'herz-K', 'pik-A', 'pik-8', 'kreuz-A', 'kreuz-10', 'karo-A'];
const HAND_1 = ['herz-B', 'herz-D', 'herz-9', 'pik-K', 'pik-7', 'pik-D', 'kreuz-K', 'kreuz-D', 'karo-10', 'karo-K'];
const HAND_2 = ['karo-B', 'herz-8', 'herz-7', 'kreuz-9', 'kreuz-8', 'kreuz-7', 'karo-D', 'karo-9', 'karo-8', 'karo-7'];
const SKAT = ['pik-10', 'pik-9'];
const V = 0, M = 1, H = 2;
const ALL = { kontra: true, bock: true, schenken: true };
const KONTRA = { kontra: true, bock: true, schenken: false };

const make = (houseRules = ALL, bock = false) =>
  new SkatGame({ dealer: 2, deck: [...HAND_0, ...HAND_1, ...HAND_2, ...SKAT], houseRules, bock });
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof GameError && e.code === code);

/** Vorhand (Platz 0) wird Alleinspieler für 18 */
function forehandAt18(g) {
  g.bid(M, 'pass');
  g.bid(H, 'pass');
  g.bid(V, 'bid');
  return g;
}
/** Mittelhand (Platz 1) wird Alleinspieler für 18 */
function middleAt18(g) {
  g.bid(M, 'bid');
  g.bid(V, 'pass');
  g.bid(H, 'pass');
  return g;
}
function playOut(g) {
  while (g.phase === 'playing') g.play(g.turn, g.legalFor(g.turn)[0]);
}

describe('Kontra / Re', () => {
  test('Kontra verdoppelt den Spielwert', () => {
    const plain = forehandAt18(make(KONTRA));
    plain.declare(V, { type: 'grand' });
    playOut(plain);

    const kontra = forehandAt18(make(KONTRA));
    kontra.declare(V, { type: 'grand' });
    kontra.play(V, kontra.legalFor(V)[0]); // Alleinspieler spielt aus
    kontra.sayKontra(M); // Mittelhand hat noch keine Karte gespielt
    playOut(kontra);

    assert.equal(kontra.result.won, plain.result.won);
    assert.equal(kontra.result.value, 2 * plain.result.value);
    assert.equal(kontra.result.score, 2 * plain.result.score);
    assert.equal(kontra.result.kontraBy, M);
    assert.deepEqual(kontra.result.factors, [{ label: 'Kontra', factor: 2 }]);
  });

  test('Re (nach Kontra) vervierfacht', () => {
    const plain = middleAt18(make(KONTRA));
    plain.declare(M, { type: 'grand' });
    playOut(plain);

    const g = middleAt18(make(KONTRA));
    g.declare(M, { type: 'grand' });
    throwsCode(() => g.sayRe(M), 'KEIN_RE'); // ohne Kontra kein Re
    g.sayKontra(V); // Vorhand vor dem Ausspielen
    g.play(V, g.legalFor(V)[0]);
    g.sayRe(M); // Alleinspieler vor seiner ersten Karte
    throwsCode(() => g.sayRe(M), 'KEIN_RE');
    playOut(g);
    assert.equal(g.result.value, 4 * plain.result.value);
    assert.equal(g.result.re, true);
  });

  test('Zeitpunkt: nur vor der eigenen ersten Karte, nur ein Kontra', () => {
    const g = forehandAt18(make(KONTRA));
    g.declare(V, { type: 'grand' });
    throwsCode(() => g.sayKontra(V), 'KEIN_KONTRA'); // Alleinspieler
    g.play(V, g.legalFor(V)[0]);
    g.play(M, g.legalFor(M)[0]);
    throwsCode(() => g.sayKontra(M), 'KEIN_KONTRA'); // hat schon gespielt
    assert.equal(g.viewFor(H).canKontra, true);
    assert.equal(g.viewFor(M).canKontra, false);
    g.sayKontra(H);
    throwsCode(() => g.sayKontra(H), 'KEIN_KONTRA');
    assert.equal(g.viewFor(V).canRe, false, 'Alleinspieler hat schon ausgespielt → kein Re mehr');
  });

  test('Hausregel aus → kein Kontra', () => {
    const g = forehandAt18(make({}));
    g.declare(V, { type: 'grand' });
    throwsCode(() => g.sayKontra(M), 'KEIN_KONTRA');
    assert.equal(g.viewFor(M).canKontra, false);
  });

  test('Kontra geht auch im Null', () => {
    const g = forehandAt18(make(KONTRA));
    g.declare(V, { type: 'null' }); // Null Hand 35
    g.sayKontra(M);
    playOut(g);
    assert.equal(Math.abs(g.result.value), 70);
  });
});

describe('Bock-Spiel', () => {
  test('Bock verdoppelt, Kontra im Bock = ×4', () => {
    const plain = forehandAt18(make(KONTRA));
    plain.declare(V, { type: 'grand' });
    playOut(plain);

    const bock = forehandAt18(make(KONTRA, true));
    bock.declare(V, { type: 'grand' });
    bock.sayKontra(M);
    playOut(bock);
    assert.equal(bock.result.value, 4 * plain.result.value);
    assert.equal(bock.result.bock, true);
    assert.deepEqual(bock.result.factors.map((f) => f.label), ['Kontra', 'Bock']);
  });
});

describe('Schenken', () => {
  function declaredGrand(houseRules = ALL, bock = false) {
    const g = forehandAt18(make(houseRules, bock));
    g.declare(V, { type: 'grand' });
    return g;
  }

  test('nach der Ansage: Phase "Schenken", noch keine Karte spielbar', () => {
    const g = declaredGrand();
    assert.equal(g.phase, 'gift');
    throwsCode(() => g.play(V, 'kreuz-B'), 'FALSCHE_PHASE');
    throwsCode(() => g.offerGift(V, true), 'NUR_GEGENSPIELER');
    throwsCode(() => g.answerGift(V, true), 'KEIN_GESCHENK');
  });

  test('einer schenkt nicht → normal spielen, Alleinspieler wird nicht gefragt', () => {
    const g = declaredGrand();
    g.offerGift(M, true);
    assert.equal(g.phase, 'gift');
    g.offerGift(H, false);
    assert.equal(g.phase, 'playing');
    assert.equal(g.turn, V);
    assert.equal(g.gift.declinedBy, H);
    assert.equal(g.game.schneiderAnnounced, false, 'keine Verschärfung');
  });

  test('beide schenken + Alleinspieler nimmt an → sofort gewonnen mit einfachem Spielwert', () => {
    const g = declaredGrand();
    g.offerGift(M, true);
    throwsCode(() => g.offerGift(M, true), 'SCHON_ENTSCHIEDEN');
    g.offerGift(H, true);
    assert.equal(g.gift.awaitingDeclarer, true);
    assert.equal(g.turn, V);
    throwsCode(() => g.answerGift(M, true), 'NICHT_ALLEINSPIELER');
    g.answerGift(V, true);
    assert.equal(g.phase, 'finished');
    assert.equal(g.result.gift, true);
    assert.equal(g.result.won, true);
    // Grand Hand, mit 2 (Kreuz- und Pik-Bube): 24 × (2 + Spiel + Hand) = 96
    assert.equal(g.result.value, 96);
    assert.equal(g.result.score, 96);
  });

  test('Geschenk im Bock zählt doppelt', () => {
    const g = declaredGrand(ALL, true);
    g.offerGift(M, true);
    g.offerGift(H, true);
    g.answerGift(V, true);
    assert.equal(g.result.value, 192);
  });

  test('beide schenken + Alleinspieler lehnt ab → normal ausspielen, Schneider wird Pflicht', () => {
    const g = declaredGrand();
    g.offerGift(M, true);
    g.offerGift(H, true);
    g.answerGift(V, false);
    assert.equal(g.phase, 'playing');
    assert.equal(g.gift.refused, true);
    assert.equal(g.game.schneiderAnnounced, true);
    playOut(g);
    const labels = g.result.levels.map((l) => l.label);
    assert.ok(labels.includes('Schneider angesagt'), labels.join(', '));
    if (g.result.defenderPoints > 30) assert.equal(g.result.won, false, 'ohne Schneider verloren');
  });

  test('kein Schenken im Null, bei Ansagen oder wenn die Hausregel aus ist', () => {
    const nullGame = forehandAt18(make());
    nullGame.declare(V, { type: 'null' });
    assert.equal(nullGame.phase, 'playing');
    const announced = forehandAt18(make());
    announced.declare(V, { type: 'grand', schneiderAnnounced: true });
    assert.equal(announced.phase, 'playing');
    assert.equal(declaredGrand({}).phase, 'playing');
  });

  test('nach abgelehntem Schenken ist Kontra noch möglich', () => {
    const g = declaredGrand();
    g.offerGift(M, false);
    g.sayKontra(H);
    assert.equal(g.kontraBy, H);
  });

  test('Sicht: Schenk-Angebote sind öffentlich, Kopie statt Original', () => {
    const g = declaredGrand();
    g.offerGift(M, true);
    const view = g.viewFor(H);
    assert.deepEqual(view.gift.offers, [null, true, null]);
    view.gift.offers[2] = true;
    assert.equal(g.gift.offers[2], null);
  });
});
