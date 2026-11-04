// Verwaltet alle Räume im Arbeitsspeicher. Ein Raum pro Karten-ID.
// Ein Server-Neustart löscht alle Räume – für Etappe 1 bewusst so (keine Datenbank).

import { Room, RoomError } from './room.js';

export class RoomRegistry {
  constructor({ now = Date.now, maxRooms = 500, playerIdleMs = 10 * 60_000, roomIdleMs = 6 * 3_600_000 } = {}) {
    this.now = now;
    this.maxRooms = maxRooms;
    this.playerIdleMs = playerIdleMs;
    this.roomIdleMs = roomIdleMs;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
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
      room = new Room(id, { now: this.now });
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
      if (!room.hasConnected() && (room.players.size === 0 || idle)) this.rooms.delete(id);
    }
    return changed.filter((id) => this.rooms.has(id));
  }
}
