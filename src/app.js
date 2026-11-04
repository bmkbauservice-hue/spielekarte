// Verdrahtet Express (HTTP-Seiten) und Socket.IO (Echtzeit) mit der Raum-Logik.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { RoomRegistry } from './rooms/registry.js';
import { RoomError, normalizeRoomId } from './rooms/room.js';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

/**
 * @param {{ basePath?: string, sweepIntervalMs?: number, registry?: RoomRegistry }} [options]
 */
export function createApp({ basePath = '', sweepIntervalMs = 60_000, registry = new RoomRegistry() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  // HTML-Vorlagen einmal laden; Platzhalter {{BASE}} und {{ROOM_ID}} werden ersetzt.
  const template = (file) => readFileSync(join(publicDir, file), 'utf8');
  const landingHtml = template('index.html').replaceAll('{{BASE}}', basePath);
  const roomHtml = template('room.html').replaceAll('{{BASE}}', basePath);
  const notFoundHtml = template('404.html').replaceAll('{{BASE}}', basePath);

  const router = express.Router();
  router.get('/health', (_req, res) => res.json({ ok: true, rooms: registry.rooms.size }));
  router.use('/static', express.static(join(publicDir, 'static'), { maxAge: '1h' }));
  router.get('/', (_req, res) => res.type('html').send(landingHtml));
  router.get('/k/:id', (req, res) => {
    const id = normalizeRoomId(req.params.id);
    if (!id) return res.status(404).type('html').send(notFoundHtml);
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

  /** Wrapper: prüft Eingaben, fängt RoomError ab und antwortet per Ack. */
  function handle(socket, event, fn) {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const data = payload && typeof payload === 'object' ? payload : {};
      try {
        reply({ ok: true, ...(fn(data) ?? {}) });
      } catch (err) {
        if (err instanceof RoomError) return reply({ ok: false, code: err.code, message: err.message });
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
    handle(socket, 'room:join', ({ roomId, name, token }) => {
      const id = normalizeRoomId(roomId);
      if (!id) throw new RoomError('RAUM_UNGUELTIG', 'Diese Karten-ID gibt es nicht.');
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
      });

    action('seat:take', (room, token, { seat }) => room.takeSeat(token, seat));
    action('seat:leave', (room, token) => room.leaveSeat(token));
    action('game:start', (room, token) => room.start(token));
    action('game:stop', (room, token) => room.stop(token));

    socket.on('disconnect', () => detach(socket));
  });

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
        io.close(() => resolve());
      }),
  };
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
