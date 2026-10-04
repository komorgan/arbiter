import fs from "node:fs";
import path from "node:path";
import type { Sandbox } from "../sandbox/index.ts";

/** Provider-neutral tool definition (JSON Schema). Each provider maps these to its own wire format. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_files",
    description: "List files under a directory of the workspace, recursively (skips .git and node_modules).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory relative to the workspace root. Default: ." } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the workspace. Optionally a 1-based inclusive line range.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer" },
        end_line: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file in the workspace with the given content.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact, unique occurrence of old_string with new_string in a workspace file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace root and return its exit code and output. No network access.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_sec: { type: "integer", description: "Default 120, max 600." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description: "Call exactly once when the task is complete, with a short summary of what you changed.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

export interface ToolResult {
  output: string;
  isError: boolean;
  finished?: string; // set when the agent called `finish`
}

const MAX_OUTPUT = 16_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

export class ToolRuntime {
  constructor(private sandbox: Sandbox) {}

  /** Resolve a model-supplied path and refuse anything that escapes the workspace. */
  private resolve(p: unknown): string {
    if (typeof p !== "string" || !p) throw new Error("path must be a non-empty string");
    const root = fs.realpathSync(this.sandbox.root);
    const label = this.sandbox.cwdLabel.replace(/\\/g, "/");
    let rel = p.replace(/\\/g, "/");
    if (rel === label || rel.startsWith(`${label}/`)) rel = rel.slice(label.length + 1) || ".";
    const target = path.resolve(root, rel);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escapes the workspace");
    // Guard against symlinks pointing outside: check the nearest existing ancestor.
    let probe = target;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error("path escapes the workspace");
    return target;
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case "list_files": {
          const dir = this.resolve(input.path ?? ".");
          const out: string[] = [];
          const walk = (d: string, rel: string) => {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
              if (out.length >= 500) return;
              if (SKIP_DIRS.has(entry.name)) continue;
              const r = rel ? `${rel}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                out.push(`${r}/`);
                walk(path.join(d, entry.name), r);
              } else out.push(r);
            }
          };
          walk(dir, "");
          return { output: out.join("\n") || "(empty)", isError: false };
        }
        case "read_file": {
          const text = fs.readFileSync(this.resolve(input.path), "utf8");
          if (input.start_line == null && input.end_line == null) return { output: clip(text), isError: false };
          const lines = text.split("\n");
          const a = Math.max(1, Number(input.start_line ?? 1));
          const b = Math.min(lines.length, Number(input.end_line ?? lines.length));
          return { output: clip(lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join("\n")), isError: false };
        }
        case "write_file": {
          if (typeof input.content !== "string") throw new Error("content must be a string");
          const file = this.resolve(input.path);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, input.content);
          return { output: `wrote ${input.content.length} chars to ${input.path}`, isError: false };
        }
        case "edit_file": {
          const file = this.resolve(input.path);
          const { old_string: from, new_string: to } = input;
          if (typeof from !== "string" || typeof to !== "string" || !from) throw new Error("old_string and new_string must be strings; old_string non-empty");
          const text = fs.readFileSync(file, "utf8");
          const count = text.split(from).length - 1;
          if (count !== 1) throw new Error(`old_string must occur exactly once (found ${count})`);
          fs.writeFileSync(file, text.replace(from, () => to));
          return { output: `edited ${input.path}`, isError: false };
        }
        case "run_command": {
          if (typeof input.command !== "string" || !input.command.trim()) throw new Error("command must be a non-empty string");
          const timeout = Math.min(600, Math.max(1, Number(input.timeout_sec ?? 120)));
          const r = await this.sandbox.exec(input.command, timeout);
          const body = [
            `exit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`,
            r.stdout && `--- stdout ---\n${r.stdout}`,
            r.stderr && `--- stderr ---\n${r.stderr}`,
          ].filter(Boolean).join("\n");
          return { output: clip(body), isError: r.exitCode !== 0 };
        }
        case "finish":
          return { output: "ok", isError: false, finished: String(input.summary ?? "") };
        default:
          return { output: `unknown tool: ${name}`, isError: true };
      }
    } catch (err) {
      return { output: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}
