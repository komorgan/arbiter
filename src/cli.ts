import os from "node:os";
import path from "node:path";
import { arbiterHome, ensureHome, loadContestants, paths } from "./config.ts";
import { ensureSetupCode } from "./managed/auth.ts";
import { managedDb } from "./managed/db.ts";
import { createVault } from "./managed/vault.ts";
import { installSecretBackend } from "./secrets.ts";
import { createEvaluation, executeEvaluation, recoverInterrupted } from "./runner.ts";
import { setLocalSandboxAllowed, type SandboxPreference } from "./sandbox/index.ts";
import { serve } from "./server.ts";
import { listTasks } from "./task.ts";
import { evaluationDetail, listEvaluations, ratingsView } from "./views.ts";

const HELP = `arbiter — blind A/B evaluation of AI coding models

Usage:
  arbiter init                                   Create the data dir (${arbiterHome()}) with sample contestants and a task
  arbiter contestants                            List configured contestants (edit contestants.yaml to add more)
  arbiter tasks                                  List tasks in the data dir
  arbiter run <task> --contestants a,b[,c]       Run contestants on a task (folder or task name), then queue blind reviews
        [--repeats N] [--sandbox auto|docker|local]
  arbiter list                                   List evaluations
  arbiter ratings [--tag T]                      Show ratings from submitted reviews
  arbiter serve [--port 4173]                    Start the review UI at http://localhost:4173

Managed mode (for evaluation teams):
  arbiter server [--port 8080] [--host 127.0.0.1] [--public-url https://arbiter.example.com]
        [--allow-host name,...] [--trust-proxy] [--allow-local-sandbox]
                                                 Run the Managed server: admin dashboard at /, annotators at /annotate.
                                                 Data dir defaults to ~/.arbiter-server. Put it behind HTTPS.

Any command accepts --home <dir> to use a different data dir.
Environment: ARBITER_HOME (data dir), ANTHROPIC_API_KEY, OPENAI_API_KEY (or per-contestant apiKeyEnv).`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return console.log("(none)");
  const cols = Object.keys(rows[0]);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i])).join("  ");
  console.log(line(cols));
  console.log(line(width.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ""))));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(HELP);
  const home = flag(args, "home");
  if (home) process.env.ARBITER_HOME = home;
  // A Managed server keeps its data apart from the personal data dir.
  else if (cmd === "server" && !process.env.ARBITER_HOME) process.env.ARBITER_HOME = path.join(os.homedir(), ".arbiter-server");
  ensureHome();

  switch (cmd) {
    case "init":
      console.log(`Data dir ready: ${arbiterHome()}\n  contestants: ${paths.contestants()}\n  tasks:       ${paths.tasks()}`);
      return;
    case "contestants":
      return table(loadContestants().map((c) => ({ id: c.id, name: c.displayName, provider: c.provider, model: c.model ?? "" })));
    case "tasks":
      return table(listTasks(paths.tasks()).map((t) => ({ id: t.id, title: t.title, tags: t.tags.join(","), path: t.path })));
    case "run": {
      const taskPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
      const contestants = flag(args, "contestants")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      if (!taskPath || contestants.length < 2) throw new Error("usage: arbiter run <task-dir> --contestants a,b");
      const id = await createEvaluation({
        taskPath,
        contestantIds: contestants,
        repeats: Number(flag(args, "repeats") ?? 1),
        sandbox: (flag(args, "sandbox") as SandboxPreference) ?? "auto",
      });
      const ev = evaluationDetail(id)!;
      console.log(`evaluation ${id}: "${ev.title}", ${ev.runs.length} runs, sandbox=${ev.sandbox}`);
      if (ev.sandbox === "local") console.log("warning: local sandbox — agent commands run directly on this machine without isolation.");
      await executeEvaluation(id, (m) => console.log(`  ${m}`));
      const done = evaluationDetail(id)!;
      console.log(`\n${done.assignments.length} blind comparison(s) queued. Review them with:\n  npm run serve   →  http://localhost:4173/#/eval/${id}`);
      return;
    }
    case "list":
      return table(
        listEvaluations().map((e) => ({
          id: e.id, created: e.createdAt.slice(0, 16).replace("T", " "), task: e.title, status: e.status,
          runs: `${e.runs.done}/${e.runs.total}`, reviewed: `${e.reviews.submitted}/${e.reviews.total}`,
        })),
      );
    case "ratings": {
      const r = ratingsView(flag(args, "tag"));
      console.log(`${r.comparisons} comparison(s)${r.tag ? ` tagged "${r.tag}"` : ""}`);
      return table(
        r.ratings.map((x) => ({
          contestant: x.name, rating: x.rating.toFixed(0), "95% CI": `${x.ciLow.toFixed(0)}–${x.ciHigh.toFixed(0)}`,
          "W-L-T": `${x.wins}-${x.losses}-${x.ties}`, "avg cost": x.avgCostUsd == null ? "?" : `$${x.avgCostUsd.toFixed(3)}`,
          checks: x.avgCheckScore == null ? "" : `${(x.avgCheckScore * 100).toFixed(0)}%`, note: x.provisional ? "provisional" : "",
        })),
      );
    }
    case "serve": {
      const port = Number(flag(args, "port") ?? 4173);
      const { port: bound } = await serve({ port });
      console.log(`Arbiter review UI: http://localhost:${bound}   (data: ${arbiterHome()})`);
      await recoverInterrupted((m) => console.log(`  ${m}`));
      return;
    }
    case "server": {
      // Every option can also come from the environment (handy in containers); flags win.
      const env = process.env;
      const port = Number(flag(args, "port") ?? env.ARBITER_PORT ?? 8080);
      const host = flag(args, "host") ?? env.ARBITER_HOST ?? "127.0.0.1";
      const publicUrl = (flag(args, "public-url") ?? env.ARBITER_PUBLIC_URL)?.replace(/\/+$/, "") || undefined;
      const allowedHosts = [
        ...(publicUrl ? [new URL(publicUrl).hostname] : []),
        ...((flag(args, "allow-host") ?? env.ARBITER_ALLOW_HOSTS)?.split(",").map((h) => h.trim()).filter(Boolean) ?? []),
      ];
      const truthy = (v: string | undefined) => v === "1" || v === "true";
      const trustProxy = args.includes("--trust-proxy") || truthy(env.ARBITER_TRUST_PROXY);
      const allowLocal = args.includes("--allow-local-sandbox") || truthy(env.ARBITER_ALLOW_LOCAL_SANDBOX);
      setLocalSandboxAllowed(allowLocal);
      managedDb();
      const vault = createVault();
      installSecretBackend(vault.backend);
      const { port: bound } = await serve({
        port,
        host,
        appInfo: { version: "server", desktop: false },
        managed: { publicUrl, allowedHosts, secureCookies: !!publicUrl?.startsWith("https://"), trustProxy, vaultKeySource: vault.keySource },
      });
      console.log(`Arbiter Managed server on http://${host}:${bound}${publicUrl ? `  (public: ${publicUrl})` : ""}`);
      console.log(`  data: ${arbiterHome()}`);
      console.log(`  admin dashboard: ${publicUrl ?? `http://localhost:${bound}`}/    annotators: ${publicUrl ?? `http://localhost:${bound}`}/annotate`);
      if (allowLocal) console.log("  WARNING: --allow-local-sandbox: agent commands may run unisolated on this server. Use only for testing with mock contestants.");
      if (vault.keySource === "file") console.log("  note: API keys are encrypted with a key file in the data dir. Set ARBITER_MASTER_KEY to keep the key elsewhere.");
      if (host !== "127.0.0.1" && host !== "localhost" && !publicUrl?.startsWith("https://")) {
        console.log("  WARNING: listening beyond this machine without an https public URL. Passwords and review data would travel unencrypted. Put a TLS proxy in front and pass --public-url https://...");
      }
      const code = ensureSetupCode();
      if (code) console.log(`
  First-time setup: open the dashboard and create the admin account with this one-time code:

      ${code}
`);
      await recoverInterrupted((m) => console.log(`  ${m}`));
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}". Run "arbiter help".`);
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
