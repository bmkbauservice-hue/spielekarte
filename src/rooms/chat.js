// Chat-Verlauf eines Raums – reine Logik ohne Netzwerk, damit alles mit Unit-Tests prüfbar ist.
// Die Audiodaten der Sprachnachrichten liegen NICHT hier, sondern in storage/voice-store.js;
// der Verlauf merkt sich nur, welche Datei zu welcher Nachricht gehört.

export const CHAT_MAX_LENGTH = 200;   // Zeichen pro Nachricht
export const CHAT_MAX_MESSAGES = 200; // ältere Nachrichten fallen heraus

/**
 * Text säubern: Zeilenumbrüche und Leerraum zusammenfassen, Steuerzeichen und unsichtbare Zeichen entfernen
 * (auch Richtungs-Tricks wie U+202E). Der Emoji-Verbinder U+200D bleibt, sonst zerfallen zusammengesetzte Emoji.
 * @returns {string} bereinigter Text, evtl. leer
 */
export function cleanChatText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/(?!‍)[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu, '')
    .trim();
}

/** Länge in Zeichen: Array.from zählt ein Emoji als ein Zeichen. */
export const chatLength = (text) => Array.from(text).length;

export class ChatLog {
  /** @param {{ now?: () => number }} [options] */
  constructor({ now = Date.now } = {}) {
    this.now = now;
    /** @type {ChatMessage[]} */
    this.messages = [];
    this.seq = 0; // läuft auch nach dem Leeren weiter → der Browser kann "bis hierher gelesen" sicher vergleichen
  }

  /** Nachricht anhängen. Was über das Maximum hinausgeht, fällt vorne heraus. */
  add(fields) {
    const message = { seq: ++this.seq, at: this.now(), ...fields };
    this.messages.push(message);
    if (this.messages.length > CHAT_MAX_MESSAGES) this.messages.shift();
    return message;
  }

  clear() {
    this.messages = [];
  }

  findVoice(id) {
    return this.messages.find((m) => m.kind === 'voice' && m.voice.id === id) ?? null;
  }

  /** Summe aller Sprachnachrichten dieses Raums in Bytes */
  voiceBytes() {
    return this.messages.reduce((sum, m) => sum + (m.kind === 'voice' ? m.voice.bytes : 0), 0);
  }

  /**
   * Sprachnachrichten entfernen, die älter als maxAgeMs sind.
   * @returns {number[]} seq der entfernten Nachrichten
   */
  expireVoice(maxAgeMs) {
    const limit = this.now() - maxAgeMs;
    const removed = this.messages.filter((m) => m.kind === 'voice' && m.at <= limit).map((m) => m.seq);
    if (removed.length > 0) this.messages = this.messages.filter((m) => !removed.includes(m.seq));
    return removed;
  }

  toJSON() {
    return { seq: this.seq, messages: structuredClone(this.messages) };
  }

  /** @param {{ seq: number, messages: ChatMessage[] } | undefined} data  fehlt bei Schnappschüssen von vor Etappe 5 */
  static fromJSON(data, options = {}) {
    const log = new ChatLog(options);
    if (data) {
      log.seq = data.seq;
      log.messages = structuredClone(data.messages);
    }
    return log;
  }
}

/**
 * @typedef {object} ChatMessage  Geht so an alle im Raum – enthält deshalb nie ein Token.
 * @property {number} seq   laufende Nummer im Raum
 * @property {number} at    Zeitpunkt (ms)
 * @property {string} from  öffentliche Spieler-id
 * @property {string} name  Name beim Absenden (bleibt, auch wenn der Spieler geht)
 * @property {'text'|'voice'} kind
 * @property {string} [text]
 * @property {{ id: string, mime: string, durationMs: number, bytes: number }} [voice]
 */
