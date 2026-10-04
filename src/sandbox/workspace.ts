import fs from "node:fs";
import path from "node:path";
import type { TaskBundle } from "../types.ts";
import { git } from "./exec.ts";

const COPY_SKIP = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const IDENT = ["-c", "user.name=arbiter", "-c", "user.email=arbiter@localhost", "-c", "commit.gpgsign=false"];

// Files that reveal which vendor's agent produced a result. Hidden from the reviewed diff.
export const VENDOR_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".aider*", ".cursor*", ".claude", ".codex", ".gemini"];

/** Materialize the task's workspace at `dest` as a git repo, and return the base commit to diff against. */
export async function prepareWorkspace(task: TaskBundle, dest: string): Promise<string> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (task.workspace.repo) {
    await git(path.dirname(dest), ["clone", "--quiet", "--no-hardlinks", task.workspace.repo, dest]);
    if (task.workspace.commit) await git(dest, ["checkout", "--quiet", "--detach", task.workspace.commit]);
    await git(dest, ["remote", "remove", "origin"]).catch(() => {});
  } else {
    fs.cpSync(task.workspace.path!, dest, {
      recursive: true,
      filter: (src) => !COPY_SKIP.has(path.basename(src)),
    });
    await git(dest, ["init", "--quiet"]);
    await git(dest, ["add", "-A"]);
    await git(dest, [...IDENT, "commit", "--quiet", "--allow-empty", "-m", "arbiter: base"]);
  }
  return (await git(dest, ["rev-parse", "HEAD"])).trim();
}

/** Record post-setup state (e.g. installed deps) as the new base, so setup noise never shows in the diff. */
export async function commitBase(dest: string): Promise<string> {
  await git(dest, ["add", "-A"]);
  await git(dest, [...IDENT, "commit", "--quiet", "--allow-empty", "-m", "arbiter: setup"]);
  return (await git(dest, ["rev-parse", "HEAD"])).trim();
}

export interface DiffResult {
  diff: string;
  files: string[];
  linesAdded: number;
  linesRemoved: number;
}

/** Diff the working tree against the base commit, excluding vendor-identifying files. */
export async function captureDiff(dest: string, base: string): Promise<DiffResult> {
  // Keep generated junk out of the diff without touching the repo's own .gitignore.
  fs.appendFileSync(path.join(dest, ".git", "info", "exclude"), "\nnode_modules/\n__pycache__/\n.venv/\n");
  await git(dest, ["add", "-A"]);
  const excludes = VENDOR_FILES.map((f) => `:(exclude,glob)**/${f}`);
  const spec = ["--", ".", ...excludes];
  const diff = await git(dest, ["diff", "--cached", "--no-color", "--no-ext-diff", base, ...spec]);
  const numstat = await git(dest, ["diff", "--cached", "--numstat", base, ...spec]);
  let linesAdded = 0;
  let linesRemoved = 0;
  const files: string[] = [];
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, r, file] = line.split("\t");
    linesAdded += Number(a) || 0;
    linesRemoved += Number(r) || 0;
    files.push(file);
  }
  return { diff, files, linesAdded, linesRemoved };
}

/** Minimal glob matcher for scope checks: supports **, *, ?. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
