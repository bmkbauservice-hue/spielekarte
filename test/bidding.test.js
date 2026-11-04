import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { Bidding } from '../src/game/bidding.js';
import { GameError } from '../src/game/errors.js';

// Geber = Platz 2 → Vorhand 0, Mittelhand 1, Hinterhand 2
const V = 0, M = 1, H = 2;
const fresh = () => new Bidding(2);
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof GameError && e.code === code);

/** Folge von [Platz, Aktion] abspielen */
function run(b, steps) {
  for (const [seat, action] of steps) b.act(seat, action);
  return b;
}

describe('Reizen – Rollen', () => {
  test('Vorhand links vom Geber, dann Mittelhand, Hinterhand = Geber', () => {
    const b = new Bidding(0);
    assert.deepEqual([b.forehand, b.middle, b.rear], [1, 2, 0]);
  });

  test('Mittelhand sagt zuerst, Vorhand hört', () => {
    const b = fresh();
    assert.equal(b.turn, M);
    assert.equal(b.role, 'speaker');
    assert.equal(b.pendingValue, 18);
    b.act(M, 'bid');
    assert.equal(b.turn, V);
    assert.equal(b.role, 'listener');
    assert.equal(b.pendingValue, 18);
  });
});

describe('Reizen – Abläufe', () => {
  test('M sagt bis 20, V passt; H reizt M bis 22, H passt → M spielt für 22', () => {
    const b = run(fresh(), [[M, 'bid'], [V, 'hold'], [M, 'bid'], [V, 'pass'], [H, 'bid'], [M, 'hold'], [H, 'pass']]);
    assert.equal(b.done, true);
    assert.equal(b.declarer, M);
    assert.equal(b.value, 22);
  });

  test('Reizwerte steigen 18, 20, 22, 23, 24, 27', () => {
    const b = fresh();
    const seen = [];
    for (let i = 0; i < 6; i++) {
      b.act(M, 'bid');
      seen.push(b.value);
      b.act(V, 'hold');
    }
    assert.deepEqual(seen, [18, 20, 22, 23, 24, 27]);
  });

  test('Hinterhand reizt ab dem erreichten Wert weiter', () => {
    const b = run(fresh(), [[M, 'bid'], [V, 'hold'], [M, 'bid'], [V, 'hold'], [M, 'pass']]);
    assert.equal(b.stage, 2);
    assert.equal(b.listener, V, 'Vorhand hat Runde 1 gewonnen');
    assert.equal(b.turn, H);
    assert.equal(b.pendingValue, 22, 'nach 20 kommt 22');
    run(b, [[H, 'bid'], [V, 'pass']]);
    assert.equal(b.declarer, H);
    assert.equal(b.value, 22);
  });

  test('M passt sofort, H sagt 18, V hält, H passt → V spielt für 18', () => {
    const b = run(fresh(), [[M, 'pass'], [H, 'bid'], [V, 'hold'], [H, 'pass']]);
    assert.equal(b.declarer, V);
    assert.equal(b.value, 18);
  });

  test('M und H passen sofort → Vorhand darf 18 spielen', () => {
    const b = run(fresh(), [[M, 'pass'], [H, 'pass']]);
    assert.equal(b.stage, 3);
    assert.equal(b.role, 'forehand');
    assert.equal(b.turn, V);
    b.act(V, 'bid');
    assert.equal(b.declarer, V);
    assert.equal(b.value, 18);
  });

  test('alle passen → eingepasst', () => {
    const b = run(fresh(), [[M, 'pass'], [H, 'pass'], [V, 'pass']]);
    assert.equal(b.done, true);
    assert.equal(b.declarer, null);
    assert.deepEqual(b.passed, [M, H, V]);
  });

  test('V passt auf 18 von M, H passt → M spielt für 18', () => {
    const b = run(fresh(), [[M, 'bid'], [V, 'pass'], [H, 'pass']]);
    assert.equal(b.declarer, M);
    assert.equal(b.value, 18);
  });
});

describe('Reizen – Fehler', () => {
  test('nur wer dran ist', () => {
    const b = fresh();
    throwsCode(() => b.act(V, 'hold'), 'NICHT_DRAN');
    throwsCode(() => b.act(H, 'bid'), 'NICHT_DRAN');
  });

  test('Sagender kann nicht "Ja" sagen, Hörender nicht weiterreizen', () => {
    const b = fresh();
    throwsCode(() => b.act(M, 'hold'), 'AKTION_UNGUELTIG');
    b.act(M, 'bid');
    throwsCode(() => b.act(V, 'bid'), 'AKTION_UNGUELTIG');
    throwsCode(() => b.act(V, 'ramsch'), 'AKTION_UNGUELTIG');
  });

  test('nach dem Ende nichts mehr', () => {
    const b = run(fresh(), [[M, 'pass'], [H, 'pass'], [V, 'pass']]);
    throwsCode(() => b.act(V, 'bid'), 'FALSCHE_PHASE');
  });

  test('über 264 geht nicht', () => {
    const b = fresh();
    b.value = 264;
    throwsCode(() => b.act(M, 'bid'), 'REIZWERT_MAX');
  });
});

describe('Reizen – Zufalls-Simulation', () => {
  test('1000 zufällige Reizverläufe enden immer korrekt', () => {
    for (let n = 0; n < 1000; n++) {
      const b = new Bidding(n % 3);
      let steps = 0;
      while (!b.done) {
        const options = b.role === 'speaker' || b.role === 'forehand' ? ['bid', 'pass'] : ['hold', 'pass'];
        // eher weiterreizen als passen, damit auch hohe Werte vorkommen
        const action = randomInt(4) === 0 ? 'pass' : options[0];
        b.act(b.turn, b.value >= 264 && action === 'bid' ? 'pass' : action);
        assert.ok(++steps < 500, 'Reizen muss enden');
      }
      if (b.declarer === null) {
        assert.equal(b.passed.length, 3);
      } else {
        assert.ok(!b.passed.includes(b.declarer), 'Alleinspieler hat nicht gepasst');
        assert.equal(b.passed.length, 2);
        assert.ok(b.value >= 18);
      }
    }
  });
});
