// Hausregeln: alles, was über die Skatordnung hinausgeht. Pro Tisch beim Start einschaltbar, Standard: aus.
// Reine Funktionen – game.js und room.js rufen sie nur auf. Neue Hausregeln kommen hierher.
//
//   kontra   Gegenspieler sagt vor seiner ersten Karte "Kontra" (×2), Alleinspieler danach "Re" (×4)
//   bock     Kontra/Re gesagt UND Alleinspieler verliert → 9 Bock-Spiele mit ×2 (nur zusammen mit kontra)
//   schenken Nach der Ansage können beide Gegenspieler schenken; der Alleinspieler nimmt an oder lehnt ab
//            (Ablehnen → Schneider wird Pflicht, gewertet wie "Schneider angesagt")

import { baseValue, matadors } from './scoring.js';

export const HOUSE_RULES = {
  kontra: { label: 'Kontra / Re', description: 'Gegenspieler sagt Kontra (×2), Alleinspieler antwortet Re (×4).' },
  bock: { label: 'Bockrunden', description: 'Verliert der Alleinspieler nach Kontra/Re, folgen 9 Bock-Spiele mit ×2.' },
  schenken: { label: 'Schenken', description: 'Beide Gegenspieler können das Spiel schenken; der Alleinspieler entscheidet.' },
};

export const DEFAULT_HOUSE_RULES = Object.freeze({ kontra: false, bock: false, schenken: false });

/** Bock-Spiele pro Auslöser: 3 Bockrunden × 3 Spiele (jeder gibt einmal) */
export const BOCK_GAMES_PER_TRIGGER = 9;

/** Eingaben säubern: nur bekannte Schalter, nur echte Booleans. Bock ohne Kontra/Re ergibt keinen Sinn. */
export function normalizeHouseRules(input = {}) {
  const on = (key) => input?.[key] === true;
  const kontra = on('kontra');
  return { kontra, bock: kontra && on('bock'), schenken: on('schenken') };
}

/** Faktor für den Spielwert: Kontra ×2, Re ×4 (statt ×2), Bock zusätzlich ×2. */
export function valueFactor({ kontra = false, re = false, bock = false }) {
  return (re ? 4 : kontra ? 2 : 1) * (bock ? 2 : 1);
}

/** Lesbare Faktoren für den Rechenweg, z. B. [{ label: 'Kontra', factor: 2 }, { label: 'Bock', factor: 2 }] */
export function factorList({ kontra = false, re = false, bock = false }) {
  const list = [];
  if (re) list.push({ label: 'Kontra + Re', factor: 4 });
  else if (kontra) list.push({ label: 'Kontra', factor: 2 });
  if (bock) list.push({ label: 'Bock', factor: 2 });
  return list;
}

/** Faktor auf ein Ergebnis anwenden (Wert und Punkte neu berechnen). */
export function applyFactors(result, flags) {
  const factor = valueFactor(flags);
  const value = result.value * factor;
  return { ...result, baseResultValue: result.value, value, score: result.won ? value : -2 * value, factors: factorList(flags) };
}

/**
 * Bock-Zähler nach einem Spiel.
 * Ein Bock-Spiel verbraucht eins (auch eingepasst); ein Auslöser hängt 9 hinten an – kein Stapeln der Faktoren.
 */
export function nextBockCount(remaining, { wasBock, triggered }) {
  let next = wasBock ? Math.max(0, remaining - 1) : remaining;
  if (triggered) next += BOCK_GAMES_PER_TRIGGER;
  return next;
}

/** Auslöser für Bock: Kontra oder Re gesagt UND Alleinspieler verliert. */
export function triggersBock({ kontra, re, won }) {
  return (kontra || re) && won === false;
}

/**
 * Darf `seat` jetzt Kontra sagen? Gegenspieler, noch keine eigene Karte gespielt, noch kein Kontra.
 * @param {{ rules, phase, declarer, kontraBy, cardsPlayed: number[] }} s
 */
export function canSayKontra(s, seat) {
  return (
    s.rules.kontra && s.phase === 'playing' && seat !== s.declarer && s.kontraBy === null && s.cardsPlayed[seat] === 0
  );
}

/** Darf `seat` jetzt Re sagen? Alleinspieler, nach Kontra, vor seiner ersten Karte, noch kein Re. */
export function canSayRe(s, seat) {
  return (
    s.rules.kontra && s.phase === 'playing' && seat === s.declarer && s.kontraBy !== null && !s.re &&
    s.cardsPlayed[seat] === 0
  );
}

/** Schenken möglich? Farbe/Grand ohne Schneider-/Schwarz-Ansage und ohne Ouvert. */
export function giftAllowed(rules, game) {
  return rules.schenken && game.type !== 'null' && !game.schneiderAnnounced && !game.ouvert;
}

/**
 * Wert eines angenommenen Geschenks: einfacher Spielwert = Grundwert × (Spitzen + Spiel + Hand),
 * ohne erspielten Schneider. Liegt er unter dem Reizwert → kleinstes Vielfaches, das den Reizwert erreicht
 * (ein Geschenk wird nie bestraft).
 */
export function giftValue({ game, bid, declarerCards }) {
  const base = baseValue(game);
  const spitzen = matadors(declarerCards, game);
  const levels = [{ label: `${spitzen.with ? 'mit' : 'ohne'} ${spitzen.count}`, n: spitzen.count }, { label: 'Spiel', n: 1 }];
  if (game.hand) levels.push({ label: 'Hand', n: 1 });
  const multiplier = levels.reduce((sum, l) => sum + l.n, 0);
  const simple = base * multiplier;
  const value = simple >= bid ? simple : Math.ceil(bid / base) * base;
  return { value, base, multiplier, levels, raisedToBid: simple < bid };
}
