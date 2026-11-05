// Verdrahtet Express (HTTP-Seiten) und Socket.IO (Echtzeit) mit der Raum-Logik.

import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { RoomRegistry } from './rooms/registry.js';
import { RoomError, normalizeRoomId } from './rooms/room.js';
import { GameError } from './game/game.js';
import { createRateLimiter } from './rate-limit.js';
import { VoiceStore, isVoiceId, isVoiceType, looksLikeAudio } from './storage/voice-store.js';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const staticDir = join(publicDir, 'static');

export const VOICE_MAX_BYTES = 600 * 1024;     // eine Sprachnachricht
export const VOICE_MAX_DURATION_MS = 31_000;   // 30 s + Spielraum für den Timer im Browser
export const VOICE_MAX_AGE_MS = 24 * 3_600_000; // spätestens dann wird gelöscht
const VOICE_ROOM_MAX_BYTES = 30 * 1024 * 1024; // Obergrenzen, damit niemand die Platte füllen kann
const VOICE_TOTAL_MAX_BYTES = 500 * 1024 * 1024;

/** Rate-Limit pro Spieler statt pro Verbindung: Neu verbinden setzt es nicht zurück. Verschwindet mit dem Spieler. */
function perPlayerLimiter(options) {
  const limiters = new WeakMap();
  return (player) => {
    if (!limiters.has(player)) limiters.set(player, createRateLimiter(options));
    return limiters.get(player).allow();
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.basePath]          URL-Prefix, z. B. "/spiel"
 * @param {Iterable<string>} [options.cardIds] erlaubte Karten-IDs; leer = alle erlaubt
 * @param {{ limit: number, windowMs: number }} [options.joinLimit]  Beitritte pro Verbindung
 * @param {{ limit: number, windowMs: number }} [options.eventLimit] Aktionen pro Verbindung insgesamt
 * @param {{ limit: number, windowMs: number }} [options.chatLimit]  Chat-Nachrichten pro Spieler
 * @param {{ limit: number, windowMs: number }} [options.voiceLimit] Sprachnachrichten pro Spieler
 * @param {string} [options.voiceDir]          Ordner für Sprachnachrichten; leer = Temp-Ordner
 * @param {number} [options.voiceMaxAgeMs]     Sprachnachrichten werden spätestens danach gelöscht
 * @param {number} [options.sweepIntervalMs]
 * @param {import('./storage/sqlite-store.js').SqliteStore} [options.store]  Speicher; ohne → nur Arbeitsspeicher
 * @param {RoomRegistry} [options.registry]
 */
export function createApp({
  basePath = '',
  cardIds = [],
  joinLimit = { limit: 10, windowMs: 60_000 },
  eventLimit = { limit: 120, windowMs: 60_000 },
  chatLimit = { limit: 5, windowMs: 10_000 },
  voiceLimit = { limit: 3, windowMs: 30_000 },
  voiceDir = '',
  voiceMaxAgeMs = VOICE_MAX_AGE_MS,
  sweepIntervalMs = 60_000,
  store = null,
  registry = new RoomRegistry({ store }),
} = {}) {
  // Gespeicherte Räume laden (nach Neustart/Deploy geht es da weiter, wo alle aufgehört haben)
  const restored = registry.loadFromStore();
  if (restored.loaded || restored.skipped) {
    console.log(`${restored.loaded} Raum/Räume aus der Datenbank geladen${restored.skipped ? `, ${restored.skipped} übersprungen` : ''}.`);
  }
  const allowedCards = new Set(cardIds);
  const isCardAllowed = (id) => allowedCards.size === 0 || allowedCards.has(id);
  const voices = new VoiceStore(voiceDir);
  const allowChat = perPlayerLimiter(chatLimit);
  const allowVoice = perPlayerLimiter(voiceLimit);

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  // HTML-Vorlagen einmal laden. Platzhalter: {{BASE}}, {{V}} (Cache-Busting), {{ROOM_ID}}, {{TITLE}}, {{TEXT}}
  const version = staticVersion();
  const template = (file) =>
    readFileSync(join(publicDir, file), 'utf8').replaceAll('{{BASE}}', basePath).replaceAll('{{V}}', version);
  const landingHtml = template('index.html');
  const roomHtml = template('room.html');
  const errorTemplate = template('404.html');
  const errorPage = (title, text) => errorTemplate.replaceAll('{{TITLE}}', title).replaceAll('{{TEXT}}', text);
  const notFoundHtml = errorPage('Seite nicht gefunden', 'Karten-Codes bestehen aus 3–16 Buchstaben und Ziffern.');
  const unknownCardHtml = errorPage(
    'Diese Karte ist nicht freigeschaltet',
    'Prüfe den Code auf deiner Karte – oder frag den, der dir die Karte gegeben hat.',
  );

  const router = express.Router();
  router.get('/health', (_req, res) => res.json({ ok: true, rooms: registry.rooms.size }));
  // Dateien haben ?v=<hash> in der URL → dürfen lange gecacht werden
  router.use('/static', express.static(staticDir, { maxAge: '7d' }));
  router.get('/', (_req, res) => res.type('html').send(landingHtml));
  router.get('/k/:id', (req, res) => {
    const id = normalizeRoomId(req.params.id);
    if (!id) return res.status(404).type('html').send(notFoundHtml);
    if (!isCardAllowed(id)) return res.status(404).type('html').send(unknownCardHtml);
    // Eine kanonische URL pro Karte: /k/muju01 → /k/MUJU01
    if (id !== req.params.id) return res.redirect(301, `${basePath}/k/${id}`);
    // id ist geprüft (nur A–Z, 0–9), daher sicher ins HTML einsetzbar
    res.type('html').send(roomHtml.replaceAll('{{ROOM_ID}}', id));
  });

  // ---------- Sprachnachrichten: per HTTP, weil Socket.IO nur kleine Pakete annimmt ----------

  const voiceError = (res, status, code, message) => res.status(status).json({ ok: false, code, message });

  /** Nur Raum-Mitglieder: Das Token kommt im Header, nie in der URL (URLs landen in Protokollen). */
  function requireMember(req, res, next) {
    const id = normalizeRoomId(req.params.id);
    const room = id && isCardAllowed(id) ? registry.get(id) : undefined;
    const player = room?.players.get(req.get('x-player-token'));
    if (!player) return voiceError(res, 403, 'NICHT_IM_RAUM', 'Du bist nicht in diesem Raum.');
    req.room = room;
    req.player = player;
    next();
  }

  /** Alles prüfen, was ohne den Inhalt geht – so wird von Unbefugten gar nicht erst etwas eingelesen. */
  function checkVoiceUpload(req, res, next) {
    if (!allowVoice(req.player)) {
      return voiceError(res, 429, 'ZU_VIELE', 'Zu viele Sprachnachrichten. Bitte kurz warten.');
    }
    const mime = (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!isVoiceType(mime)) return voiceError(res, 415, 'FORMAT_UNGUELTIG', 'Dieses Audioformat wird nicht unterstützt.');
    const durationMs = Number(req.get('x-voice-duration'));
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > VOICE_MAX_DURATION_MS) {
      return voiceError(res, 400, 'DAUER_UNGUELTIG', 'Sprachnachrichten dürfen höchstens 30 Sekunden lang sein.');
    }
    req.voice = { id: randomBytes(16).toString('hex'), mime, durationMs };
    next();
  }

  router.post(
    '/k/:id/voice',
    requireMember,
    checkVoiceUpload,
    express.raw({ type: () => true, limit: VOICE_MAX_BYTES }),
    (req, res) => {
      const { room, voice } = req;
      const data = req.body;
      if (!Buffer.isBuffer(data) || !looksLikeAudio(voice.mime, data)) {
        return voiceError(res, 400, 'FORMAT_UNGUELTIG', 'Das ist keine gültige Aufnahme.');
      }
      if (room.chat.voiceBytes() + data.length > VOICE_ROOM_MAX_BYTES || voices.totalBytes() + data.length > VOICE_TOTAL_MAX_BYTES) {
        return voiceError(res, 507, 'SPEICHER_VOLL', 'Gerade ist kein Platz für weitere Sprachnachrichten. „Neuer Abend“ räumt auf.');
      }
      voice.bytes = data.length;
      voices.save(room.id, voice, data);
      const message = room.addVoiceMessage(req.player.token, voice);
      publish(room);
      io.to(room.id).emit('chat:message', message);
      res.status(201).json({ ok: true, id: voice.id });
    },
    (err, _req, res, next) => {
      if (res.headersSent) return next(err);
      if (err.type === 'entity.too.large') {
        return voiceError(res, 413, 'ZU_GROSS', 'Die Aufnahme ist zu groß (höchstens 600 KB).');
      }
      if (err.type === 'request.aborted') return res.status(400).end(); // Verbindung abgerissen – liest eh niemand mehr
      console.error('[voice]', err);
      voiceError(res, 500, 'SERVERFEHLER', 'Unerwarteter Fehler auf dem Server.');
    },
  );

  router.get('/k/:id/voice/:voiceId', requireMember, (req, res) => {
    const message = isVoiceId(req.params.voiceId) ? req.room.chat.findVoice(req.params.voiceId) : null;
    if (!message) return voiceError(res, 404, 'NICHT_GEFUNDEN', 'Diese Sprachnachricht gibt es nicht mehr.');
    res.type(message.voice.mime);
    res.sendFile(
      voices.relativePath(req.room.id, message.voice),
      { root: voices.root, etag: false, lastModified: false, cacheControl: false, headers: { 'Cache-Control': 'private, no-store' } },
      (err) => {
        if (err && !res.headersSent) voiceError(res, 404, 'NICHT_GEFUNDEN', 'Diese Sprachnachricht gibt es nicht mehr.');
      },
    );
  });

  router.use((_req, res) => res.status(404).type('html').send(notFoundHtml));

  app.use(basePath || '/', router);

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    path: `${basePath}/socket.io`,
    maxHttpBufferSize: 10_000, // Nachrichten sind klein – große Pakete gar nicht erst annehmen
  });

  // Welcher Socket gehört gerade zu welchem Token? (Ein Token = höchstens eine aktive Verbindung)
  /** @type {Map<string, import('socket.io').Socket>} */
  const activeSocket = new Map();

  /** Nach jeder Änderung: erst speichern, dann allen ihren Stand schicken. */
  function publish(room) {
    registry.persist(room);
    broadcast(room);
  }

  /** Jedem Socket im Raum SEINEN Zustand schicken (nicht allen denselben!). */
  function broadcast(room) {
    const ids = io.sockets.adapter.rooms.get(room.id) ?? new Set();
    for (const socketId of ids) {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('room:state', room.stateFor(s.data.token));
    }
  }

  /** Wrapper: Rate-Limit, Eingaben prüfen, Fehler abfangen, per Ack antworten. */
  function handle(socket, event, fn) {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const data = payload && typeof payload === 'object' ? payload : {};
      try {
        if (!socket.data.limits.events.allow()) {
          throw new RoomError('ZU_VIELE', 'Zu viele Anfragen. Bitte kurz warten.');
        }
        reply({ ok: true, ...(fn(data) ?? {}) });
      } catch (err) {
        if (err instanceof RoomError || err instanceof GameError) {
          return reply({ ok: false, code: err.code, message: err.message });
        }
        console.error(`[${event}]`, err);
        reply({ ok: false, code: 'SERVERFEHLER', message: 'Unerwarteter Fehler auf dem Server.' });
      }
    });
  }

  /** Raum + Token der aktuellen Verbindung, sonst Fehler. */
  function current(socket) {
    const room = socket.data.roomId && registry.get(socket.data.roomId);
    if (!room || !room.players.has(socket.data.token)) {
      throw new RoomError('NICHT_IM_RAUM', 'Du bist nicht in diesem Raum.');
    }
    return { room, token: socket.data.token };
  }

  function detach(socket) {
    const { roomId, token } = socket.data;
    if (!roomId) return;
    socket.leave(roomId);
    socket.data.roomId = socket.data.token = undefined;
    if (activeSocket.get(token) !== socket) return;
    activeSocket.delete(token);
    const room = registry.get(roomId);
    if (room) {
      room.disconnect(token);
      broadcast(room);
    }
  }

  io.on('connection', (socket) => {
    // Nach einem Deploy: alte Tabs merken an der Version, dass sie neu laden müssen
    socket.emit('app:version', version);
    socket.data.limits = {
      joins: createRateLimiter(joinLimit),
      events: createRateLimiter(eventLimit),
    };

    handle(socket, 'room:join', ({ roomId, name, token }) => {
      if (!socket.data.limits.joins.allow()) {
        throw new RoomError('ZU_VIELE', 'Zu viele Beitrittsversuche. Bitte eine Minute warten.');
      }
      const id = normalizeRoomId(roomId);
      if (!id) throw new RoomError('RAUM_UNGUELTIG', 'Diese Karten-ID gibt es nicht.');
      if (!isCardAllowed(id)) throw new RoomError('KARTE_UNBEKANNT', 'Diese Karte ist nicht freigeschaltet.');
      // Eine Verbindung = eine Person. Wer schon im Raum ist, kann sich nicht als weitere Person anmelden.
      if (socket.data.roomId === id && token !== socket.data.token) {
        throw new RoomError('SCHON_IM_RAUM', 'Du bist schon in diesem Raum.');
      }

      const room = registry.getOrCreate(id);
      const { player } = room.join({ name, token });

      detach(socket); // falls dieser Socket vorher in einem anderen Raum war

      // Gleiches Token in einem anderen Tab/Gerät aktiv? → Der neue übernimmt.
      const previous = activeSocket.get(player.token);
      if (previous && previous !== socket) {
        previous.emit('session:replaced');
        previous.leave(room.id);
        previous.data.roomId = previous.data.token = undefined;
      }

      activeSocket.set(player.token, socket);
      socket.data.roomId = room.id;
      socket.data.token = player.token;
      socket.join(room.id);
      room.connect(player.token);
      publish(room);
      socket.emit('chat:history', room.chat.messages); // erst nach dem Zustand: Der Browser weiß dann, wer "du" ist
      return { token: player.token }; // Token geht NUR an diesen einen Socket
    });

    handle(socket, 'room:leave', () => {
      const { room, token } = current(socket);
      room.leave(token);
      activeSocket.delete(token);
      socket.leave(room.id);
      socket.data.roomId = socket.data.token = undefined;
      publish(room);
    });

    const action = (event, fn) =>
      handle(socket, event, (data) => {
        const { room, token } = current(socket);
        fn(room, token, data);
        publish(room);
        scheduleVoteExpiry(room);
      });

    action('seat:take', (room, token, { seat }) => room.takeSeat(token, seat));
    action('seat:leave', (room, token) => room.leaveSeat(token));
    action('game:start', (room, token) => room.start(token));
    action('game:bid', (room, token, { action: what }) => room.bid(token, what));
    action('game:skat', (room, token) => room.pickUpSkat(token));
    action('game:discard', (room, token, { cards }) => room.discard(token, cards));
    action('game:declare', (room, token, { type, trump, schneiderAnnounced, schwarzAnnounced, ouvert }) =>
      room.declare(token, { type, trump, schneiderAnnounced, schwarzAnnounced, ouvert }));
    action('game:play', (room, token, { card }) => room.playCard(token, card));
    action('game:next', (room, token) => room.nextRound(token));
    action('rules:set', (room, token, { kontra, bock, schenken }) => room.setHouseRules(token, { kontra, bock, schenken }));
    action('game:kontra', (room, token) => room.sayKontra(token));
    action('game:re', (room, token) => room.sayRe(token));
    action('game:gift', (room, token, { yes }) => room.offerGift(token, yes === true));
    action('game:gift-answer', (room, token, { accept }) => room.answerGift(token, accept === true));
    action('vote:request', (room, token, { kind }) => room.requestVote(token, kind));
    action('vote:cast', (room, token, { agree }) => room.castVote(token, agree === true));
    action('evening:new', (room, token) => {
      room.newEvening(token);
      io.to(room.id).emit('chat:cleared');
      // Dateifehler dürfen den neuen Abend nicht stoppen; übrig gebliebene Dateien erwischt das Aufräumen
      try {
        voices.removeRoom(room.id);
      } catch (err) {
        console.error('[voice] Löschen fehlgeschlagen:', err.message);
      }
    });
    action('evening:lobby', (room, token) => room.backToLobby(token));
    action('chat:send', (room, token, { text }) => {
      if (!allowChat(room.players.get(token))) {
        throw new RoomError('ZU_VIELE', 'Du schreibst gerade sehr schnell. Bitte kurz warten.');
      }
      io.to(room.id).emit('chat:message', room.sendChat(token, text));
    });

    socket.on('disconnect', () => detach(socket));
  });

  /** Abgelaufene Sprachnachrichten entfernen, dann alle Dateien löschen, zu denen es keine Nachricht mehr gibt. */
  function sweepVoice() {
    for (const room of registry.rooms.values()) {
      const removed = room.chat.expireVoice(voiceMaxAgeMs);
      if (removed.length === 0) continue;
      registry.persist(room);
      io.to(room.id).emit('chat:removed', removed);
    }
    try {
      voices.prune((roomId, id) => !!registry.get(roomId)?.chat.findVoice(id));
    } catch (err) {
      console.error('[voice] Aufräumen fehlgeschlagen:', err.message); // nächster Versuch beim nächsten Durchlauf
    }
  }
  // Auch beim Start: Die 24 Stunden gelten auch dann, wenn der Server zwischendurch aus war.
  sweepVoice();

  // Abstimmung läuft ab, ohne dass jemand klickt → allen Bescheid geben
  /** @type {Map<string, NodeJS.Timeout>} */
  const voteTimers = new Map();
  function scheduleVoteExpiry(room) {
    clearTimeout(voteTimers.get(room.id));
    voteTimers.delete(room.id);
    if (!room.vote) return;
    const timer = setTimeout(() => {
      voteTimers.delete(room.id);
      if (room.expireVote()) broadcast(room);
    }, Math.max(0, room.vote.expiresAt - room.now()) + 50);
    timer.unref();
    voteTimers.set(room.id, timer);
  }

  // Regelmäßig aufräumen (getrennte Spieler, leere Räume)
  const sweepTimer = setInterval(() => {
    for (const id of registry.sweep()) broadcast(registry.get(id));
    sweepVoice();
  }, sweepIntervalMs);
  sweepTimer.unref(); // hält den Prozess nicht künstlich am Leben

  return {
    httpServer,
    io,
    registry,
    store,
    version,
    voices,
    sweepVoice,
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweepTimer);
        for (const timer of voteTimers.values()) clearTimeout(timer);
        io.close(() => {
          store?.close();
          voices.close();
          resolve();
        });
      }),
  };
}

/** Kurzer Hash über alle statischen Dateien (inkl. Unterordner) → ändert sich bei jedem Deploy mit geänderten Dateien. */
function staticVersion() {
  const hash = createHash('sha256');
  const files = readdirSync(staticDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
  for (const file of files) hash.update(file.slice(staticDir.length)).update(readFileSync(file));
  return hash.digest('hex').slice(0, 10);
}

/** Einfache Sicherheits-Header. CSP: nur eigene Skripte/Styles, keine Inline-Skripte. */
function securityHeaders(_req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}
