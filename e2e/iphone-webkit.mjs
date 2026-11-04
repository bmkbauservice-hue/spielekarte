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

  let clicks = 0;
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
    await actor.click('.hand .card.playable >> nth=0', { position: { x: 8, y: 50 }, timeout: 6000 });
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
