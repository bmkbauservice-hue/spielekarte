// Reine Raum-Logik: Plätze, Spieler-Tokens, Start.
// Bewusst OHNE Netzwerk-Code, damit alles mit Unit-Tests prüfbar ist.

import { randomBytes } from 'node:crypto';
import { SkatGame } from '../game/game.js';
import { simpleTotals, seegerFabianTotals, summarizeEvening } from '../game/stats.js';
import { DEFAULT_HOUSE_RULES, normalizeHouseRules, nextBockCount, triggersBock } from '../game/house-rules.js';

export const SEAT_COUNT = 3;
export const MAX_SPECTATORS = 20;
export const NAME_MAX_LENGTH = 20;
export const VOTE_MS = 60_000; // Abstimmungen (Abbrechen, Abend beenden) laufen 60 s
export const VOTE_KINDS = ['abort', 'end'];
export const ABSENT_MS = 120_000; // wer 2 min getrennt ist, blockiert den Abbruch nicht

/** Fehler mit maschinenlesbarem Code (für den Client) und deutschem Text (für Menschen). */
export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

/** Karten-ID vereinheitlichen: "muju01" → "MUJU01". Ungültig → null. */
export function normalizeRoomId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toUpperCase();
  return /^[A-Z0-9]{3,16}$/.test(id) ? id : null;
}

/** Namen säubern: Steuerzeichen raus, Leerraum zusammenfassen, max. 20 Zeichen. Leer → null. */
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw
    .normalize('NFC')
    .replace(/[\p{C}]/gu, '') // unsichtbare/Steuer-Zeichen
    .replace(/\s+/g, ' ')
    .trim();
  // Array.from zählt Emoji usw. korrekt als ein Zeichen
  const short = Array.from(name).slice(0, NAME_MAX_LENGTH).join('').trim();
  return short.length > 0 ? short : null;
}

const newToken = () => randomBytes(24).toString('base64url'); // geheim, ~190 Bit Zufall

export class Room {
  /**
   * @param {string} id  bereits normalisierte Karten-ID
   * @param {object} [options]  alles austauschbar, damit Tests Zeit und Kartenverteilung steuern können
   * @param {() => number} [options.now]
   * @param {(opts: { dealer: number }) => SkatGame} [options.createGame]
   * @param {number} [options.voteMs]  so lange läuft eine Abstimmung
   * @param {number} [options.absentMs]     wer so lange getrennt ist, blockiert eine Abstimmung nicht
   */
  constructor(id, {
    now = Date.now,
    createGame = (opts) => new SkatGame(opts),
    voteMs = VOTE_MS,
    absentMs = ABSENT_MS,
  } = {}) {
    this.id = id;
    this.now = now;
    this.createGame = createGame;
    this.voteMs = voteMs;
    this.absentMs = absentMs;
    /** laufende Abstimmung: { kind: 'abort'|'end', by, yes: Set<seat>, expiresAt } */
    this.vote = null;
    this.voteRejectedBy = null;
    /** Punkteliste = Spielhistorie des Abends: eine Zeile pro Runde */
    this.scores = [];
    this.recordedGame = null;
    this.eveningStartedAt = null;
    /** Abendwertung nach "Abend beenden" */
    this.summary = null;
    /** Hausregeln für diesen Tisch – in der Lobby einstellbar, während des Abends fest */
    this.houseRules = { ...DEFAULT_HOUSE_RULES };
    /** noch zu spielende Bock-Spiele */
    this.bockRemaining = 0;
    this.status = 'lobby'; // 'lobby' | 'running' | 'summary'
    /** @type {SkatGame|null} aktuelle Runde */
    this.game = null;
    this.round = 0;
    this.dealer = SEAT_COUNT - 1; // erste Runde: Platz 3 gibt → Platz 1 ist Vorhand
    /** @type {Map<string, Player>} token → Spieler */
    this.players = new Map();
    /** @type {(string|null)[]} Token pro Spielplatz */
    this.seats = Array(SEAT_COUNT).fill(null);
    this.lastActivity = now();
  }

  // ---------- Betreten / Verlassen ----------

  /**
   * Raum betreten. Mit bekanntem Token → derselbe Spieler (z. B. nach Neuladen).
   * Ohne/unbekanntem Token → neuer Spieler, dafür ist ein Name nötig.
   * @returns {{ player: Player, resumed: boolean }}
   */
  join({ name, token } = {}) {
    this.touch();
    const known = typeof token === 'string' ? this.players.get(token) : undefined;

    if (known) {
      const newName = cleanName(name);
      if (newName) known.name = newName;
      return { player: known, resumed: true };
    }

    const clean = cleanName(name);
    if (!clean) {
      if (token) throw new RoomError('TOKEN_UNBEKANNT', 'Deine Sitzung ist abgelaufen. Bitte gib deinen Namen neu ein.');
      throw new RoomError('NAME_UNGUELTIG', 'Bitte gib einen Namen ein (1–20 Zeichen).');
    }

    const freeSeat = this.status === 'lobby' ? this.seats.indexOf(null) : -1;
    if (freeSeat === -1 && this.spectators().length >= MAX_SPECTATORS) {
      throw new RoomError('RAUM_VOLL', 'Der Raum ist voll.');
    }

    const player = {
      token: newToken(),
      id: this.newPublicId(),
      name: clean,
      seat: null,
      connected: false,
      lastSeen: this.now(),
    };
    this.players.set(player.token, player);
    if (freeSeat !== -1) this.assignSeat(player, freeSeat);
    return { player, resumed: false };
  }

  /** Raum endgültig verlassen (Platz wird frei, Token ungültig). */
  leave(token) {
    const p = this.require(token);
    if (p.seat !== null && this.status === 'running') {
      throw new RoomError('SPIEL_LAEUFT', 'Während eines Spiels kannst du den Raum nicht verlassen.');
    }
    this.releaseSeat(p);
    this.players.delete(token);
    this.touch();
  }

  connect(token) {
    const p = this.require(token);
    p.connected = true;
    p.lastSeen = this.now();
    this.touch();
  }

  disconnect(token) {
    const p = this.players.get(token);
    if (!p) return;
    p.connected = false;
    p.lastSeen = this.now();
    this.touch();
  }

  // ---------- Plätze ----------

  takeSeat(token, seat) {
    const p = this.require(token);
    this.requireLobby();
    if (p.seat !== null) throw new RoomError('SITZT_SCHON', 'Du hast schon einen Platz.');
    const index = Number.isInteger(seat) ? seat : this.seats.indexOf(null);
    if (index < 0 || index >= SEAT_COUNT) throw new RoomError('PLATZ_UNGUELTIG', 'Diesen Platz gibt es nicht.');
    if (this.seats[index] !== null) throw new RoomError('PLATZ_BELEGT', 'Dieser Platz ist schon belegt.');
    this.assignSeat(p, index);
    this.touch();
  }

  leaveSeat(token) {
    const p = this.require(token);
    this.requireLobby();
    if (p.seat === null) throw new RoomError('KEIN_PLATZ', 'Du sitzt auf keinem Platz.');
    this.releaseSeat(p);
    this.touch();
  }

  // ---------- Spiel ----------

  /** Startbereit: Lobby, alle 3 Plätze besetzt, alle verbunden. */
  isReady() {
    return (
      this.status !== 'running' &&
      this.seats.every((t) => t !== null && this.players.get(t)?.connected)
    );
  }

  /** Neuen Abend starten – aus der Lobby oder nach der Abendwertung ("Neuer Abend"). */
  start(token) {
    const p = this.require(token);
    if (this.status === 'running') throw new RoomError('SPIEL_LAEUFT', 'Es läuft schon ein Spiel.');
    if (p.seat === null) throw new RoomError('NUR_SPIELER', 'Nur Spieler am Tisch können das Spiel starten.');
    if (!this.isReady()) throw new RoomError('NICHT_BEREIT', 'Es müssen 3 verbundene Spieler am Tisch sitzen.');
    this.status = 'running';
    this.round = 1;
    this.dealer = SEAT_COUNT - 1;
    this.bockRemaining = 0;
    this.game = this.newGame();
    this.scores = []; // neuer Abend = alles auf null
    this.recordedGame = null;
    this.vote = null;
    this.voteRejectedBy = null;
    this.summary = null;
    this.eveningStartedAt = this.now();
    this.touch();
  }

  // ---------- Spielzüge (werden an SkatGame weitergereicht) ----------

  /** Reizen: 'bid' (sagen/weiter/18 spielen), 'hold' ("Ja"), 'pass' */
  bid(token, action) {
    this.gameAction(token, 'reizen', (seat) => this.game.bid(seat, action));
  }

  pickUpSkat(token) {
    this.gameAction(token, 'den Skat aufnehmen', (seat) => this.game.pickUpSkat(seat));
  }

  discard(token, cards) {
    this.gameAction(token, 'drücken', (seat) => this.game.discard(seat, cards));
  }

  /** Ansage: { type: 'suit'|'grand'|'null', trump?, schneiderAnnounced?, schwarzAnnounced?, ouvert? } */
  declare(token, spec) {
    this.gameAction(token, 'das Spiel ansagen', (seat) => this.game.declare(seat, spec));
  }

  playCard(token, card) {
    this.gameAction(token, 'Karten spielen', (seat) => this.game.play(seat, card));
  }

  /** Nach dem Ende (oder Einpassen) einer Runde: neu geben, Geber rückt eins weiter. */
  nextRound(token) {
    this.requireSeatedInGame(token, 'eine neue Runde starten');
    if (!['finished', 'passed'].includes(this.game.phase)) {
      throw new RoomError('RUNDE_LAEUFT', 'Die Runde ist noch nicht zu Ende.');
    }
    this.dealer = (this.dealer + 1) % SEAT_COUNT;
    this.round++;
    this.game = this.newGame();
    this.touch();
  }

  newGame() {
    return this.createGame({ dealer: this.dealer, houseRules: this.houseRules, bock: this.bockRemaining > 0 });
  }

  /** Hausregeln einstellen – nur in der Lobby, nur Spieler am Tisch. */
  setHouseRules(token, rules) {
    const p = this.require(token);
    this.requireLobby();
    if (p.seat === null) throw new RoomError('NUR_SPIELER', 'Nur Spieler am Tisch können die Hausregeln ändern.');
    this.houseRules = normalizeHouseRules(rules);
    this.touch();
  }

  // ---------- Hausregeln im Spiel ----------

  sayKontra(token) {
    this.gameAction(token, 'Kontra sagen', (seat) => this.game.sayKontra(seat));
  }

  sayRe(token) {
    this.gameAction(token, 'Re sagen', (seat) => this.game.sayRe(seat));
  }

  offerGift(token, yes) {
    this.gameAction(token, 'schenken', (seat) => this.game.offerGift(seat, yes));
  }

  answerGift(token, accept) {
    this.gameAction(token, 'das Geschenk annehmen', (seat) => this.game.answerGift(seat, accept));
  }

  gameAction(token, verb, fn) {
    const p = this.requireSeatedInGame(token, verb);
    fn(p.seat);
    this.recordScore();
    this.touch();
  }

  /** Runde in die Punkteliste (= Spielhistorie) eintragen – genau einmal pro Runde. Danach Bock-Zähler fortschreiben. */
  recordScore() {
    const g = this.game;
    if (this.recordedGame === g) return;
    const extra = { bock: g.bock, kontraBy: null, re: false, gift: false };
    if (g.phase === 'passed') {
      this.scores.push({ round: this.round, declarer: null, label: 'eingepasst', bid: null, value: 0, score: 0, won: null, ...extra });
    } else if (g.phase === 'finished') {
      const r = g.result;
      this.scores.push({
        round: this.round, declarer: g.declarer, label: r.label, bid: g.bidValue, value: r.value, score: r.score, won: r.won,
        ...extra, kontraBy: r.kontraBy, re: r.re, gift: r.gift,
      });
    } else {
      return;
    }
    this.recordedGame = g;
    const row = this.scores.at(-1);
    const triggered = this.houseRules.bock && triggersBock({ kontra: row.kontraBy !== null, re: row.re, won: row.won });
    this.bockRemaining = nextBockCount(this.bockRemaining, { wasBock: row.bock, triggered });
  }

  /** Summe pro Platz: gewonnen +Spielwert, verloren −2× Spielwert */
  totals() {
    return simpleTotals(this.scores);
  }

  // ---------- Abstimmungen: Abbrechen / Abend beenden – nur gemeinsam ----------

  /**
   * Abstimmung vorschlagen (zählt gleich als eigene Zustimmung).
   * kind 'abort' → zurück in die Lobby, 'end' → Abendwertung.
   */
  requestVote(token, kind) {
    if (!VOTE_KINDS.includes(kind)) throw new RoomError('ABSTIMMUNG_UNGUELTIG', 'Unbekannte Abstimmung.');
    const p = this.requireSeatedInGame(token, 'eine Abstimmung vorschlagen');
    this.expireVote();
    if (this.vote && this.vote.kind !== kind) {
      throw new RoomError('ABSTIMMUNG_LAEUFT', 'Es läuft schon eine andere Abstimmung.');
    }
    if (!this.vote) {
      this.vote = { kind, by: p.seat, yes: new Set(), expiresAt: this.now() + this.voteMs };
      this.voteRejectedBy = null;
    }
    this.vote.yes.add(p.seat);
    this.checkVote();
    this.touch();
  }

  /** Zustimmen (agree = true) oder ablehnen. Eine Ablehnung beendet die Abstimmung sofort. */
  castVote(token, agree) {
    const p = this.requireSeatedInGame(token, 'abstimmen');
    this.expireVote();
    if (!this.vote) throw new RoomError('KEINE_ABSTIMMUNG', 'Es läuft gerade keine Abstimmung.');
    if (agree !== true) {
      this.vote = null;
      this.voteRejectedBy = p.seat;
    } else {
      this.vote.yes.add(p.seat);
      this.checkVote();
    }
    this.touch();
  }

  /** Alle zugestimmt? Wer länger als absentMs getrennt ist, blockiert nicht (sonst hinge der Tisch fest). */
  checkVote() {
    if (this.voteMissing().length > 0) return false;
    const { kind } = this.vote;
    this.vote = null;
    if (kind === 'end') {
      this.summary = summarizeEvening({
        rows: this.scores,
        names: this.seats.map((t) => this.players.get(t).name),
        startedAt: this.eveningStartedAt,
        endedAt: this.now(),
      });
      this.status = 'summary';
    } else {
      this.status = 'lobby';
    }
    this.game = null;
    return true;
  }

  voteMissing() {
    const now = this.now();
    return this.seats
      .map((t, seat) => ({ seat, p: this.players.get(t) }))
      .filter(({ seat, p }) => !this.vote.yes.has(seat) && (p.connected || now - p.lastSeen < this.absentMs))
      .map(({ seat }) => seat);
  }

  /** Abgelaufene Abstimmung verwerfen. @returns {boolean} ob etwas abgelaufen ist */
  expireVote() {
    if (this.vote && this.now() >= this.vote.expiresAt) {
      this.vote = null;
      return true;
    }
    return false;
  }

  /** Nach der Abendwertung zurück in die Lobby (Plätze wieder frei wählbar). */
  backToLobby(token) {
    const p = this.require(token);
    if (this.status !== 'summary') throw new RoomError('KEINE_WERTUNG', 'Es gibt gerade keine Abendwertung.');
    if (p.seat === null) throw new RoomError('NUR_SPIELER', 'Nur Spieler am Tisch können das.');
    this.status = 'lobby';
    this.summary = null;
    this.touch();
  }

  // ---------- Aufräumen ----------

  /**
   * Entfernt Spieler, die länger als `maxIdleMs` getrennt sind.
   * Ausnahme: Während eines Spiels bleiben Tisch-Spieler erhalten (sie sollen zurückkommen können).
   * @returns {number} Anzahl entfernter Spieler
   */
  removeStale(maxIdleMs) {
    const now = this.now();
    let removed = 0;
    for (const p of [...this.players.values()]) {
      if (p.connected || now - p.lastSeen <= maxIdleMs) continue;
      if (this.status === 'running' && p.seat !== null) continue;
      this.releaseSeat(p);
      this.players.delete(p.token);
      removed++;
    }
    return removed;
  }

  hasConnected() {
    for (const p of this.players.values()) if (p.connected) return true;
    return false;
  }

  // ---------- Sicht eines Spielers ----------

  /**
   * Was ein bestimmter Spieler sehen darf. Enthält NIE Tokens anderer Spieler
   * und NIE fremde Handkarten: Das Spiel liefert die Sicht nur für den eigenen Platz.
   */
  stateFor(token) {
    const me = this.players.get(token) ?? null;
    const pub = (p) => ({ id: p.id, name: p.name, connected: p.connected });
    return {
      roomId: this.id,
      status: this.status,
      round: this.round,
      seats: this.seats.map((t) => (t ? pub(this.players.get(t)) : null)),
      spectators: this.spectators().map(pub),
      you: me ? { id: me.id, name: me.name, seat: me.seat } : null,
      canStart: !!me && me.seat !== null && this.isReady(),
      game: this.game ? this.game.viewFor(me?.seat ?? null) : null,
      scores: {
        rounds: this.scores.map((r) => ({ ...r })),
        totals: this.totals(),
        seegerFabian: seegerFabianTotals(this.scores),
      },
      houseRules: { ...this.houseRules },
      bockRemaining: this.bockRemaining,
      vote: this.voteView(),
      voteRejectedBy: this.voteRejectedBy,
      summary: this.summary,
    };
  }

  voteView() {
    const vote = this.vote;
    if (!vote || this.now() >= vote.expiresAt) return null;
    return {
      kind: vote.kind,
      by: vote.by,
      yes: [...vote.yes].sort(),
      waitingFor: this.voteMissing(),
      remainingMs: vote.expiresAt - this.now(),
    };
  }

  // ---------- Hilfsfunktionen ----------

  spectators() {
    return [...this.players.values()].filter((p) => p.seat === null);
  }

  require(token) {
    const p = typeof token === 'string' ? this.players.get(token) : undefined;
    if (!p) throw new RoomError('NICHT_IM_RAUM', 'Du bist nicht in diesem Raum.');
    return p;
  }

  /** Spieler am Tisch während eines laufenden Spiels – sonst Fehler. */
  requireSeatedInGame(token, verb) {
    const p = this.require(token);
    if (this.status !== 'running' || !this.game) throw new RoomError('KEIN_SPIEL', 'Es läuft gerade kein Spiel.');
    if (p.seat === null) throw new RoomError('NUR_SPIELER', `Nur Spieler am Tisch können ${verb}.`);
    return p;
  }

  requireLobby() {
    if (this.status !== 'lobby') throw new RoomError('SPIEL_LAEUFT', 'Das geht nicht, während ein Spiel läuft.');
  }

  assignSeat(player, index) {
    this.seats[index] = player.token;
    player.seat = index;
  }

  releaseSeat(player) {
    if (player.seat !== null) this.seats[player.seat] = null;
    player.seat = null;
  }

  newPublicId() {
    const taken = new Set([...this.players.values()].map((p) => p.id));
    let id;
    do id = randomBytes(4).toString('hex');
    while (taken.has(id));
    return id;
  }

  touch() {
    this.lastActivity = this.now();
  }
}

/**
 * @typedef {object} Player
 * @property {string} token     geheim – nur der Spieler selbst kennt es
 * @property {string} id        öffentlich – für die Anzeige bei anderen
 * @property {string} name
 * @property {number|null} seat 0–2 oder null (= Zuschauer)
 * @property {boolean} connected
 * @property {number} lastSeen
 */
