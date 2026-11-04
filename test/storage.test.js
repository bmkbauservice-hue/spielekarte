// Etappe 3c: Speichern in SQLite – Schnappschüsse, Datenbank, Neustart.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connectClient } from 'socket.io-client';
import { Room, SNAPSHOT_VERSION } from '../src/rooms/room.js';
import { RoomRegistry } from '../src/rooms/registry.js';
import { SkatGame } from '../src/game/game.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';
import { createApp } from '../src/app.js';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'spielekarte-test-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

const viaText = (snapshot) => JSON.parse(JSON.stringify(snapshot)); // genau wie in der Datenbank
const silent = { warn: () => {}, error: () => {} };

function tableOf3(rules = { kontra: true, bock: true, schenken: true }) {
  const room = new Room('SPEICH');
  const t = ['Anna', 'Ben', 'Cem'].map((name) => {
    const { player } = room.join({ name });
    room.connect(player.token);
    return player.token;
  });
  room.setHouseRules(t[0], rules);
  room.start(t[0]);
  return { room, t };
}

/** Ein zufälliger erlaubter Zug für die aktuelle Phase – liefert eine Beschreibung, damit er wiederholbar ist */
function randomMove(game) {
  const pick = (list) => list[randomInt(list.length)];
  switch (game.phase) {
    case 'bidding': return { kind: 'bid', seat: game.turn, action: randomInt(3) === 0 ? 'pass' : game.bidding.role === 'listener' ? 'hold' : 'bid' };
    case 'skat': return randomInt(2) ? { kind: 'skat', seat: game.declarer } : { kind: 'declare', seat: game.declarer, spec: { type: 'grand' } };
    case 'discard': { const h = game.hands[game.declarer]; return { kind: 'discard', seat: game.declarer, cards: [h[0], h[1]] }; }
    case 'declaring': return { kind: 'declare', seat: game.declarer, spec: pick([{ type: 'grand' }, { type: 'suit', trump: 'herz' }]) };
    case 'gift': {
      const open = [0, 1, 2].find((s) => s !== game.declarer && game.gift.offers[s] === null);
      return game.gift.awaitingDeclarer ? { kind: 'answer', seat: game.declarer, yes: randomInt(2) === 0 } : { kind: 'gift', seat: open, yes: randomInt(2) === 0 };
    }
    case 'playing': return { kind: 'play', seat: game.turn, card: pick(game.legalFor(game.turn)) };
    default: return null;
  }
}

function applyMove(game, m) {
  if (m.kind === 'bid') game.bid(m.seat, m.action === 'bid' && game.bidding.value >= 60 ? 'pass' : m.action);
  else if (m.kind === 'skat') game.pickUpSkat(m.seat);
  else if (m.kind === 'discard') game.discard(m.seat, m.cards);
  else if (m.kind === 'declare') game.declare(m.seat, m.spec);
  else if (m.kind === 'gift') game.offerGift(m.seat, m.yes);
  else if (m.kind === 'answer') game.answerGift(m.seat, m.yes);
  else game.play(m.seat, m.card);
}

describe('Schnappschuss einer Runde (SkatGame)', () => {
  test('300 zufällige Runden: an zufälliger Stelle speichern + laden → Original und Kopie laufen identisch weiter', () => {
    const rules = { kontra: true, bock: true, schenken: true };
    for (let n = 0; n < 300; n++) {
      const original = new SkatGame({ dealer: n % 3, houseRules: rules, bock: n % 4 === 0 });
      const stopAt = randomInt(45);
      let copy = null;
      for (let step = 0; step < 200; step++) {
        if (step === stopAt) copy = SkatGame.fromJSON(viaText(original.toJSON()));
        const m = randomMove(original);
        if (!m) break;
        applyMove(original, m);
        if (copy) applyMove(copy, m);
      }
      if (!copy) copy = SkatGame.fromJSON(viaText(original.toJSON()));
      assert.deepEqual(copy.toJSON(), original.toJSON());
      for (const seat of [0, 1, 2, null]) assert.deepEqual(copy.viewFor(seat), original.viewFor(seat));
    }
  });

  test('Kopie ist unabhängig vom Original', () => {
    const g = new SkatGame();
    const copy = SkatGame.fromJSON(viaText(g.toJSON()));
    copy.hands[0].pop();
    copy.bidding.passed.push(1);
    assert.equal(g.hands[0].length, 10);
    assert.deepEqual(g.bidding.passed, []);
  });
});

describe('Schnappschuss eines Raums', () => {
  test('mitten in der Runde: Plätze, Karten, Hausregeln, Punkteliste, Bock bleiben erhalten', () => {
    const { room, t } = tableOf3();
    // Runde 1: eingepasst, Runde 2: Reizen läuft
    room.bid(t[1], 'pass'); room.bid(t[2], 'pass'); room.bid(t[0], 'pass');
    room.nextRound(t[0]);
    room.bid(t[2], 'bid');
    room.bockRemaining = 7;

    const restored = Room.fromJSON(viaText(room.toJSON()));
    for (const token of t) restored.connect(token); // erst alle wieder verbinden …
    for (const token of t) assert.deepEqual(restored.stateFor(token), room.stateFor(token), 'gleiche Sicht für jeden Spieler'); // … dann vergleichen
    assert.equal(restored.bockRemaining, 7);
    assert.deepEqual(restored.houseRules, { kontra: true, bock: true, schenken: true });
    assert.equal(restored.scores.length, 1);
  });

  test('nach dem Laden gelten alle als getrennt; die Gnadenfrist beginnt neu; Abstimmungen sind weg', () => {
    let now = 1_000;
    const { room, t } = tableOf3();
    room.requestVote(t[0], 'abort');
    const restored = Room.fromJSON(viaText(room.toJSON()), { now: () => now });
    assert.equal([...restored.players.values()].every((p) => !p.connected && p.lastSeen === 1_000), true);
    assert.equal(restored.vote, null);
    now += 5 * 60_000;
    assert.equal(restored.removeStale(10 * 60_000), 0, 'niemand fliegt direkt nach dem Neustart raus');
  });

  test('Eintrag in der Punkteliste wird nach dem Laden nicht doppelt geschrieben', () => {
    const { room, t } = tableOf3({});
    room.bid(t[1], 'pass'); room.bid(t[2], 'pass'); room.bid(t[0], 'pass');
    const restored = Room.fromJSON(viaText(room.toJSON()));
    restored.recordScore();
    assert.equal(restored.scores.length, 1);
  });

  test('Abendwertung bleibt erhalten', () => {
    const { room, t } = tableOf3({});
    for (const token of t) room.requestVote(token, 'end');
    const restored = Room.fromJSON(viaText(room.toJSON()));
    assert.equal(restored.status, 'summary');
    assert.deepEqual(restored.summary, room.summary);
  });

  test('falsche Version oder kaputte Daten → Fehler statt halbem Raum', () => {
    const { room } = tableOf3();
    const snap = viaText(room.toJSON());
    assert.throws(() => Room.fromJSON({ ...snap, v: SNAPSHOT_VERSION + 1 }), /Version/);
    assert.throws(() => Room.fromJSON({ ...snap, seats: ['gibt-es-nicht', null, null] }), /inkonsistent/);
  });

  test('der Schnappschuss geht nie an Clients – stateFor enthält keine Tokens', () => {
    const { room, t } = tableOf3();
    const json = JSON.stringify(room.stateFor(t[0]));
    for (const token of t) assert.equal(json.includes(token), false);
  });
});

describe('SQLite-Speicher', () => {
  test('speichern, laden, löschen; Schema-Version 1; bleibt nach Schließen erhalten', () => {
    const file = join(dir, 'a', 'test.db');
    const store = new SqliteStore(file);
    assert.equal(store.schemaVersion, 1);
    store.save('ABC', { v: 1, x: 1 });
    store.save('ABC', { v: 1, x: 2 }); // überschreiben, nicht doppelt
    store.save('XYZ', { v: 1, x: 3 });
    store.delete('XYZ');
    store.close();
    store.close(); // zweimal schließen ist harmlos

    const again = new SqliteStore(file);
    assert.deepEqual(again.loadAll(), [{ id: 'ABC', data: { v: 1, x: 2 } }]);
    again.close();
  });

  test('Registry: kaputte und veraltete Räume werden übersprungen, gute geladen', () => {
    const store = new SqliteStore(':memory:');
    const { room } = tableOf3();
    store.save(room.id, room.toJSON());
    store.save('ALT001', { v: 0 });
    store.db.prepare("INSERT INTO rooms VALUES ('KAPUTT', '{nicht json', 0)").run();
    const warnings = [];
    const registry = new RoomRegistry({ store, log: { warn: (m) => warnings.push(m), error: () => {} } });
    assert.deepEqual(registry.loadFromStore(), { loaded: 1, skipped: 2 });
    assert.ok(registry.get('SPEICH'));
    assert.equal(warnings.length, 2);
    store.close();
  });

  test('Aufräumen löscht verlassene Räume auch aus der Datenbank', () => {
    let now = 0;
    const store = new SqliteStore(':memory:');
    const registry = new RoomRegistry({ store, now: () => now, playerIdleMs: 1_000, log: silent });
    const room = registry.getOrCreate('WEG001');
    const { player } = room.join({ name: 'Kurz' });
    registry.persist(room);
    assert.equal(store.loadAll().length, 1);
    room.disconnect(player.token);
    now = 5_000;
    registry.sweep();
    assert.equal(store.loadAll().length, 0);
    store.close();
  });

  test('Datensicherung (VACUUM INTO) ergibt eine lesbare Kopie', () => {
    const store = new SqliteStore(join(dir, 'live.db'));
    store.save('BACKUP', { v: 1 });
    const file = join(dir, 'sicherung', 'backup.db');
    store.backupTo(file);
    store.close();
    assert.ok(existsSync(file));
    const copy = new SqliteStore(file);
    assert.deepEqual(copy.loadAll(), [{ id: 'BACKUP', data: { v: 1 } }]);
    copy.close();
  });
});

describe('Neustart des Servers', () => {
  const request = (s, event, data = {}) => new Promise((resolve) => s.emit(event, data, resolve));

  async function start(file) {
    const app = createApp({ store: new SqliteStore(file) });
    await new Promise((r) => app.httpServer.listen(0, '127.0.0.1', r));
    return { app, url: `http://127.0.0.1:${app.httpServer.address().port}` };
  }
  async function phone(url) {
    const s = connectClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    s.latest = null;
    s.on('room:state', (state) => { s.latest = state; });
    await new Promise((resolve) => s.once('connect', resolve));
    return s;
  }
  const settle = () => new Promise((r) => setTimeout(r, 40));

  test('Abend, Punkteliste, Bock-Zähler und laufende Runde überleben einen Neustart', async () => {
    const file = join(dir, 'neustart.db');
    let { app, url } = await start(file);
    let phones = [await phone(url), await phone(url), await phone(url)];
    const tokens = [];
    for (const [i, name] of ['Anna', 'Ben', 'Cem'].entries()) tokens.push((await request(phones[i], 'room:join', { roomId: 'NEU001', name })).token);

    await request(phones[0], 'rules:set', { kontra: true, bock: true, schenken: false });
    await request(phones[0], 'game:start');
    // Runde 1 einpassen, Runde 2 anreizen
    for (const [seat, act] of [[1, 'pass'], [2, 'pass'], [0, 'pass']]) await request(phones[seat], 'game:bid', { action: act });
    await request(phones[0], 'game:next');
    await request(phones[2], 'game:bid', { action: 'bid' });
    app.registry.get('NEU001').bockRemaining = 5; // als wäre vorher Bock ausgelöst worden
    app.registry.persist(app.registry.get('NEU001'));
    await settle();
    const before = phones.map((p) => p.latest);

    // Server stoppen (wie bei einem Deploy) …
    for (const p of phones) p.disconnect();
    await app.close();

    // … und neu starten
    ({ app, url } = await start(file));
    phones = [await phone(url), await phone(url), await phone(url)];
    for (let i = 0; i < 3; i++) {
      const res = await request(phones[i], 'room:join', { roomId: 'NEU001', token: tokens[i] });
      assert.equal(res.ok, true, `Spieler ${i} kommt mit seinem Token wieder rein`);
    }
    await settle();
    const afterRestart = phones.map((p) => p.latest);

    for (let i = 0; i < 3; i++) {
      assert.equal(afterRestart[i].you.seat, before[i].you.seat, 'gleicher Platz');
      assert.deepEqual(afterRestart[i].game.hand, before[i].game.hand, 'gleiche Karten');
      assert.deepEqual(afterRestart[i].game.bidding, before[i].game.bidding, 'Reizen geht weiter, wo es war');
      assert.deepEqual(afterRestart[i].scores, before[i].scores, 'gleiche Punkteliste');
    }
    assert.equal(afterRestart[0].round, 2);
    assert.equal(afterRestart[0].bockRemaining, 5);
    assert.deepEqual(afterRestart[1].houseRules, { kontra: true, bock: true, schenken: false });

    // Und es geht wirklich weiter: Mittelhand war mit "hören" dran
    assert.equal((await request(phones[1], 'game:bid', { action: 'hold' })).ok, true);

    for (const p of phones) p.disconnect();
    await app.close();
  });
});
