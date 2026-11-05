// Sprachnachrichten als einzelne Dateien: <ordner>/<RAUM>/<id>.<endung>
// Bewusst nicht in SQLite: Die Aufnahmen sollen nur vorübergehend existieren und nie in einer Datensicherung landen.
// Schreiben und Aufräumen laufen synchron (wie SQLite): kurze Dateien, und zwischen "Datei geschrieben" und
// "Nachricht eingetragen" kann das Aufräumen so nicht dazwischenfunken.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSIONS = { 'audio/mp4': 'm4a', 'audio/webm': 'webm' };
const FILE_PATTERN = /^([0-9a-f]{32})\.(m4a|webm)$/;
const ROOM_PATTERN = /^[A-Z0-9]{3,16}$/;

export const isVoiceType = (mime) => Object.hasOwn(EXTENSIONS, mime);
export const isVoiceId = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);

// Erlaubte erste MP4-Blöcke. Bewusst nicht nur "ftyp": Wir können nicht jedes Handy prüfen, und eine zu strenge
// Kontrolle würde dort jede Aufnahme blockieren. Es geht nur darum, offensichtlich Fremdes abzuweisen.
const MP4_FIRST_BOXES = new Set(['ftyp', 'styp', 'moov', 'moof', 'mdat', 'free', 'skip', 'wide']);

/** Ist das wirklich dieses Format? Prüft die ersten Bytes: MP4 hat an Stelle 4 einen Blocknamen, WebM die EBML-Kennung am Anfang. */
export function looksLikeAudio(mime, data) {
  if (mime === 'audio/mp4') return data.length > 8 && MP4_FIRST_BOXES.has(data.toString('latin1', 4, 8));
  if (mime === 'audio/webm') return data.length > 4 && data.readUInt32BE(0) === 0x1a45dfa3;
  return false;
}

export class VoiceStore {
  /** @param {string} [dir]  Ordner; leer = eigener Temp-Ordner, der beim Beenden wieder verschwindet */
  constructor(dir = '') {
    this.dir = dir;
    this.temporary = !dir;
  }

  /** Ordner wird erst beim ersten Bedarf angelegt (die meisten Tests brauchen keinen) */
  get root() {
    if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), 'spielekarte-voice-'));
    return this.dir;
  }

  /** Dateipfad relativ zum Ordner */
  relativePath(roomId, voice) {
    return join(roomId, `${voice.id}.${EXTENSIONS[voice.mime]}`);
  }

  save(roomId, voice, data) {
    mkdirSync(join(this.root, roomId), { recursive: true });
    writeFileSync(join(this.root, this.relativePath(roomId, voice)), data, { mode: 0o600 });
  }

  /** Alle Sprachnachrichten eines Raums löschen ("Neuer Abend") */
  removeRoom(roomId) {
    if (!this.dir || !ROOM_PATTERN.test(roomId)) return;
    rmSync(join(this.dir, roomId), { recursive: true, force: true });
  }

  /** Alle Dateien, die zu diesem Speicher gehören – fremde Dateien im Ordner werden nie angefasst. */
  * files() {
    if (!this.dir || !existsSync(this.dir)) return; // noch nie etwas gespeichert (z. B. erster Start nach dem Deploy)
    for (const room of readdirSync(this.root, { withFileTypes: true })) {
      if (!room.isDirectory() || !ROOM_PATTERN.test(room.name)) continue;
      for (const name of readdirSync(join(this.root, room.name))) {
        const match = name.match(FILE_PATTERN);
        if (match) yield { roomId: room.name, id: match[1], path: join(this.root, room.name, name) };
      }
    }
  }

  /**
   * Dateien löschen, zu denen es keine Nachricht (mehr) gibt: abgelaufen, aus dem Verlauf gefallen, Raum gelöscht.
   * @param {(roomId: string, id: string) => boolean} isReferenced
   * @returns {number} Anzahl gelöschter Dateien
   */
  prune(isReferenced) {
    let removed = 0;
    for (const { roomId, id, path } of [...this.files()]) {
      if (isReferenced(roomId, id)) continue;
      rmSync(path, { force: true });
      removed++;
    }
    return removed;
  }

  totalBytes() {
    let total = 0;
    for (const { path } of this.files()) total += statSync(path).size;
    return total;
  }

  close() {
    if (this.temporary && this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}
