// Das Skatblatt: 32 Karten, französisches Bild mit deutschen Bezeichnungen.
// Eine Karte ist ein lesbarer Text "<farbe>-<wert>", z. B. "herz-B" (Herz-Bube) oder "pik-10".

import { randomInt as cryptoRandomInt } from 'node:crypto';

/** Farben in Skat-Rangfolge (wichtig für die Buben: Kreuz > Pik > Herz > Karo). */
export const SUITS = ['kreuz', 'pik', 'herz', 'karo'];

/** Werte von niedrig nach hoch in der normalen Farb-Reihenfolge (7 < 8 < 9 < D < K < 10 < A). B ist Sonderfall. */
export const RANKS = ['7', '8', '9', '10', 'B', 'D', 'K', 'A'];

/** Augen pro Wert. Summe über das ganze Blatt: 120. */
export const POINTS = { A: 11, 10: 10, K: 4, D: 3, B: 2, 9: 0, 8: 0, 7: 0 };

export const SUIT_NAMES = { kreuz: 'Kreuz', pik: 'Pik', herz: 'Herz', karo: 'Karo' };

/** Alle 32 Karten in fester Reihenfolge. */
export function createDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => `${suit}-${rank}`));
}

/** "herz-10" → { suit: 'herz', rank: '10' }. Unbekannt → null. */
export function parseCard(card) {
  if (typeof card !== 'string') return null;
  const [suit, rank, extra] = card.split('-');
  if (extra !== undefined || !SUITS.includes(suit) || !RANKS.includes(rank)) return null;
  return { suit, rank };
}

export const isCard = (card) => parseCard(card) !== null;

export function cardPoints(card) {
  return POINTS[parseCard(card).rank];
}

export function sumPoints(cards) {
  return cards.reduce((sum, card) => sum + cardPoints(card), 0);
}

/**
 * Fisher-Yates-Mischen mit kryptografischem Zufall (node:crypto).
 * Math.random wäre vorhersagbar – bei Karten will man das nicht.
 * Gibt ein NEUES Array zurück, das Original bleibt unverändert.
 * @param {string[]} cards
 * @param {(max: number) => number} [randomInt]  liefert 0 … max-1 (für Tests austauschbar)
 */
export function shuffle(cards, randomInt = cryptoRandomInt) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
