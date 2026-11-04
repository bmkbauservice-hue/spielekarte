// Eine Skat-Runde: Geben → Spiel ansagen → 10 Stiche → Auswertung.
// Reine Logik ohne Netzwerk. Plätze heißen 0, 1, 2 (im Uhrzeigersinn).
//
// Etappe 2 (ohne Reizen): Vorhand ist Alleinspieler und wählt Farbe oder Grand.
// Der Skat bleibt liegen und zählt am Ende für den Alleinspieler. Reizen, Skat aufnehmen/drücken → Etappe 3.

import { createDeck, shuffle, sumPoints, isCard } from './cards.js';
import { isValidGame, legalCards, trickWinner, evaluate, sortHand } from './rules.js';

export const PLAYERS = 3;
const HAND_SIZE = 10;

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

const next = (seat) => (seat + 1) % PLAYERS;

export class SkatGame {
  /**
   * @param {{ dealer?: number, deck?: string[] }} [options]
   *   `deck`: feste Kartenreihenfolge für Tests. Ohne → frisch gemischt (crypto).
   */
  constructor({ dealer = 0, deck } = {}) {
    const cards = deck ? checkDeck(deck) : shuffle(createDeck());

    this.dealer = dealer;
    this.forehand = next(dealer); // Vorhand: links vom Geber, spielt den ersten Stich aus
    this.declarer = this.forehand;

    // Geben: Vorhand bekommt die ersten 10, dann Mittelhand, dann Hinterhand (Geber), Rest in den Skat.
    this.hands = [[], [], []];
    for (let i = 0; i < PLAYERS; i++) {
      this.hands[(this.forehand + i) % PLAYERS] = cards.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE);
    }
    this.skat = cards.slice(PLAYERS * HAND_SIZE);

    this.phase = 'declaring'; // 'declaring' | 'playing' | 'finished'
    this.game = null;
    this.turn = this.declarer; // wer gerade handeln muss
    /** @type {{ seat: number, card: string }[]} */
    this.trick = [];
    this.lastTrick = null;
    /** gewonnene Karten pro Platz */
    this.won = [[], [], []];
    this.tricksWon = [0, 0, 0];
    this.result = null;
  }

  /** Alleinspieler legt das Spiel fest: { type: 'grand' } oder { type: 'suit', trump: 'herz' }. */
  declare(seat, game) {
    if (this.phase !== 'declaring') throw new GameError('FALSCHE_PHASE', 'Das Spiel wurde schon angesagt.');
    if (seat !== this.declarer) throw new GameError('NICHT_ALLEINSPIELER', 'Nur der Alleinspieler sagt das Spiel an.');
    if (!isValidGame(game)) throw new GameError('SPIEL_UNGUELTIG', 'Bitte Kreuz, Pik, Herz, Karo oder Grand wählen.');
    this.game = game.type === 'grand' ? { type: 'grand' } : { type: 'suit', trump: game.trump };
    this.phase = 'playing';
    this.turn = this.forehand;
  }

  /** Erlaubte Karten für einen Platz (leer, wenn er nicht dran ist). */
  legalFor(seat) {
    if (this.phase !== 'playing' || seat !== this.turn) return [];
    return legalCards(this.hands[seat], this.trick.map((t) => t.card), this.game);
  }

  play(seat, card) {
    if (this.phase !== 'playing') throw new GameError('FALSCHE_PHASE', 'Gerade kann keine Karte gespielt werden.');
    if (seat !== this.turn) throw new GameError('NICHT_DRAN', 'Du bist nicht dran.');
    if (!isCard(card) || !this.hands[seat].includes(card)) {
      throw new GameError('KARTE_FEHLT', 'Diese Karte hast du nicht auf der Hand.');
    }
    if (!this.legalFor(seat).includes(card)) {
      throw new GameError('BEDIENPFLICHT', 'Du musst die ausgespielte Farbe bedienen.');
    }

    this.hands[seat] = this.hands[seat].filter((c) => c !== card);
    this.trick.push({ seat, card });

    if (this.trick.length < PLAYERS) {
      this.turn = next(seat);
      return;
    }

    // Stich komplett: Gewinner nimmt die Karten und spielt als Nächster aus.
    const cards = this.trick.map((t) => t.card);
    const winner = this.trick[trickWinner(cards, this.game)].seat;
    this.won[winner].push(...cards);
    this.tricksWon[winner]++;
    this.lastTrick = { cards: this.trick, winner };
    this.trick = [];
    this.turn = winner;

    if (this.hands.every((h) => h.length === 0)) this.finish();
  }

  finish() {
    const skatPoints = sumPoints(this.skat);
    const declarerPoints = sumPoints(this.won[this.declarer]) + skatPoints; // Skat zählt für den Alleinspieler
    this.result = {
      ...evaluate(declarerPoints, this.tricksWon[this.declarer]),
      skatPoints,
      declarerTricks: this.tricksWon[this.declarer],
    };
    this.phase = 'finished';
    this.turn = null;
  }

  /**
   * Was ein Platz sehen darf. `seat` = null → Zuschauer.
   * Fremde Handkarten und der Skat (bis zum Ende) sind NIE enthalten.
   */
  viewFor(seat) {
    const isPlayer = Number.isInteger(seat) && seat >= 0 && seat < PLAYERS;
    const finished = this.phase === 'finished';
    return {
      phase: this.phase,
      dealer: this.dealer,
      forehand: this.forehand,
      declarer: this.declarer,
      game: this.game ? { ...this.game } : null,
      turn: this.turn,
      hand: isPlayer ? sortHand(this.hands[seat], this.game ?? undefined) : null,
      legal: isPlayer ? this.legalFor(seat) : [],
      handCounts: this.hands.map((h) => h.length),
      trick: this.trick.map((t) => ({ ...t })),
      lastTrick: this.lastTrick
        ? { winner: this.lastTrick.winner, cards: this.lastTrick.cards.map((t) => ({ ...t })) }
        : null,
      tricksWon: [...this.tricksWon],
      skat: finished ? [...this.skat] : null,
      result: finished ? { ...this.result } : null,
    };
  }
}

function checkDeck(deck) {
  const all = createDeck();
  if (deck.length !== all.length || new Set(deck).size !== all.length || !deck.every((c) => all.includes(c))) {
    throw new Error('Ungültiges Blatt: Es müssen genau die 32 Skatkarten sein.');
  }
  return [...deck];
}
