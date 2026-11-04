// Eine Skat-Runde: Geben → Reizen → Skat aufnehmen/drücken oder Hand → Ansage → Stiche → Abrechnung.
// Reine Logik ohne Netzwerk. Plätze heißen 0, 1, 2 (im Uhrzeigersinn).
//
// Phasen:
//   'bidding'   Reizen (siehe bidding.js)
//   'passed'    alle haben gepasst – eingepasst, Runde ohne Wertung
//   'skat'      Alleinspieler: Skat aufnehmen ODER direkt ansagen (= Handspiel)
//   'discard'   Alleinspieler hat 12 Karten und drückt 2
//   'declaring' Alleinspieler sagt an (nach dem Drücken, kein Handspiel)
//   'playing'   10 Stiche (Null endet vorzeitig, sobald der Alleinspieler einen Stich bekommt)
//   'finished'  Abrechnung steht fest

import { createDeck, shuffle, sumPoints, isCard } from './cards.js';
import { legalCards, trickWinner, sortHand } from './rules.js';
import { Bidding } from './bidding.js';
import { normalizeGame, nullValue, scoreGame, gameLabel } from './scoring.js';
import { GameError } from './errors.js';

export { GameError };
export const PLAYERS = 3;
const HAND_SIZE = 10;

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
    this.middle = next(this.forehand);
    this.rear = dealer;

    // Geben: Vorhand bekommt die ersten 10, dann Mittelhand, dann Hinterhand (Geber), Rest in den Skat.
    this.hands = [[], [], []];
    for (let i = 0; i < PLAYERS; i++) {
      this.hands[(this.forehand + i) % PLAYERS] = cards.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE);
    }
    this.skat = cards.slice(PLAYERS * HAND_SIZE);

    this.bidding = new Bidding(dealer);
    this.phase = 'bidding';
    this.turn = this.bidding.turn; // wer gerade handeln muss
    this.declarer = null;
    this.bidValue = null; // gereizter Wert (Achtung: nicht "bid" nennen – das ist die Methode)
    this.declarerCards = null; // alle 12 Karten des Alleinspielers – Grundlage für die Spitzen
    this.skatTaken = false;
    this.discarded = null;
    this.game = null;

    /** @type {{ seat: number, card: string }[]} */
    this.trick = [];
    this.lastTrick = null;
    this.won = [[], [], []];
    this.tricksWon = [0, 0, 0];
    this.result = null;
  }

  // ---------- Reizen ----------

  /** action: 'bid' (sagen/weiter, bzw. Vorhand "18 spielen"), 'hold' ("Ja"), 'pass' */
  bid(seat, action) {
    this.requirePhase('bidding');
    this.bidding.act(seat, action);
    this.turn = this.bidding.turn;
    if (!this.bidding.done) return;

    if (this.bidding.declarer === null) {
      this.phase = 'passed';
      this.turn = null;
      return;
    }
    this.declarer = this.bidding.declarer;
    this.bidValue = this.bidding.value;
    this.declarerCards = [...this.hands[this.declarer], ...this.skat];
    this.phase = 'skat';
    this.turn = this.declarer;
  }

  // ---------- Skat ----------

  pickUpSkat(seat) {
    this.requireDeclarer(seat, 'skat');
    this.hands[seat] = [...this.hands[seat], ...this.skat];
    this.skatTaken = true;
    this.phase = 'discard';
  }

  /** Zwei Karten drücken. Sie zählen am Ende für den Alleinspieler. */
  discard(seat, cards) {
    this.requireDeclarer(seat, 'discard');
    const hand = this.hands[seat];
    const valid =
      Array.isArray(cards) && cards.length === 2 && cards[0] !== cards[1] &&
      cards.every((c) => isCard(c) && hand.includes(c));
    if (!valid) throw new GameError('DRUECKEN_UNGUELTIG', 'Bitte genau 2 deiner Karten zum Drücken wählen.');
    this.hands[seat] = hand.filter((c) => !cards.includes(c));
    this.discarded = [...cards];
    this.phase = 'declaring';
  }

  // ---------- Ansage ----------

  /**
   * Spiel ansagen. In Phase 'skat' (Skat nicht aufgenommen) ist es automatisch ein Handspiel.
   * @param {object} spec  { type: 'suit'|'grand'|'null', trump?, schneiderAnnounced?, schwarzAnnounced?, ouvert? }
   */
  declare(seat, spec) {
    if (this.phase !== 'skat' && this.phase !== 'declaring') {
      throw new GameError('FALSCHE_PHASE', 'Gerade kann kein Spiel angesagt werden.');
    }
    if (seat !== this.declarer) throw new GameError('NICHT_ALLEINSPIELER', 'Nur der Alleinspieler sagt das Spiel an.');
    const game = normalizeGame(spec, { hand: this.phase === 'skat' });
    // Ein Null-Spiel hat einen festen Wert – darunter darf man es gar nicht erst ansagen
    if (game.type === 'null' && nullValue(game) < this.bidValue) {
      throw new GameError(
        'NULL_ZU_NIEDRIG',
        `${gameLabel(game)} ist nur ${nullValue(game)} wert – gereizt wurde bis ${this.bidValue}.`,
      );
    }
    this.game = game;
    this.startPlay();
  }

  /** Übergang Ansage → Ausspielen. Hier können später Hausregeln (z. B. Schenken) einhaken. */
  startPlay() {
    this.phase = 'playing';
    this.turn = this.forehand;
  }

  // ---------- Stiche ----------

  /** Erlaubte Karten für einen Platz (leer, wenn er nicht dran ist). */
  legalFor(seat) {
    if (this.phase !== 'playing' || seat !== this.turn) return [];
    return legalCards(this.hands[seat], this.trick.map((t) => t.card), this.game);
  }

  play(seat, card) {
    this.requirePhase('playing', 'Gerade kann keine Karte gespielt werden.');
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

    const nullLost = this.game.type === 'null' && winner === this.declarer;
    if (nullLost || this.hands.every((h) => h.length === 0)) this.finish();
  }

  finish() {
    // Im Handspiel zählt der Skat, sonst die gedrückten Karten – beides für den Alleinspieler
    const pile = this.skatTaken ? this.discarded : this.skat;
    const skatPoints = sumPoints(pile);
    this.result = {
      ...scoreGame({
        game: this.game,
        bid: this.bidValue,
        declarerCards: this.declarerCards,
        declarerPoints: sumPoints(this.won[this.declarer]) + skatPoints,
        declarerTricks: this.tricksWon[this.declarer],
      }),
      label: gameLabel(this.game),
      skatPoints,
    };
    this.phase = 'finished';
    this.turn = null;
  }

  // ---------- Sicht eines Spielers ----------

  /**
   * Was ein Platz sehen darf. `seat` = null → Zuschauer.
   * Nie enthalten: fremde Handkarten (Ausnahme: Ouvert), der Skat vor dem Ende,
   * gedrückte Karten für andere als den Alleinspieler.
   */
  viewFor(seat) {
    const isPlayer = Number.isInteger(seat) && seat >= 0 && seat < PLAYERS;
    const isDeclarer = isPlayer && seat === this.declarer;
    const finished = this.phase === 'finished';
    const open = this.game?.ouvert && (this.phase === 'playing' || finished);
    return {
      phase: this.phase,
      dealer: this.dealer,
      forehand: this.forehand,
      middle: this.middle,
      rear: this.rear,
      bidding: this.bidding.view(),
      declarer: this.declarer,
      bid: this.bidValue,
      skatTaken: this.skatTaken,
      game: this.game ? { ...this.game } : null,
      label: gameLabel(this.game),
      turn: this.turn,
      hand: isPlayer ? sortHand(this.hands[seat], this.game ?? undefined) : null,
      legal: isPlayer ? this.legalFor(seat) : [],
      handCounts: this.hands.map((h) => h.length),
      openHand: open ? sortHand(this.hands[this.declarer], this.game) : null,
      trick: this.trick.map((t) => ({ ...t })),
      lastTrick: this.lastTrick
        ? { winner: this.lastTrick.winner, cards: this.lastTrick.cards.map((t) => ({ ...t })) }
        : null,
      tricksWon: [...this.tricksWon],
      discarded: this.discarded && (isDeclarer || finished) ? [...this.discarded] : null,
      skat: finished ? [...this.skat] : null,
      result: finished ? { ...this.result, levels: this.result.levels.map((l) => ({ ...l })) } : null,
    };
  }

  // ---------- Hilfen ----------

  requirePhase(phase, message = 'Das geht in dieser Phase nicht.') {
    if (this.phase !== phase) throw new GameError('FALSCHE_PHASE', message);
  }

  requireDeclarer(seat, phase) {
    this.requirePhase(phase);
    if (seat !== this.declarer) throw new GameError('NICHT_ALLEINSPIELER', 'Das darf nur der Alleinspieler.');
  }
}

function checkDeck(deck) {
  const all = createDeck();
  if (deck.length !== all.length || new Set(deck).size !== all.length || !deck.every((c) => all.includes(c))) {
    throw new Error('Ungültiges Blatt: Es müssen genau die 32 Skatkarten sein.');
  }
  return [...deck];
}
