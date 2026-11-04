// Skat-Regeln als reine Funktionen: Trumpf, Bedienpflicht, Stichgewinner, Auswertung.
//
// Ein "Spiel" (game) ist entweder
//   { type: 'grand' }                 → nur die 4 Buben sind Trumpf
//   { type: 'suit', trump: 'herz' }   → Buben + alle Karten der Trumpffarbe sind Trumpf
// Null-Spiele kommen erst in Etappe 3.

import { SUITS, parseCard } from './cards.js';

export const TRUMP = 'trumpf';

/** Rang innerhalb einer Farbe (ohne Buben): 7 < 8 < 9 < D < K < 10 < A */
const SUIT_ORDER = ['7', '8', '9', 'D', 'K', '10', 'A'];

export function isValidGame(game) {
  if (!game || typeof game !== 'object') return false;
  if (game.type === 'grand') return true;
  return game.type === 'suit' && SUITS.includes(game.trump);
}

export function isTrump(card, game) {
  const { suit, rank } = parseCard(card);
  return rank === 'B' || (game.type === 'suit' && suit === game.trump);
}

/**
 * Zu welcher "Farbe" gehört die Karte im aktuellen Spiel?
 * Kernpunkt: Ein Bube gehört NICHT zu seiner aufgedruckten Farbe, sondern zum Trumpf.
 */
export function effectiveSuit(card, game) {
  return isTrump(card, game) ? TRUMP : parseCard(card).suit;
}

/**
 * Stärke einer Karte (höher = stärker). Trümpfe liegen immer über allen Farbkarten.
 *   Buben:          Kreuz 103 > Pik 102 > Herz 101 > Karo 100
 *   Trumpffarbe:    50 … 56 (7 … A)
 *   normale Farbe:   0 …  6 (7 … A) – zählt nur, wenn es die ausgespielte Farbe ist
 */
export function cardStrength(card, game) {
  const { suit, rank } = parseCard(card);
  if (rank === 'B') return 100 + (SUITS.length - 1 - SUITS.indexOf(suit));
  const base = SUIT_ORDER.indexOf(rank);
  return isTrump(card, game) ? 50 + base : base;
}

/**
 * Bedienpflicht: Wer die ausgespielte (effektive) Farbe hat, muss sie bedienen.
 * Sonst darf jede Karte gespielt werden (abwerfen oder trumpfen).
 * @param {string[]} hand
 * @param {string[]} trickCards  bereits gespielte Karten des aktuellen Stichs, in Reihenfolge
 */
export function legalCards(hand, trickCards, game) {
  if (trickCards.length === 0) return [...hand];
  const lead = effectiveSuit(trickCards[0], game);
  const follow = hand.filter((card) => effectiveSuit(card, game) === lead);
  return follow.length > 0 ? follow : [...hand];
}

/**
 * Wer gewinnt den Stich? Höchster Trumpf – oder, ohne Trumpf, die höchste Karte der ausgespielten Farbe.
 * Abgeworfene Fremdfarben können nie gewinnen (auch kein Ass).
 * @returns {number} Index der Gewinnerkarte in trickCards
 */
export function trickWinner(trickCards, game) {
  const lead = effectiveSuit(trickCards[0], game);
  let best = 0;
  for (let i = 1; i < trickCards.length; i++) {
    if (beats(trickCards[i], trickCards[best], lead, game)) best = i;
  }
  return best;
}

function beats(challenger, current, lead, game) {
  const cTrump = isTrump(challenger, game);
  const kTrump = isTrump(current, game);
  if (cTrump !== kTrump) return cTrump;
  if (!cTrump && effectiveSuit(challenger, game) !== lead) return false; // abgeworfen
  return cardStrength(challenger, game) > cardStrength(current, game);
}

/**
 * Auswertung aus Sicht des Alleinspielers (inkl. Skat).
 * Gewonnen ab 61 Augen. Schneider: eine Partei hat höchstens 30 Augen. Schwarz: eine Partei ohne Stich.
 */
export function evaluate(declarerPoints, declarerTricks, totalTricks = 10) {
  const defenderPoints = 120 - declarerPoints;
  return {
    declarerPoints,
    defenderPoints,
    won: declarerPoints >= 61,
    schneider: declarerPoints <= 30 || defenderPoints <= 30,
    schwarz: declarerTricks === 0 || declarerTricks === totalTricks,
  };
}

/** Hand fürs Anzeigen sortieren: Trümpfe zuerst (stärkste links), dann Farben Kreuz, Pik, Herz, Karo. */
export function sortHand(hand, game = { type: 'grand' }) {
  const group = (card) => {
    if (isTrump(card, game)) return -1;
    return SUITS.indexOf(parseCard(card).suit);
  };
  return [...hand].sort((a, b) => group(a) - group(b) || cardStrength(b, game) - cardStrength(a, game));
}
