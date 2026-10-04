// Quality control and results for a Managed project: per-annotator QA signals, contestant ratings,
// per-criterion breakdowns, and the raw export with the blind map resolved.

import { q } from "../db.ts";
import { computeRatings, type Match } from "../ratings.ts";
import { getRubric, listRubrics, requireRubric, outcomeOf } from "../rubrics.ts";
import { managedDb } from "./db.ts";
import { getProject, qualState } from "./projects.ts";

interface SubmittedRow {
  id: string;
  comparison_id: string;
  user_id: string;
  flip: number;
  is_gold: number;
  outcome: "A" | "B" | "tie";
  outcome_display: "left" | "right" | "tie";
  answers_json: string;
  model_guess_json: string | null;
  time_spent_s: number | null;
  submitted_at: string;
  run_a: string;
  run_b: string;
  gold_expected: string | null;
  excluded: number;
}

function submitted(projectId: string): SubmittedRow[] {
  return managedDb()
    .prepare(
      `SELECT r.id, r.comparison_id, r.user_id, r.flip, r.is_gold, r.outcome, r.outcome_display, r.answers_json,
              r.model_guess_json, r.time_spent_s, r.submitted_at, a.run_a, a.run_b, g.expected AS gold_expected,
              COALESCE(m.excluded, 0) AS excluded
       FROM reviews r JOIN assignments a ON a.id = r.comparison_id
       LEFT JOIN gold g ON g.comparison_id = r.comparison_id
       LEFT JOIN project_members m ON m.project_id = r.project_id AND m.user_id = r.user_id
       WHERE r.project_id = ? AND r.status = 'submitted' AND r.is_qual = 0 ORDER BY r.submitted_at`,
    )
    .all(projectId) as unknown as SubmittedRow[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Majority outcome among a set of votes; null when there's no strict majority. */
function majority(votes: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted[1] && sorted[1][1] === sorted[0][1])) return null;
  return sorted[0][0];
}

// Thresholds for flags. Deliberately conservative: flags prompt a human look, they don't act on their own.
const FLAGS = { minGoldN: 3, goldAccuracy: 0.7, minSideN: 10, sideBias: 0.8, minMedianSec: 20, minAgreeN: 5, agreement: 0.5 };

export function qaView(projectId: string) {
  const p = getProject(projectId);
  if (!p) throw new Error("No such project");
  const db = managedDb();
  const rows = submitted(projectId);
  const members = db
    .prepare("SELECT u.id, u.email, u.name, u.status, m.excluded, m.qual_status FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name")
    .all(projectId) as { id: string; email: string; name: string; status: string; excluded: number; qual_status: string }[];
  const skipped = new Map(
    (db.prepare("SELECT user_id, COUNT(*) AS n FROM reviews WHERE project_id = ? AND status = 'skipped' GROUP BY user_id").all(projectId) as { user_id: string; n: number }[])
      .map((r) => [r.user_id, r.n]),
  );
  const byComparison = new Map<string, SubmittedRow[]>();
  for (const r of rows) byComparison.set(r.comparison_id, [...(byComparison.get(r.comparison_id) ?? []), r]);
  const justificationKey = requireRubric(p.rubric).criteria.find((c) => c.type === "text")?.id;

  const annotators = members.map((m) => {
    const mine = rows.filter((r) => r.user_id === m.id);
    const gold = mine.filter((r) => r.gold_expected);
    const goldRight = gold.filter((r) => r.outcome === r.gold_expected).length;
    // Agreement: on regular comparisons, does this person match the majority of the *other* reviewers?
    let agreeN = 0;
    let agree = 0;
    for (const r of mine) {
      if (r.gold_expected) continue;
      const others = (byComparison.get(r.comparison_id) ?? []).filter((o) => o.user_id !== m.id && !o.excluded).map((o) => o.outcome);
      const maj = majority(others);
      if (!maj) continue;
      agreeN++;
      if (maj === r.outcome) agree++;
    }
    const decisive = mine.filter((r) => r.outcome_display !== "tie");
    const leftRate = decisive.length ? decisive.filter((r) => r.outcome_display === "left").length / decisive.length : null;
    const times = mine.map((r) => r.time_spent_s).filter((t): t is number => t != null);
    const texts = justificationKey
      ? mine.map((r) => String((JSON.parse(r.answers_json) as Record<string, unknown>)[justificationKey] ?? "").trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean)
      : [];
    const duplicates = texts.length - new Set(texts).size;
    const guesses = mine.flatMap((r) => {
      if (!r.model_guess_json) return [];
      const g = JSON.parse(r.model_guess_json) as { A?: string; B?: string };
      const names = { A: q.run(r.run_a)?.contestant.displayName, B: q.run(r.run_b)?.contestant.displayName };
      return (["A", "B"] as const).filter((s) => g[s]).map((s) => g[s] === names[s]);
    });

    const flags: string[] = [];
    if (gold.length >= FLAGS.minGoldN && goldRight / gold.length < FLAGS.goldAccuracy) flags.push("low gold accuracy");
    if (leftRate !== null && decisive.length >= FLAGS.minSideN && (leftRate > FLAGS.sideBias || leftRate < 1 - FLAGS.sideBias)) flags.push("side bias");
    const med = median(times);
    if (med !== null && mine.length >= 3 && med < FLAGS.minMedianSec) flags.push("very fast");
    if (duplicates > 0) flags.push("repeated justifications");
    if (agreeN >= FLAGS.minAgreeN && agree / agreeN < FLAGS.agreement) flags.push("low agreement");

    return {
      id: m.id, name: m.name, email: m.email, status: m.status, excluded: !!m.excluded,
      qualification: p.qual_required ? (({ done, correct, required, status }) => ({ done, correct, required, status }))(qualState(p, m.id)) : null,
      reviews: mine.length, skipped: skipped.get(m.id) ?? 0,
      gold: { n: gold.length, accuracy: gold.length ? goldRight / gold.length : null },
      agreement: { n: agreeN, rate: agreeN ? agree / agreeN : null },
      leftRate, decisive: decisive.length,
      medianSec: med,
      avgJustification: texts.length ? Math.round(texts.reduce((s, t) => s + t.length, 0) / texts.length) : null,
      duplicates,
      guessAccuracy: guesses.length ? guesses.filter(Boolean).length / guesses.length : null,
      flags,
    };
  });

  // Overall agreement: over comparisons with 2+ included reviews, the share of review pairs that agree.
  let pairs = 0;
  let agreeing = 0;
  for (const list of byComparison.values()) {
    const votes = list.filter((r) => !r.excluded).map((r) => r.outcome);
    for (let i = 0; i < votes.length; i++) for (let j = i + 1; j < votes.length; j++) {
      pairs++;
      if (votes[i] === votes[j]) agreeing++;
    }
  }
  return { thresholds: FLAGS, pairwiseAgreement: pairs ? agreeing / pairs : null, pairs, annotators };
}

/** Contestant ratings and per-criterion win rates, from included (non-excluded) reviewers only. */
export function resultsView(projectId: string) {
  const p = getProject(projectId);
  if (!p) throw new Error("No such project");
  const rubric = requireRubric(p.rubric);
  const rows = submitted(projectId).filter((r) => !r.excluded);
  const name = new Map<string, string>();
  const contestantOf = (runId: string) => {
    const c = q.run(runId)!.contestant;
    name.set(c.id, c.displayName);
    return c.id;
  };
  const matches: Match[] = rows.map((r) => ({ a: contestantOf(r.run_a), b: contestantOf(r.run_b), outcome: r.outcome }));

  // Per pairwise criterion: each contestant's wins / losses / ties across comparisons it appeared in.
  const criteria = rubric.criteria.filter((c) => c.type === "pairwise").map((c) => {
    const tally = new Map<string, { wins: number; losses: number; ties: number }>();
    const bump = (id: string, k: "wins" | "losses" | "ties") => {
      const t = tally.get(id) ?? { wins: 0, losses: 0, ties: 0 };
      t[k]++;
      tally.set(id, t);
    };
    for (const r of rows) {
      const v = (JSON.parse(r.answers_json) as Record<string, unknown>)[c.id];
      if (typeof v !== "number") continue;
      const o = outcomeOf(v);
      const a = contestantOf(r.run_a);
      const b = contestantOf(r.run_b);
      if (o === "tie") {
        bump(a, "ties");
        bump(b, "ties");
      } else {
        bump(o === "A" ? a : b, "wins");
        bump(o === "A" ? b : a, "losses");
      }
    }
    return {
      id: c.id, label: c.label,
      contestants: [...tally.entries()].map(([id, t]) => ({ id, name: name.get(id) ?? id, ...t, winRate: (t.wins + t.ties / 2) / Math.max(1, t.wins + t.losses + t.ties) }))
        .sort((x, y) => y.winRate - x.winRate),
    };
  });

  // Flag rates per contestant (e.g. "broke existing behavior").
  const flags = rubric.criteria.filter((c) => c.type === "flag").map((c) => {
    const tally = new Map<string, { n: number; flagged: number }>();
    for (const r of rows) {
      const v = (JSON.parse(r.answers_json) as Record<string, { A?: boolean; B?: boolean }>)[c.id];
      for (const [side, runId] of [["A", r.run_a], ["B", r.run_b]] as const) {
        const id = contestantOf(runId);
        const t = tally.get(id) ?? { n: 0, flagged: 0 };
        t.n++;
        if (v?.[side]) t.flagged++;
        tally.set(id, t);
      }
    }
    return { id: c.id, label: c.label, contestants: [...tally.entries()].map(([id, t]) => ({ id, name: name.get(id) ?? id, rate: t.flagged / Math.max(1, t.n), n: t.n })) };
  });

  return {
    reviews: rows.length,
    comparisons: new Set(rows.map((r) => r.comparison_id)).size,
    ratings: computeRatings(matches).map((r) => ({ ...r, name: name.get(r.id) ?? r.id })),
    criteria,
    flags,
  };
}

/** Every submitted review with identities resolved, one JSON object per line. For admins only. */
export function exportJsonl(projectId: string): string {
  const p = getProject(projectId);
  if (!p) throw new Error("No such project");
  const users = new Map((managedDb().prepare("SELECT id, email FROM users").all() as { id: string; email: string }[]).map((u) => [u.id, u.email]));
  return submitted(projectId)
    .map((r) => {
      const a = q.run(r.run_a)!;
      const b = q.run(r.run_b)!;
      const ev = q.evaluation(a.evaluation_id)!;
      return JSON.stringify({
        project: p.name, review_id: r.id, comparison_id: r.comparison_id, task_id: ev.task.id, task_hash: ev.task.contentHash,
        annotator: users.get(r.user_id), excluded: !!r.excluded,
        a: { contestant: a.contestant.id, model: a.contestant.model ?? null, run: a.id, status: a.status, metrics: a.metrics },
        b: { contestant: b.contestant.id, model: b.contestant.model ?? null, run: b.id, status: b.status, metrics: b.metrics },
        shown_flipped: !!r.flip, outcome: r.outcome, answers: JSON.parse(r.answers_json),
        gold: r.gold_expected ? { expected: r.gold_expected, correct: r.outcome === r.gold_expected } : null,
        model_guess: r.model_guess_json ? JSON.parse(r.model_guess_json) : null,
        time_spent_s: r.time_spent_s, submitted_at: r.submitted_at,
      });
    })
    .join("\n");
}

/** Dashboard overview: every project's progress. */
export function overview() {
  const db = managedDb();
  const projects = db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as unknown as import("./db.ts").Project[];
  const t = new Date().toISOString();
  return projects.map((p) => {
    const comps = (db.prepare("SELECT COUNT(*) AS n FROM project_evaluations pe JOIN assignments a ON a.evaluation_id = pe.evaluation_id LEFT JOIN gold g ON g.comparison_id = a.id WHERE pe.project_id = ? AND g.comparison_id IS NULL").get(p.id) as { n: number }).n;
    const goldN = (db.prepare("SELECT COUNT(*) AS n FROM project_evaluations pe JOIN assignments a ON a.evaluation_id = pe.evaluation_id JOIN gold g ON g.comparison_id = a.id WHERE pe.project_id = ? AND g.qual = 0").get(p.id) as { n: number }).n;
    const qualN = (db.prepare("SELECT COUNT(*) AS n FROM project_evaluations pe JOIN assignments a ON a.evaluation_id = pe.evaluation_id JOIN gold g ON g.comparison_id = a.id WHERE pe.project_id = ? AND g.qual = 1").get(p.id) as { n: number }).n;
    // Progress counts reviews toward the target only (capped per comparison), not extra gold reviews.
    const done = (db.prepare(
      `SELECT COALESCE(SUM(MIN(c, ?)), 0) AS n FROM (SELECT COUNT(*) AS c FROM reviews r LEFT JOIN gold g ON g.comparison_id = r.comparison_id
       WHERE r.project_id = ? AND r.status = 'submitted' AND g.comparison_id IS NULL GROUP BY r.comparison_id)`,
    ).get(p.reviews_per_comparison, p.id) as { n: number }).n;
    const running = (db.prepare("SELECT COUNT(*) AS n FROM project_evaluations pe JOIN evaluations e ON e.id = pe.evaluation_id WHERE pe.project_id = ? AND e.status = 'running'").get(p.id) as { n: number }).n;
    return {
      id: p.id, name: p.name, status: p.status, rubric: p.rubric, createdAt: p.created_at,
      comparisons: comps, gold: goldN, qualItems: qualN, qualRequired: p.qual_required, target: comps * p.reviews_per_comparison, done,
      members: (db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?").get(p.id) as { n: number }).n,
      activeLeases: (db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE project_id = ? AND status = 'leased' AND lease_expires > ?").get(p.id, t) as { n: number }).n,
      runningBatches: running,
    };
  });
}
