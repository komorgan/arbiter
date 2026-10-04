import type { TaskBundle } from "../types.ts";
import { run, type ExecResult } from "./exec.ts";

/**
 * A sandbox owns one contestant's copy of the workspace. File tools operate on `root` (a host path),
 * and commands run through `exec`, which is where isolation differs between backends.
 */
export interface Sandbox {
  kind: "docker" | "local";
  root: string; // host path of the workspace
  cwdLabel: string; // how the workspace path appears to the agent
  exec(cmd: string, timeoutSec: number): Promise<ExecResult>;
  dispose(): Promise<void>;
}

export type SandboxPreference = "auto" | "docker" | "local";

// Re-checked at most every 30s, so a long-running process notices Docker starting or stopping.
let dockerCheck: { ok: boolean; at: number } | undefined;

export async function detectDocker(): Promise<boolean> {
  if (!dockerCheck || Date.now() - dockerCheck.at > 30_000) {
    const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutSec: 10, env: process.env });
    dockerCheck = { ok: r.exitCode === 0, at: Date.now() };
  }
  return dockerCheck.ok;
}

/**
 * Whether the unisolated "local" sandbox may be used in this process. Personal mode allows it (the user runs their
 * own models on their own machine). A Managed server forbids it by default: agent commands would run next to the
 * server's key vault and database.
 */
let localAllowed = true;
export function setLocalSandboxAllowed(allowed: boolean): void {
  localAllowed = allowed;
}
export const localSandboxAllowed = () => localAllowed;

const LOCAL_FORBIDDEN = "This server only runs agents in Docker containers (the local sandbox would expose the server's keys and data). Start Docker on the server, or restart it with --allow-local-sandbox for testing.";

export async function resolveSandboxKind(pref: SandboxPreference): Promise<"docker" | "local"> {
  if (pref === "local") {
    if (!localAllowed) throw new Error(LOCAL_FORBIDDEN);
    return "local";
  }
  const ok = await detectDocker();
  if (ok) return "docker";
  if (pref === "docker" || !localAllowed) throw new Error(localAllowed ? "Docker was requested but the Docker daemon is not reachable. Start Docker, or pass --sandbox local." : LOCAL_FORBIDDEN);
  return "local";
}

export async function createSandbox(kind: "docker" | "local", root: string, task: TaskBundle, name: string): Promise<Sandbox> {
  // Checked here too: an evaluation created under a looser policy (or before a restart) must not run locally now.
  if (kind === "local" && !localAllowed) throw new Error(LOCAL_FORBIDDEN);
  if (kind === "docker") {
    const { DockerSandbox } = await import("./docker.ts");
    return DockerSandbox.start(root, task, name);
  }
  const { LocalSandbox } = await import("./local.ts");
  return new LocalSandbox(root);
}
