// Chat + Sprachnachrichten: reine Logik (ChatLog, Room) und echter Server mit simulierten Handys.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connectClient } from 'socket.io-client';
import { createApp, VOICE_MAX_BYTES } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CHAT_MAX_MESSAGES, ChatLog, cleanChatText } from '../src/rooms/chat.js';
import { Room, RoomError, SNAPSHOT_VERSION } from '../src/rooms/room.js';
import { RoomRegistry } from '../src/rooms/registry.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { looksLikeAudio, VoiceStore } from '../src/storage/voice-store.js';

const code = (c) => (err) => err instanceof RoomError && err.code === c;

// Kleinste Dateianfänge, die als echte Aufnahme durchgehen
const fakeMp4 = (size = 64) => { const b = Buffer.alloc(size); b.write('ftyp', 4, 'latin1'); return b; };
const fakeWebm = (size = 64) => { const b = Buffer.alloc(size); b.writeUInt32BE(0x1a45dfa3, 0); return b; };

describe('cleanChatText', () => {
  test('entfernt Leerraum und Zeilenumbrüche', () => {
    assert.equal(cleanChatText('  Moin\n\n  Leute\t! '), 'Moin Leute !');
  });

  test('entfernt Steuerzeichen und Richtungs-Tricks', () => {
    assert.equal(cleanChatText('a\u0000b‮c​d'), 'abcd');
  });

  test('Emoji bleiben ganz, auch zusammengesetzte', () => {
    assert.equal(cleanChatText('Gut gespielt 👏'), 'Gut gespielt 👏');
    assert.equal(cleanChatText('👨‍👩‍👧'), '👨‍👩‍👧');
  });

  test('HTML bleibt reiner Text – unschädlich macht es textContent im Browser', () => {
    assert.equal(cleanChatText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  });

  test('kein Text → leer', () => {
    for (const raw of [undefined, null, 42, {}, ['a'], '   ', '​']) assert.equal(cleanChatText(raw), '');
  });
});

describe('ChatLog', () => {
  test('behält nur die letzten 200 Nachrichten', () => {
    const log = new ChatLog();
    for (let i = 1; i <= CHAT_MAX_MESSAGES + 5; i++) log.add({ kind: 'text', text: String(i) });
    assert.equal(log.messages.length, CHAT_MAX_MESSAGES);
    assert.equal(log.messages[0].text, '6');
    assert.equal(log.messages.at(-1).seq, CHAT_MAX_MESSAGES + 5);
  });

  test('Nummern laufen nach dem Leeren weiter', () => {
    const log = new ChatLog();
    log.add({ kind: 'text', text: 'a' });
    log.clear();
    assert.equal(log.add({ kind: 'text', text: 'b' }).seq, 2);
  });

  test('expireVoice entfernt nur alte Sprachnachrichten', () => {
    let t = 0;
    const log = new ChatLog({ now: () => t });
    const voice = (id) => ({ kind: 'voice', voice: { id, mime: 'audio/mp4', durationMs: 1000, bytes: 10 } });
    log.add(voice('alt'));
    log.add({ kind: 'text', text: 'Text bleibt' });
    t = 500;
    log.add(voice('neu'));
    t = 1000;
    assert.deepEqual(log.expireVoice(1000), [1]);
    assert.deepEqual(log.messages.map((m) => m.seq), [2, 3]);
    assert.equal(log.findVoice('alt'), null);
    assert.equal(log.voiceBytes(), 10);
  });
});

describe('Room: Chat', () => {
  function roomWithPlayers() {
    const room = new Room('TEST01', { now: () => 1000 });
    const [a, b, c] = ['Anna', 'Ben', 'Cem'].map((name) => room.join({ name }).player);
    const spec = room.join({ name: 'Zoe' }).player;
    for (const p of [a, b, c]) room.connect(p.token);
    return { room, a, b, c, spec };
  }

  test('Nachricht mit Name, Uhrzeit, Text – ohne Token', () => {
    const { room, a } = roomWithPlayers();
    const m = room.sendChat(a.token, ' Moin ');
    assert.deepEqual(m, { seq: 1, at: 1000, from: a.id, name: 'Anna', kind: 'text', text: 'Moin' });
    assert.equal(JSON.stringify(m).includes(a.token), false);
  });

  test('Zuschauer dürfen mitschreiben, Fremde nicht', () => {
    const { room, spec } = roomWithPlayers();
    assert.equal(room.sendChat(spec.token, 'Hallo').name, 'Zoe');
    assert.throws(() => room.sendChat('falsch', 'Hallo'), code('NICHT_IM_RAUM'));
    assert.throws(() => room.sendChat(undefined, 'Hallo'), code('NICHT_IM_RAUM'));
  });

  test('leer → Fehler', () => {
    const { room, a } = roomWithPlayers();
    for (const raw of ['', '   ', undefined, 5]) assert.throws(() => room.sendChat(a.token, raw), code('CHAT_LEER'));
    assert.equal(room.chat.messages.length, 0);
  });

  test('genau 200 Zeichen gehen, 201 nicht; Emoji zählt als ein Zeichen', () => {
    const { room, a } = roomWithPlayers();
    assert.ok(room.sendChat(a.token, 'x'.repeat(200)));
    assert.ok(room.sendChat(a.token, '👏'.repeat(200)));
    assert.throws(() => room.sendChat(a.token, 'x'.repeat(201)), code('CHAT_ZU_LANG'));
  });

  test('Neuer Abend leert den Chat, aber nur wenn der Start klappt', () => {
    const { room, a, spec } = roomWithPlayers();
    room.start(a.token);
    room.sendChat(a.token, 'läuft');
    assert.throws(() => room.newEvening(a.token), code('SPIEL_LAEUFT'));
    assert.equal(room.chat.messages.length, 1, 'Fehlversuch lässt den Chat in Ruhe');
    room.status = 'summary';
    room.game = null;
    assert.throws(() => room.newEvening(spec.token), code('NUR_SPIELER'));
    assert.equal(room.chat.messages.length, 1);
    room.newEvening(a.token);
    assert.equal(room.chat.messages.length, 0);
    assert.equal(room.status, 'running');
  });

  test('Spiel starten aus der Lobby lässt den Chat stehen', () => {
    const { room, a } = roomWithPlayers();
    room.sendChat(a.token, 'Alle da?');
    room.start(a.token);
    assert.equal(room.chat.messages.length, 1);
  });

  test('Chat ist nicht Teil des Spielzustands', () => {
    const { room, a } = roomWithPlayers();
    room.sendChat(a.token, 'geheim-im-state?');
    assert.equal(JSON.stringify(room.stateFor(a.token)).includes('geheim-im-state?'), false);
  });

  test('Schnappschuss: Chat überlebt den Neustart', () => {
    const { room, a } = roomWithPlayers();
    room.sendChat(a.token, 'bleibt');
    const copy = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
    assert.deepEqual(copy.chat.messages, room.chat.messages);
    assert.equal(copy.chat.add({ kind: 'text', text: 'weiter' }).seq, 2);
  });

  test('alter Schnappschuss ohne Chat lädt weiter (kein neues SNAPSHOT_VERSION nötig)', () => {
    const { room } = roomWithPlayers();
    const snap = JSON.parse(JSON.stringify(room.toJSON()));
    delete snap.chat;
    assert.equal(snap.v, SNAPSHOT_VERSION);
    assert.deepEqual(Room.fromJSON(snap).chat.messages, []);
  });
});

describe('VoiceStore', () => {
  test('erkennt echte Formate an den ersten Bytes', () => {
    assert.equal(looksLikeAudio('audio/mp4', fakeMp4()), true);
    assert.equal(looksLikeAudio('audio/webm', fakeWebm()), true);
    assert.equal(looksLikeAudio('audio/mp4', fakeWebm()), false);
    assert.equal(looksLikeAudio('audio/webm', fakeMp4()), false);
    assert.equal(looksLikeAudio('audio/mp4', Buffer.from('<html>')), false);
    assert.equal(looksLikeAudio('audio/webm', Buffer.alloc(2)), false);
  });

  test('Aufräumen löscht nur eigene, nicht mehr gebrauchte Dateien', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-test-'));
    try {
      const store = new VoiceStore(dir);
      const keep = { id: 'a'.repeat(32), mime: 'audio/mp4' };
      const drop = { id: 'b'.repeat(32), mime: 'audio/webm' };
      store.save('TEST01', keep, Buffer.alloc(10));
      store.save('TEST01', drop, Buffer.alloc(5));
      assert.equal(store.totalBytes(), 15);
      writeFileSync(join(dir, 'TEST01', 'fremd.txt'), 'nicht anfassen');
      mkdirSync(join(dir, 'kleinbuchstaben'));
      writeFileSync(join(dir, 'kleinbuchstaben', `${'c'.repeat(32)}.m4a`), 'auch nicht');

      assert.equal(store.prune((_room, id) => id === keep.id), 1);
      assert.deepEqual(readdirSync(join(dir, 'TEST01')).sort(), [`${keep.id}.m4a`, 'fremd.txt']);
      assert.equal(existsSync(join(dir, 'kleinbuchstaben', `${'c'.repeat(32)}.m4a`)), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Ordner gibt es noch nicht (erster Start) → kein Absturz', () => {
    const store = new VoiceStore(join(tmpdir(), `gibt-es-nicht-${process.pid}`));
    assert.equal(store.prune(() => false), 0);
    assert.equal(store.totalBytes(), 0);
    store.removeRoom('TEST01');
  });
});

describe('Konfiguration: Ordner für Sprachnachrichten', () => {
  test('neben der Datenbank, VOICE_DIR hat Vorrang, sonst leer', () => {
    assert.equal(loadConfig({ DB_PATH: '/app/data/x.db' }).voiceDir, '/app/data/voice');
    assert.equal(loadConfig({ DB_PATH: '/app/data/x.db', VOICE_DIR: '/tmp/v' }).voiceDir, '/tmp/v');
    assert.equal(loadConfig({}).voiceDir, '');
  });
});

describe('Server: Chat und Sprachnachrichten', () => {
  const BASE = '/spiel';
  let server;
  let origin;
  let clients = [];
  let counter = 0;

  before(async () => {
    // Jeder Test nimmt einen frischen Raum (newRoomId), damit sich die Rate-Limits nicht ins Gehege kommen
    server = createApp({ basePath: BASE, cardIds: [], joinLimit: { limit: 1000, windowMs: 1000 } });
    await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  });

  after(async () => {
    for (const c of clients) c.disconnect();
    await server.close();
  });

  beforeEach(() => {
    for (const c of clients) c.disconnect();
    clients = [];
  });

  async function phone() {
    const socket = connectClient(origin, { path: `${BASE}/socket.io`, transports: ['websocket'], forceNew: true });
    clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  }
  const request = (socket, event, data = {}) => new Promise((resolve) => socket.emit(event, data, resolve));
  const nextEvent = (socket, event, ms = 2000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Kein ${event} erhalten`)), ms);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });

  async function enter(roomId, name) {
    const socket = await phone();
    const history = nextEvent(socket, 'chat:history');
    const res = await request(socket, 'room:join', { roomId, name });
    assert.equal(res.ok, true, res.message);
    return { socket, token: res.token, history: await history };
  }
  const newRoomId = () => `RAUM${++counter}`;

  const upload = (roomId, token, body = fakeMp4(), { mime = 'audio/mp4', duration = '1500' } = {}) => {
    const headers = { 'Content-Type': mime };
    if (token) headers['X-Player-Token'] = token;
    if (duration !== null) headers['X-Voice-Duration'] = duration;
    return fetch(`${origin}${BASE}/k/${roomId}/voice`, { method: 'POST', headers, body });
  };
  const download = (roomId, token, id) =>
    fetch(`${origin}${BASE}/k/${roomId}/voice/${id}`, { headers: token ? { 'X-Player-Token': token } : {} });

  test('CSP erlaubt zusätzlich nur media-src self + blob', async () => {
    const res = await fetch(`${origin}${BASE}/k/TEST01`);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /media-src 'self' blob:/);
    assert.match(csp, /script-src 'self';/);
    assert.equal(/unsafe/.test(csp), false);
  });

  describe('Text', () => {
    test('geht live an alle im Raum, auch an Zuschauer – nicht an andere Räume', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      const b = await enter(id, 'Ben');
      await enter(id, 'Cem');
      const spec = await enter(id, 'Zoe');
      const other = await enter(newRoomId(), 'Fremd');
      let leaked = false;
      other.socket.on('chat:message', () => { leaked = true; });

      const atB = nextEvent(b.socket, 'chat:message');
      const atSpec = nextEvent(spec.socket, 'chat:message');
      const atA = nextEvent(a.socket, 'chat:message');
      assert.equal((await request(a.socket, 'chat:send', { text: 'Kontra!' })).ok, true);
      const m = await atB;
      assert.equal(m.name, 'Anna');
      assert.equal(m.text, 'Kontra!');
      assert.equal(typeof m.at, 'number');
      assert.deepEqual(await atSpec, m);
      assert.deepEqual(await atA, m);
      assert.equal(JSON.stringify(m).includes(a.token), false, 'kein Token in der Nachricht');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(leaked, false);
    });

    test('nur Raum-Mitglieder: ohne Beitritt kein Senden', async () => {
      const id = newRoomId();
      await enter(id, 'Anna');
      const outsider = await phone();
      const res = await request(outsider, 'chat:send', { text: 'Hallo?' });
      assert.equal(res.code, 'NICHT_IM_RAUM');
      assert.equal(server.registry.get(id).chat.messages.length, 0);
    });

    test('wer dazukommt oder neu verbindet, bekommt den Verlauf', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      await request(a.socket, 'chat:send', { text: 'Erste' });
      const b = await enter(id, 'Ben');
      assert.deepEqual(b.history.map((m) => m.text), ['Erste']);

      const again = await phone();
      const history = nextEvent(again, 'chat:history');
      await request(again, 'room:join', { roomId: id, token: a.token });
      assert.deepEqual((await history).map((m) => m.text), ['Erste']);
    });

    test('Rate-Limit: 5 Nachrichten pro Spieler in 10 s, neu verbinden hilft nicht', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      const results = [];
      for (let i = 0; i < 6; i++) results.push((await request(a.socket, 'chat:send', { text: `n${i}` })).code ?? 'ok');
      assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok', 'ZU_VIELE']);
      assert.equal(server.registry.get(id).chat.messages.length, 5);

      const again = await phone();
      await request(again, 'room:join', { roomId: id, token: a.token });
      assert.equal((await request(again, 'chat:send', { text: 'nochmal' })).code, 'ZU_VIELE');

      // Andere Spieler sind nicht betroffen
      const b = await enter(id, 'Ben');
      assert.equal((await request(b.socket, 'chat:send', { text: 'Ich darf' })).ok, true);
    });

    test('zu lang und leer werden abgelehnt', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      assert.equal((await request(a.socket, 'chat:send', { text: 'x'.repeat(201) })).code, 'CHAT_ZU_LANG');
      assert.equal((await request(a.socket, 'chat:send', { text: '  ' })).code, 'CHAT_LEER');
      assert.equal((await request(a.socket, 'chat:send', {})).code, 'CHAT_LEER');
    });
  });

  describe('Sprachnachricht hochladen', () => {
    test('landet als Sprachblase bei allen, Datei kommt unverändert zurück', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      const b = await enter(id, 'Ben');
      const body = fakeMp4(2048);
      const atB = nextEvent(b.socket, 'chat:message');
      const res = await upload(id, a.token, body, { duration: '4200' });
      assert.equal(res.status, 201);
      const m = await atB;
      assert.equal(m.kind, 'voice');
      assert.equal(m.name, 'Anna');
      assert.equal(m.voice.durationMs, 4200);
      assert.equal(m.voice.mime, 'audio/mp4');
      assert.equal(JSON.stringify(m).includes(a.token), false);

      const file = await download(id, b.token, m.voice.id);
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('content-type').split(';')[0], 'audio/mp4');
      assert.match(file.headers.get('cache-control'), /no-store/);
      assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), body);
    });

    test('iPhone <-> Android: beide Formate gehen durch und kommen mit richtigem Typ zurück', async () => {
      const id = newRoomId();
      const iphone = await enter(id, 'iPhone');
      const android = await enter(id, 'Android');
      for (const [mime, body, from, to] of [
        ['audio/mp4', fakeMp4(), iphone, android],
        ['audio/webm', fakeWebm(), android, iphone],
      ]) {
        const atTo = nextEvent(to.socket, 'chat:message');
        // ";codecs=x": So kann ein Browser den Typ mitsamt Codec melden
        assert.equal((await upload(id, from.token, body, { mime: `${mime};codecs=x` })).status, 201);
        const m = await atTo;
        assert.equal(m.voice.mime, mime);
        const file = await download(id, to.token, m.voice.id);
        assert.equal(file.headers.get('content-type').split(';')[0], mime);
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), body);
      }
    });

    test('ohne oder mit falschem Token → 403, nichts wird gespeichert', async () => {
      const id = newRoomId();
      await enter(id, 'Anna');
      for (const token of [undefined, 'falsch']) {
        const res = await upload(id, token);
        assert.equal(res.status, 403);
        assert.equal((await res.json()).code, 'NICHT_IM_RAUM');
      }
      assert.equal(server.registry.get(id).chat.messages.length, 0);
    });

    test('Token aus einem anderen Raum gilt nicht', async () => {
      const id = newRoomId();
      await enter(id, 'Anna');
      const other = await enter(newRoomId(), 'Fremd');
      assert.equal((await upload(id, other.token)).status, 403);
    });

    test('Raum existiert nicht oder ungültige ID → 403', async () => {
      assert.equal((await upload('GIBTESNICHT', 'x')).status, 403);
      assert.equal((await upload('a!b', 'x')).status, 403);
    });

    test('Größe: genau 600 KB geht, ein Byte mehr → 413', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      const b = await enter(id, 'Ben');
      assert.equal((await upload(id, a.token, fakeMp4(VOICE_MAX_BYTES))).status, 201);
      const tooBig = await upload(id, b.token, fakeMp4(VOICE_MAX_BYTES + 1));
      assert.equal(tooBig.status, 413);
      assert.equal((await tooBig.json()).code, 'ZU_GROSS');
      assert.equal(server.registry.get(id).chat.messages.length, 1);
    });

    test('falsches Format → abgelehnt, auch wenn nur der Typ stimmt', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      assert.equal((await upload(id, a.token, fakeMp4(), { mime: 'text/html' })).status, 415);
      assert.equal((await upload(id, a.token, Buffer.from('<script>x</script>'), { mime: 'audio/mp4' })).status, 400);
      const b = await enter(id, 'Ben');
      assert.equal((await upload(id, b.token, Buffer.alloc(0))).status, 400);
    });

    test('Dauer über 30 s oder ungültig → abgelehnt', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      assert.equal((await upload(id, a.token, fakeMp4(), { duration: '60000' })).status, 400);
      assert.equal((await upload(id, a.token, fakeMp4(), { duration: 'lang' })).status, 400);
      assert.equal((await upload(id, a.token, fakeMp4(), { duration: null })).status, 400);
    });

    test('Rate-Limit: 3 pro Spieler in 30 s', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await upload(id, a.token)).status);
      assert.deepEqual(codes, [201, 201, 201, 429]);
      const b = await enter(id, 'Ben');
      assert.equal((await upload(id, b.token)).status, 201, 'andere Spieler sind nicht betroffen');
    });
  });

  describe('Sprachnachricht abrufen', () => {
    async function withVoice() {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      const b = await enter(id, 'Ben');
      const atB = nextEvent(b.socket, 'chat:message');
      await upload(id, a.token);
      return { id, a, b, voiceId: (await atB).voice.id };
    }

    test('nur mit gültigem Token des Raums', async () => {
      const { id, b, voiceId } = await withVoice();
      assert.equal((await download(id, b.token, voiceId)).status, 200);
      assert.equal((await download(id, undefined, voiceId)).status, 403);
      assert.equal((await download(id, 'falsch', voiceId)).status, 403);
      const other = await enter(newRoomId(), 'Fremd');
      assert.equal((await download(id, other.token, voiceId)).status, 403);
    });

    test('Token im URL-Parameter zählt nicht', async () => {
      const { id, b, voiceId } = await withVoice();
      assert.equal((await fetch(`${origin}${BASE}/k/${id}/voice/${voiceId}?token=${b.token}`)).status, 403);
    });

    test('wer den Raum verlässt, kommt nicht mehr dran', async () => {
      const { id, b, voiceId } = await withVoice();
      await request(b.socket, 'seat:leave');
      await request(b.socket, 'room:leave');
      assert.equal((await download(id, b.token, voiceId)).status, 403);
    });

    test('unbekannte oder krumme ID → 404, kein Pfad-Trick', async () => {
      const { id, b } = await withVoice();
      assert.equal((await download(id, b.token, 'a'.repeat(32))).status, 404);
      assert.equal((await download(id, b.token, '..%2F..%2Fpackage.json')).status, 404);
    });

    test('ID aus einem anderen Raum → 404', async () => {
      const { voiceId } = await withVoice();
      const otherId = newRoomId();
      const other = await enter(otherId, 'Fremd');
      assert.equal((await download(otherId, other.token, voiceId)).status, 404);
    });
  });

  describe('Löschen', () => {
    /** Drei Spieler bis zur Abendwertung bringen */
    async function toSummary(id) {
      const seated = [await enter(id, 'Anna'), await enter(id, 'Ben'), await enter(id, 'Cem')];
      assert.equal((await request(seated[0].socket, 'game:start')).ok, true);
      for (const s of seated) await request(s.socket, 'vote:request', { kind: 'end' });
      assert.equal(server.registry.get(id).status, 'summary');
      return seated;
    }

    test('Neuer Abend: Chat leer, Dateien weg, alle bekommen Bescheid', async () => {
      const id = newRoomId();
      const [a, b] = await toSummary(id);
      await request(a.socket, 'chat:send', { text: 'gute Runde' });
      await upload(id, a.token);
      const { voice } = server.registry.get(id).chat.messages.at(-1);
      const inRoom = () => [...server.voices.files()].filter((f) => f.roomId === id).length;
      assert.equal(inRoom(), 1);

      const cleared = nextEvent(b.socket, 'chat:cleared');
      assert.equal((await request(a.socket, 'evening:new')).ok, true);
      await cleared;
      assert.equal(server.registry.get(id).chat.messages.length, 0);
      assert.equal(inRoom(), 0);
      assert.equal((await download(id, b.token, voice.id)).status, 404);
    });

    test('Zuschauer kann den Chat nicht per Neuer Abend leeren', async () => {
      const id = newRoomId();
      const [a] = await toSummary(id);
      const spec = await enter(id, 'Zoe');
      await request(a.socket, 'chat:send', { text: 'bleibt' });
      assert.equal((await request(spec.socket, 'evening:new')).code, 'NUR_SPIELER');
      assert.equal(server.registry.get(id).chat.messages.length, 1);
    });

    test('nach 24 h: Nachricht und Datei weg, Text bleibt, alle bekommen Bescheid', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      const b = await enter(id, 'Ben');
      const atB = nextEvent(b.socket, 'chat:message');
      await upload(id, a.token);
      const m = await atB;
      await request(a.socket, 'chat:send', { text: 'Text bleibt' });
      const chat = server.registry.get(id).chat;

      // 23:59 h: noch da
      chat.messages[0].at = Date.now() - (24 * 3_600_000 - 60_000);
      server.sweepVoice();
      assert.equal((await download(id, b.token, m.voice.id)).status, 200);

      // 24 h: weg
      chat.messages[0].at = Date.now() - 24 * 3_600_000;
      const removed = nextEvent(b.socket, 'chat:removed');
      server.sweepVoice();
      assert.deepEqual(await removed, [m.seq]);
      assert.deepEqual(chat.messages.map((x) => x.text), ['Text bleibt']);
      assert.equal((await download(id, b.token, m.voice.id)).status, 404);
      assert.equal([...server.voices.files()].some((f) => f.id === m.voice.id), false);
    });

    test('Datei von einem gelöschten Raum wird aufgeräumt', async () => {
      const id = newRoomId();
      const a = await enter(id, 'Anna');
      await upload(id, a.token);
      assert.equal([...server.voices.files()].filter((f) => f.roomId === id).length, 1);
      server.registry.rooms.delete(id);
      server.sweepVoice();
      assert.equal([...server.voices.files()].filter((f) => f.roomId === id).length, 0);
    });
  });
});

describe('Neustart: Sprachnachrichten', () => {
  const DAY = 24 * 3_600_000;

  test('überleben den Neustart, aber nie länger als 24 h – auch wenn der Server aus war', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-restart-'));
    const voiceDir = join(dir, 'voice');
    const dbPath = join(dir, 'x.db');
    let now = 1_000_000;
    const start = () => {
      const store = new SqliteStore(dbPath);
      return createApp({ store, voiceDir, registry: new RoomRegistry({ store, now: () => now }) });
    };
    try {
      let app = start();
      await new Promise((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
      const room = app.registry.getOrCreate('TEST01');
      const { player } = room.join({ name: 'Anna' });
      const voice = { id: 'a'.repeat(32), mime: 'audio/mp4', durationMs: 1000, bytes: 64 };
      app.voices.save('TEST01', voice, fakeMp4());
      room.addVoiceMessage(player.token, voice);
      room.sendChat(player.token, 'Text');
      app.registry.persist(room);
      await app.close();

      // Neustart innerhalb der Frist: alles noch da
      now += DAY - 1000;
      app = start();
      assert.equal(app.registry.get('TEST01').chat.messages.length, 2);
      assert.equal(existsSync(join(voiceDir, 'TEST01', `${voice.id}.m4a`)), true);
      assert.deepEqual(readFileSync(join(voiceDir, 'TEST01', `${voice.id}.m4a`)), fakeMp4());
      await app.close();

      // Neustart nach Ablauf: Sprachnachricht weg, schon beim Start
      now += 2000;
      app = start();
      assert.deepEqual(app.registry.get('TEST01').chat.messages.map((m) => m.text), ['Text']);
      assert.equal(existsSync(join(voiceDir, 'TEST01', `${voice.id}.m4a`)), false);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('voice-Ordner steckt nicht in der SQLite-Sicherung', async () => {
    const store = new SqliteStore(':memory:');
    const room = new Room('TEST01');
    const { player } = room.join({ name: 'Anna' });
    room.addVoiceMessage(player.token, { id: 'a'.repeat(32), mime: 'audio/mp4', durationMs: 1, bytes: 64 });
    store.save(room.id, room.toJSON());
    const [{ data }] = store.loadAll();
    assert.deepEqual(Object.keys(data.chat.messages[0].voice).sort(), ['bytes', 'durationMs', 'id', 'mime'], 'nur Angaben, keine Audiodaten');
    store.close();
  });
});
