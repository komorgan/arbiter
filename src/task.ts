import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "./config.ts";
import YAML from "yaml";
import { getRubric, listRubrics, requireRubric } from "./rubrics.ts";
import type { Check, TaskBundle } from "./types.ts";

const TASK_FILE = "arbiter.task.yaml";

/**
 * Resolve what the user typed to a task path. Expands a leading ~ (cmd.exe and PowerShell don't),
 * and treats a bare name like "fix-sum" as a task in the data dir's tasks folder.
 */
export function resolveTaskPath(input: string): string {
  const expanded = input.replace(/^~(?=$|[\\/])/, os.homedir());
  const direct = path.resolve(expanded);
  if (fs.existsSync(direct)) return direct;
  const named = path.join(paths.tasks(), expanded);
  if (!/[\\/]/.test(expanded) && fs.existsSync(named)) return named;
  return direct;
}

/** Load a task bundle from a directory (or a path to its arbiter.task.yaml). */
export function loadTask(input: string): TaskBundle {
  let file = resolveTaskPath(input);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, TASK_FILE);
  if (!fs.existsSync(file)) throw new Error(`task file not found: ${file}`);
  const dir = path.dirname(file);
  const text = fs.readFileSync(file, "utf8");
  const raw = YAML.parse(text) ?? {};

  const req = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`${file}: ${msg}`);
  };
  req(typeof raw.prompt === "string" && raw.prompt.trim(), "`prompt` is required");

  const ws = raw.workspace ?? {};
  const workspace = {
    path: ws.path ? path.resolve(dir, ws.path) : ws.repo ? undefined : path.join(dir, "workspace"),
    repo: ws.repo ? path.resolve(dir, ws.repo) : undefined,
    commit: ws.commit,
  };
  if (workspace.path) req(fs.existsSync(workspace.path), `workspace path does not exist: ${workspace.path}`);
  if (workspace.repo) req(fs.existsSync(path.join(workspace.repo, ".git")), `workspace.repo is not a git repo: ${workspace.repo}`);

  const checks: Check[] = (raw.checks ?? []).map((c: Partial<Check>, i: number) => ({
    id: c.id ?? `check-${i + 1}`,
    cmd: String(c.cmd ?? ""),
    weight: Number(c.weight ?? 1),
    kind: c.kind ?? "test",
  }));
  for (const c of checks) req(c.cmd, `check ${c.id} has no cmd`);

  const rubric = raw.rubric ?? "quick-pairwise";
  req(requireRubric(rubric), `unknown rubric "${rubric}". Known: ${listRubrics().map((r) => r.id).join(", ")}`);

  // Hash the task definition plus the workspace contents, so a result can be tied to exactly what was run.
  const hash = crypto.createHash("sha256").update(text);
  if (workspace.path) hashDir(workspace.path, hash);
  if (workspace.repo) hash.update(`${workspace.repo}@${workspace.commit ?? "HEAD"}`);

  return {
    id: raw.id ?? path.basename(dir),
    title: raw.title ?? raw.id ?? path.basename(dir),
    contentHash: hash.digest("hex").slice(0, 16),
    dir,
    prompt: raw.prompt.trim(),
    workspace,
    env: {
      image: raw.env?.image ?? "node:22-bookworm-slim",
      setup: raw.env?.setup,
      network: raw.env?.network === "open" ? "open" : "none",
    },
    limits: {
      wallClockSec: Number(raw.limits?.wallClockSec ?? 600),
      maxTokens: raw.limits?.maxTokens,
      maxCostUsd: raw.limits?.maxCostUsd,
      maxToolCalls: raw.limits?.maxToolCalls ?? 60,
      maxTurns: raw.limits?.maxTurns ?? 40,
    },
    checks,
    tags: (raw.tags ?? []).map(String),
    rubric,
    scopeGlobs: raw.scopeGlobs,
  };
}

const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", "build"]);

function hashDir(dir: string, hash: crypto.Hash, rel = ""): void {
  for (const name of fs.readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (fs.statSync(full).isDirectory()) hashDir(full, hash, r);
    else hash.update(r).update(fs.readFileSync(full));
  }
}

export interface TaskSummary {
  path: string;
  id: string;
  title: string;
  tags: string[];
  rubric: string;
  source: string; // where the workspace comes from, for display
  checks: number;
  error?: string;
}

/** List tasks under a directory. Reads only the YAML (no workspace hashing), so it stays fast for big repos. */
export function listTasks(root: string): TaskSummary[] {
  if (!fs.existsSync(root)) return [];
  const out: TaskSummary[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    const file = path.join(dir, TASK_FILE);
    if (!fs.existsSync(file)) continue;
    try {
      const raw = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
      const ws = raw.workspace ?? {};
      out.push({
        path: dir,
        id: raw.id ?? name,
        title: raw.title ?? raw.id ?? name,
        tags: (raw.tags ?? []).map(String),
        rubric: raw.rubric ?? "quick-pairwise",
        source: ws.repo ? `${ws.repo}${ws.commit ? ` @ ${String(ws.commit).slice(0, 10)}` : ""}` : ws.path ?? "workspace/ (bundled)",
        checks: (raw.checks ?? []).length,
      });
    } catch (err) {
      out.push({ path: dir, id: name, title: name, tags: [], rubric: "", source: "", checks: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export interface TaskInput {
  id?: string;
  title: string;
  prompt: string;
  source: string; // folder on disk: a git repo (pinned to its current commit) or a plain folder (copied per run)
  tags?: string[];
  rubric?: string;
  checks?: { id?: string; cmd: string; kind?: Check["kind"]; weight?: number }[];
  setup?: string;
  image?: string;
  network?: "none" | "open";
  limits?: Partial<TaskBundle["limits"]>;
  scopeGlobs?: string[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";

/**
 * Create or overwrite a task in the data dir. A git repo is pinned to its current HEAD, so every run
 * (now and later) starts from the same commit; uncommitted changes are NOT included, and a warning says so.
 */
export async function saveTask(input: TaskInput, root: string, opts: { overwrite?: boolean } = {}): Promise<{ task: TaskSummary; warnings: string[] }> {
  const warnings: string[] = [];
  if (!input.title?.trim()) throw new Error("title is required");
  if (!input.prompt?.trim()) throw new Error("prompt is required");
  const source = path.resolve(resolveHome(input.source ?? ""));
  if (!input.source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`source folder not found: ${input.source}`);
  const rubric = input.rubric ?? "quick-pairwise";
  if (!getRubric(rubric)) throw new Error(`unknown rubric "${rubric}"`);

  const id = input.id ? slug(input.id) : slug(input.title);
  const dir = path.join(root, id);
  if (fs.existsSync(dir) && !opts.overwrite) throw new Error(`a task with id "${id}" already exists`);

  let workspace: Record<string, string>;
  if (fs.existsSync(path.join(source, ".git"))) {
    const { git } = await import("./sandbox/exec.ts");
    const commit = (await git(source, ["rev-parse", "HEAD"])).trim();
    const dirty = (await git(source, ["status", "--porcelain"])).trim();
    if (dirty) warnings.push("The repo has uncommitted changes. Runs start from the last commit, so those changes are not included.");
    workspace = { repo: source, commit };
  } else {
    workspace = { path: source };
    warnings.push("Not a git repo: the folder is copied as-is for every run, so later edits to it change the task. Consider committing it to git.");
  }

  const doc: Record<string, unknown> = {
    id,
    title: input.title.trim(),
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
    prompt: input.prompt.trim() + "\n",
    rubric,
    workspace,
    env: { image: input.image || "node:22-bookworm-slim", network: input.network ?? "none", ...(input.setup ? { setup: input.setup } : {}) },
    limits: {
      wallClockSec: input.limits?.wallClockSec ?? 600,
      ...(input.limits?.maxCostUsd ? { maxCostUsd: input.limits.maxCostUsd } : {}),
      ...(input.limits?.maxTokens ? { maxTokens: input.limits.maxTokens } : {}),
      maxToolCalls: input.limits?.maxToolCalls ?? 60,
    },
    checks: (input.checks ?? []).filter((c) => c.cmd?.trim()).map((c, i) => ({ id: c.id || `check-${i + 1}`, kind: c.kind ?? "test", cmd: c.cmd.trim(), weight: c.weight ?? 1 })),
    ...(input.scopeGlobs?.length ? { scopeGlobs: input.scopeGlobs } : {}),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, TASK_FILE), YAML.stringify(doc, { lineWidth: 0 }));
  loadTask(dir); // validate what we wrote
  return { task: listTasks(root).find((t) => t.path === dir)!, warnings };
}

/** Raw editable fields of a task, for the edit form. */
export function readTaskInput(dir: string): TaskInput & { id: string } {
  const raw = YAML.parse(fs.readFileSync(path.join(dir, TASK_FILE), "utf8")) ?? {};
  const ws = raw.workspace ?? {};
  return {
    id: raw.id ?? path.basename(dir),
    title: raw.title ?? "",
    prompt: raw.prompt ?? "",
    source: ws.repo ? path.resolve(dir, ws.repo) : path.resolve(dir, ws.path ?? "workspace"),
    tags: raw.tags ?? [],
    rubric: raw.rubric ?? "quick-pairwise",
    checks: raw.checks ?? [],
    setup: raw.env?.setup,
    image: raw.env?.image,
    network: raw.env?.network,
    limits: raw.limits ?? {},
    scopeGlobs: raw.scopeGlobs ?? [],
  };
}

/** Delete a task definition. Only the task folder inside the data dir is removed, never the source repo. */
export function deleteTask(id: string, root: string): void {
  const dir = path.resolve(root, id);
  if (path.dirname(dir) !== path.resolve(root)) throw new Error("invalid task id");
  if (!fs.existsSync(path.join(dir, TASK_FILE))) throw new Error(`no task "${id}"`);
  fs.rmSync(dir, { recursive: true, force: true });
}

function resolveHome(p: string): string {
  return p.replace(/^~(?=$|[\/])/, os.homedir());
}
