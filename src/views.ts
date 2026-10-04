// Read models for the UI and CLI. Everything shown before a reveal goes through the scrubber,
// and nothing here links a side (A/B) or a run's metrics to a contestant until the review is submitted.

import fs from "node:fs";
import path from "node:path";
import { getDb, newId, now, q, type RunRow } from "./db.ts";
import { computeRatings, type Match } from "./ratings.ts";
import { forceRemove } from "./runner.ts";
import { getRubric, listRubrics, requireRubric, outcomeOf, validateAnswers } from "./rubrics.ts";
import { makeScrubber } from "./scrub.ts";
import type { CheckResult, TranscriptEvent } from "./types.ts";

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function scrubberFor(evaluationId: string) {
  const runs = q.runs(evaluationId);
  return makeScrubber(runs.flatMap((r) => [r.contestant.displayName, r.contestant.model ?? "", r.contestant.id]));
}

function reviewProgress(evaluationId: string) {
  const assignments = q.assignments(evaluationId);
  const submitted = assignments.filter((a) => q.submission(a.id)).length;
  return { total: assignments.length, submitted, complete: assignments.length > 0 && submitted === assignments.length };
}

export function listEvaluations() {
  return q.evaluations().map((ev) => {
    const runs = q.runs(ev.id);
    const done = runs.filter((r) => !["queued", "running"].includes(r.status)).length;
    return {
      id: ev.id,
      createdAt: ev.created_at,
      title: ev.task.title,
      tags: ev.tags,
      status: ev.status,
      sandbox: ev.sandbox,
      contestants: [...new Set(runs.map((r) => r.contestant.displayName))],
      runs: { total: runs.length, done },
      reviews: reviewProgress(ev.id),
    };
  });
}

export function evaluationDetail(id: string) {
  const ev = q.evaluation(id);
  if (!ev) return undefined;
  const progress = reviewProgress(id);
  // Anonymous runs are listed in random-id order, so the list doesn't group runs by contestant.
  const runs = progress.complete ? q.runs(id) : q.runs(id).sort((a, b) => a.id.localeCompare(b.id));
  const scrub = scrubberFor(id);
  return {
    id: ev.id,
    createdAt: ev.created_at,
    title: ev.task.title,
    prompt: ev.task.prompt,
    tags: ev.tags,
    status: ev.status,
    sandbox: ev.sandbox,
    rubric: ev.rubric,
    contestants: [...new Set(runs.map((r) => r.contestant.displayName))],
    reviews: progress,
    // Before every comparison is reviewed, runs are anonymous: status only, no contestant, no metrics.
    runs: runs.map((r, i) =>
      progress.complete
        ? { id: r.id, label: r.contestant.displayName, attempt: r.attempt, status: r.status, error: r.error, metrics: r.metrics }
        : { id: r.id, label: `Run ${i + 1}`, attempt: r.attempt, status: r.status, error: r.error ? scrub(r.error) : null },
    ),
    assignments: q.assignments(id).map((a, i) => ({ id: a.id, label: `Comparison ${i + 1}`, submitted: !!q.submission(a.id) })),
  };
}

export function sideView(run: RunRow, scrub: (s: string) => string) {
  const diff = fs.existsSync(path.join(run.dir, "diff.patch")) ? fs.readFileSync(path.join(run.dir, "diff.patch"), "utf8") : "";
  const checks = readJson<CheckResult[]>(path.join(run.dir, "checks.json"), []);
  const events: TranscriptEvent[] = fs.existsSync(path.join(run.dir, "transcript.jsonl"))
    ? fs.readFileSync(path.join(run.dir, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return {
    status: run.status,
    error: run.error ? scrub(run.error) : null,
    summary: run.summary ? scrub(run.summary) : null,
    metrics: run.metrics,
    diff: scrub(diff),
    checks: checks.map((c) => ({ ...c, output: scrub(c.output) })),
    transcript: events
      .filter((e) => e.type !== "usage")
      .map((e) => ({
        t: e.t,
        type: e.type,
        tool: e.tool,
        isError: e.isError,
        text: e.text ? scrub(e.text.length > 3000 ? `${e.text.slice(0, 3000)}\n…[truncated]` : e.text) : undefined,
        input: e.input !== undefined ? scrub(JSON.stringify(e.input, null, 1).slice(0, 3000)) : undefined,
      })),
  };
}

export function assignmentView(id: string) {
  const a = q.assignment(id);
  if (!a) return undefined;
  const ev = q.evaluation(a.evaluation_id)!;
  const runA = q.run(a.run_a)!;
  const runB = q.run(a.run_b)!;
  const scrub = scrubberFor(ev.id);
  const submission = q.submission(id);
  const siblings = q.assignments(ev.id);
  const next = siblings.find((s) => s.id !== id && !q.submission(s.id));
  return {
    id,
    evaluationId: ev.id,
    index: siblings.findIndex((s) => s.id === id) + 1,
    count: siblings.length,
    nextId: next?.id ?? null,
    task: { title: ev.task.title, prompt: ev.task.prompt, tags: ev.tags },
    rubric: requireRubric(ev.rubric),
    // Names the reviewer may guess from: all contestants in this evaluation, in a fixed (alphabetical) order.
    guessOptions: [...new Set(q.runs(ev.id).map((r) => r.contestant.displayName))].sort(),
    sides: { A: sideView(runA, scrub), B: sideView(runB, scrub) },
    submission: submission ?? null,
    reveal: submission ? { A: runA.contestant.displayName, B: runB.contestant.displayName } : null,
  };
}

export function submitAssignment(
  id: string,
  body: { answers?: Record<string, unknown>; modelGuess?: { A?: string; B?: string }; timeSpentSec?: number },
) {
  const a = q.assignment(id);
  if (!a) throw new Error("no such assignment");
  if (q.submission(id)) throw new Error("already submitted");
  const ev = q.evaluation(a.evaluation_id)!;
  const rubric = requireRubric(ev.rubric);
  const answers = body.answers ?? {};
  const problem = validateAnswers(rubric, answers);
  if (problem) throw new Error(problem);
  const outcome = outcomeOf(answers.overall as number);
  getDb()
    .prepare("INSERT INTO submissions VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(newId(), id, JSON.stringify(answers), outcome, body.modelGuess ? JSON.stringify(body.modelGuess) : null, body.timeSpentSec ?? null, now());
  return assignmentView(id);
}

/** Ratings over all submitted comparisons, optionally restricted to one task tag. */
export function ratingsView(tag?: string) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.outcome, s.model_guess_json, ra.contestant_json AS ca, rb.contestant_json AS cb, e.tags_json
       FROM submissions s JOIN assignments a ON a.id = s.assignment_id
       JOIN runs ra ON ra.id = a.run_a JOIN runs rb ON rb.id = a.run_b
       JOIN evaluations e ON e.id = a.evaluation_id`,
    )
    .all() as { outcome: Match["outcome"]; model_guess_json: string | null; ca: string; cb: string; tags_json: string }[];

  const allTags = new Set<string>();
  const matches: Match[] = [];
  const names = new Map<string, string>();
  let guesses = 0;
  let correctGuesses = 0;
  for (const r of rows) {
    const tags: string[] = JSON.parse(r.tags_json);
    tags.forEach((t) => allTags.add(t));
    if (tag && !tags.includes(tag)) continue;
    const ca = JSON.parse(r.ca);
    const cb = JSON.parse(r.cb);
    names.set(ca.id, ca.displayName);
    names.set(cb.id, cb.displayName);
    matches.push({ a: ca.id, b: cb.id, outcome: r.outcome });
    const g = r.model_guess_json ? JSON.parse(r.model_guess_json) : null;
    for (const [side, c] of [["A", ca], ["B", cb]] as const) {
      if (g?.[side]) {
        guesses++;
        if (g[side] === c.displayName) correctGuesses++;
      }
    }
  }

  // Per-contestant run stats (cost, time, checks) over runs that were reviewed.
  const runRows = db
    .prepare(`SELECT r.contestant_id, r.metrics_json, e.tags_json FROM runs r JOIN evaluations e ON e.id = r.evaluation_id WHERE r.metrics_json IS NOT NULL`)
    .all() as { contestant_id: string; metrics_json: string; tags_json: string }[];
  const stats = new Map<string, { runs: number; cost: number; costRuns: number; wall: number; checkScore: number; checkRuns: number }>();
  for (const r of runRows) {
    if (tag && !(JSON.parse(r.tags_json) as string[]).includes(tag)) continue;
    const m = JSON.parse(r.metrics_json);
    const s = stats.get(r.contestant_id) ?? { runs: 0, cost: 0, costRuns: 0, wall: 0, checkScore: 0, checkRuns: 0 };
    s.runs++;
    s.wall += m.wallSec;
    if (m.costUsd != null) {
      s.cost += m.costUsd;
      s.costRuns++;
    }
    if (m.checkScore != null) {
      s.checkScore += m.checkScore;
      s.checkRuns++;
    }
    stats.set(r.contestant_id, s);
  }

  const PROVISIONAL_N = 10;
  return {
    tag: tag ?? null,
    tags: [...allTags].sort(),
    comparisons: matches.length,
    // Share of model guesses that were right, minus chance. Near 0 = blinding held.
    blinding: guesses ? { guesses, accuracy: correctGuesses / guesses } : null,
    ratings: computeRatings(matches).map((r) => {
      const s = stats.get(r.id);
      return {
        ...r,
        name: names.get(r.id) ?? r.id,
        provisional: r.n < PROVISIONAL_N,
        avgCostUsd: s?.costRuns ? s.cost / s.costRuns : null,
        avgWallSec: s?.runs ? s.wall / s.runs : null,
        avgCheckScore: s?.checkRuns ? s.checkScore / s.checkRuns : null,
      };
    }),
  };
}

/** Permanently delete an evaluation: its runs' artifacts, comparisons and reviews. Refuses while it's running. */
export function deleteEvaluation(id: string): void {
  const ev = q.evaluation(id);
  if (!ev) throw new Error("no such evaluation");
  if (ev.status === "running") throw new Error("this evaluation is still running");
  const db = getDb();
  for (const r of q.runs(id)) forceRemove(r.dir);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM submissions WHERE assignment_id IN (SELECT id FROM assignments WHERE evaluation_id = ?)").run(id);
    db.prepare("DELETE FROM assignments WHERE evaluation_id = ?").run(id);
    db.prepare("DELETE FROM runs WHERE evaluation_id = ?").run(id);
    db.prepare("DELETE FROM evaluations WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
