// Spielwert nach Skatordnung: Grundwert × Stufen, Null-Festwerte, Reizwerte, Überreizen.
// Reine Funktionen ohne Zustand.

import { SUITS, SUIT_NAMES } from './cards.js';
import { GameError } from './errors.js';

/** Grundwerte der Farbspiele und des Grand */
export const BASE_VALUES = { karo: 9, herz: 10, pik: 11, kreuz: 12, grand: 24 };

/** Null-Spiele haben feste Werte */
export const NULL_VALUES = { plain: 23, hand: 35, ouvert: 46, ouvertHand: 59 };

/** Höchste mögliche Stufenzahl: Spitzen (11 bzw. 4) + Spiel + Hand + Schneider + angesagt + Schwarz + angesagt + Ouvert */
const EXTRA_LEVELS = 7;

/**
 * Alle möglichen Reizwerte, aufsteigend: 18, 20, 22, 23, 24, 27, 30, …, 264.
 * Berechnet statt abgetippt – so kann kein Wert fehlen.
 */
export const BID_VALUES = (() => {
  const values = new Set(Object.values(NULL_VALUES));
  for (const suit of SUITS) for (let m = 2; m <= 11 + EXTRA_LEVELS; m++) values.add(BASE_VALUES[suit] * m);
  for (let m = 2; m <= 4 + EXTRA_LEVELS; m++) values.add(BASE_VALUES.grand * m);
  return [...values].sort((a, b) => a - b);
})();

/** Nächster Reizwert über `value` (0 → 18). Über dem Höchstwert → null. */
export function nextBid(value) {
  return BID_VALUES.find((v) => v > value) ?? null;
}

export function baseValue(game) {
  return game.type === 'grand' ? BASE_VALUES.grand : BASE_VALUES[game.trump];
}

export function nullValue(game) {
  if (game.ouvert) return game.hand ? NULL_VALUES.ouvertHand : NULL_VALUES.ouvert;
  return game.hand ? NULL_VALUES.hand : NULL_VALUES.plain;
}

/** Trümpfe von oben nach unten – die Grundlage für die Spitzen */
function trumpLadder(game) {
  const jacks = SUITS.map((s) => `${s}-B`);
  if (game.type === 'grand') return jacks;
  return [...jacks, ...['A', '10', 'K', 'D', '9', '8', '7'].map((r) => `${game.trump}-${r}`)];
}

/**
 * Spitzen: Wie viele Trümpfe von oben hat der Alleinspieler lückenlos ("mit") –
 * oder wie viele fehlen ihm lückenlos ("ohne")? Gezählt wird mit Skat (alle 12 Karten).
 * @returns {{ count: number, with: boolean }}
 */
export function matadors(cards, game) {
  const own = new Set(cards);
  const ladder = trumpLadder(game);
  const hasTop = own.has(ladder[0]);
  let count = 0;
  while (count < ladder.length && own.has(ladder[count]) === hasTop) count++;
  return { count, with: hasTop };
}

/**
 * Spiel-Ansage prüfen und vereinheitlichen.
 * Regeln: Ouvert (außer Null) und Schneider/Schwarz ansagen nur bei Handspiel;
 * Schwarz angesagt schließt Schneider angesagt ein, Ouvert schließt beides ein.
 * @param {object} spec  z. B. { type: 'suit', trump: 'herz', schneiderAnnounced: true }
 * @param {{ hand: boolean }} context  hand = Skat wurde nicht aufgenommen
 */
export function normalizeGame(spec, { hand }) {
  if (!spec || typeof spec !== 'object') throw invalid();
  const ouvert = spec.ouvert === true;
  if (spec.type === 'null') return { type: 'null', hand, ouvert };
  if (spec.type !== 'grand' && !(spec.type === 'suit' && SUITS.includes(spec.trump))) throw invalid();

  const schwarzAnnounced = spec.schwarzAnnounced === true || ouvert;
  const schneiderAnnounced = spec.schneiderAnnounced === true || schwarzAnnounced;
  if (ouvert && !hand) throw new GameError('NUR_HAND', 'Ouvert geht (außer beim Null) nur als Handspiel.');
  if (schneiderAnnounced && !hand) throw new GameError('NUR_HAND', 'Schneider oder Schwarz ansagen geht nur beim Handspiel.');

  const game = spec.type === 'grand' ? { type: 'grand' } : { type: 'suit', trump: spec.trump };
  return { ...game, hand, schneiderAnnounced, schwarzAnnounced, ouvert };
}

const invalid = () => new GameError('SPIEL_UNGUELTIG', 'Bitte Kreuz, Pik, Herz, Karo, Grand oder Null wählen.');

/** Lesbarer Name: "Herz Hand Schneider angesagt", "Null Ouvert", "Grand" … */
export function gameLabel(game) {
  if (!game) return '';
  const parts = [game.type === 'null' ? 'Null' : game.type === 'grand' ? 'Grand' : SUIT_NAMES[game.trump]];
  if (game.type === 'null') {
    if (game.ouvert) parts.push('Ouvert');
    if (game.hand) parts.push('Hand');
    return parts.join(' ');
  }
  if (game.hand) parts.push('Hand');
  if (game.ouvert) parts.push('Ouvert');
  else if (game.schwarzAnnounced) parts.push('Schwarz angesagt');
  else if (game.schneiderAnnounced) parts.push('Schneider angesagt');
  return parts.join(' ');
}

/**
 * Abrechnung einer Runde.
 * @param {object} p
 * @param {object} p.game              vereinheitlichtes Spiel (normalizeGame)
 * @param {number} p.bid               gereizter Wert
 * @param {string[]} p.declarerCards   alle 12 Karten des Alleinspielers (Hand + Skat) – für die Spitzen
 * @param {number} p.declarerPoints    Augen des Alleinspielers inkl. Skat/Gedrücktem
 * @param {number} p.declarerTricks
 * @param {number} [p.totalTricks]
 * @returns {object} won, value, score, levels (Aufschlüsselung), overbid, reason …
 */
export function scoreGame({ game, bid, declarerCards, declarerPoints, declarerTricks, totalTricks = 10 }) {
  const defenderPoints = 120 - declarerPoints;

  if (game.type === 'null') {
    const value = nullValue(game);
    const won = declarerTricks === 0;
    return {
      won,
      value,
      score: won ? value : -2 * value,
      bid,
      declarerPoints,
      defenderPoints,
      declarerTricks,
      overbid: false,
      levels: [],
      base: null,
      reason: won ? null : 'Alleinspieler hat einen Stich bekommen',
    };
  }

  const base = baseValue(game);
  const spitzen = matadors(declarerCards, game);
  const schneider = declarerPoints <= 30 || defenderPoints <= 30;
  const schwarz = declarerTricks === 0 || declarerTricks === totalTricks;

  // Aufschlüsselung der Stufen – wird auch so in der Oberfläche angezeigt
  const levels = [{ label: `${spitzen.with ? 'mit' : 'ohne'} ${spitzen.count}`, n: spitzen.count }, { label: 'Spiel', n: 1 }];
  if (game.hand) levels.push({ label: 'Hand', n: 1 });
  if (schneider || game.schneiderAnnounced) levels.push({ label: 'Schneider', n: 1 });
  if (game.schneiderAnnounced) levels.push({ label: 'Schneider angesagt', n: 1 });
  if (schwarz || game.schwarzAnnounced) levels.push({ label: 'Schwarz', n: 1 });
  if (game.schwarzAnnounced) levels.push({ label: 'Schwarz angesagt', n: 1 });
  if (game.ouvert) levels.push({ label: 'Ouvert', n: 1 });
  const multiplier = levels.reduce((sum, l) => sum + l.n, 0);

  let value = base * multiplier;
  let reason = null;
  if (declarerPoints < 61) reason = 'weniger als 61 Augen';
  else if (game.schneiderAnnounced && defenderPoints > 30) reason = 'Schneider angesagt, aber nicht erreicht';
  else if (game.schwarzAnnounced && declarerTricks !== totalTricks) reason = 'Schwarz angesagt, aber nicht erreicht';

  // Überreizt: verloren mit dem kleinsten Vielfachen des Grundwerts, das den Reizwert erreicht
  const overbid = value < bid;
  if (overbid) {
    value = Math.ceil(bid / base) * base;
    reason = `überreizt (Spielwert ${base * multiplier} < gereizt ${bid})`;
  }

  const won = reason === null;
  return {
    won,
    value,
    score: won ? value : -2 * value,
    bid,
    declarerPoints,
    defenderPoints,
    declarerTricks,
    overbid,
    levels,
    multiplier,
    base,
    schneider,
    schwarz,
    reason,
  };
}
