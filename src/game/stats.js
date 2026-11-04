// Abendwertung: alles wird aus der Spielhistorie berechnet (eine Zeile pro Runde).
// Reine Funktionen – kein eigener Zähler, der aus dem Takt geraten könnte.
//
// Eine Zeile (siehe Room.recordScore):
//   { round, declarer: 0|1|2|null, label, bid, value, score, won: true|false|null }
//   declarer === null → eingepasst

export const PLAYERS = 3;

/** Seeger-Fabian: gewonnen Wert+50, verloren −2×Wert−50, bei Verlust je Gegenspieler +40. */
export const SEEGER = { win: 50, loss: 50, defenderBonus: 40 };

export function seegerFabianTotals(rows) {
  const sums = Array(PLAYERS).fill(0);
  for (const row of rows) {
    if (row.declarer === null) continue;
    if (row.won) {
      sums[row.declarer] += row.score + SEEGER.win;
    } else {
      sums[row.declarer] += row.score - SEEGER.loss;
      for (let seat = 0; seat < PLAYERS; seat++) if (seat !== row.declarer) sums[seat] += SEEGER.defenderBonus;
    }
  }
  return sums;
}

/** Einfache Liste: gewonnen +Wert, verloren −2×Wert (steht schon in row.score). */
export function simpleTotals(rows) {
  const sums = Array(PLAYERS).fill(0);
  for (const row of rows) if (row.declarer !== null) sums[row.declarer] += row.score;
  return sums;
}

/** Platzierung nach Punkten; Gleichstand teilt sich den Platz (1, 1, 3). */
export function placements(points) {
  return points.map((p) => 1 + points.filter((other) => other > p).length);
}

/**
 * Zusammenfassung des Abends – für alle gleich.
 * @param {{ rows: object[], names: string[], startedAt: number, endedAt: number }} input
 */
export function summarizeEvening({ rows, names, startedAt, endedAt }) {
  const points = simpleTotals(rows);
  const seeger = seegerFabianTotals(rows);
  const places = placements(points);

  const players = names.map((name, seat) => {
    const own = rows.filter((r) => r.declarer === seat);
    const won = own.filter((r) => r.won);
    const best = won.reduce((top, r) => (top === null || r.value > top.value ? r : top), null);
    return {
      seat,
      name,
      points: points[seat],
      seegerFabian: seeger[seat],
      place: places[seat],
      declarerGames: own.length,
      won: won.length,
      lost: own.length - won.length,
      best: best ? { label: best.label, value: best.value, round: best.round } : null,
    };
  });

  return {
    players,
    games: rows.length,
    passed: rows.filter((r) => r.declarer === null).length,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
  };
}
