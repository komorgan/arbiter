// Projects, batches, membership, gold, and the annotator review queue.

import crypto from "node:crypto";
import { newId, now, q, type AssignmentRow } from "../db.ts";
import { createEvaluation, executeEvaluation } from "../runner.ts";
import { getRubric, listRubrics, requireRubric, outcomeOf, swapSides, validateAnswers } from "../rubrics.ts";
import { scrubberFor, sideView } from "../views.ts";
import { audit, managedDb, type Project, type User } from "./db.ts";

const LEASE_MINUTES = 30;

// ---------- projects ----------

export interface ProjectInput {
  name?: string;
  instructions?: string;
  rubric?: string;
  reviewsPerComparison?: number;
  goldShare?: number;
  showMetrics?: boolean;
  showTranscript?: boolean;
  allowGuess?: boolean;
  status?: Project["status"];
  qualRequired?: number;
  requireDesktop?: boolean;
  qualPass?: number;
}

export function getProject(id: string): Project | undefined {
  return managedDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as Project | undefined;
}

export function saveProject(by: User, id: string | null, input: ProjectInput, ip: string): Project {
  const db = managedDb();
  const cur = id ? getProject(id) : undefined;
  if (id && !cur) throw new Error("No such project");
  const name = (input.name ?? cur?.name ?? "").trim();
  if (!name) throw new Error("Project name is required");
  const rubric = input.rubric ?? cur?.rubric ?? "detailed-pairwise";
  if (!getRubric(rubric)) throw new Error(`Unknown rubric "${rubric}"`);
  // The rubric fixes what reviews mean; changing it after reviews exist would mix incompatible answers.
  if (cur && rubric !== cur.rubric && db.prepare("SELECT 1 FROM reviews WHERE project_id = ? AND status = 'submitted' LIMIT 1").get(cur.id)) {
    throw new Error("The rubric can't change once reviews have been submitted");
  }
  const n = Math.round(Number(input.reviewsPerComparison ?? cur?.reviews_per_comparison ?? 3));
  if (!(n >= 1 && n <= 20)) throw new Error("Reviews per comparison must be 1–20");
  const gold = Number(input.goldShare ?? cur?.gold_share ?? 0.1);
  if (!(gold >= 0 && gold <= 0.5)) throw new Error("Gold share must be between 0 and 0.5");
  const status = input.status ?? cur?.status ?? "draft";
  if (!["draft", "active", "paused", "closed"].includes(status)) throw new Error("Invalid status");
  const qualRequired = Math.round(Number(input.qualRequired ?? cur?.qual_required ?? 0));
  if (!(qualRequired >= 0 && qualRequired <= 50)) throw new Error("Qualification items must be 0–50");
  const qualPass = Number(input.qualPass ?? cur?.qual_pass ?? 0.8);
  if (!(qualPass > 0 && qualPass <= 1)) throw new Error("The qualification pass mark must be between 1% and 100%");
  const bool = (v: boolean | undefined, d: number | undefined, dflt: number) => (v === undefined ? (d ?? dflt) : v ? 1 : 0);
  const row = [
    name.slice(0, 200), String(input.instructions ?? cur?.instructions ?? "").slice(0, 20000), rubric, n, gold,
    bool(input.showMetrics, cur?.show_metrics, 1), bool(input.showTranscript, cur?.show_transcript, 0), bool(input.allowGuess, cur?.allow_guess, 0), status, qualRequired, qualPass, bool(input.requireDesktop, cur?.require_desktop, 1),
  ];
  if (cur) {
    db.prepare("UPDATE projects SET name=?, instructions=?, rubric=?, reviews_per_comparison=?, gold_share=?, show_metrics=?, show_transcript=?, allow_guess=?, status=?, qual_required=?, qual_pass=?, require_desktop=? WHERE id=?").run(...row, cur.id);
    audit(by.id, "project.update", { id: cur.id, ...input }, ip);
    return getProject(cur.id)!;
  }
  const pid = newId();
  db.prepare("INSERT INTO projects (name, instructions, rubric, reviews_per_comparison, gold_share, show_metrics, show_transcript, allow_guess, status, qual_required, qual_pass, require_desktop, id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...row, pid, now());
  audit(by.id, "project.create", { id: pid, name }, ip);
  return getProject(pid)!;
}

/** Comparisons (engine assignments) belonging to a project, with review counts and gold info. */
export function projectComparisons(projectId: string) {
  const db = managedDb();
  return db
    .prepare(
      `SELECT a.id, a.evaluation_id, a.run_a, a.run_b, e.task_json,
              g.expected AS gold_expected, g.note AS gold_note, g.qual AS gold_qual,
              (SELECT COUNT(*) FROM reviews r WHERE r.comparison_id = a.id AND r.status = 'submitted') AS submitted,
              (SELECT COUNT(*) FROM reviews r WHERE r.comparison_id = a.id AND r.status = 'leased' AND r.lease_expires > ?) AS leased
       FROM project_evaluations pe JOIN assignments a ON a.evaluation_id = pe.evaluation_id
       JOIN evaluations e ON e.id = a.evaluation_id LEFT JOIN gold g ON g.comparison_id = a.id
       WHERE pe.project_id = ? ORDER BY a.created_at`,
    )
    .all(now(), projectId)
    .map((r) => {
      const x = r as Record<string, unknown>;
      const runA = q.run(x.run_a as string)!;
      const runB = q.run(x.run_b as string)!;
      return {
        id: x.id as string,
        evaluationId: x.evaluation_id as string,
        task: (JSON.parse(x.task_json as string) as { title: string }).title,
        a: { contestant: runA.contestant.displayName, status: runA.status, checks: runA.metrics ? `${runA.metrics.checksPassed}/${runA.metrics.checksTotal}` : "–" },
        b: { contestant: runB.contestant.displayName, status: runB.status, checks: runB.metrics ? `${runB.metrics.checksPassed}/${runB.metrics.checksTotal}` : "–" },
        gold: x.gold_expected ? { expected: x.gold_expected as string, note: (x.gold_note as string) ?? "", qual: !!x.gold_qual } : null,
        submitted: Number(x.submitted),
        leased: Number(x.leased),
      };
    });
}

/** Add a batch: run each task against the chosen contestants on the server, attached to the project. */
export async function addBatch(by: User, projectId: string, input: { taskPaths?: unknown; contestantIds?: unknown; repeats?: unknown }, ip: string): Promise<string[]> {
  const p = getProject(projectId);
  if (!p) throw new Error("No such project");
  const tasks = Array.isArray(input.taskPaths) ? input.taskPaths.map(String) : [];
  const contestants = Array.isArray(input.contestantIds) ? input.contestantIds.map(String) : [];
  if (!tasks.length) throw new Error("Pick at least one task");
  if (contestants.length < 2) throw new Error("Pick at least two contestants");
  const ids: string[] = [];
  for (const t of tasks) {
    const evId = await createEvaluation({ taskPath: t, contestantIds: contestants, repeats: Number(input.repeats ?? 1) });
    managedDb().prepare("INSERT INTO project_evaluations VALUES (?, ?)").run(projectId, evId);
    ids.push(evId);
  }
  audit(by.id, "project.batch", { project: projectId, evaluations: ids, tasks, contestants }, ip);
  // Run in the background, one evaluation after another, to bound load on the server.
  (async () => {
    for (const id of ids) await executeEvaluation(id, (m) => console.log(`[project ${projectId}] [eval ${id}] ${m}`)).catch((e) => console.error(e));
  })();
  return ids;
}

export function projectBatches(projectId: string) {
  return (managedDb().prepare("SELECT evaluation_id FROM project_evaluations WHERE project_id = ?").all(projectId) as { evaluation_id: string }[])
    .map((r) => q.evaluation(r.evaluation_id))
    .filter((e) => !!e)
    .map((e) => {
      const runs = q.runs(e!.id);
      return {
        id: e!.id, createdAt: e!.created_at, task: e!.task.title, status: e!.status, sandbox: e!.sandbox,
        contestants: [...new Set(runs.map((r) => r.contestant.displayName))],
        runs: { total: runs.length, done: runs.filter((r) => !["queued", "running"].includes(r.status)).length, failed: runs.filter((r) => r.status === "failed").length },
        comparisons: q.assignments(e!.id).length,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Mark a comparison as gold (known answer), or as a qualification item (a gold answer used only for the entry test,
 * with the note shown to the annotator as feedback). Qualification items never appear in regular work or results.
 */
export function setGold(by: User, comparisonId: string, expected: unknown, note: unknown, qual: unknown, ip: string): void {
  const db = managedDb();
  if (!db.prepare("SELECT 1 FROM assignments WHERE id = ?").get(comparisonId)) throw new Error("No such comparison");
  const isQual = qual ? 1 : 0;
  const cur = db.prepare("SELECT qual FROM gold WHERE comparison_id = ?").get(comparisonId) as { qual: number } | undefined;
  // Moving a comparison between real work and the entry test would mix its reviews into the wrong pool.
  const reviewed = db.prepare("SELECT 1 FROM reviews WHERE comparison_id = ? AND status = 'submitted' LIMIT 1").get(comparisonId);
  if (reviewed && (cur?.qual ?? 0) !== (expected === null || expected === "" ? 0 : isQual)) {
    throw new Error("This comparison already has reviews, so it can't move in or out of the qualification test");
  }
  if (expected === null || expected === "") {
    db.prepare("DELETE FROM gold WHERE comparison_id = ?").run(comparisonId);
  } else {
    if (!["A", "B", "tie"].includes(String(expected))) throw new Error("expected must be A, B or tie");
    db.prepare("INSERT INTO gold (comparison_id, expected, note, created_at, qual) VALUES (?, ?, ?, ?, ?) ON CONFLICT(comparison_id) DO UPDATE SET expected = excluded.expected, note = excluded.note, qual = excluded.qual")
      .run(comparisonId, String(expected), typeof note === "string" ? note.slice(0, 1000) : null, now(), isQual);
  }
  audit(by.id, "gold.set", { comparison: comparisonId, expected, qual: !!isQual }, ip);
}

/** Admin override of an annotator's qualification: reset (they retake it from scratch), pass, or fail. */
export function setQualification(by: User, projectId: string, userId: string, status: unknown, ip: string): void {
  if (status !== "none" && status !== "passed" && status !== "failed") throw new Error("status must be none, passed or failed");
  const db = managedDb();
  const r = db.prepare("UPDATE project_members SET qual_status = ?, qual_at = ? WHERE project_id = ? AND user_id = ?").run(status, now(), projectId, userId);
  if (!r.changes) throw new Error("That person isn't in this project");
  if (status === "none") db.prepare("DELETE FROM reviews WHERE project_id = ? AND user_id = ? AND is_qual = 1").run(projectId, userId);
  audit(by.id, "qual.set", { project: projectId, user: userId, status }, ip);
}

// ---------- membership ----------

export function setMembers(by: User, projectId: string, userIds: unknown, ip: string): void {
  if (!getProject(projectId)) throw new Error("No such project");
  const ids = Array.isArray(userIds) ? userIds.map(String) : [];
  const db = managedDb();
  db.exec("BEGIN");
  try {
    const keep = new Set(ids);
    for (const m of db.prepare("SELECT user_id FROM project_members WHERE project_id = ?").all(projectId) as { user_id: string }[]) {
      if (!keep.has(m.user_id)) db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(projectId, m.user_id);
    }
    const add = db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)");
    for (const uid of ids) add.run(projectId, uid, now());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  audit(by.id, "project.members", { project: projectId, users: ids }, ip);
}

export function setExcluded(by: User, projectId: string, userId: string, excluded: boolean, ip: string): void {
  const r = managedDb().prepare("UPDATE project_members SET excluded = ? WHERE project_id = ? AND user_id = ?").run(excluded ? 1 : 0, projectId, userId);
  if (!r.changes) throw new Error("That person isn't in this project");
  audit(by.id, excluded ? "qa.exclude" : "qa.include", { project: projectId, user: userId }, ip);
}

// ---------- annotator queue ----------

export interface QualState {
  required: number; // items this annotator must answer (0 = no qualification)
  items: number; // qualification items the admin has set up
  done: number;
  correct: number;
  status: "none" | "passed" | "failed";
  /** True while the annotator must work on qualification items instead of real comparisons. */
  gating: boolean;
}

export function qualState(p: Project, userId: string): QualState {
  const db = managedDb();
  const items = (db.prepare(
    "SELECT COUNT(*) AS n FROM project_evaluations pe JOIN assignments a ON a.evaluation_id = pe.evaluation_id JOIN gold g ON g.comparison_id = a.id WHERE pe.project_id = ? AND g.qual = 1",
  ).get(p.id) as { n: number }).n;
  const m = db.prepare("SELECT qual_status FROM project_members WHERE project_id = ? AND user_id = ?").get(p.id, userId) as { qual_status: QualState["status"] } | undefined;
  const r = db.prepare(
    `SELECT COUNT(*) AS done, COALESCE(SUM(r.outcome = g.expected), 0) AS correct FROM reviews r JOIN gold g ON g.comparison_id = r.comparison_id
     WHERE r.project_id = ? AND r.user_id = ? AND r.is_qual = 1 AND r.status = 'submitted'`,
  ).get(p.id, userId) as { done: number; correct: number };
  const status = m?.qual_status ?? "none";
  const required = p.qual_required > 0 ? Math.min(p.qual_required, items || p.qual_required) : 0;
  return { required, items, done: r.done, correct: r.correct, status, gating: required > 0 && status !== "passed" };
}

/** Where the annotator's request came from. The desktop app's protected window marks its requests (see desktop/main.ts). */
export interface ClientInfo {
  desktop: boolean;
}

export const DESKTOP_REQUIRED = "This project must be reviewed in the Arbiter desktop app. Open it there under Managed workspaces.";

/**
 * Enforce a project's "desktop app required" setting. This is a policy control, not a security boundary: the marker
 * can be imitated by someone determined to. It keeps honest annotators in the protected window (capture blocking,
 * no local storage) and gives the team a clear rule to point to.
 */
function assertClient(p: Project, client: ClientInfo): void {
  if (p.require_desktop && !client.desktop) throw new Error(DESKTOP_REQUIRED);
}

/** Projects an annotator can work on, with how much is left for them and where they stand on qualification. */
export function annotatorProjects(user: User, client: ClientInfo) {
  const db = managedDb();
  const rows = db
    .prepare("SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? AND p.status IN ('active', 'paused') ORDER BY p.created_at DESC")
    .all(user.id) as unknown as Project[];
  return rows.map((p) => {
    const done = (db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE project_id = ? AND user_id = ? AND status = 'submitted' AND is_qual = 0").get(p.id, user.id) as { n: number }).n;
    const qual = qualState(p, user.id);
    const blocked = !!p.require_desktop && !client.desktop;
    const available = p.status !== "active" || qual.status === "failed" || blocked ? 0 : qual.gating ? Math.max(0, qual.required - qual.done) : pickComparison(p, user, true).length;
    return {
      id: p.id, name: p.name, instructions: p.instructions, status: p.status, done, available,
      requiresDesktop: !!p.require_desktop, blocked: blocked ? "desktop" : null,
      qualification: qual.required ? { required: qual.required, done: qual.done, status: qual.status, ready: qual.items >= qual.required, passMark: p.qual_pass } : null,
    };
  });
}

/**
 * Candidate comparisons for this annotator, best first: not reviewed or skipped by them, still under the
 * project's review target (counting live leases), fewest reviews first, random among ties.
 */
function pickComparison(p: Project, user: User, countOnly = false, qualOnly = false): AssignmentRow[] {
  const db = managedDb();
  const rows = db
    .prepare(
      `SELECT a.*, g.expected AS gold, COALESCE(g.qual, 0) AS qual,
              (SELECT COUNT(*) FROM reviews r WHERE r.comparison_id = a.id AND (r.status = 'submitted' OR (r.status = 'leased' AND r.lease_expires > ?))) AS load
       FROM project_evaluations pe JOIN assignments a ON a.evaluation_id = pe.evaluation_id
       LEFT JOIN gold g ON g.comparison_id = a.id
       WHERE pe.project_id = ?
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.comparison_id = a.id AND r.user_id = ? AND r.status IN ('submitted', 'skipped'))`,
    )
    .all(now(), p.id, user.id) as unknown as (AssignmentRow & { gold: string | null; qual: number; load: number })[];
  if (qualOnly) {
    // The entry test: unseen qualification items in random order.
    const items = rows.filter((r) => r.qual);
    return items.length ? [items[crypto.randomInt(items.length)]] : [];
  }
  // Gold comparisons go to everyone (no target); regular ones stop at the target. Qualification items never appear here.
  const regular = rows.filter((r) => !r.gold && r.load < p.reviews_per_comparison);
  const gold = rows.filter((r) => r.gold && !r.qual);
  if (countOnly) return [...regular, ...gold];
  // Mix gold in at the project's rate while regular work remains; once it runs out, finish the unseen gold,
  // so every annotator gets a measured accuracy even on small projects.
  const useGold = gold.length > 0 && (regular.length === 0 || crypto.randomInt(1000) < p.gold_share * 1000);
  const pool = useGold ? gold : regular;
  const minLoad = Math.min(...pool.map((r) => r.load));
  const best = pool.filter((r) => r.load === minLoad);
  return best.length ? [best[crypto.randomInt(best.length)]] : [];
}

/** Return the annotator's current lease in this project, or lease a new comparison. Null when nothing is left. */
export function nextReview(user: User, projectId: string, client: ClientInfo): string | null {
  const db = managedDb();
  const p = getProject(projectId);
  if (!p || !isMember(projectId, user.id)) throw new Error("You're not a member of this project");
  if (p.status !== "active") throw new Error("This project is not accepting reviews right now");
  assertClient(p, client);
  const open = db
    .prepare("SELECT id FROM reviews WHERE project_id = ? AND user_id = ? AND status = 'leased' AND lease_expires > ? LIMIT 1")
    .get(projectId, user.id, now()) as { id: string } | undefined;
  if (open) return open.id;
  const qual = qualState(p, user.id);
  if (qual.status === "failed") throw new Error("You didn't pass this project's qualification. Your admin can let you retake it.");
  if (qual.gating && qual.items < qual.required) throw new Error("This project's qualification test isn't ready yet. Please check back later.");
  if (qual.gating && qual.done >= qual.required) throw new Error("Your qualification is being graded. Reload the page.");
  const [c] = pickComparison(p, user, false, qual.gating);
  if (!c) return null;
  const leasedAt = new Date();
  const expires = new Date(leasedAt.getTime() + LEASE_MINUTES * 60_000).toISOString();
  const g = db.prepare("SELECT qual FROM gold WHERE comparison_id = ?").get(c.id) as { qual: number } | undefined;
  const isGold = g && !g.qual ? 1 : 0;
  const isQual = g?.qual ? 1 : 0;
  const flip = crypto.randomInt(2);
  const existing = db.prepare("SELECT id FROM reviews WHERE comparison_id = ? AND user_id = ?").get(c.id, user.id) as { id: string } | undefined;
  if (existing) {
    // An expired lease of theirs: renew it (new flip, new clock).
    db.prepare("UPDATE reviews SET status = 'leased', flip = ?, is_gold = ?, is_qual = ?, leased_at = ?, lease_expires = ? WHERE id = ?")
      .run(flip, isGold, isQual, leasedAt.toISOString(), expires, existing.id);
    return existing.id;
  }
  const id = crypto.randomBytes(12).toString("base64url"); // unguessable: it's the only handle the client gets
  db.prepare("INSERT INTO reviews (id, comparison_id, project_id, user_id, flip, status, is_gold, is_qual, leased_at, lease_expires) VALUES (?, ?, ?, ?, ?, 'leased', ?, ?, ?, ?)")
    .run(id, c.id, projectId, user.id, flip, isGold, isQual, leasedAt.toISOString(), expires);
  return id;
}

function isMember(projectId: string, userId: string): boolean {
  return !!managedDb().prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, userId);
}

interface ReviewRow {
  id: string;
  comparison_id: string;
  project_id: string;
  user_id: string;
  flip: number;
  status: string;
  is_gold: number;
  is_qual: number;
  lease_expires: string;
}

function ownReview(user: User, reviewId: string): ReviewRow {
  const r = managedDb().prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId) as unknown as ReviewRow | undefined;
  if (!r || r.user_id !== user.id) throw new Error("Review not found");
  return r;
}

/**
 * The blind payload an annotator sees. Contains no run ids, contestant names, model ids or evaluation ids:
 * only the review handle, the scrubbed task and results in display order, and the rubric.
 */
export function reviewPayload(user: User, reviewId: string, client: ClientInfo) {
  const r = ownReview(user, reviewId);
  if (r.status !== "leased") throw new Error("This review is already closed");
  if (Date.parse(r.lease_expires) < Date.now()) throw new Error("This review's time ran out. Take the next one.");
  const p = getProject(r.project_id)!;
  assertClient(p, client);
  const a = q.assignment(r.comparison_id)!;
  const ev = q.evaluation(a.evaluation_id)!;
  const scrub = scrubberFor(ev.id);
  const [left, right] = r.flip ? [a.run_b, a.run_a] : [a.run_a, a.run_b];
  const side = (runId: string) => {
    const s = sideView(q.run(runId)!, scrub);
    return {
      status: s.status,
      summary: s.summary,
      diff: s.diff,
      checks: s.checks,
      metrics: p.show_metrics ? s.metrics : null,
      transcript: p.show_transcript ? s.transcript : [],
      error: s.error,
    };
  };
  return {
    id: r.id,
    project: { id: p.id, name: p.name, instructions: p.instructions, allowGuess: !!p.allow_guess },
    leaseExpires: r.lease_expires,
    task: { title: ev.task.title, prompt: ev.task.prompt },
    rubric: requireRubric(p.rubric),
    guessOptions: p.allow_guess ? [...new Set(q.runs(ev.id).map((x) => x.contestant.displayName))].sort() : [],
    sides: { A: side(left), B: side(right) },
    // Qualification items are announced as such: the annotator knows they're taking the entry test.
    qualification: r.is_qual ? (() => {
      const s = qualState(p, user.id);
      return { index: s.done + 1, required: s.required, passMark: p.qual_pass };
    })() : null,
  };
}

export function submitReview(user: User, reviewId: string, body: { answers?: unknown; modelGuess?: unknown; timeSpentSec?: unknown }, ip: string, client: ClientInfo) {
  const db = managedDb();
  const r = ownReview(user, reviewId);
  if (r.status !== "leased") throw new Error("This review is already closed");
  const p = getProject(r.project_id)!;
  if (p.status === "closed") throw new Error("This project is closed");
  assertClient(p, client);
  const rubric = requireRubric(p.rubric);
  const shown = (body.answers ?? {}) as Record<string, unknown>;
  const problem = validateAnswers(rubric, shown);
  if (problem) throw new Error(problem);
  // Store in the comparison's frame: undo the per-annotator left/right flip.
  const answers = r.flip ? swapSides(rubric, shown) : shown;
  const outcome = outcomeOf(answers.overall as number);
  const display = outcomeOf(shown.overall as number);
  const guess = body.modelGuess && typeof body.modelGuess === "object" ? body.modelGuess as { A?: string; B?: string } : null;
  const guessNorm = guess && r.flip ? { A: guess.B, B: guess.A } : guess;
  const time = Math.max(0, Math.min(86400, Number(body.timeSpentSec) || 0));
  db.prepare("UPDATE reviews SET status = 'submitted', submitted_at = ?, answers_json = ?, outcome = ?, outcome_display = ?, model_guess_json = ?, time_spent_s = ? WHERE id = ? AND status = 'leased'")
    .run(now(), JSON.stringify(answers), outcome, display === "A" ? "left" : display === "B" ? "right" : "tie", guessNorm ? JSON.stringify(guessNorm) : null, time, r.id);
  audit(user.id, "review.submit", { review: r.id, project: p.id, qual: !!r.is_qual }, ip);
  if (!r.is_qual) return { ok: true };

  // Qualification: tell them how they did on this item (in the frame they saw), and grade the test when it's complete.
  const g = db.prepare("SELECT expected, note FROM gold WHERE comparison_id = ?").get(r.comparison_id) as { expected: string; note: string | null };
  const expectedShown = r.flip && g.expected !== "tie" ? (g.expected === "A" ? "B" : "A") : g.expected;
  const s = qualState(p, user.id);
  let status = s.status;
  if (s.done >= s.required) {
    status = s.correct / s.done >= p.qual_pass ? "passed" : "failed";
    db.prepare("UPDATE project_members SET qual_status = ?, qual_at = ? WHERE project_id = ? AND user_id = ?").run(status, now(), p.id, user.id);
    audit(user.id, status === "passed" ? "qual.passed" : "qual.failed", { project: p.id, correct: s.correct, of: s.done }, ip);
  }
  return {
    ok: true,
    qualification: {
      correct: outcome === g.expected,
      expected: expectedShown,
      note: g.note ?? "",
      done: s.done,
      required: s.required,
      score: s.correct,
      status,
    },
  };
}

export function skipReview(user: User, reviewId: string, reason: unknown, ip: string, client: ClientInfo) {
  const r = ownReview(user, reviewId);
  assertClient(getProject(r.project_id)!, client);
  if (r.status !== "leased") throw new Error("This review is already closed");
  if (r.is_qual) throw new Error("Qualification items can't be skipped");
  const why = typeof reason === "string" ? reason.slice(0, 300) : "";
  managedDb().prepare("UPDATE reviews SET status = 'skipped', skip_reason = ?, submitted_at = ? WHERE id = ?").run(why, now(), r.id);
  audit(user.id, "review.skip", { review: r.id, reason: why }, ip);
  return { ok: true };
}

/** Give a lease back without skipping (e.g. the annotator closed the window). The comparison can come back to them. */
export function releaseReview(user: User, reviewId: string) {
  const r = ownReview(user, reviewId);
  if (r.status === "leased") managedDb().prepare("DELETE FROM reviews WHERE id = ?").run(r.id);
  return { ok: true };
}
