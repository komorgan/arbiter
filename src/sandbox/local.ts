import type { Sandbox } from "./index.ts";
import { run } from "./exec.ts";

/**
 * Runs commands directly on the host, in the workspace copy, with credentials stripped from the env.
 * This is NOT isolation: an agent command can touch anything the user can. It exists so the prototype
 * works without Docker; use it only with models and tasks you trust.
 */
export class LocalSandbox implements Sandbox {
  kind = "local" as const;
  cwdLabel: string;
  constructor(public root: string) {
    this.cwdLabel = root;
  }

  exec(cmd: string, timeoutSec: number) {
    return run(cmd, [], { cwd: this.root, timeoutSec, shell: true });
  }

  async dispose(): Promise<void> {}
}
