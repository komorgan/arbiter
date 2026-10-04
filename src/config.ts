import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { Contestant } from "./types.ts";

/**
 * Where bundled read-only resources (public/, examples/) live. The CLI runs from the source tree;
 * the desktop app sets ARBITER_RESOURCES because packaged files sit in the app's resources folder.
 */
export function resourceRoot(): string {
  return process.env.ARBITER_RESOURCES ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Personal-mode data directory. Everything Arbiter stores lives here. */
export function arbiterHome(): string {
  return path.resolve(process.env.ARBITER_HOME ?? path.join(os.homedir(), ".arbiter"));
}

export const paths = {
  db: () => path.join(arbiterHome(), "arbiter.db"),
  runs: () => path.join(arbiterHome(), "runs"),
  contestants: () => path.join(arbiterHome(), "contestants.yaml"),
  tasks: () => path.join(arbiterHome(), "tasks"),
  secrets: () => path.join(arbiterHome(), "secrets.json"),
  rubrics: () => path.join(arbiterHome(), "rubrics.json"),
};

export function ensureHome(): void {
  fs.mkdirSync(paths.runs(), { recursive: true });
  fs.mkdirSync(paths.tasks(), { recursive: true });
  if (!fs.existsSync(paths.contestants())) {
    fs.copyFileSync(path.join(resourceRoot(), "examples", "contestants.yaml"), paths.contestants());
  }
  const sample = path.join(paths.tasks(), "fix-sum");
  if (!fs.existsSync(sample)) {
    fs.cpSync(path.join(resourceRoot(), "examples", "tasks", "fix-sum"), sample, { recursive: true });
  }
}

const PROVIDERS = ["anthropic", "openai-compatible", "mock"] as const;

/** Validate one contestant spec. Throws with a readable message. */
export function validateContestant(c: Partial<Contestant>): Contestant {
  if (!c || typeof c !== "object") throw new Error("contestant must be an object");
  if (!c.id || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(c.id)) throw new Error(`invalid contestant id "${c.id ?? ""}": use letters, digits, . _ -`);
  if (!c.displayName?.trim()) throw new Error(`contestant ${c.id}: displayName is required`);
  if (!PROVIDERS.includes(c.provider as (typeof PROVIDERS)[number])) throw new Error(`contestant ${c.id}: provider must be one of ${PROVIDERS.join(", ")}`);
  if (c.provider !== "mock" && !c.model?.trim()) throw new Error(`contestant ${c.id}: model is required`);
  if (c.params !== undefined && (typeof c.params !== "object" || Array.isArray(c.params))) throw new Error(`contestant ${c.id}: params must be an object`);
  return {
    id: c.id,
    displayName: c.displayName.trim(),
    provider: c.provider!,
    adapter: c.provider === "mock" ? "mock" : "api-agent",
    ...(c.model ? { model: c.model.trim() } : {}),
    ...(c.params && Object.keys(c.params).length ? { params: c.params } : {}),
  };
}

export function loadContestants(): Contestant[] {
  const raw = YAML.parse(fs.readFileSync(paths.contestants(), "utf8")) as { contestants?: Contestant[] };
  const list = (raw?.contestants ?? []).map(validateContestant);
  const seen = new Set<string>();
  for (const c of list) {
    if (seen.has(c.id)) throw new Error(`duplicate contestant id: ${c.id}`);
    seen.add(c.id);
  }
  return list;
}

const CONTESTANTS_HEADER = `# Arbiter contestants. Edited by the app; hand edits are fine too.
# Each run snapshots the contestant spec, so editing this file never rewrites past results.
# provider: anthropic | openai-compatible | mock   (see README for params)
`;

/** Replace the contestant list. Validates everything before writing anything. */
export function saveContestants(list: Partial<Contestant>[]): Contestant[] {
  const clean = list.map(validateContestant);
  const ids = new Set<string>();
  for (const c of clean) {
    if (ids.has(c.id)) throw new Error(`duplicate contestant id: ${c.id}`);
    ids.add(c.id);
  }
  const file = paths.contestants();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, CONTESTANTS_HEADER + YAML.stringify({ contestants: clean.map(({ adapter, ...rest }) => rest) }));
  fs.renameSync(tmp, file);
  return clean;
}

export function getContestants(ids: string[]): Contestant[] {
  const all = loadContestants();
  return ids.map((id) => {
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error(`unknown contestant "${id}". Known: ${all.map((x) => x.id).join(", ")}`);
    return c;
  });
}
