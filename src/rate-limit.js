// Gleitendes Zeitfenster: höchstens `limit` Aktionen in `windowMs`.
// Gemerkt werden nur die Zeitpunkte der letzten erlaubten Aktionen (höchstens `limit` Stück).

/**
 * @param {{ limit: number, windowMs: number, now?: () => number }} options
 * @returns {{ allow: () => boolean }}
 */
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = [];
  return {
    allow() {
      const t = now();
      while (hits.length > 0 && t - hits[0] >= windowMs) hits.shift();
      if (hits.length >= limit) return false;
      hits.push(t);
      return true;
    },
  };
}
