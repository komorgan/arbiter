// A local Managed-mode workspace for trying Arbiter as an evaluation team: `npm run test-workspace`.
//
// First run: starts an Arbiter server on http://localhost:8095 with its own data dir (~/.arbiter-test-workspace),
// creates an admin and two annotator accounts, a project with a qualification test, and runs a small batch of mock
// contestants to review. Account details go to CREDENTIALS.txt in the data dir (never printed).
// Later runs: just start the server again with the same data. Ctrl+C stops it. Delete the data dir to start over.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 8095 by default (8090 is often taken by other software); override with ARBITER_TEST_PORT.
const PORT = Number(process.env.ARBITER_TEST_PORT ?? 8095);
const HOME = path.join(os.homedir(), ".arbiter-test-workspace");
const CREDS = path.join(HOME, "CREDENTIALS.txt");
const BASE = `http://localhost:${PORT}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const firstRun = !fs.existsSync(CREDS);

const server = spawn(process.execPath, ["--no-warnings", "--import", "tsx", "src/cli.ts", "server", "--port", String(PORT), "--home", HOME], {
  cwd: root,
  stdio: ["ignore", "pipe", "inherit"],
});
let out = "";
server.stdout.on("data", (d) => {
  out += d;
  process.stdout.write(d);
});
server.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => server.kill());

// Wait for the server to print its banner.
while (!out.includes("annotators:")) await new Promise((r) => setTimeout(r, 300));

if (!firstRun) {
  console.log(`\nTest workspace is running at ${BASE}. Accounts: ${CREDS}`);
} else {
  try {
    await seed();
  } catch (err) {
    console.error(`\nSetting up the test workspace failed: ${err.message}`);
    server.kill();
  }
}

function client() {
  let cookie = "";
  return async (p, method = "GET", body) => {
    const r = await fetch(`${BASE}/api/${p}`, {
      method,
      headers: { "content-type": "application/json", "x-arbiter": "1", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${p}: ${data?.error ?? r.status}`);
    return data;
  };
}

async function seed() {
  const code = out.match(/one-time code:\s+(\S+)/)?.[1];
  if (!code) throw new Error("no setup code in the server output (is this data dir already set up? delete it to start over)");
  const pw = () => crypto.randomBytes(9).toString("base64url");
  const accounts = [
    { role: "admin", name: "Test Admin", email: "admin@workspace.test", password: pw() },
    { role: "annotator", name: "Annie Annotator", email: "annie@workspace.test", password: pw() },
    { role: "annotator", name: "Ben Annotator", email: "ben@workspace.test", password: pw() },
  ];

  const admin = client();
  await admin("auth/setup", "POST", { code, ...accounts[0] });
  console.log("\n[test workspace] admin account created");

  const project = await admin("admin/projects", "POST", {
    name: "Test workspace: fix-sum",
    instructions:
      "Compare the two results for the task shown.\n\n" +
      "1. Correctness first: do the tests pass, and does the code do what the task asked?\n" +
      "2. Then scope: changes to unrelated files count against a result.\n" +
      "3. Pick Tie only when the results are genuinely equivalent.",
    rubric: "detailed-pairwise",
    reviewsPerComparison: 2,
    goldShare: 0.2,
    showMetrics: true,
    showTranscript: true,
    qualRequired: 1,
    qualPass: 1,
    requireDesktop: true, // reviews only in the desktop app's protected window
    status: "active",
  });
  console.log(`[test workspace] project created; running a batch of mock contestants (${(await admin("settings")).docker ? "Docker sandbox" : "local sandbox"})…`);

  const cat = await admin("admin/catalog");
  const task = cat.tasks.find((t) => t.id === "fix-sum") ?? cat.tasks[0];
  await admin(`admin/projects/${project.id}/batches`, "POST", { taskPaths: [task.path], contestantIds: ["mock-alpha", "mock-beta"], repeats: 5 });
  for (let i = 0; i < 150; i++) {
    const d = await admin(`admin/projects/${project.id}`);
    if (d.batches.every((b) => b.status !== "running")) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const comps = await admin(`admin/projects/${project.id}/comparisons`);
  if (comps.length < 3) throw new Error(`only ${comps.length} comparisons were produced; check the batch on the dashboard`);
  // Mock Alpha always passes the tests and Mock Beta never does, so known answers are easy to set.
  const alphaSide = (c) => (c.a.contestant === "Mock Alpha" ? "A" : "B");
  await admin(`admin/comparisons/${comps[0].id}/gold`, "PUT", {
    expected: alphaSide(comps[0]),
    qual: true,
    note: "Only this side passes the tests: the other returns 0 for an empty array (the task asks for NaN) and adds an unrelated NOTES.md.",
  });
  await admin(`admin/comparisons/${comps[1].id}/gold`, "PUT", { expected: alphaSide(comps[1]), note: "Passes the tests; the other side doesn't." });
  console.log(`[test workspace] ${comps.length} comparisons ready (1 qualification item, 1 gold)`);

  for (const a of accounts.slice(1)) {
    const inv = await admin("admin/invites", "POST", { email: a.email, role: a.role, projectIds: [project.id] });
    await client()("auth/redeem", "POST", { code: inv.code, name: a.name, password: a.password });
  }
  console.log("[test workspace] annotator accounts created");

  fs.writeFileSync(
    CREDS,
    [
      "Arbiter test workspace: local test accounts (not real credentials; this server only listens on localhost).",
      "",
      `Admin dashboard:   ${BASE}/`,
      `Annotator client:  ${BASE}/annotate   (or the desktop app: Managed workspaces > add ${BASE} > Open)`,
      "",
      ...accounts.map((a) => `${a.role.padEnd(10)} ${a.email.padEnd(24)} ${a.password}`),
      "",
      "Delete this folder to reset the workspace.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  console.log(`\nTest workspace is running at ${BASE}. Accounts are in ${CREDS}. Ctrl+C stops the server.`);
}
