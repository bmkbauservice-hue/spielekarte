// Speichert Raum-Schnappschüsse in SQLite (eingebautes node:sqlite – kein Zusatzpaket nötig).
// Eine Zeile pro Raum: id, JSON-Schnappschuss, Zeitpunkt der letzten Änderung.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Schema-Version der Datenbank (PRAGMA user_version). Neue Migrationen unten anhängen. */
const MIGRATIONS = [
  // 0 → 1
  `CREATE TABLE rooms (
     id         TEXT PRIMARY KEY,
     data       TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
];

export class SqliteStore {
  /** @param {string} path  Datei, z. B. /app/data/spielekarte.db – oder ':memory:' für Tests */
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    // WAL: schnelle Schreibvorgänge, Lesen blockiert nicht; NORMAL reicht mit WAL für Absturzsicherheit
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
    this.migrate();
    this.saveStmt = this.db.prepare(
      `INSERT INTO rooms (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    );
    this.deleteStmt = this.db.prepare('DELETE FROM rooms WHERE id = ?');
    this.allStmt = this.db.prepare('SELECT id, data FROM rooms ORDER BY id');
  }

  migrate() {
    const current = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  get schemaVersion() {
    return this.db.prepare('PRAGMA user_version').get().user_version;
  }

  /** @returns {{ id: string, data: object | null, error?: Error }[]}  kaputtes JSON → data null + error */
  loadAll() {
    return this.allStmt.all().map(({ id, data }) => {
      try {
        return { id, data: JSON.parse(data) };
      } catch (error) {
        return { id, data: null, error };
      }
    });
  }

  save(id, snapshot, updatedAt = Date.now()) {
    this.saveStmt.run(id, JSON.stringify(snapshot), updatedAt);
  }

  delete(id) {
    this.deleteStmt.run(id);
  }

  /** Datensicherung als einzelne, konsistente Datei (auch während der Server läuft) */
  backupTo(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
