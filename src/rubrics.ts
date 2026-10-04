// Rubrics: typed criteria the Evaluator fills in. Built-in ones ship with Arbiter; custom ones live in the data
// dir (rubrics.json) and are edited in the UI. Exactly one pairwise criterion has id "overall": it decides
// win/loss/tie for ratings. A rubric that reviews have used is locked, so stored answers keep their meaning.

import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.ts";
import { getDb } from "./db.ts";

export type Criterion =
  | { id: string; type: "pairwise"; label: string; scale: 3 | 5 | 7 }
  | { id: string; type: "likert"; label: string; min: 1; max: 5 | 7 } // scored per side
  | { id: string; type: "flag"; label: string } // checkbox per side
  | { id: string; type: "text"; label: string; minChars?: number; required?: boolean };

export interface Rubric {
  id: string;
  name: string;
  description?: string;
  criteria: Criterion[];
}

export const BUILTIN_RUBRICS: Record<string, Rubric> = {
  "quick-pairwise": {
    id: "quick-pairwise",
    name: "Quick pairwise",
    criteria: [
      { id: "overall", type: "pairwise", label: "Which result is better overall?", scale: 7 },
      { id: "notes", type: "text", label: "Notes (optional)" },
    ],
  },
  "code-review": {
    id: "code-review",
    name: "Code review",
    criteria: [
      { id: "overall", type: "pairwise", label: "Which result is better overall?", scale: 7 },
      { id: "correctness", type: "likert", label: "Correctness", min: 1, max: 5 },
      { id: "quality", type: "likert", label: "Code quality", min: 1, max: 5 },
      { id: "instructions", type: "likert", label: "Instruction following", min: 1, max: 5 },
      { id: "scope", type: "likert", label: "Scope discipline (no unrelated changes)", min: 1, max: 5 },
      { id: "broke_behavior", type: "flag", label: "Broke existing behavior" },
      { id: "hallucinated_api", type: "flag", label: "Hallucinated API or file" },
      { id: "justification", type: "text", label: "Justification", minChars: 20, required: true },
    ],
  },
  "detailed-pairwise": {
    id: "detailed-pairwise",
    name: "Detailed pairwise (annotation vendor style)",
    criteria: [
      { id: "correctness", type: "pairwise", label: "Which is more correct?", scale: 7 },
      { id: "quality", type: "pairwise", label: "Which has better code quality?", scale: 7 },
      { id: "instructions", type: "pairwise", label: "Which follows the instructions better?", scale: 7 },
      { id: "scope", type: "pairwise", label: "Which stays better in scope (no unrelated changes)?", scale: 7 },
      { id: "overall", type: "pairwise", label: "Overall, which result is better?", scale: 7 },
      { id: "broke_behavior", type: "flag", label: "Broke existing behavior" },
      { id: "unsafe", type: "flag", label: "Unsafe or destructive action" },
      { id: "justification", type: "text", label: "Justification (explain the overall choice)", minChars: 60, required: true },
    ],
  },
};

// ---------- registry ----------

function readCustom(): Record<string, Rubric> {
  try {
    return JSON.parse(fs.readFileSync(paths.rubrics(), "utf8"));
  } catch {
    return {};
  }
}

function writeCustom(all: Record<string, Rubric>): void {
  fs.writeFileSync(`${paths.rubrics()}.tmp`, JSON.stringify(all, null, 2));
  fs.renameSync(`${paths.rubrics()}.tmp`, paths.rubrics());
}

export function getRubric(id: string): Rubric | undefined {
  return BUILTIN_RUBRICS[id] ?? readCustom()[id];
}

export function requireRubric(id: string): Rubric {
  const r = getRubric(id);
  if (!r) throw new Error(`Unknown rubric "${id}". It may have been deleted.`);
  return r;
}

export interface RubricInfo extends Rubric {
  builtin: boolean;
  locked: boolean; // answers exist that were given against this rubric
  usedBy: string[]; // what refers to it (projects, evaluations, tasks), for display
}

/** Has anyone answered against this rubric? Then its questions can't change. */
function answeredWith(id: string): boolean {
  const db = getDb();
  const personal = db
    .prepare("SELECT 1 FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN evaluations e ON e.id = a.evaluation_id WHERE e.rubric = ? LIMIT 1")
    .get(id);
  if (personal) return true;
  try {
    return !!db.prepare("SELECT 1 FROM reviews r JOIN projects p ON p.id = r.project_id WHERE p.rubric = ? AND r.status = 'submitted' LIMIT 1").get(id);
  } catch {
    return false; // a personal data dir has no Managed tables
  }
}

/** Task files that name this rubric (read as YAML text: a cheap, exact check on the `rubric:` line). */
function tasksUsing(id: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(paths.tasks())) return out;
  for (const name of fs.readdirSync(paths.tasks())) {
    const file = path.join(paths.tasks(), name, "arbiter.task.yaml");
    if (!fs.existsSync(file)) continue;
    const line = fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("rubric:"));
    if (line && line.slice("rubric:".length).trim().replace(/^["']|["']$/g, "") === id) out.push(name);
  }
  return out;
}

function usedBy(id: string): string[] {
  const db = getDb();
  const out: string[] = [];
  const evs = (db.prepare("SELECT COUNT(*) AS n FROM evaluations WHERE rubric = ?").get(id) as { n: number }).n;
  if (evs) out.push(`${evs} evaluation${evs === 1 ? "" : "s"}`);
  try {
    for (const p of db.prepare("SELECT name FROM projects WHERE rubric = ?").all(id) as { name: string }[]) out.push(`project "${p.name}"`);
  } catch {
    // personal data dir
  }
  for (const t of tasksUsing(id)) out.push(`task "${t}"`);
  return out;
}

export function listRubrics(): RubricInfo[] {
  const custom = readCustom();
  return [
    ...Object.values(BUILTIN_RUBRICS).map((r) => ({ ...r, builtin: true, locked: true, usedBy: usedBy(r.id) })),
    ...Object.values(custom)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({ ...r, builtin: false, locked: answeredWith(r.id), usedBy: usedBy(r.id) })),
  ];
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** Check a rubric definition and return a clean copy. Throws with a message a person can act on. */
export function validateRubric(input: unknown): Rubric {
  const r = (input ?? {}) as Partial<Rubric>;
  const name = String(r.name ?? "").trim();
  if (!name) throw new Error("Give the rubric a name");
  const id = String(r.id ?? "").trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  if (!SLUG.test(id)) throw new Error("Rubric id: lowercase letters, digits, - and _");
  if (!Array.isArray(r.criteria) || r.criteria.length === 0) throw new Error("Add at least one question");
  if (r.criteria.length > 30) throw new Error("At most 30 questions");
  const seen = new Set<string>();
  const criteria: Criterion[] = r.criteria.map((c, i) => {
    const label = String(c?.label ?? "").trim().slice(0, 300);
    if (!label) throw new Error(`Question ${i + 1} needs a label`);
    const cid = String(c?.id ?? "").trim();
    if (!SLUG.test(cid)) throw new Error(`"${label}": its id must be lowercase letters, digits, - and _`);
    if (seen.has(cid)) throw new Error(`Two questions share the id "${cid}"`);
    seen.add(cid);
    switch (c.type) {
      case "pairwise": {
        const scale = Number((c as { scale?: number }).scale ?? 7);
        if (scale !== 3 && scale !== 5 && scale !== 7) throw new Error(`"${label}": the scale must be 3, 5 or 7 points`);
        return { id: cid, type: "pairwise", label, scale };
      }
      case "likert": {
        const max = Number((c as { max?: number }).max ?? 5);
        if (max !== 5 && max !== 7) throw new Error(`"${label}": scores go up to 5 or 7`);
        return { id: cid, type: "likert", label, min: 1, max };
      }
      case "flag":
        return { id: cid, type: "flag", label };
      case "text": {
        const t = c as { minChars?: number; required?: boolean };
        const minChars = t.minChars ? Math.max(0, Math.min(5000, Math.round(Number(t.minChars)))) : 0;
        return { id: cid, type: "text", label, ...(minChars ? { minChars } : {}), ...(t.required ? { required: true } : {}) };
      }
      default:
        throw new Error(`"${label}": unknown question type`);
    }
  });
  if (!criteria.some((c) => c.id === "overall" && c.type === "pairwise")) {
    throw new Error('A rubric needs a pairwise question with id "overall": it decides who wins each comparison');
  }
  const description = String(r.description ?? "").trim();
  return { id, name: name.slice(0, 120), ...(description ? { description: description.slice(0, 2000) } : {}), criteria };
}

/** Create a custom rubric (existingId omitted) or update one. */
export function saveRubric(input: unknown, existingId?: string): Rubric {
  const rubric = validateRubric(input);
  const all = readCustom();
  if (existingId) {
    if (BUILTIN_RUBRICS[existingId]) throw new Error("Built-in rubrics can't be edited. Duplicate one instead.");
    const cur = all[existingId];
    if (!cur) throw new Error("No such rubric");
    if (rubric.id !== existingId) throw new Error("A rubric's id can't change");
    // Once answered, only wording may change: the questions themselves (ids, types, scales) stay fixed.
    if (answeredWith(existingId)) {
      const shape = (x: Rubric) => JSON.stringify(x.criteria.map(({ label: _label, ...rest }) => rest));
      if (shape(cur) !== shape(rubric)) {
        throw new Error("Reviews already use this rubric, so its questions can't be added, removed or changed. You can still reword them, or duplicate the rubric.");
      }
    }
  } else if (BUILTIN_RUBRICS[rubric.id] || all[rubric.id]) {
    throw new Error(`A rubric with id "${rubric.id}" already exists`);
  }
  all[rubric.id] = rubric;
  writeCustom(all);
  return rubric;
}

export function deleteRubric(id: string): void {
  if (BUILTIN_RUBRICS[id]) throw new Error("Built-in rubrics can't be deleted");
  const all = readCustom();
  if (!all[id]) throw new Error("No such rubric");
  const users = usedBy(id);
  if (users.length) throw new Error(`It's in use by ${users.join(", ")}`);
  delete all[id];
  writeCustom(all);
}

/**
 * Swap sides in a set of answers: pairwise values flip sign, per-side values trade places.
 * Used when a reviewer saw the comparison with left/right flipped.
 */
export function swapSides(rubric: Rubric, answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...answers };
  for (const c of rubric.criteria) {
    const v = answers[c.id];
    if (c.type === "pairwise" && typeof v === "number") out[c.id] = v === 0 ? 0 : -v;
    if ((c.type === "likert" || c.type === "flag") && v && typeof v === "object") {
      const s = v as { A?: unknown; B?: unknown };
      out[c.id] = { A: s.B, B: s.A };
    }
  }
  return out;
}

/** Map an "overall" pairwise answer (-k..k, negative favours A) to an outcome. */
export function outcomeOf(overall: number): "A" | "B" | "tie" {
  return overall < 0 ? "A" : overall > 0 ? "B" : "tie";
}

/** Validate a submission's answers against a rubric. Returns an error message or null. */
export function validateAnswers(rubric: Rubric, answers: Record<string, unknown>): string | null {
  for (const c of rubric.criteria) {
    const v = answers[c.id];
    switch (c.type) {
      case "pairwise": {
        const k = (c.scale - 1) / 2;
        if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > k) return `${c.label}: pick a value`;
        break;
      }
      case "likert": {
        const s = v as { A?: number; B?: number } | undefined;
        for (const side of ["A", "B"] as const) {
          const n = s?.[side];
          if (typeof n !== "number" || n < c.min || n > c.max) return `${c.label}: score both sides`;
        }
        break;
      }
      case "flag":
        break;
      case "text": {
        const t = typeof v === "string" ? v.trim() : "";
        if (c.required && !t) return `${c.label} is required`;
        if (t && c.minChars && t.length < c.minChars) return `${c.label}: at least ${c.minChars} characters`;
        break;
      }
    }
  }
  return null;
}
