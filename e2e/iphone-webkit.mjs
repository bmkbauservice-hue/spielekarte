// iPhone-Test mit Playwright WebKit + Geräteprofil (iPhone 12 / iPhone SE), CSP an.
// Spielt eine komplette Runde inkl. Misch-Show und Reizen, prüft Zoom, unsichtbare Seite,
// hängende Animationen, Fehler in der Show und den globalen Fehlerhinweis.
//
//   npx playwright-core install webkit      (einmalig)
//   npm run test:iphone                     (beide Geräte)
//   node e2e/iphone-webkit.mjs "iPhone SE"  (ein Gerät)
//
// Hinweis: Das ist ein AKTUELLES WebKit. Syntax, die nur alte iPhones nicht verstehen,
// prüft test/browser-compat.test.js.
import { webkit, devices } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const project = fileURLToPath(new URL('..', import.meta.url));
const deviceName = process.argv[2] || 'iPhone 12';
const port = 3113 + (deviceName === 'iPhone SE' ? 1 : 0);
const out = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(out, { recursive: true });
const tag = deviceName.replace(/\s+/g, '');
const srv = spawn('node', ['src/server.js'], { cwd: project, env: { ...process.env, PORT: String(port), CARD_IDS: 'TEST01', BASE_PATH: '/spiel' } });
await new Promise((r) => setTimeout(r, 900));
process.on('exit', () => srv.kill());

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices[deviceName] });
await ctx.addInitScript(() => {
  window.__zoom = [];
  let last = '-';
  document.addEventListener('pointerdown', (e) => { last = `${e.target.tagName}.${String(e.target.className).slice(0, 30)}#${e.target.id}`; }, true);
  document.addEventListener('click', (e) => { last = `${e.target.tagName}.${String(e.target.className).slice(0, 30)}#${e.target.id}`; }, true);
  const watch = () => {
    if (!window.visualViewport) return;
    let prev = window.visualViewport.scale;
    window.visualViewport.addEventListener('resize', () => {
      const now = window.visualViewport.scale;
      if (Math.abs(now - prev) > 0.01) {
        const status = document.getElementById('game-info');
        window.__zoom.push(`${prev.toFixed(2)}→${now.toFixed(2)} nach Klick auf ${last} | ${status ? status.textContent : ''} | innerW=${innerWidth} docW=${document.documentElement.scrollWidth}`);
      }
      prev = now;
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
});
const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let step = 'Start';
let lastShot = 0; // Playwright-WebKit fügt bei Screenshots ein Stylesheet ein → CSP meldet das (gewollt)
const check = (name, ok, extra = '') => { step = name; results.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` (${extra})` : ''}`); };
const stageGone = async (page) => (await page.$('.fx-stage')) === null;
const waitStageGone = async (page, ms) => { const t0 = Date.now(); while (!(await stageGone(page)) && Date.now() - t0 < ms) await wait(40); return Date.now() - t0; };
const tap = async (page, sel, opts) => { await page.bringToFront(); await page.waitForSelector(`${sel}:not([hidden])`, { timeout: 8000 }); await page.click(sel, { timeout: 8000, ...opts }); };

try {
  const pages = [];
  for (const [p, name] of [['a', 'Anna'], ['b', 'Ben'], ['c', 'Cem']]) {
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !(m.text().startsWith('Refused to apply a stylesheet') && Date.now() - lastShot < 1500)) { errors.push(`${p}: ${m.text()}`); console.log(`  [Konsole ${p} nach „${step}“] ${m.text().slice(0, 60)} @ ${JSON.stringify(m.location())}`); } });
    page.on('pageerror', (e) => errors.push(`${p}: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    page.on('crash', () => errors.push(`${p}: WebKit-Tab abgestürzt`));
    await page.goto(`http://localhost:${port}/spiel/k/TEST01?profil=${p}`);
    await page.fill('#name-input', name);
    await tap(page, 'button[type=submit]');
    await page.waitForSelector('#view-room:not([hidden])');
    pages.push(page);
  }
  const [anna, ben, cem] = pages;
  check('Seite lädt und Lobby erscheint auf allen drei', true);

  // ---------- Chat: senden, empfangen, Ungelesen-Zähler ----------
  const unread = (p) => p.$eval('#chat-unread', (e) => (e.hidden ? 0 : Number(e.textContent)));
  const waitUnread = async (p, n) => { for (let t = 0; t < 100 && (await unread(p)) !== n; t++) await wait(30); return unread(p); };
  const msgCount = (p) => p.$$eval('.chat-msg', (e) => e.length);
  const waitMsgs = async (p, n) => { for (let t = 0; t < 100 && (await msgCount(p)) !== n; t++) await wait(30); return msgCount(p); };
  const say = async (p, text) => { await p.bringToFront(); await p.fill('#chat-input', text); await p.click('#chat-form button[type=submit]'); };

  check('Chat ist anfangs zu, Zähler aus', (await anna.isHidden('#chat-panel')) && (await unread(anna)) === 0);
  await tap(anna, '#btn-chat');
  check('Chat-Knopf klappt das Panel auf', await anna.isVisible('#chat-panel'));
  await say(anna, 'Moin zusammen!');
  check('eigene Nachricht erscheint, ohne Zähler', (await waitMsgs(anna, 1)) === 1 && (await unread(anna)) === 0);
  check('Ben: Zähler steht auf 1', (await waitUnread(ben, 1)) === 1);
  check('Ben: Ungelesen auch im Knopf-Text', (await ben.getAttribute('#btn-chat', 'aria-label')).includes('1 ungelesen'));

  await say(anna, '<img src=x onerror="window.__xss=1"><b>fett</b>');
  check('Cem: Zähler steht auf 2', (await waitUnread(cem, 2)) === 2);
  await tap(ben, '#btn-chat');
  check('Ben öffnet: Zähler weg, beide Nachrichten da', (await unread(ben)) === 0 && (await msgCount(ben)) === 2);
  const bubble = await ben.$eval('.chat-msg:last-child', (e) => ({ text: e.querySelector('.chat-text').textContent, html: e.querySelectorAll('img, .chat-text b').length, name: e.querySelector('.chat-meta b').textContent, time: e.querySelector('time').textContent, xss: window.__xss }));
  check('HTML im Chat bleibt reiner Text', bubble.html === 0 && bubble.xss === undefined && bubble.text.startsWith('<img'));
  check('Nachricht zeigt Name und Uhrzeit', bubble.name === 'Anna' && /^\d\d:\d\d$/.test(bubble.time), `${bubble.name} ${bubble.time}`);
  check('fremde Nachricht nicht als eigene markiert', (await ben.$$('.chat-msg.mine')).length === 0 && (await anna.$$('.chat-msg.mine')).length === 2);

  await ben.bringToFront();
  await ben.click('#chat-quick button:has-text("Mach hinne!")');
  check('Schnellspruch kommt bei Anna an', (await waitMsgs(anna, 3)) === 3 && (await anna.textContent('.chat-msg:last-child .chat-text')) === 'Mach hinne!');
  await say(ben, 'x'.repeat(250));
  check('Eingabe begrenzt auf 200 Zeichen', (await waitMsgs(anna, 4)) === 4 && (await anna.textContent('.chat-msg:last-child .chat-text')).length === 200);

  // Rate-Limit: Ben schreibt so schnell, bis der Server ablehnt (5 in 10 s). Der Text darf dabei nicht verloren gehen.
  let refused = null;
  for (let i = 0; i < 10 && !refused; i++) {
    await say(ben, `schnell ${i}`);
    for (let t = 0; t < 10 && !refused; t++) {
      if (await ben.inputValue('#chat-input')) refused = await ben.textContent('#toast');
      else await wait(20);
    }
  }
  check('Rate-Limit: Zu schnell → Hinweis, Text bleibt im Eingabefeld', !!refused && refused.includes('schnell'), refused || 'nie abgelehnt');
  await ben.fill('#chat-input', '');

  const fits = async (p) => p.evaluate(() => {
    const vv = window.visualViewport;
    const r = document.getElementById('chat-panel').getBoundingClientRect();
    return { docW: document.documentElement.scrollWidth, innerW: innerWidth, left: r.left, right: r.right, scale: vv ? vv.scale : 1 };
  });
  await anna.bringToFront();
  const box = await fits(anna);
  check('Chat ragt nicht über den Rand', box.docW <= box.innerW && box.left >= 0 && box.right <= box.innerW, JSON.stringify(box));
  await anna.focus('#chat-input');
  await wait(300);
  check('kein Zoom beim Tippen ins Chat-Feld', Math.abs((await fits(anna)).scale - 1) < 0.01);
  lastShot = Date.now(); await anna.screenshot({ path: `${out}${tag}-chat.png`, caret: 'initial' });
  await anna.evaluate(() => document.activeElement.blur());
  await tap(anna, '#btn-chat-close');
  check('Chat lässt sich einklappen', await anna.isHidden('#chat-panel'));
  await tap(ben, '#btn-chat-close');

  // Neu geladen: Verlauf bleibt, Gelesen-Stand auch
  await ben.reload();
  await ben.waitForSelector('#view-room:not([hidden])');
  await waitMsgs(ben, await msgCount(anna));
  check('Neuladen: Verlauf ist wieder da, nichts wird neu als ungelesen gezählt', (await msgCount(ben)) === (await msgCount(anna)) && (await unread(ben)) === 0);

  // ---------- A) Runde 1: Misch-Show + Reizen + Spiel ----------
  await tap(anna, '#btn-start');
  await anna.waitForSelector('.fx-stage', { timeout: 3000 });
  check('Misch-Show startet', true);
  const showMs = await waitStageGone(anna, 6000);
  check('Misch-Show verschwindet von selbst', await stageGone(anna), `${showMs} ms`);
  for (const p of [ben, cem]) await waitStageGone(p, 6000);

  await tap(ben, '#btn-bid-go');          // Ben (Mittelhand): 18
  await tap(anna, '#btn-bid-go');         // Anna: Ja
  await tap(ben, '#btn-bid-go');          // Ben: 20
  await tap(anna, '#btn-bid-pass');
  await tap(cem, '#btn-bid-pass');
  check('Reizen per Tippen durchgelaufen', true);

  await tap(ben, '#btn-skat');
  await ben.waitForSelector('#discard:not([hidden])');
  const cardBox = await ben.$eval('.hand .card', (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  check('Karten haben echte Größe', cardBox.h > 60 && cardBox.w > 40, `${cardBox.w}×${cardBox.h}`);
  await ben.click('.hand .card >> nth=10', { position: { x: 8, y: 50 } });
  await ben.click('.hand .card >> nth=11', { position: { x: 8, y: 50 } });
  await tap(ben, '#btn-discard');
  await ben.waitForSelector('#declare:not([hidden])');

  // ---------- D) Ansage: nur die gewählte Spielart ist gold ----------
  const goldBefore = await ben.$$eval('#declare-types button', (bs) => bs.filter((b) => getComputedStyle(b).backgroundColor === 'rgb(232, 199, 102)').length);
  await ben.click('#declare-types button[data-type="grand"]');
  const sel = await ben.$$eval('#declare-types button', (bs) => bs.map((b) => [b.dataset.type + (b.dataset.trump || ''), getComputedStyle(b).backgroundColor === 'rgb(232, 199, 102)', b.getAttribute('aria-pressed')]));
  const golden = sel.filter((x) => x[1]).map((x) => x[0]);
  check('Ansage: vorher keine Spielart gold', goldBefore === 0, `${goldBefore} gold`);
  check('Ansage: nach Wahl nur Grand gold + aria-pressed', golden.length === 1 && golden[0] === 'grand' && sel.find((x) => x[0] === 'grand')[2] === 'true', golden.join(','));
  await tap(ben, '#btn-declare');

  // ---------- Zweimal tippen ----------
  // Echte Touch-Ereignisse (wie am Handy), auf den sichtbaren Streifen der Karte
  const handCount = (p) => p.$$eval('.hand .card', (e) => e.length);
  const armedCard = (p) => p.$$eval('.hand .card.armed', (e) => e.map((c) => c.dataset.card));
  const touchCard = async (p, sel) => {
    const pos = await p.$eval(sel, (el) => { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + 8, y: r.top + 50, card: el.dataset.card }; });
    await p.bringToFront();
    await p.touchscreen.tap(pos.x, pos.y);
    await wait(420);
    return pos.card;
  };
  let first = null; // wer ausspielt, hängt vom Geben ab
  for (let t = 0; t < 200 && !first; t++) {
    for (const p of pages) if (await p.$('.hand .card.playable')) first = p;
    if (!first) await wait(30);
  }
  const startCount = await handCount(first);
  const cardA = await touchCard(first, '.hand .card.playable >> nth=0');
  check('1. Tippen hebt die Karte an und spielt sie nicht', (await armedCard(first)).join() === cardA && (await handCount(first)) === startCount, cardA);
  const lift = await first.$eval('.hand .card.armed', (el) => { const s = getComputedStyle(el); return { border: s.borderTopColor, width: s.borderTopWidth, transform: s.transform }; });
  check('angehobene Karte: Mint-Rand und nach oben versetzt', lift.border === 'rgb(62, 242, 192)' && /matrix.*-1[0-9]/.test(lift.transform), JSON.stringify(lift));
  check('Hinweis sagt, wie es weitergeht', (await first.textContent('#hand-hint')).startsWith('Nochmal tippen'));
  lastShot = Date.now(); await first.screenshot({ path: `${out}${tag}-karte-angehoben.png`, caret: 'initial' });

  const cardB = await touchCard(first, '.hand .card.playable >> nth=-1');
  check('andere Karte tippen wechselt die Auswahl', cardA !== cardB && (await armedCard(first)).join() === cardB && (await handCount(first)) === startCount, `${cardA} → ${cardB}`);

  const beside = await first.$eval('#game-sub', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 5 }; });
  await first.touchscreen.tap(beside.x, beside.y); // Text ohne Knopf – dort meldet iOS keinen Klick ans document
  await wait(420);
  check('daneben tippen hebt die Auswahl auf', (await armedCard(first)).length === 0 && (await handCount(first)) === startCount);

  await touchCard(first, '.hand .card.playable >> nth=0');
  await first.$eval('.status-pill', (el) => el.scrollIntoView());
  check('Seite verschieben ohne Tippen hebt die Auswahl nicht auf', (await armedCard(first)).length === 1);
  await touchCard(first, '.hand .card.armed');
  for (let t = 0; t < 150 && (await handCount(first)) !== startCount - 1; t++) await wait(20);
  check('2. Tippen derselben Karte spielt sie aus', (await handCount(first)) === startCount - 1);
  check('nach dem Ausspielen ist nichts mehr angehoben', (await armedCard(first)).length === 0);
  check('kein Zoom nach dem zweimaligen Tippen', Math.abs((await first.evaluate(() => (window.visualViewport ? window.visualViewport.scale : 1))) - 1) < 0.01);

  let clicks = 1; // eine Karte ist schon gespielt
  while (clicks < 40 && !(await anna.isVisible('#result'))) {
    let actor = null;
    for (let t = 0; t < 200 && !actor; t++) {
      for (const p of pages) if (await p.$('.hand .card.playable')) actor = p;
      if (!actor) await wait(30);
    }
    if (!actor) break;
    const before = await actor.$$eval('.hand .card', (e) => e.length);
    // Jeder Spieler hat sein eigenes Handy → dessen Seite ist immer im Vordergrund.
    // Kurze Denkpause: zwei schnelle Maus-Klicks an derselben Stelle wertet die Emulation sonst als Doppelklick-Zoom
    await wait(500);
    await actor.bringToFront();
    // Wie ein Mensch: Hand in den Blick holen, dann auf den sichtbaren Streifen der Karte tippen
    const hit = await actor.$eval('.hand .card.playable', (el) => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + 8;
      const y = r.top + 50;
      const top = document.elementFromPoint(x, y);
      const desc = (e) => (e ? `${e.tagName.toLowerCase()}.${String(e.className).split(' ').join('.')} in ${e.parentElement ? e.parentElement.className : '-'} opacity=${getComputedStyle(e).opacity}` : 'nichts');
      const vv = window.visualViewport;
      return { x, y, hitsCard: !!top && !!top.closest('.card.playable'), oben: desc(top),
        scale: vv && vv.scale, vvTop: vv && Math.round(vv.offsetTop), vvH: vv && Math.round(vv.height), innerW: innerWidth, innerH: innerHeight, scrollY: Math.round(scrollY) };
    });
    if (!hit.hitsCard) console.log('  Zoom-Protokoll:', JSON.stringify(await actor.evaluate(() => window.__zoom)));
    if (!hit.hitsCard) console.log('  Karte nicht treffbar:', JSON.stringify(hit), 'Tab:', ['Anna', 'Ben', 'Cem'][pages.indexOf(actor)], 'Zug', clicks + 1);
    // Zweimal tippen: 1. hebt an, 2. spielt
    await actor.click('.hand .card.playable >> nth=0', { position: { x: 8, y: 50 }, timeout: 6000 });
    await wait(350);
    await actor.click('.hand .card.armed', { position: { x: 8, y: 50 }, timeout: 6000 });
    for (let t = 0; t < 150 && (await actor.$$eval('.hand .card', (e) => e.length)) !== before - 1; t++) await wait(20);
    clicks++;
  }
  await anna.waitForSelector('#result:not([hidden])', { timeout: 8000 });
  check('komplette Runde gespielt (30 Karten)', clicks === 30, `${clicks} Klicks`);
  const scales = await Promise.all(pages.map((p) => p.evaluate(() => (window.visualViewport ? window.visualViewport.scale : 1))));
  check('kein ungewollter Zoom nach vielem Tippen', scales.every((x) => Math.abs(x - 1) < 0.01), scales.map((x) => x.toFixed(2)).join(' / '));
  lastShot = Date.now(); await anna.screenshot({ path: `${out}${tag}-ergebnis.png`, caret: 'initial' }); // ohne caret-Stylesheet (würde die CSP verletzen)

  // ---------- B) Neue Runde, Seite während der Show unsichtbar ----------
  await tap(anna, '#btn-next');
  await anna.waitForSelector('.fx-stage', { timeout: 3000 });
  await wait(600);
  // So meldet iOS "Handy gesperrt / App gewechselt"
  await anna.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenMs = await waitStageGone(anna, 1000);
  check('Seite unsichtbar → Show sofort beendet', await stageGone(anna), `${hiddenMs} ms`);
  await anna.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (const p of [ben, cem]) await waitStageGone(p, 6000);
  // Danach muss Tippen funktionieren: Runde 2 → Cem ist Mittelhand und reizt, Anna (Hinterhand) danach
  await tap(cem, '#btn-bid-pass');
  await tap(anna, '#btn-bid-pass');
  check('nach dem Wiederkommen lässt sich wieder tippen', true);

  // ---------- Mikro: ohne MediaRecorder, ohne Erlaubnis ----------
  const joinAs = async (profile, name, setup) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${profile}: ${e.message}`));
    if (setup) await p.addInitScript(setup);
    await p.goto(`http://localhost:${port}/spiel/k/TEST01?profil=${profile}`);
    await p.fill('#name-input', name);
    await p.click('button[type=submit]');
    await p.waitForSelector('#view-room:not([hidden])');
    await p.click('#btn-chat');
    return p;
  };
  const noRecorder = await joinAs('m1', 'Mia', () => { delete window.MediaRecorder; });
  check('ohne MediaRecorder: Mikro-Knopf ausgeblendet', await noRecorder.isHidden('#btn-mic'));
  await say(noRecorder, 'Text geht trotzdem');
  await noRecorder.waitForSelector('.chat-msg.mine:has-text("Text geht trotzdem")');
  check('ohne MediaRecorder: Text-Chat geht', true);
  await noRecorder.close();

  const denied = await joinAs('m2', 'Nia', () => {
    window.__micAsked = 0;
    window.MediaRecorder = class { static isTypeSupported(t) { return t.startsWith('audio/mp4'); } };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => { window.__micAsked++; return Promise.reject(new DOMException('nein', 'NotAllowedError')); },
    } });
  });
  check('Mikro-Knopf sichtbar, wenn Aufnahme möglich ist', await denied.isVisible('#btn-mic'));
  check('Erlaubnis wird NICHT schon beim Öffnen des Chats gefragt', (await denied.evaluate(() => window.__micAsked)) === 0);
  const micBox = await denied.$eval('#btn-mic', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await denied.mouse.move(micBox.x, micBox.y);
  await denied.mouse.down();
  await denied.waitForSelector('#chat-hint:not([hidden])', { timeout: 3000 });
  await denied.mouse.up();
  check('erst das Drücken fragt nach der Erlaubnis', (await denied.evaluate(() => window.__micAsked)) === 1);
  check('verweigert → Hinweis, dass der Text-Chat weitergeht', (await denied.textContent('#chat-hint')).includes('Text-Chat geht weiter'));
  check('verweigert → keine Aufnahme-Anzeige', await denied.isHidden('#chat-rec'));
  await say(denied, 'Tippen geht noch');
  await denied.waitForSelector('.chat-msg.mine:has-text("Tippen geht noch")');
  check('verweigert → Text-Chat funktioniert', true);
  lastShot = Date.now(); await denied.screenshot({ path: `${out}${tag}-mikro-verweigert.png`, caret: 'initial' });
  await denied.close();

  // ---------- "Neuer Abend" leert den Chat ----------
  await tap(anna, '#btn-end');
  await tap(ben, '#btn-abort-yes');
  await tap(cem, '#btn-abort-yes');
  await anna.waitForSelector('#summary:not([hidden])', { timeout: 5000 });
  check('vor "Neuer Abend": Chat ist voll', (await msgCount(ben)) > 0);
  await tap(anna, '#btn-new-evening');
  check('"Neuer Abend" leert den Chat bei allen', (await waitMsgs(ben, 0)) === 0 && (await waitMsgs(cem, 0)) === 0 && (await waitUnread(cem, 0)) === 0);
  for (const p of pages) await waitStageGone(p, 6000);

  // ---------- C) Störfälle direkt an fx.js ----------
  const probe = await ctx.newPage();
  probe.on('pageerror', (e) => errors.push(`probe: ${e.message}`));
  await probe.goto(`http://localhost:${port}/spiel/k/TEST01?profil=z`);
  await probe.waitForFunction(() => window.SkatFX && window.SkatCrash);
  const back = `() => { const d = document.createElement('div'); d.className = 'card back plain'; return d; }`;

  // 1. Animationen melden nie "fertig" (wie bei angehaltenen Animationen) → Notbremse ≤ 5 s
  const stalledMs = await probe.evaluate(async (backSrc) => {
    const back = eval(backSrc);
    const real = Element.prototype.animate;
    Element.prototype.animate = function () { return { finished: new Promise(() => {}), cancel() {} }; };
    const t0 = performance.now();
    window.SkatFX.shuffle({ targets: {}, order: [], cutter: 'X', seed: 's', myCards: [], makeBack: back, makeFront: back });
    while (document.querySelector('.fx-stage') && performance.now() - t0 < 7000) await new Promise((r) => setTimeout(r, 50));
    Element.prototype.animate = real;
    return { ms: Math.round(performance.now() - t0), gone: !document.querySelector('.fx-stage') };
  }, back);
  check('Animationen hängen → Bühne trotzdem weg', stalledMs.gone && stalledMs.ms <= 5300, `${stalledMs.ms} ms`);

  // 2. Fehler mitten in der Show → Bühne sofort weg
  const errorMs = await probe.evaluate(async () => {
    let n = 0;
    const makeBack = () => { if (++n === 5) throw new Error('Testfehler'); const d = document.createElement('div'); d.className = 'card back plain'; return d; };
    const t0 = performance.now();
    window.SkatFX.shuffle({ targets: {}, order: [], cutter: 'X', seed: 's', myCards: [], makeBack, makeFront: makeBack });
    while (document.querySelector('.fx-stage') && performance.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    return { ms: Math.round(performance.now() - t0), gone: !document.querySelector('.fx-stage') };
  });
  check('Fehler in der Show → Bühne sofort weg', errorMs.gone && errorMs.ms < 400, `${errorMs.ms} ms`);

  // 3. Antippen beendet die Show
  await probe.evaluate((backSrc) => { const back = eval(backSrc); window.SkatFX.shuffle({ targets: {}, order: [], cutter: 'X', seed: 's', myCards: [], makeBack: back, makeFront: back }); }, back);
  await probe.waitForSelector('.fx-stage');
  await probe.click('.fx-stage');
  check('Antippen beendet die Show', (await waitStageGone(probe, 1000)) < 1000);

  // 4. Fehler im Skript → Hinweis mit "Neu laden" statt eingefrorener Seite
  await probe.evaluate(() => {
    // so meldet der Browser einen Fehler aus unserem room.js
    window.dispatchEvent(new ErrorEvent('error', { message: 'Absichtlicher Testfehler', filename: location.origin + '/spiel/static/room.js' }));
  });
  await probe.waitForSelector('.crash', { timeout: 2000 });
  check('Skriptfehler → Hinweis "Neu laden"', (await probe.textContent('.crash')).includes('neu laden'));
  lastShot = Date.now(); await probe.screenshot({ path: `${out}${tag}-fehlerhinweis.png`, caret: 'initial' });
  await probe.evaluate(() => { Promise.reject(new Error('auch abgelehnte Promises')); });
  check('nur ein Hinweis, auch bei mehreren Fehlern', (await probe.$$('.crash')).length === 1);
} catch (err) {
  console.log('ABBRUCH:', err.message.split('\n').slice(0, 14).join('\n'));
  results.push(false);
} finally {
  const unexpected = errors.filter((e) => !/Testfehler|abgelehnte Promises/.test(e));
  check('keine unerwarteten Fehler in der Konsole', unexpected.length === 0, unexpected.join(' | '));
  console.log(`${deviceName}: ${results.filter(Boolean).length}/${results.length} ok`);
  await browser.close();
  srv.kill();
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
