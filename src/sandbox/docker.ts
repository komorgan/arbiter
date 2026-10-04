import type { TaskBundle } from "../types.ts";
import type { Sandbox } from "./index.ts";
import { run } from "./exec.ts";

/**
 * One long-lived container per contestant, with the workspace bind-mounted at /workspace.
 * No network by default, all capabilities dropped, bounded CPU/memory/pids. Model API calls
 * happen in the orchestrator on the host, so API keys never enter the container.
 */
export class DockerSandbox implements Sandbox {
  kind = "docker" as const;
  cwdLabel = "/workspace";
  private constructor(
    public root: string,
    private container: string,
  ) {}

  static async start(root: string, task: TaskBundle, name: string): Promise<DockerSandbox> {
    const container = `arbiter-${name}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
    const args = [
      "run", "-d", "--rm",
      "--name", container,
      "--network", task.env.network === "open" ? "bridge" : "none",
      "--cpus", "2", "--memory", "2g", "--pids-limit", "512",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      // On Linux, run as the server's own user: files the agent creates in the bind-mounted workspace then belong
      // to us (not root), so we can clean them up. Docker Desktop (Windows/macOS) maps ownership itself.
      ...(typeof process.getuid === "function" && process.getuid() !== 0
        ? ["--user", `${process.getuid()}:${process.getgid!()}`, "-e", "HOME=/tmp"]
        : []),
      "-v", `${root}:/workspace`, "-w", "/workspace",
      task.env.image, "sleep", "infinity",
    ];
    const r = await run("docker", args, { timeoutSec: 300, env: process.env });
    if (r.exitCode !== 0) throw new Error(`docker run failed: ${r.stderr || r.stdout}`);
    return new DockerSandbox(root, container);
  }

  exec(cmd: string, timeoutSec: number) {
    // `timeout` inside the container stops the command even if the docker client is killed.
    return run("docker", ["exec", this.container, "timeout", "-k", "5", String(timeoutSec), "sh", "-c", cmd], {
      timeoutSec: timeoutSec + 15,
      env: process.env,
    });
  }

  async dispose(): Promise<void> {
    await run("docker", ["rm", "-f", this.container], { timeoutSec: 60, env: process.env });
  }
}
