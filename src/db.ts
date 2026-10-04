import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { paths } from "./config.ts";
import type { Contestant, RunMetrics, RunStatus, TaskBundle } from "./types.ts";

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(paths.db());
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, task_path TEXT NOT NULL, task_json TEXT NOT NULL,
      rubric TEXT NOT NULL, tags_json TEXT NOT NULL, sandbox TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
      contestant_id TEXT NOT NULL, contestant_json TEXT NOT NULL, attempt INTEGER NOT NULL,
      status TEXT NOT NULL, error TEXT, summary TEXT, base_commit TEXT,
      started_at TEXT, ended_at TEXT, metrics_json TEXT, dir TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
      run_a TEXT NOT NULL REFERENCES runs(id), run_b TEXT NOT NULL REFERENCES runs(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(id),
      answers_json TEXT NOT NULL, outcome TEXT NOT NULL, model_guess_json TEXT,
      time_spent_s REAL, submitted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_eval ON runs(evaluation_id);
    CREATE INDEX IF NOT EXISTS assignments_eval ON assignments(evaluation_id);
  `);
  return db;
}

export const newId = () => crypto.randomBytes(5).toString("hex");
export const now = () => new Date().toISOString();

export interface EvaluationRow {
  id: string;
  created_at: string;
  task_path: string;
  task: TaskBundle;
  rubric: string;
  tags: string[];
  sandbox: string;
  status: "running" | "ready" | "failed";
}

export interface RunRow {
  id: string;
  evaluation_id: string;
  contestant_id: string;
  contestant: Contestant;
  attempt: number;
  status: RunStatus;
  error: string | null;
  summary: string | null;
  started_at: string | null;
  ended_at: string | null;
  metrics: RunMetrics | null;
  dir: string;
}

export interface AssignmentRow {
  id: string;
  evaluation_id: string;
  run_a: string;
  run_b: string;
  created_at: string;
}

export interface SubmissionRow {
  id: string;
  assignment_id: string;
  answers: Record<string, unknown>;
  outcome: "A" | "B" | "tie";
  model_guess: { A?: string; B?: string } | null;
  time_spent_s: number | null;
  submitted_at: string;
}

type Raw = Record<string, unknown>;

export function toEvaluation(r: Raw): EvaluationRow {
  return {
    id: r.id as string,
    created_at: r.created_at as string,
    task_path: r.task_path as string,
    task: JSON.parse(r.task_json as string),
    rubric: r.rubric as string,
    tags: JSON.parse(r.tags_json as string),
    sandbox: r.sandbox as string,
    status: r.status as EvaluationRow["status"],
  };
}

export function toRun(r: Raw): RunRow {
  return {
    id: r.id as string,
    evaluation_id: r.evaluation_id as string,
    contestant_id: r.contestant_id as string,
    contestant: JSON.parse(r.contestant_json as string),
    attempt: Number(r.attempt),
    status: r.status as RunStatus,
    error: (r.error as string) ?? null,
    summary: (r.summary as string) ?? null,
    started_at: (r.started_at as string) ?? null,
    ended_at: (r.ended_at as string) ?? null,
    metrics: r.metrics_json ? JSON.parse(r.metrics_json as string) : null,
    dir: r.dir as string,
  };
}

export function toSubmission(r: Raw): SubmissionRow {
  return {
    id: r.id as string,
    assignment_id: r.assignment_id as string,
    answers: JSON.parse(r.answers_json as string),
    outcome: r.outcome as SubmissionRow["outcome"],
    model_guess: r.model_guess_json ? JSON.parse(r.model_guess_json as string) : null,
    time_spent_s: (r.time_spent_s as number) ?? null,
    submitted_at: r.submitted_at as string,
  };
}

export const q = {
  evaluation: (id: string) => {
    const r = getDb().prepare("SELECT * FROM evaluations WHERE id = ?").get(id);
    return r ? toEvaluation(r as Raw) : undefined;
  },
  evaluations: () => (getDb().prepare("SELECT * FROM evaluations ORDER BY created_at DESC").all() as Raw[]).map(toEvaluation),
  runs: (evaluationId: string) =>
    (getDb().prepare("SELECT * FROM runs WHERE evaluation_id = ? ORDER BY contestant_id, attempt").all(evaluationId) as Raw[]).map(toRun),
  run: (id: string) => {
    const r = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return r ? toRun(r as Raw) : undefined;
  },
  assignments: (evaluationId: string) =>
    getDb().prepare("SELECT * FROM assignments WHERE evaluation_id = ? ORDER BY created_at, id").all(evaluationId) as unknown as AssignmentRow[],
  assignment: (id: string) => getDb().prepare("SELECT * FROM assignments WHERE id = ?").get(id) as unknown as AssignmentRow | undefined,
  submission: (assignmentId: string) => {
    const r = getDb().prepare("SELECT * FROM submissions WHERE assignment_id = ?").get(assignmentId);
    return r ? toSubmission(r as Raw) : undefined;
  },
};
