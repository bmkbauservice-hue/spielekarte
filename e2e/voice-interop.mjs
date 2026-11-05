// Sprachnachrichten zwischen den Browser-Welten: Was die eine Seite aufnimmt, muss die andere abspielen.
//
//   npm run test:voice      braucht Google Chrome oder Chromium (oder CHROME_PATH) + WebKit von Playwright
//
// Wer spielt wen?
//   "Android" = Chrome mit Pixel-5-Profil und Test-Mikrofon. Nimmt ECHT auf, im Format, das chat.js wählt.
//               Hat dieses Chrome keinen AAC-Encoder (Linux), ist das WebM/Opus – wie ein Android ohne AAC-Encoder.
//   "iPhone"  = WebKit mit iPhone-12-Profil. Spielt ECHT ab. Aufnehmen kann Playwright-WebKit nicht (kein MediaRecorder),
//               deshalb liefert hier eine Attrappe eine echte AAC-Datei (fixtures/ton-aac.m4a) durch die echte Oberfläche.
//
// WICHTIG – was dieser Test NICHT beweist: WebKit unter Linux dekodiert mit GStreamer, nicht mit den Codecs von iOS, und
// erzwingt die Autoplay-Regeln von iOS nicht. Die Prüfliste für echte Handys steht in der README.
import { webkit, chromium, devices } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const out = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(out, { recursive: true });
const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
if (!chromePath) {
  console.error('✖ Kein Chrome/Chromium gefunden – Test NICHT gelaufen. Pfad mit CHROME_PATH angeben.');
  process.exit(1);
}

const port = 3115;
const origin = `http://localhost:${port}/spiel/k/TEST01`;
const srv = spawn('node', ['src/server.js'], { cwd: project, env: { ...process.env, PORT: String(port), CARD_IDS: 'TEST01', BASE_PATH: '/spiel', DB_PATH: '', VOICE_DIR: '' } });
process.on('exit', () => srv.kill());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(900);

const fixture = readFileSync(new URL('./fixtures/ton-aac.m4a', import.meta.url)).toString('base64');
const tmp = mkdtempSync(join(tmpdir(), 'voice-interop-'));
const results = [];
const errors = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` (${extra})` : ''}`); };

/** Welcher Codec steckt wirklich in der Datei? Der Dateityp allein sagt das nicht. (ohne ffprobe: "?") */
function codecOf(buffer, name) {
  const file = join(tmp, name);
  writeFileSync(file, buffer);
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '?';
}

const chrome = await chromium.launch({
  executablePath: chromePath,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const safari = await webkit.launch();

try {
  const androidCtx = await chrome.newContext({ ...devices['Pixel 5'], permissions: ['microphone'] });
  const iphoneCtx = await safari.newContext({ ...devices['iPhone 12'] });

  async function enter(ctx, profile, name, setup, setupArg) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    if (setup) await page.addInitScript(setup, setupArg);
    await page.goto(`${origin}?profil=${profile}`);
    await page.fill('#name-input', name);
    await page.click('button[type=submit]');
    await page.waitForSelector('#view-room:not([hidden])');
    await page.click('#btn-chat');
    return page;
  }

  const android = await enter(androidCtx, 'a', 'Android');
  const iphone = await enter(iphoneCtx, 'i', 'iPhone', (b64) => {
    window.__micStopped = 0;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    window.MediaRecorder = class {
      static isTypeSupported(t) { return t.startsWith('audio/mp4'); }
      constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable({ data: new Blob([bytes], { type: 'audio/mp4' }) });
        this.onstop();
      }
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() { window.__micStopped++; } }] }),
    } });
  }, fixture);

  // ---------- Hilfen ----------
  async function press(page) {
    await page.bringToFront();
    const at = await page.$eval('#btn-mic', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    return at;
  }
  async function hold(page, ms) {
    await press(page);
    await wait(ms);
    await page.mouse.up();
  }
  const bubbles = (page) => page.$$eval('.voice-play', (e) => e.length);
  async function waitBubbles(page, n, ms = 6000) {
    const t0 = Date.now();
    while ((await bubbles(page)) < n && Date.now() - t0 < ms) await wait(40);
    return bubbles(page);
  }

  /** Letzte Sprachblase antippen und zuhören: Läuft die Zeit wirklich, und wie lange, bis sie von selbst endet? */
  async function listen(page) {
    await page.bringToFront();
    const last = page.locator('.voice').last();
    const button = last.locator('.voice-play');
    const responses = [];
    const onResponse = (r) => { if (/\/voice\/[0-9a-f]{32}$/.test(r.url())) responses.push(r); };
    page.on('response', onResponse);
    const silentBefore = !(await button.evaluate((b) => b.classList.contains('playing')));
    await button.click();
    let advanced = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && advanced === 0) {
      advanced = await last.locator('.voice-bar').evaluate((b) => {
        const m = /scaleX\(([\d.]+)\)/.exec(b.style.transform);
        return m ? Number(m[1]) : 0;
      });
      await wait(40);
    }
    let ended = false;
    while (Date.now() - t0 < 12000 && !ended) {
      ended = await button.evaluate((b) => !b.classList.contains('playing') && b.getAttribute('aria-label') === 'Sprachnachricht abspielen');
      if (!ended) await wait(40);
    }
    const heardMs = Date.now() - t0;
    page.off('response', onResponse);
    const label = await last.locator('.voice-time').textContent();
    const played = advanced > 0 && ended && label !== 'nicht abspielbar';
    const res = responses[0];
    const body = res ? await res.body().catch(() => null) : null; // Chrome gibt den Inhalt nicht immer heraus
    return { silentBefore, played, heardMs, downloads: responses.length, type: res && res.headers()['content-type'], body, label };
  }

  // ---------- 1. Aufnehmen: Anzeige beim Halten ----------
  await press(android);
  await wait(900);
  const during = await android.evaluate(() => ({
    rec: !document.getElementById('chat-rec').hidden,
    dot: getComputedStyle(document.querySelector('.chat-rec-dot')).animationName,
    time: document.getElementById('chat-rec-time').textContent,
    hint: document.getElementById('chat-rec-hint').textContent,
  }));
  check('beim Halten: Zeit + pulsierender Punkt', during.rec && during.dot === 'rec-pulse' && /^0:0[01]$/.test(during.time), `${during.time}, ${during.hint}`);
  await android.screenshot({ path: `${out}Android-aufnahme.png` });
  await wait(1600);
  await android.mouse.up();

  // ---------- 2. Android → iPhone ----------
  check('Android → iPhone: Sprachblase kommt an', (await waitBubbles(iphone, 1)) === 1);
  check('Android: eigene Blase auch beim Absender', (await waitBubbles(android, 1)) === 1);
  const a2i = await listen(iphone);
  check('kein Autoplay: vor dem Antippen läuft nichts', a2i.silentBefore);
  const codec = codecOf(a2i.body, 'android-aufnahme');
  const isMp4 = a2i.type.startsWith('audio/mp4');
  // Das war der Fehler, den dieser Test gefunden hat: "audio/mp4" allein ist in Chrome Opus im MP4-Container
  check('Android-Aufnahme ist AAC in MP4 oder Opus in WebM – nie Opus in MP4', codec === '?' || (isMp4 ? codec === 'aac' : codec === 'opus'), `${a2i.type}, Codec ${codec}, ${a2i.body.length} Bytes`);
  check('iPhone-WebKit spielt die Android-Aufnahme bis zum Ende ab', a2i.played && a2i.heardMs >= 1500, `${a2i.heardMs} ms, ${a2i.label}`);
  await iphone.screenshot({ path: `${out}iPhone-sprachblase.png` });

  // Aus dem Zwischenspeicher: Auf iOS läuft das direkt in der Geste – auch wenn das erste Mal nicht klappen sollte
  const again = await listen(iphone);
  check('zweites Abspielen ohne neuen Download', again.downloads === 0 && again.played, `${again.downloads} Downloads`);

  const own = await listen(android);
  check('Android spielt die eigene Aufnahme ab', own.played);

  // ---------- 3. iPhone → Android ----------
  await hold(iphone, 1200);
  check('iPhone → Android: Sprachblase kommt an', (await waitBubbles(android, 2)) === 2);
  check('iPhone: Mikro danach wieder aus', (await iphone.evaluate(() => window.__micStopped)) === 1);
  const i2a = await listen(android);
  check('Android-Chrome spielt iPhones AAC bis zum Ende ab', i2a.type.startsWith('audio/mp4') && i2a.played && i2a.heardMs >= 1200, `${i2a.heardMs} ms`);
  await waitBubbles(iphone, 2);
  const i2i = await listen(iphone);
  check('iPhone-WebKit spielt AAC ebenfalls ab', i2i.played && i2i.heardMs >= 1200, `${i2i.heardMs} ms`);

  // ---------- Gerät kann die Aufnahme nicht abspielen: Hinweis statt Hänger ----------
  // Sieht für den Server aus wie WebM, ist aber nicht abspielbar – so wie Opus auf einem iPhone ohne passenden Decoder
  const token = await android.evaluate(() => localStorage.getItem('spielekarte:token:TEST01:a'));
  const broken = Buffer.alloc(4096, 7);
  broken.writeUInt32BE(0x1a45dfa3, 0);
  const posted = await fetch(`${origin}/voice`, { method: 'POST', headers: { 'Content-Type': 'audio/webm', 'X-Player-Token': token, 'X-Voice-Duration': '2000' }, body: broken });
  check('kaputte Testdatei angenommen', posted.status === 201, String(posted.status));
  await waitBubbles(iphone, 3);
  await iphone.bringToFront();
  await iphone.locator('.voice-play').last().click();
  let brokenLabel = '';
  for (let t = 0; t < 200 && brokenLabel !== 'nicht abspielbar'; t++) { // waitForFunction würde an unserer CSP scheitern
    brokenLabel = await iphone.locator('.voice-time').last().textContent();
    await wait(40);
  }
  check('nicht abspielbar: Hinweis in der Blase und als Meldung', brokenLabel === 'nicht abspielbar' && (await iphone.textContent('#toast')).includes('nicht abspielen'), brokenLabel);
  const stillWorks = await iphone.locator('.voice').nth(0).locator('.voice-play').click().then(() => wait(600)).then(() => iphone.locator('.voice').nth(0).locator('.voice-play').evaluate((b) => b.classList.contains('playing')));
  check('danach lässt sich eine andere Nachricht weiter abspielen', stillWorks);
  await iphone.locator('.voice').nth(0).locator('.voice-play').click();

  // ---------- 4. Bedienung ----------
  const start = await bubbles(iphone);
  const at = await press(android);
  await wait(800);
  await android.mouse.move(at.x - 120, at.y, { steps: 6 });
  check('wegwischen: Anzeige sofort weg', await android.isHidden('#chat-rec'));
  check('wegwischen: Hinweis "verworfen"', (await android.textContent('#toast')).includes('verworfen'));
  await android.mouse.up();
  await wait(700);
  check('wegwischen: nichts gesendet', (await bubbles(iphone)) === start);

  await hold(android, 120);
  await wait(500);
  check('nur kurz angetippt: nichts gesendet, Hinweis', (await bubbles(iphone)) === start && (await android.textContent('#chat-hint')).includes('gedrückt halten'));

  // ---------- 5. 30-Sekunden-Grenze und echte Dateigröße ----------
  console.log('  … halte das Mikro jetzt 31 Sekunden gedrückt');
  await press(android);
  await wait(30800);
  check('nach 30 s stoppt die Aufnahme von selbst', await android.isHidden('#chat-rec'));
  await android.mouse.up();
  check('die 30-s-Nachricht wird automatisch gesendet', (await waitBubbles(iphone, start + 1, 8000)) === start + 1);
  const long = await iphone.locator('.voice-time').last().textContent();
  check('Dauer zeigt 0:30', long === '0:30', long);
  await iphone.bringToFront();
  const [response] = await Promise.all([
    iphone.waitForResponse((r) => /\/voice\/[0-9a-f]{32}$/.test(r.url())),
    iphone.locator('.voice-play').last().click(),
  ]);
  const size = (await response.body()).length;
  check('30 s bleiben deutlich unter 600 KB', size < 400 * 1024, `${Math.round(size / 1024)} KB`);
} catch (err) {
  console.log('ABBRUCH:', err.message.split('\n').slice(0, 14).join('\n'));
  results.push(false);
} finally {
  // Playwright-WebKit fügt für Screenshots ein Stylesheet ein – das blockiert die CSP absichtlich
  const unexpected = errors.filter((e) => !e.includes('Refused to apply a stylesheet'));
  check('keine unerwarteten Fehler in der Konsole', unexpected.length === 0, unexpected.join(' | ').slice(0, 600));
  console.log(`Sprachnachrichten: ${results.filter(Boolean).length}/${results.length} ok`);
  await chrome.close();
  await safari.close();
  srv.kill();
  rmSync(tmp, { recursive: true, force: true });
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
