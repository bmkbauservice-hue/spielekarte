// Integrationstest: echter Server (mit Basis-Pfad /spiel) + simulierte Handys per socket.io-client.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connectClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { normalizeBasePath } from '../src/config.js';

const BASE = '/spiel';
let server;
let origin;
const clients = [];

before(async () => {
  server = createApp({ basePath: BASE });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(async () => {
  for (const c of clients) c.disconnect();
  await server.close();
});

/** Neues "Handy" verbinden */
async function phone() {
  const socket = connectClient(origin, { path: `${BASE}/socket.io`, transports: ['websocket'], forceNew: true });
  clients.push(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

const request = (socket, event, data = {}) => new Promise((resolve) => socket.emit(event, data, resolve));

/** Wartet auf den nächsten room:state, der die Bedingung erfüllt */
const nextState = (socket, predicate = () => true) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Kein passender room:state erhalten')), 2000);
    const onState = (state) => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off('room:state', onState);
      resolve(state);
    };
    socket.on('room:state', onState);
  });

describe('Konfiguration', () => {
  test('normalizeBasePath', () => {
    assert.equal(normalizeBasePath(''), '');
    assert.equal(normalizeBasePath('/'), '');
    assert.equal(normalizeBasePath('/spiel/'), '/spiel');
    assert.equal(normalizeBasePath('spiel'), '/spiel');
    assert.throws(() => normalizeBasePath('/sp iel'));
    assert.throws(() => normalizeBasePath('/<script>'));
  });
});

describe('HTTP unter Basis-Pfad', () => {
  test('Health-Check', async () => {
    const res = await fetch(`${origin}${BASE}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test('Raumseite enthält Karten-ID und Basis-Pfad', async () => {
    const res = await fetch(`${origin}${BASE}/k/MUJU01`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-room="MUJU01"/);
    assert.match(html, /<meta name="base-path" content="\/spiel">/);
    assert.match(html, /src="\/spiel\/socket\.io\/socket\.io\.js"/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  });

  test('Kleinschreibung → Weiterleitung auf kanonische URL', async () => {
    const res = await fetch(`${origin}${BASE}/k/muju01`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), `${BASE}/k/MUJU01`);
  });

  test('ungültige ID und Pfad ohne Prefix → 404', async () => {
    assert.equal((await fetch(`${origin}${BASE}/k/a%3Cb%3E`)).status, 404);
    assert.equal((await fetch(`${origin}/k/MUJU01`)).status, 404);
  });

  test('statische Dateien und Socket.IO-Client unter dem Prefix', async () => {
    assert.equal((await fetch(`${origin}${BASE}/static/room.js`)).status, 200);
    assert.equal((await fetch(`${origin}${BASE}/socket.io/socket.io.js`)).status, 200);
  });
});

describe('Spielraum per Socket.IO', () => {
  test('3 Spieler betreten den Raum, alle sehen die Liste, Start möglich', async () => {
    const [a, b, c] = [await phone(), await phone(), await phone()];

    const ra = await request(a, 'room:join', { roomId: 'LIVE01', name: 'Anna' });
    assert.equal(ra.ok, true);
    assert.equal(typeof ra.token, 'string');
    await request(b, 'room:join', { roomId: 'live01', name: 'Ben' }); // Kleinschreibung egal

    const aSeesThree = nextState(a, (s) => s.seats.every(Boolean));
    await request(c, 'room:join', { roomId: 'LIVE01', name: 'Cem' });
    const state = await aSeesThree;

    assert.deepEqual(state.seats.map((s) => s.name), ['Anna', 'Ben', 'Cem']);
    assert.equal(state.you.seat, 0);
    assert.equal(state.canStart, true);
    assert.equal(JSON.stringify(state).includes(ra.token), false, 'Token darf nie im Zustand stehen');

    const running = nextState(b, (s) => s.status === 'running');
    assert.equal((await request(c, 'game:start')).ok, true);
    assert.equal((await running).status, 'running');
  });

  test('4. Person wird Zuschauer und darf nicht starten', async () => {
    const players = [];
    for (const name of ['Ida', 'Jan', 'Kim']) {
      const s = await phone();
      await request(s, 'room:join', { roomId: 'ZUSCH1', name });
      players.push(s);
    }
    const watcher = await phone();
    const stateP = nextState(watcher);
    await request(watcher, 'room:join', { roomId: 'ZUSCH1', name: 'Lea' });
    const state = await stateP;
    assert.equal(state.you.seat, null);
    assert.equal(state.spectators.length, 1);
    assert.equal(state.canStart, false);
    const res = await request(watcher, 'game:start');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NUR_SPIELER');
  });

  test('Neuladen mit Token behält den Platz', async () => {
    const first = await phone();
    const { token } = await request(first, 'room:join', { roomId: 'RELOAD', name: 'Ole' });
    await request((await phone()), 'room:join', { roomId: 'RELOAD', name: 'Pia' });

    const observer = await phone();
    await request(observer, 'room:join', { roomId: 'RELOAD', name: 'Zoe' });

    const sawOffline = nextState(observer, (s) => s.seats[0] && !s.seats[0].connected);
    first.disconnect();
    await sawOffline;

    const reloaded = await phone();
    const stateP = nextState(reloaded);
    const res = await request(reloaded, 'room:join', { roomId: 'RELOAD', token });
    assert.equal(res.ok, true);
    const state = await stateP;
    assert.equal(state.you.seat, 0);
    assert.equal(state.seats[0].name, 'Ole');
    assert.equal(state.seats[0].connected, true);
  });

  test('gleiches Token in zweitem Tab → erster Tab wird abgelöst', async () => {
    const tab1 = await phone();
    const { token } = await request(tab1, 'room:join', { roomId: 'ZWEITAB', name: 'Uwe' });
    const replaced = new Promise((resolve) => tab1.once('session:replaced', resolve));
    const tab2 = await phone();
    assert.equal((await request(tab2, 'room:join', { roomId: 'ZWEITAB', token })).ok, true);
    await replaced;
    // Der alte Tab darf nichts mehr tun
    assert.equal((await request(tab1, 'seat:leave')).code, 'NICHT_IM_RAUM');
    // Wenn der alte Tab schließt, bleibt der Spieler trotzdem verbunden
    tab1.disconnect();
    const room = server.registry.get('ZWEITAB');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(room.players.get(token).connected, true);
  });

  test('unbekanntes Token → TOKEN_UNBEKANNT; kaputte Eingaben stürzen nicht ab', async () => {
    const s = await phone();
    assert.equal((await request(s, 'room:join', { roomId: 'NEU123', token: 'alt' })).code, 'TOKEN_UNBEKANNT');
    assert.equal((await request(s, 'room:join', { roomId: '../../etc' , name: 'X' })).code, 'RAUM_UNGUELTIG');
    assert.equal((await request(s, 'room:join', 'kein-objekt')).code, 'RAUM_UNGUELTIG');
    assert.equal((await request(s, 'seat:take', { seat: 'abc' })).code, 'NICHT_IM_RAUM');
  });
});

describe('Skat-Runde per Socket.IO', () => {
  /** wartet, bis eine Bedingung erfüllt ist (Zustände kommen asynchron über drei Verbindungen) */
  async function waitUntil(predicate, ms = 2000) {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('Bedingung nicht erfüllt');
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  const cardsLeft = (s) => s.game.handCounts.reduce((a, b) => a + b, 0);

  test('komplette Runde: nur eigene Karten, nur erlaubte Züge, Ergebnis, neue Runde', async () => {
    const phones = [await phone(), await phone(), await phone()];
    const latest = [null, null, null];
    phones.forEach((p, i) => p.on('room:state', (s) => { latest[i] = s; }));
    for (const [i, name] of ['Ali', 'Bea', 'Cai'].entries()) {
      assert.equal((await request(phones[i], 'room:join', { roomId: 'SPIEL1', name })).ok, true);
    }
    await request(phones[0], 'game:start');
    await waitUntil(() => latest.every((s) => s?.game?.phase === 'declaring'));

    // Auf der Leitung: jedes Handy hat 10 eigene Karten und keine fremde
    const hands = latest.map((s) => s.game.hand);
    assert.deepEqual(hands.map((h) => h.length), [10, 10, 10]);
    assert.equal(new Set(hands.flat()).size, 30);
    for (const i of [0, 1, 2]) {
      const json = JSON.stringify(latest[i]);
      for (const card of hands.filter((_, j) => j !== i).flat()) assert.equal(json.includes(`"${card}"`), false);
      assert.equal(latest[i].game.skat, null);
    }

    const declarer = latest[0].game.declarer;
    assert.equal(declarer, 0, 'erste Runde: Platz 1 ist Alleinspieler');
    assert.equal((await request(phones[1], 'game:declare', { type: 'grand' })).code, 'NICHT_ALLEINSPIELER');
    assert.equal((await request(phones[0], 'game:declare', { type: 'suit', trump: 'pik' })).ok, true);

    let played = 0;
    for (;;) {
      await waitUntil(() => latest.every((s) => cardsLeft(s) === 30 - played));
      const g = latest[0].game;
      if (g.phase === 'finished') break;
      const turn = g.turn;
      const other = (turn + 1) % 3;
      assert.equal((await request(phones[other], 'game:play', { card: latest[other].game.hand[0] })).code, 'NICHT_DRAN');
      const mine = latest[turn].game;
      const illegal = mine.hand.find((c) => !mine.legal.includes(c));
      if (illegal) assert.equal((await request(phones[turn], 'game:play', { card: illegal })).code, 'BEDIENPFLICHT');
      assert.equal((await request(phones[turn], 'game:play', { card: mine.legal[0] })).ok, true);
      played++;
    }

    const results = latest.map((s) => s.game.result);
    assert.equal(results[0].declarerPoints + results[0].defenderPoints, 120);
    assert.deepEqual(results[1], results[0]);
    assert.equal(latest[2].game.skat.length, 2, 'Skat wird am Ende aufgedeckt');

    assert.equal((await request(phones[2], 'game:next')).ok, true);
    await waitUntil(() => latest.every((s) => s.round === 2 && s.game.phase === 'declaring'));
    assert.equal(latest[0].game.declarer, 1, 'Alleinspieler wechselt reihum');
  });
});
