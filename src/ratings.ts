// Bradley–Terry ratings from pairwise outcomes, reported on an Elo-like scale with bootstrap CIs.
// Unlike online Elo, the fit does not depend on the order in which comparisons happened.

export interface Match {
  a: string; // contestant id shown as A
  b: string;
  outcome: "A" | "B" | "tie";
}

export interface Rating {
  id: string;
  rating: number;
  ciLow: number;
  ciHigh: number;
  wins: number;
  losses: number;
  ties: number;
  n: number;
}

const ELO_BASE = 1000;
const ELO_SCALE = 400 / Math.log(10);

/** Fit BT strengths by MM iteration. Ties count as half a win each. A weak prior keeps unbeaten players finite. */
function fit(ids: string[], matches: Match[]): Map<string, number> {
  const idx = new Map(ids.map((id, i) => [id, i]));
  const k = ids.length;
  const wins = new Array(k).fill(0.5); // prior: half a win …
  const games: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) if (i !== j) games[i][j] = 1 / Math.max(1, k - 1); // … over one virtual game
  for (const m of matches) {
    const i = idx.get(m.a)!;
    const j = idx.get(m.b)!;
    games[i][j]++;
    games[j][i]++;
    if (m.outcome === "A") wins[i]++;
    else if (m.outcome === "B") wins[j]++;
    else {
      wins[i] += 0.5;
      wins[j] += 0.5;
    }
  }
  let p = new Array(k).fill(1);
  for (let iter = 0; iter < 500; iter++) {
    const next = p.map((pi, i) => {
      let denom = 0;
      for (let j = 0; j < k; j++) if (j !== i && games[i][j] > 0) denom += games[i][j] / (pi + p[j]);
      return denom > 0 ? wins[i] / denom : pi;
    });
    const logMean = next.reduce((s, x) => s + Math.log(x), 0) / k;
    const norm = next.map((x) => x / Math.exp(logMean));
    const delta = Math.max(...norm.map((x, i) => Math.abs(x - p[i])));
    p = norm;
    if (delta < 1e-9) break;
  }
  return new Map(ids.map((id, i) => [id, ELO_BASE + ELO_SCALE * Math.log(p[i])]));
}

function rng(seed: number): () => number {
  // mulberry32: deterministic, so CIs don't jitter on every page load.
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeRatings(matches: Match[], bootstrap = 300): Rating[] {
  const ids = [...new Set(matches.flatMap((m) => [m.a, m.b]))].sort();
  if (ids.length < 2) return [];
  const point = fit(ids, matches);
  const samples = new Map(ids.map((id) => [id, [] as number[]]));
  const rand = rng(42);
  for (let s = 0; s < bootstrap; s++) {
    const resample = matches.map(() => matches[Math.floor(rand() * matches.length)]);
    const r = fit(ids, resample);
    for (const id of ids) samples.get(id)!.push(r.get(id)!);
  }
  return ids
    .map((id) => {
      const xs = samples.get(id)!.sort((x, y) => x - y);
      const pct = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
      let wins = 0, losses = 0, ties = 0;
      for (const m of matches) {
        if (m.a !== id && m.b !== id) continue;
        if (m.outcome === "tie") ties++;
        else if ((m.outcome === "A") === (m.a === id)) wins++;
        else losses++;
      }
      return { id, rating: point.get(id)!, ciLow: pct(0.025), ciHigh: pct(0.975), wins, losses, ties, n: wins + losses + ties };
    })
    .sort((x, y) => y.rating - x.rating);
}
