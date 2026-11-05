// Kompatibilitäts-Check für ältere iPhones (Ziel: Safari ab iOS 13).
// Ein aktueller Browser-Test findet solche Fehler NICHT – deshalb wird der Code hier statisch geprüft.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parse, tokenizer } from 'acorn';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const staticDir = join(root, 'src/public/static');
const read = (file) => readFileSync(file, 'utf8');
const browserScripts = readdirSync(staticDir).filter((f) => f.endsWith('.js'));

/** iOS 13 kann ES2019: kein ?., ??, ??=, ||=, &&=, Zahlen mit _, private Felder … */
const IOS13 = 2019;

/** Methoden/Objekte, die Safari 13 noch nicht kennt (→ nur mit Polyfill aus boot.js erlaubt) */
const MISSING_IN_IOS13 = new Set([
  'replaceAll', 'at', 'structuredClone', 'hasOwn', 'findLast', 'findLastIndex', 'toSorted', 'toReversed',
  'toSpliced', 'any', 'AggregateError', 'WeakRef', 'FinalizationRegistry', 'randomUUID', 'groupBy',
  'replaceChildren', 'requestSubmit',
]);
const POLYFILLED = new Set(['replaceChildren']);

/** Global-Namen, die als Aufruf/Konstruktor geprüft werden (z. B. structuredClone(…), new WeakRef(…)) */
const GLOBALS = new Set(['structuredClone', 'AggregateError', 'WeakRef', 'FinalizationRegistry']);

/**
 * Aufgerufene Methoden (".name(") und globale Funktionen ("name(") im Code.
 * Reine Eigenschaften wie { at: 380 } oder opt.at zählen nicht – nur echte Aufrufe.
 */
function calledNames(code) {
  const tokens = [...tokenizer(code, { ecmaVersion: 'latest' })];
  const names = [];
  tokens.forEach((token, i) => {
    if (token.type.label !== 'name' || tokens[i + 1]?.type.label !== '(') return;
    const afterDot = tokens[i - 1]?.type.label === '.';
    if (afterDot || GLOBALS.has(token.value)) names.push(token.value);
  });
  return names;
}

describe('Browser-Skripte laufen auf iOS 13', () => {
  for (const file of browserScripts) {
    test(`${file}: nur ES2019-Syntax`, () => {
      assert.doesNotThrow(() => parse(read(join(staticDir, file)), { ecmaVersion: IOS13, sourceType: 'script' }),
        `${file} enthält Syntax, die Safari 13 nicht versteht`);
    });

    test(`${file}: keine APIs, die iOS 13 fehlen (außer mit Polyfill)`, () => {
      const used = calledNames(read(join(staticDir, file))).filter((n) => MISSING_IN_IOS13.has(n) && !POLYFILLED.has(n));
      assert.deepEqual([...new Set(used)], [], `${file} nutzt: ${used.join(', ')}`);
    });
  }

  test('boot.js ist ES5 (läuft auch, wenn andere Skripte scheitern) und rüstet replaceChildren nach', () => {
    const code = read(join(staticDir, 'boot.js'));
    assert.doesNotThrow(() => parse(code, { ecmaVersion: 5, sourceType: 'script' }));
    assert.match(code, /Element\.prototype\.replaceChildren\s*=/);
  });

  test('der ausgelieferte socket.io-Client ist ES2019', () => {
    // Genau die Datei, die der Server unter /socket.io/socket.io.js ausliefert
    const client = join(dirname(require.resolve('socket.io')), '../client-dist/socket.io.js');
    assert.doesNotThrow(() => parse(read(client), { ecmaVersion: IOS13, sourceType: 'script' }));
  });

  test('Animationen laufen nur über fx.js (dort mit Feature-Check)', () => {
    for (const file of browserScripts.filter((f) => f !== 'fx.js')) {
      assert.equal(calledNames(read(join(staticDir, file))).includes('animate'), false, `${file} ruft .animate() direkt auf`);
    }
    assert.match(read(join(staticDir, 'fx.js')), /typeof Element\.prototype\.animate === 'function'/);
  });
});

describe('Aufnahmeformat wählen (chat.js)', () => {
  /** chat.js in einer Attrappe laden: Dieser Browser "kann" genau die angegebenen Typen aufnehmen. */
  function pickFor(supported, { recorder = true, mediaDevices = true } = {}) {
    const sandbox = { window: {}, navigator: mediaDevices ? { mediaDevices: { getUserMedia() {} } } : {} };
    if (recorder) sandbox.MediaRecorder = { isTypeSupported: (type) => supported.includes(type) };
    runInNewContext(read(join(staticDir, 'chat.js')), sandbox);
    return sandbox.window.SkatChat.pickRecordType();
  }
  const AAC = 'audio/mp4;codecs=mp4a.40.2';
  const OPUS = 'audio/webm;codecs=opus';

  test('iPhone: AAC', () => {
    assert.equal(pickFor([AAC, 'audio/mp4']), AAC);
  });

  test('kann beides (neues iPhone, Android mit AAC-Encoder): trotzdem AAC', () => {
    assert.equal(pickFor([AAC, 'audio/mp4', OPUS, 'audio/webm']), AAC);
  });

  test('Chrome ohne AAC-Encoder: WebM/Opus – NICHT schlichtes audio/mp4, das wäre Opus in MP4', () => {
    assert.equal(pickFor(['audio/mp4', OPUS, 'audio/webm']), OPUS);
  });

  test('alter Safari, der den Codec-Zusatz nicht kennt: schlichtes audio/mp4 (ist dort AAC)', () => {
    assert.equal(pickFor(['audio/mp4']), 'audio/mp4');
  });

  test('nichts Passendes, kein MediaRecorder oder kein Mikro-Zugriff → kein Format (Knopf bleibt aus)', () => {
    assert.equal(pickFor(['audio/ogg']), null);
    assert.equal(pickFor([AAC], { recorder: false }), null);
    assert.equal(pickFor([AAC], { mediaDevices: false }), null);
  });
});

describe('HTML: boot.js lädt zuerst', () => {
  for (const page of ['room.html', 'index.html']) {
    test(`${page}: boot.js ist das erste Skript, ohne defer`, () => {
      const html = read(join(root, 'src/public', page));
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      assert.match(scripts[0], /static\/boot\.js/);
      assert.equal(/\bdefer\b/.test(scripts[0]), false);
    });
  }
});

describe('CSS läuft auf iOS 13', () => {
  const css = read(join(staticDir, 'style.css')).replace(/\/\*[\s\S]*?\*\//g, ''); // Kommentare ignorieren

  test('keine Eigenschaften, die ältere Safaris nicht kennen', () => {
    for (const [pattern, why] of [
      [/aspect-ratio\s*:/, 'aspect-ratio (Safari 15)'],
      [/\d(cqw|cqh|cqi|cqb)\b/, 'Container-Einheiten (Safari 16)'],
      [/container-type\s*:/, 'Container Queries (Safari 16)'],
      [/(^|[\s;{])inset\s*:/, 'inset (Safari 14.1)'],
      [/:has\(/, ':has() (Safari 15.4)'],
      [/background[^;]*\bfixed\b/, 'background-attachment: fixed (blockiert das Scrollen in iOS-Safari)'],
    ]) {
      assert.equal(pattern.test(css), false, `style.css nutzt ${why}`);
    }
  });

  test('Karten (sind <button>) haben ≥ 16px Schrift – sonst zoomt iOS beim Antippen hinein', () => {
    const card = css.match(/\n\.card \{[^}]*\}/)[0];
    assert.match(card, /font-size:\s*16px/);
    assert.equal(/font-size:\s*calc\(var\(--card-w/.test(css), false, 'keine winzige font-size aus der Kartenbreite');
  });

  test('kein Doppeltipp-Zoom (iOS zoomt sonst beim schnellen Tippen hinein)', () => {
    // touch-action wird nicht vererbt → muss für alle Elemente gelten, nicht nur für html
    assert.match(css, /\*,\s*\*::before,\s*\*::after\s*\{\s*touch-action:\s*manipulation/);
  });

  test('backdrop-filter mit -webkit-Präfix, dvh mit vh-Rückfall', () => {
    const plain = (css.match(/(^|[^-])backdrop-filter\s*:/g) ?? []).length;
    const prefixed = (css.match(/-webkit-backdrop-filter\s*:/g) ?? []).length;
    assert.equal(prefixed, plain);
    for (const m of css.matchAll(/([a-z-]+)\s*:\s*[^;]*\d+dvh/g)) {
      const before = css.slice(0, m.index);
      assert.match(before.slice(-80), new RegExp(`${m[1]}\\s*:\\s*\\d+vh`), `${m[1]} braucht eine vh-Zeile davor`);
    }
  });
});
