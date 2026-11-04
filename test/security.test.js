// Review-Punkte: Freigabeliste für Karten-IDs, Begrenzung von Beitritten, Cache-Busting.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connectClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { loadConfig, parseCardIds } from '../src/config.js';
import { createRateLimiter } from '../src/rate-limit.js';

describe('Rate-Limiter (gleitendes Fenster)', () => {
  test('erlaubt limit Aktionen pro Fenster, danach erst wieder nach Ablauf', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
    const at = (time) => { t = time; return limiter.allow(); };
    assert.deepEqual([at(0), at(100), at(200), at(300)], [true, true, true, false]);
    assert.equal(at(999), false, 'Fenster noch nicht abgelaufen');
    assert.equal(at(1000), true, 'nur die älteste Aktion (t=0) ist aus dem Fenster gefallen');
    assert.equal(at(1001), false, 't=100 und t=200 zählen noch');
    assert.equal(at(1100), true);
  });
});

describe('Karten-IDs aus Konfiguration', () => {
  test('Komma, Leerzeichen, Zeilen, Kommentare, Kleinschreibung', () => {
    assert.deepEqual([...parseCardIds('MUJU01, test01;abc\n# Kommentar\nXYZ99 # Rest ignoriert\n\n')], ['MUJU01', 'TEST01', 'ABC', 'XYZ99']);
  });

  test('ungültige ID → Fehler beim Start', () => {
    assert.throws(() => parseCardIds('MUJU01,../etc'), /Ungültige Karten-ID/);
  });

  test('CARD_IDS und CARD_IDS_FILE werden zusammengeführt; leer = leer', () => {
    const files = { '/karten.txt': 'DATEI1\nDATEI2' };
    const config = loadConfig({ CARD_IDS: 'ENV001', CARD_IDS_FILE: '/karten.txt' }, { readFile: (p) => files[p] });
    assert.deepEqual([...config.cardIds].sort(), ['DATEI1', 'DATEI2', 'ENV001']);
    assert.equal(loadConfig({}).cardIds.size, 0);
  });
});

describe('Server mit Freigabeliste und Limits', () => {
  let server;
  let origin;
  const clients = [];

  before(async () => {
    server = createApp({ cardIds: ['MUJU01', 'TEST01'], joinLimit: { limit: 3, windowMs: 60_000 } });
    await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  });

  after(async () => {
    for (const c of clients) c.disconnect();
    await server.close();
  });

  async function phone() {
    const s = connectClient(origin, { transports: ['websocket'], forceNew: true });
    clients.push(s);
    await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
    return s;
  }
  const request = (s, event, data = {}) => new Promise((resolve) => s.emit(event, data, resolve));

  test('freigeschaltete Karte → Spielraum', async () => {
    assert.equal((await fetch(`${origin}/k/MUJU01`)).status, 200);
  });

  test('unbekannte Karte → freundliche Fehlerseite (404)', async () => {
    const res = await fetch(`${origin}/k/FREMD1`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /nicht freigeschaltet/);
  });

  test('unbekannte Karte auch per Socket abgelehnt (Seite umgehen hilft nicht)', async () => {
    const s = await phone();
    const res = await request(s, 'room:join', { roomId: 'FREMD1', name: 'Eve' });
    assert.equal(res.code, 'KARTE_UNBEKANNT');
    assert.equal(server.registry.get('FREMD1'), undefined, 'es wird kein Raum angelegt');
  });

  test('höchstens 3 Beitritte pro Verbindung und Minute (hier im Test)', async () => {
    const s = await phone();
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(s, 'room:join', { roomId: 'TEST01', token: 'unbekannt' });
      codes.push(res.code);
    }
    assert.deepEqual(codes, ['TOKEN_UNBEKANNT', 'TOKEN_UNBEKANNT', 'TOKEN_UNBEKANNT', 'ZU_VIELE', 'ZU_VIELE']);
    // Eine andere Verbindung ist davon nicht betroffen
    assert.equal((await request(await phone(), 'room:join', { roomId: 'TEST01', name: 'Fair' })).ok, true);
  });

  test('eine Verbindung kann sich nicht als weitere Person anmelden', async () => {
    const s = await phone();
    assert.equal((await request(s, 'room:join', { roomId: 'MUJU01', name: 'Echt' })).ok, true);
    const res = await request(s, 'room:join', { roomId: 'MUJU01', name: 'Geist' });
    assert.equal(res.code, 'SCHON_IM_RAUM');
    const names = [...server.registry.get('MUJU01').players.values()].map((p) => p.name);
    assert.deepEqual(names, ['Echt']);
  });

  test('statische Dateien haben eine Versionsnummer in der URL', async () => {
    const html = await (await fetch(`${origin}/k/MUJU01`)).text();
    const match = html.match(/static\/room\.js\?v=([0-9a-f]{10})"/);
    assert.ok(match, 'room.js?v=<hash>');
    assert.equal((await fetch(`${origin}/static/room.js?v=${match[1]}`)).status, 200);
    assert.equal(html.includes('{{'), false, 'keine offenen Platzhalter');
  });
});
