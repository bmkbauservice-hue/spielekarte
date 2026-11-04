// Reizen nach Skatordnung als kleiner Zustandsautomat. Reine Logik ohne Netzwerk.
//
//   Runde 1: Mittelhand SAGT (18, 20, 22 …), Vorhand HÖRT ("Ja" oder "Passe").
//   Runde 2: Hinterhand SAGT dem Sieger aus Runde 1 weiter – ab dem erreichten Wert.
//   Runde 3: Hat noch niemand etwas gesagt, darf Vorhand 18 spielen oder passen.
//   Passen alle → eingepasst (declarer = null), es wird neu gegeben.
//
// Aktionen: 'bid' (sagen / "weiter"), 'hold' ("Ja", nur der Hörende), 'pass'.

import { GameError } from './errors.js';
import { nextBid } from './scoring.js';

export const BID_ACTIONS = ['bid', 'hold', 'pass'];

export class Bidding {
  /** @param {number} dealer  Platz des Gebers (0–2) */
  constructor(dealer) {
    this.forehand = (dealer + 1) % 3;
    this.middle = (dealer + 2) % 3;
    this.rear = dealer;

    this.stage = 1;
    this.value = 0; // höchster gesagter und gehaltener Wert (0 = noch nichts gesagt)
    this.speaker = this.middle;
    this.listener = this.forehand;
    this.turn = this.speaker;
    this.passed = [];
    this.done = false;
    this.declarer = null;
    /** @type {{ seat: number, action: string, value: number }[]} für die Anzeige ("Ben: 20", "Anna: Ja") */
    this.history = [];
  }

  /** Rolle dessen, der dran ist: 'speaker' (sagt), 'listener' (hört), 'forehand' (Runde 3) oder null */
  get role() {
    if (this.done) return null;
    if (this.stage === 3) return 'forehand';
    return this.turn === this.speaker ? 'speaker' : 'listener';
  }

  /** Wert, um den es als Nächstes geht (fürs "Weiter: 20" bzw. "Ja (20)") */
  get pendingValue() {
    if (this.role === 'listener') return this.value;
    if (this.role === 'forehand') return 18;
    return nextBid(this.value);
  }

  act(seat, action) {
    if (this.done) throw new GameError('FALSCHE_PHASE', 'Das Reizen ist schon vorbei.');
    if (seat !== this.turn) throw new GameError('NICHT_DRAN', 'Du bist beim Reizen nicht dran.');
    if (!BID_ACTIONS.includes(action)) throw new GameError('AKTION_UNGUELTIG', 'Unbekannte Reiz-Aktion.');

    const role = this.role;
    if (action === 'pass') {
      this.log(seat, action);
      this.passed.push(seat);
      if (role === 'forehand') return this.finish(null); // alle haben gepasst → eingepasst
      return this.stageWonBy(role === 'speaker' ? this.listener : this.speaker);
    }

    if (role === 'forehand') {
      if (action !== 'bid') throw wrongAction();
      this.value = 18;
      this.log(seat, action);
      return this.finish(seat);
    }

    if (role === 'speaker') {
      if (action !== 'bid') throw new GameError('AKTION_UNGUELTIG', 'Du sagst – also weiter reizen oder passen.');
      const next = nextBid(this.value);
      if (next === null) throw new GameError('REIZWERT_MAX', 'Höher kann man nicht reizen.');
      this.value = next;
      this.log(seat, action);
      this.turn = this.listener;
      return;
    }

    // role === 'listener'
    if (action !== 'hold') throw new GameError('AKTION_UNGUELTIG', 'Du hörst – also "Ja" oder passen.');
    this.log(seat, action);
    this.turn = this.speaker;
  }

  /** Eine Reizrunde ist entschieden. */
  stageWonBy(winner) {
    if (this.stage === 1) {
      this.stage = 2;
      this.speaker = this.rear;
      this.listener = winner;
      this.turn = this.rear;
      return;
    }
    if (this.value === 0) {
      // Mittel- und Hinterhand haben gepasst, ohne etwas zu sagen → Vorhand entscheidet
      this.stage = 3;
      this.speaker = this.forehand;
      this.listener = null;
      this.turn = this.forehand;
      return;
    }
    this.finish(winner);
  }

  finish(declarer) {
    this.done = true;
    this.declarer = declarer;
    this.turn = null;
  }

  log(seat, action) {
    this.history.push({ seat, action, value: this.value });
  }

  /** Schnappschuss zum Speichern – reine Daten */
  toJSON() {
    return structuredClone({ ...this });
  }

  static fromJSON(data) {
    return Object.assign(Object.create(Bidding.prototype), structuredClone(data));
  }

  view() {
    return {
      stage: this.stage,
      value: this.value,
      pendingValue: this.done ? null : this.pendingValue,
      turn: this.turn,
      role: this.role,
      speaker: this.speaker,
      listener: this.listener,
      passed: [...this.passed],
      history: this.history.map((h) => ({ ...h })),
    };
  }
}

const wrongAction = () => new GameError('AKTION_UNGUELTIG', 'Diese Aktion passt gerade nicht.');
