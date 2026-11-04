// Reine Raum-Logik: Plätze, Spieler-Tokens, Start.
// Bewusst OHNE Netzwerk-Code, damit alles mit Unit-Tests prüfbar ist.

import { randomBytes } from 'node:crypto';
import { SkatGame } from '../game/game.js';

export const SEAT_COUNT = 3;
export const MAX_SPECTATORS = 20;
export const NAME_MAX_LENGTH = 20;

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
   * @param {{ now?: () => number, createGame?: (opts: { dealer: number }) => SkatGame }} [options]
   *   `now` und `createGame` sind austauschbar, damit Tests Zeit und Kartenverteilung steuern können
   */
  constructor(id, { now = Date.now, createGame = (opts) => new SkatGame(opts) } = {}) {
    this.id = id;
    this.now = now;
    this.createGame = createGame;
    this.status = 'lobby'; // 'lobby' | 'running'
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
      this.status === 'lobby' &&
      this.seats.every((t) => t !== null && this.players.get(t)?.connected)
    );
  }

  start(token) {
    const p = this.require(token);
    this.requireLobby();
    if (p.seat === null) throw new RoomError('NUR_SPIELER', 'Nur Spieler am Tisch können das Spiel starten.');
    if (!this.isReady()) throw new RoomError('NICHT_BEREIT', 'Es müssen 3 verbundene Spieler am Tisch sitzen.');
    this.status = 'running';
    this.round = 1;
    this.dealer = SEAT_COUNT - 1;
    this.game = this.createGame({ dealer: this.dealer });
    this.touch();
  }

  /** Spiel abbrechen, zurück in die Lobby. */
  stop(token) {
    this.requireSeatedInGame(token, 'das Spiel beenden');
    this.status = 'lobby';
    this.game = null;
    this.touch();
  }

  /** Alleinspieler sagt das Spiel an ({ type: 'grand' } oder { type: 'suit', trump }). */
  declare(token, game) {
    const p = this.requireSeatedInGame(token, 'das Spiel ansagen');
    this.game.declare(p.seat, game);
    this.touch();
  }

  playCard(token, card) {
    const p = this.requireSeatedInGame(token, 'Karten spielen');
    this.game.play(p.seat, card);
    this.touch();
  }

  /** Nach dem Ende einer Runde: neu geben, Geber rückt eins weiter → Alleinspieler wechselt reihum. */
  nextRound(token) {
    this.requireSeatedInGame(token, 'eine neue Runde starten');
    if (this.game.phase !== 'finished') throw new RoomError('RUNDE_LAEUFT', 'Die Runde ist noch nicht zu Ende.');
    this.dealer = (this.dealer + 1) % SEAT_COUNT;
    this.round++;
    this.game = this.createGame({ dealer: this.dealer });
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
