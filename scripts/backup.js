// Datensicherung der Spielstände: erzeugt eine konsistente Kopie der SQLite-Datenbank
// (funktioniert auch, während der Server läuft).
//
//   node scripts/backup.js                       → <DB-Ordner>/backup/spielekarte-JJJJ-MM-TT-HHMM.db
//   node scripts/backup.js /pfad/ziel.db         → genau dorthin
//   docker exec spielekarte node scripts/backup.js

import { dirname, join } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error('DB_PATH ist nicht gesetzt – es gibt nichts zu sichern.');
  process.exit(1);
}
const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const target = process.argv[2] ?? join(dirname(dbPath), 'backup', `spielekarte-${stamp}.db`);

const store = new SqliteStore(dbPath);
store.backupTo(target);
const rooms = store.loadAll().length;
store.close();
console.log(`Sicherung geschrieben: ${target} (${rooms} Räume)`);
