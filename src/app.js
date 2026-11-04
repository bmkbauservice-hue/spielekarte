// Verdrahtet Express (HTTP-Seiten) und Socket.IO (Echtzeit) mit der Raum-Logik.

import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { RoomRegistry } from './rooms/registry.js';
import { RoomError, normalizeRoomId } from './rooms/room.js';
import { GameError } from './game/game.js';
import { createRateLimiter } from './rate-limit.js';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const staticDir = join(publicDir, 'static');

/**
 * @param {object} [options]
 * @param {string} [options.basePath]          URL-Prefix, z. B. "/spiel"
 * @param {Iterable<string>} [options.cardIds] erlaubte Karten-IDs; leer = alle erlaubt
 * @param {{ limit: number, windowMs: number }} [options.joinLimit]  Beitritte pro Verbindung
 * @param {{ limit: number, windowMs: number }} [options.eventLimit] Aktionen pro Verbindung insgesamt
 * @param {number} [options.sweepIntervalMs]
 * @param {RoomRegistry} [options.registry]
 */
export function createApp({
  basePath = '',
  cardIds = [],
  joinLimit = { limit: 10, windowMs: 60_000 },
  eventLimit = { limit: 120, windowMs: 60_000 },
  sweepIntervalMs = 60_000,
  registry = new RoomRegistry(),
} = {}) {
  const allowedCards = new Set(cardIds);
  const isCardAllowed = (id) => allowedCards.size === 0 || allowedCards.has(id);

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
      broadcast(room);
      return { token: player.token }; // Token geht NUR an diesen einen Socket
    });

    handle(socket, 'room:leave', () => {
      const { room, token } = current(socket);
      room.leave(token);
      activeSocket.delete(token);
      socket.leave(room.id);
      socket.data.roomId = socket.data.token = undefined;
      broadcast(room);
    });

    const action = (event, fn) =>
      handle(socket, event, (data) => {
        const { room, token } = current(socket);
        fn(room, token, data);
        broadcast(room);
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
    action('vote:request', (room, token, { kind }) => room.requestVote(token, kind));
    action('vote:cast', (room, token, { agree }) => room.castVote(token, agree === true));
    action('evening:new', (room, token) => room.start(token));
    action('evening:lobby', (room, token) => room.backToLobby(token));

    socket.on('disconnect', () => detach(socket));
  });

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
  }, sweepIntervalMs);
  sweepTimer.unref(); // hält den Prozess nicht künstlich am Leben

  return {
    httpServer,
    io,
    registry,
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweepTimer);
        for (const timer of voteTimers.values()) clearTimeout(timer);
        io.close(() => resolve());
      }),
  };
}

/** Kurzer Hash über alle statischen Dateien → ändert sich bei jedem Deploy mit geänderten Dateien. */
function staticVersion() {
  const hash = createHash('sha256');
  for (const file of readdirSync(staticDir).sort()) hash.update(file).update(readFileSync(join(staticDir, file)));
  return hash.digest('hex').slice(0, 10);
}

/** Einfache Sicherheits-Header. CSP: nur eigene Skripte/Styles, keine Inline-Skripte. */
function securityHeaders(_req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}
