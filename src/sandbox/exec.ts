import { spawn, execFile } from "node:child_process";

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationSec: number;
}

const MAX_CAPTURE = 200_000;

/** Environment for anything the agent can run: drop credentials so they never reach sandboxed code. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** Run a command (argv form, no shell) with a timeout, capturing bounded output. */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutSec: number; env?: NodeJS.ProcessEnv; shell?: boolean },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? scrubbedEnv(),
      shell: opts.shell ?? false,
      windowsHide: true,
      // Own process group on POSIX so a timeout can kill the whole tree.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, d: Buffer) => (s.length < MAX_CAPTURE ? s + d.toString("utf8") : s);
    child.stdout.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutSec * 1000);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.slice(0, MAX_CAPTURE),
        stderr: stderr.slice(0, MAX_CAPTURE),
        timedOut,
        durationSec: (Date.now() - started) / 1000,
      });
    };
    child.on("error", (err) => {
      stderr += String(err);
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

/** Run git on the host. Throws on non-zero exit. */
export async function git(cwd: string, args: string[], timeoutSec = 120): Promise<string> {
  const r = await run("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.longpaths=true", ...args], {
    cwd,
    timeoutSec,
    env: process.env,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
