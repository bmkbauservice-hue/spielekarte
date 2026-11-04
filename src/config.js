// Konfiguration aus Umgebungsvariablen (12-Factor-Prinzip: gleiches Image, andere Umgebung).

import { readFileSync } from 'node:fs';
import { normalizeRoomId } from './rooms/room.js';

/** "/spiel/" → "/spiel", "" oder "/" → "" (kein Prefix). Ungültig → Fehler beim Start. */
export function normalizeBasePath(raw = '') {
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (!/^(\/[A-Za-z0-9_-]+)+$/.test(withSlash)) {
    throw new Error(`Ungültiger BASE_PATH: "${raw}" (erlaubt z. B. "/spiel")`);
  }
  return withSlash;
}

/**
 * Karten-IDs aus Text lesen: getrennt durch Komma, Semikolon, Leerzeichen oder Zeilenumbruch.
 * Alles hinter "#" ist Kommentar. Ungültige IDs → Fehler beim Start (lieber laut als still falsch).
 * @returns {Set<string>}
 */
export function parseCardIds(text = '') {
  const ids = new Set();
  for (const line of String(text).split('\n')) {
    for (const raw of line.replace(/#.*/, '').split(/[\s,;]+/)) {
      if (!raw) continue;
      const id = normalizeRoomId(raw);
      if (!id) throw new Error(`Ungültige Karten-ID: "${raw}" (erlaubt: 3–16 Buchstaben/Ziffern)`);
      ids.add(id);
    }
  }
  return ids;
}

export function loadConfig(env = process.env, { readFile = readFileSync } = {}) {
  const cardIds = parseCardIds(env.CARD_IDS ?? '');
  if (env.CARD_IDS_FILE) {
    for (const id of parseCardIds(readFile(env.CARD_IDS_FILE, 'utf8'))) cardIds.add(id);
  }
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    basePath: normalizeBasePath(env.BASE_PATH ?? ''),
    /** leer = alle Karten-IDs erlaubt (lokal/Tests) */
    cardIds,
  };
}
