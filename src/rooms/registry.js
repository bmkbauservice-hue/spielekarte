// Verwaltet alle Räume. Ein Raum pro Karten-ID.
// Mit `store` (SQLite) überleben Räume einen Neustart: Jede Änderung wird als Schnappschuss gespeichert,
// beim Start werden alle Räume geladen. Ohne `store` (lokal/Tests) liegt alles nur im Arbeitsspeicher.

import { Room, RoomError } from './room.js';

export class RoomRegistry {
  /**
   * @param {object} [options]
   * @param {{ save, delete, loadAll }} [options.store]  Speicher (SqliteStore) – ohne: nur Arbeitsspeicher
   */
  constructor({ now = Date.now, maxRooms = 500, playerIdleMs = 10 * 60_000, roomIdleMs = 6 * 3_600_000, roomOptions = {}, store = null, log = console } = {}) {
    this.now = now;
    this.store = store;
    this.log = log;
    this.roomOptions = roomOptions; // z. B. kürzere Abstimmungszeit in Tests
    this.maxRooms = maxRooms;
    this.playerIdleMs = playerIdleMs;
    this.roomIdleMs = roomIdleMs;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  /**
   * Alle gespeicherten Räume laden (beim Serverstart).
   * Kaputte oder veraltete Schnappschüsse werden protokolliert und übersprungen – ein Raum darf nie den Start verhindern.
   * @returns {{ loaded: number, skipped: number }}
   */
  loadFromStore() {
    if (!this.store) return { loaded: 0, skipped: 0 };
    let loaded = 0;
    let skipped = 0;
    for (const { id, data, error } of this.store.loadAll()) {
      try {
        if (error) throw error;
        this.rooms.set(id, Room.fromJSON(data, { ...this.roomOptions, now: this.now }));
        loaded++;
      } catch (err) {
        skipped++;
        this.log.warn(`Raum ${id} konnte nicht geladen werden und wird übersprungen: ${err.message}`);
      }
    }
    return { loaded, skipped };
  }

  /** Aktuellen Stand eines Raums speichern (nach jeder Änderung). */
  persist(room) {
    if (!this.store || !this.rooms.has(room.id)) return;
    try {
      this.store.save(room.id, room.toJSON(), room.lastActivity);
    } catch (err) {
      // Speichern darf das Spiel nie stoppen – im schlimmsten Fall geht nach einem Neustart etwas verloren
      this.log.error(`Raum ${room.id} konnte nicht gespeichert werden: ${err.message}`);
    }
  }

  get(id) {
    return this.rooms.get(id);
  }

  getOrCreate(id) {
    let room = this.rooms.get(id);
    if (!room) {
      if (this.rooms.size >= this.maxRooms) {
        throw new RoomError('SERVER_VOLL', 'Gerade sind zu viele Räume offen. Bitte später erneut versuchen.');
      }
      room = new Room(id, { ...this.roomOptions, now: this.now });
      this.rooms.set(id, room);
    }
    return room;
  }

  /**
   * Regelmäßig aufrufen: entfernt lange getrennte Spieler und verlassene Räume.
   * @returns {string[]} IDs der Räume, deren Spielerliste sich geändert hat (die bekommen ein Update)
   */
  sweep() {
    const changed = [];
    for (const [id, room] of this.rooms) {
      if (room.removeStale(this.playerIdleMs) > 0) changed.push(id);
      const idle = this.now() - room.lastActivity > this.roomIdleMs;
      if (!room.hasConnected() && (room.players.size === 0 || idle)) {
        this.rooms.delete(id);
        this.store?.delete(id);
      }
    }
    const stillThere = changed.filter((id) => this.rooms.has(id));
    for (const id of stillThere) this.persist(this.rooms.get(id));
    return stillThere;
  }
}
