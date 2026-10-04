// Managed-mode tables. They live in the same SQLite database as the engine's evaluations and runs, in the
// server's data dir. A "comparison" is the engine's assignments row (a pair of runs with a fixed A/B); in
// Managed mode many annotators review each comparison, so their work is stored in `reviews`.

import { getDb } from "../db.ts";

let ready = false;

export function managedDb() {
  const db = getDb();
  if (ready) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'annotator')), pw_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL, last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL,
      project_ids_json TEXT NOT NULL DEFAULT '[]', created_by TEXT, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen TEXT NOT NULL, user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
      rubric TEXT NOT NULL, reviews_per_comparison INTEGER NOT NULL DEFAULT 3,
      gold_share REAL NOT NULL DEFAULT 0.1, show_metrics INTEGER NOT NULL DEFAULT 1,
      show_transcript INTEGER NOT NULL DEFAULT 0, allow_guess INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'closed')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_evaluations (
      project_id TEXT NOT NULL REFERENCES projects(id), evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
      PRIMARY KEY (project_id, evaluation_id)
    );
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
      excluded INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );
    -- A gold comparison has a known right answer, relative to the comparison's own A/B (run_a / run_b).
    CREATE TABLE IF NOT EXISTS gold (
      comparison_id TEXT PRIMARY KEY REFERENCES assignments(id),
      expected TEXT NOT NULL CHECK (expected IN ('A', 'B', 'tie')), note TEXT, created_at TEXT NOT NULL
    );
    -- One row per (comparison, annotator). flip = 1 means the annotator saw run_b on the left.
    -- answers/outcome are stored in the comparison's frame (already un-flipped); outcome_display is what they clicked.
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, comparison_id TEXT NOT NULL REFERENCES assignments(id),
      project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
      flip INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('leased', 'submitted', 'skipped')),
      is_gold INTEGER NOT NULL DEFAULT 0, leased_at TEXT NOT NULL, lease_expires TEXT NOT NULL,
      submitted_at TEXT, answers_json TEXT, outcome TEXT, outcome_display TEXT,
      model_guess_json TEXT, time_spent_s REAL, skip_reason TEXT,
      UNIQUE (comparison_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS reviews_project ON reviews(project_id, status);
    CREATE INDEX IF NOT EXISTS reviews_user ON reviews(user_id, status);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL,
      detail_json TEXT, ip TEXT
    );
  `);
  // Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so check first.
  const addColumn = (table: string, column: string, def: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  };
  // Qualification: annotators answer N known-answer comparisons (gold rows with qual = 1) before real work.
  addColumn("projects", "qual_required", "INTEGER NOT NULL DEFAULT 0");
  addColumn("projects", "qual_pass", "REAL NOT NULL DEFAULT 0.8");
  addColumn("gold", "qual", "INTEGER NOT NULL DEFAULT 0");
  addColumn("project_members", "qual_status", "TEXT NOT NULL DEFAULT 'none'"); // none | passed | failed
  addColumn("project_members", "qual_at", "TEXT");
  addColumn("reviews", "is_qual", "INTEGER NOT NULL DEFAULT 0");
  // Annotators must work in the desktop app's protected window (a policy control; see projects.ts assertClient).
  addColumn("projects", "require_desktop", "INTEGER NOT NULL DEFAULT 1");
  ready = true;
  return db;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "annotator";
  status: "active" | "disabled";
  created_at: string;
  last_login: string | null;
}

export interface Project {
  id: string;
  name: string;
  instructions: string;
  rubric: string;
  reviews_per_comparison: number;
  gold_share: number;
  show_metrics: number;
  show_transcript: number;
  allow_guess: number;
  status: "draft" | "active" | "paused" | "closed";
  created_at: string;
  qual_required: number;
  qual_pass: number;
  require_desktop: number;
}

export function audit(userId: string | null, action: string, detail: unknown = null, ip: string | null = null): void {
  managedDb()
    .prepare("INSERT INTO audit (at, user_id, action, detail_json, ip) VALUES (?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), userId, action, detail == null ? null : JSON.stringify(detail), ip);
}
