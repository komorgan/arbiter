import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LimitTracker, type AgentContext } from "./agent/context.ts";
import { ToolRuntime } from "./agent/tools.ts";
import { getContestants, paths } from "./config.ts";
import { getDb, newId, now, q, type RunRow } from "./db.ts";
import { PRICE_TABLE_VERSION } from "./pricing.ts";
import { runAgent } from "./providers/index.ts";
import { createSandbox, resolveSandboxKind, type Sandbox, type SandboxPreference } from "./sandbox/index.ts";
import { captureDiff, commitBase, globToRegExp, prepareWorkspace } from "./sandbox/workspace.ts";
import { loadTask } from "./task.ts";
import type { AgentOutcome, CheckResult, RunMetrics, TaskBundle, TranscriptEvent } from "./types.ts";

export interface NewEvaluation {
  taskPath: string;
  contestantIds: string[];
  repeats?: number;
  sandbox?: SandboxPreference;
}

type Progress = (msg: string) => void;

/** First line of an error, capped, for progress output. The full text stays on the run record. */
const brief = (s: string) => {
  const line = s.split("\n").find((l) => /fatal|error/i.test(l)) ?? s.split("\n")[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};

/** Create an evaluation and its queued runs. Returns the id; call executeEvaluation to run it. */
export async function createEvaluation(input: NewEvaluation): Promise<string> {
  const task = loadTask(input.taskPath);
  const contestants = getContestants(input.contestantIds);
  if (contestants.length < 2) throw new Error("pick at least two contestants");
  const repeats = Math.max(1, Math.min(10, input.repeats ?? 1));
  const sandbox = await resolveSandboxKind(input.sandbox ?? "auto");

  const db = getDb();
  const id = newId();
  db.prepare("INSERT INTO evaluations VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, now(), task.dir, JSON.stringify(task), task.rubric, JSON.stringify(task.tags), sandbox, "running",
  );
  const insertRun = db.prepare(
    "INSERT INTO runs (id, evaluation_id, contestant_id, contestant_json, attempt, status, dir) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
  );
  for (const c of contestants) {
    for (let attempt = 1; attempt <= repeats; attempt++) {
      const runId = newId();
      // The contestant spec is snapshotted into the run, so later edits to contestants.yaml don't rewrite history.
      insertRun.run(runId, id, c.id, JSON.stringify(c), attempt, path.join(paths.runs(), runId));
    }
  }
  return id;
}

/** Run every queued run of an evaluation (bounded parallelism), then create blind review assignments. */
export async function executeEvaluation(evaluationId: string, progress: Progress = () => {}, concurrency = 4): Promise<void> {
  const ev = q.evaluation(evaluationId);
  if (!ev) throw new Error(`no evaluation ${evaluationId}`);
  const queue = q.runs(evaluationId).filter((r) => r.status === "queued");
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      try {
        await executeRun(ev.task, run, ev.sandbox as "docker" | "local", progress);
      } catch (err) {
        // An unexpected error must not leave the run (and so the whole evaluation) stuck as "running".
        console.error(`run ${run.id} crashed`, err);
        getDb()
          .prepare("UPDATE runs SET status = 'failed', error = ?, ended_at = ? WHERE id = ?")
          .run(`internal error: ${err instanceof Error ? err.message : String(err)}`, now(), run.id);
      }
    }
  });
  await Promise.all(workers);

  const created = createAssignments(evaluationId);
  const runs = q.runs(evaluationId);
  const status = created > 0 ? "ready" : "failed";
  getDb().prepare("UPDATE evaluations SET status = ? WHERE id = ?").run(status, evaluationId);
  progress(
    status === "ready"
      ? `evaluation ${evaluationId} ready for blind review (${created} comparison${created === 1 ? "" : "s"})`
      : `evaluation ${evaluationId} failed: no comparable runs (${[...new Set(runs.map((r) => r.error && brief(r.error)).filter(Boolean))].join("; ")})`,
  );
}

async function executeRun(task: TaskBundle, run: RunRow, sandboxKind: "docker" | "local", progress: Progress): Promise<void> {
  const db = getDb();
  const label = `run ${run.id}`; // never log the contestant here: progress is shown during blind runs too
  const ws = path.join(run.dir, "workspace");
  fs.mkdirSync(run.dir, { recursive: true });
  db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(now(), run.id);
  progress(`${label}: preparing workspace`);

  const transcript = fs.openSync(path.join(run.dir, "transcript.jsonl"), "w");
  const t0 = Date.now();
  const log = (ev: Omit<TranscriptEvent, "t">) =>
    fs.writeSync(transcript, `${JSON.stringify({ t: +((Date.now() - t0) / 1000).toFixed(2), ...ev })}\n`);

  let sandbox: Sandbox | undefined;
  let outcome: AgentOutcome;
  let base = "";
  const limits = new LimitTracker(task.limits, run.contestant);
  try {
    base = await prepareWorkspace(task, ws);
    db.prepare("UPDATE runs SET base_commit = ? WHERE id = ?").run(base, run.id);
    sandbox = await createSandbox(sandboxKind, ws, task, run.id);
    if (task.env.setup) {
      progress(`${label}: setup`);
      const r = await sandbox.exec(task.env.setup, 600);
      if (r.exitCode !== 0) throw new Error(`setup failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(-2000)}`);
      base = await commitBase(ws);
    }
    progress(`${label}: agent running`);
    const ctx: AgentContext = { task, contestant: run.contestant, sandbox, tools: new ToolRuntime(sandbox), limits, log };
    outcome = await runAgent(ctx);
  } catch (err) {
    outcome = { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.error) log({ type: outcome.status === "limit_hit" ? "limit" : "error", text: outcome.error });
  if (outcome.summary) log({ type: "finish", text: outcome.summary });
  const wallSec = limits.elapsedSec;

  // Collect artifacts even for limit_hit / refused runs: partial work is still reviewable.
  let metrics: RunMetrics | null = null;
  if (base && fs.existsSync(ws)) {
    try {
      const diff = await captureDiff(ws, base);
      fs.writeFileSync(path.join(run.dir, "diff.patch"), diff.diff);
      const checks: CheckResult[] = [];
      if (sandbox && outcome.status !== "failed") {
        progress(`${label}: running checks`);
        for (const c of task.checks) {
          const r = await sandbox.exec(c.cmd, 300);
          checks.push({
            id: c.id, kind: c.kind, cmd: c.cmd, weight: c.weight,
            passed: r.exitCode === 0, exitCode: r.exitCode, durationSec: r.durationSec,
            output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.slice(-8000),
          });
        }
      }
      fs.writeFileSync(path.join(run.dir, "checks.json"), JSON.stringify(checks, null, 2));
      const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
      const scope = task.scopeGlobs?.map(globToRegExp);
      metrics = {
        wallSec: +wallSec.toFixed(1),
        inputTokens: limits.inputTokens,
        outputTokens: limits.outputTokens,
        costUsd: limits.costUsd,
        toolCalls: limits.toolCalls,
        turns: limits.turns,
        filesTouched: diff.files.length,
        linesAdded: diff.linesAdded,
        linesRemoved: diff.linesRemoved,
        outOfScopeFiles: scope ? diff.files.filter((f) => !scope.some((re) => re.test(f))).length : 0,
        checksPassed: checks.filter((c) => c.passed).length,
        checksTotal: checks.length,
        checkScore: totalWeight > 0 ? checks.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0) / totalWeight : null,
        limitHit: outcome.status === "limit_hit" ? outcome.error : undefined,
      };
    } catch (err) {
      outcome = { status: "failed", error: `collecting results failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  fs.closeSync(transcript);
  await sandbox?.dispose().catch(() => {});
  fs.writeFileSync(
    path.join(run.dir, "run.json"),
    JSON.stringify({ contestant: run.contestant, task: { id: task.id, hash: task.contentHash }, sandbox: sandboxKind, priceTable: PRICE_TABLE_VERSION, node: process.version }, null, 2),
  );
  db.prepare("UPDATE runs SET status = ?, error = ?, summary = ?, ended_at = ?, metrics_json = ? WHERE id = ?").run(
    outcome.status, outcome.error ?? null, outcome.summary ?? null, now(), metrics ? JSON.stringify(metrics) : null, run.id,
  );
  progress(`${label}: ${outcome.status}${outcome.error ? ` (${brief(outcome.error)})` : ""}`);
  // Keep only the artifacts; the diff is enough to re-apply a winner later. Cleanup never fails a run.
  removeDirLater(ws);
}

/**
 * Delete a directory, retrying in the background. On Windows, Docker can hold a bind mount (and git can hold
 * read-only object files) for a moment after a container stops, so an immediate delete may fail with EPERM.
 */
function removeDirLater(dir: string, attempt = 0): void {
  try {
    forceRemove(dir);
  } catch (err) {
    if (attempt < 5) setTimeout(() => removeDirLater(dir, attempt + 1), 3000 * (attempt + 1)).unref();
    else console.warn(`could not remove ${dir}; it will be retried at next start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * rm -rf that also handles read-only files. Git marks its object files read-only, and on Windows the native
 * fs.rmSync in newer Node versions (Electron's included) refuses to delete them with EPERM.
 */
export function forceRemove(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM" && (err as NodeJS.ErrnoException).code !== "EACCES") throw err;
  }
  const makeWritable = (p: string) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) makeWritable(full);
      else fs.chmodSync(full, 0o666);
    }
  };
  makeWritable(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** Remove workspaces left behind by runs that are no longer active (a crash, or a cleanup that kept failing). */
function sweepLeftoverWorkspaces(): void {
  if (!fs.existsSync(paths.runs())) return;
  const active = new Set(
    (getDb().prepare("SELECT id FROM runs WHERE status IN ('queued', 'running')").all() as { id: string }[]).map((r) => r.id),
  );
  for (const id of fs.readdirSync(paths.runs())) {
    const ws = path.join(paths.runs(), id, "workspace");
    if (!active.has(id) && fs.existsSync(ws)) removeDirLater(ws);
  }
}

/** After a crash or restart: mark half-finished runs as failed and finish any evaluation left "running". */
export async function recoverInterrupted(progress: Progress = () => {}): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE runs SET status = 'failed', error = 'interrupted (Arbiter was stopped mid-run)', ended_at = ? WHERE status = 'running'").run(now());
  sweepLeftoverWorkspaces();
  for (const ev of q.evaluations().filter((e) => e.status === "running")) {
    await executeEvaluation(ev.id, progress);
  }
}

/**
 * Pair runs for blind review: every pair of contestants, attempt k vs attempt k. Which run is "A" is random.
 * Infrastructure failures are skipped; limit hits and refusals are real outcomes and stay in.
 */
function createAssignments(evaluationId: string): number {
  const runs = q.runs(evaluationId).filter((r) => r.status !== "failed" && r.status !== "queued" && r.status !== "running");
  const byContestant = new Map<string, RunRow[]>();
  for (const r of runs) byContestant.set(r.contestant_id, [...(byContestant.get(r.contestant_id) ?? []), r]);
  const ids = [...byContestant.keys()];
  const insert = getDb().prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?)");
  const pairs: [RunRow, RunRow][] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const xs = byContestant.get(ids[i])!;
      const ys = byContestant.get(ids[j])!;
      for (const x of xs) {
        const y = ys.find((r) => r.attempt === x.attempt);
        if (y) pairs.push(crypto.randomInt(2) ? [x, y] : [y, x]);
      }
    }
  }
  // Shuffle review order so the queue doesn't reveal pairing structure.
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const t = Date.now();
  pairs.forEach(([a, b], i) => insert.run(newId(), evaluationId, a.id, b.id, new Date(t + i).toISOString()));
  return pairs.length;
}
