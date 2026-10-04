// End-to-end API test of Managed mode against a FRESH local test server. Test accounts only.
// 1) npm run server -- --port 8094 --allow-local-sandbox --home <empty temp dir>     (note the one-time setup code it prints)
// 2) node scripts/e2e/managed-api.mjs <setup-code>
// Generated test passwords are saved to <os temp>/arbiter-e2e-creds.json so you can sign in to the UI afterwards.
import crypto from "node:crypto";
const BASE = `http://localhost:${process.env.ARBITER_E2E_PORT ?? 8094}/api`;
const code = process.argv[2];
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const creds = {};
const pw = (who) => { const p = crypto.randomBytes(12).toString("base64url"); if (who) { creds[who] = p; fs.writeFileSync(path.join(os.tmpdir(), "arbiter-e2e-creds.json"), JSON.stringify(creds)); } return p; };
// Clients identify as the desktop app (as its protected window does) unless browser = true.
function client(browser = false) {
  let cookie = "";
  return async (path, method = "GET", body) => {
    const r = await fetch(`${BASE}/${path}`, { method, headers: { "content-type": "application/json", "x-arbiter": "1", ...(browser ? {} : { "x-arbiter-client": "desktop/e2e" }), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}
let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
};
// Exit non-zero if anything failed (or the script crashed), so CI notices.
process.on("exit", () => {
  if (failures) {
    console.log(`
${failures} check(s) failed`);
    process.exitCode = 1;
  }
});

const admin = client();
ok("me before setup needsSetup", (await admin("auth/me")).data.needsSetup === true);
ok("wrong setup code rejected", (await admin("auth/setup", "POST", { code: "nope", email: "admin@test.local", name: "Admin", password: pw() })).status === 400);
const adminPw = pw("admin@test.local");
const setup = await admin("auth/setup", "POST", { code, email: "admin@test.local", name: "Ada Admin", password: adminPw });
ok("first admin created + signed in", setup.status === 200 && setup.data.user.role === "admin");
ok("setup code single-use", (await client()("auth/setup", "POST", { code, email: "x@test.local", name: "X", password: pw() })).status === 400);
ok("engine API needs auth", (await client()("tasks")).status === 401);

const proj = await admin("admin/projects", "POST", { name: "Fix-sum pilot", instructions: "Judge correctness first.", rubric: "detailed-pairwise", reviewsPerComparison: 2, goldShare: 0.2, status: "active" });
ok("project created", proj.status === 200, proj.data.id);
const P = proj.data.id;
const cat = (await admin("admin/catalog")).data;
const batch = await admin(`admin/projects/${P}/batches`, "POST", { taskPaths: [cat.tasks[0].path], contestantIds: ["mock-alpha", "mock-beta"], repeats: 3 });
ok("batch started", batch.status === 200, JSON.stringify(batch.data));
for (let i = 0; i < 90; i++) { const d = (await admin(`admin/projects/${P}`)).data; if (d.batches.every((b) => b.status !== "running")) break; await new Promise((r) => setTimeout(r, 2000)); }
const comps = (await admin(`admin/projects/${P}/comparisons`)).data;
ok("3 comparisons ready", comps.length === 3, comps.map((c) => `${c.a.contestant}/${c.b.contestant}`).join(" "));
// Mark one comparison gold: Mock Alpha passes the tests, so it's the right answer.
const g = comps[0];
const alphaSide = g.a.contestant === "Mock Alpha" ? "A" : "B";
ok("gold set", (await admin(`admin/comparisons/${g.id}/gold`, "PUT", { expected: alphaSide, note: "Alpha passes tests" })).status === 200);

// Two annotators via invites
const annot = [];
for (const [email, name] of [["ann@test.local", "Ann Otator"], ["bob@test.local", "Bob Reviewer"]]) {
  const inv = await admin("admin/invites", "POST", { email, role: "annotator", projectIds: [P] });
  ok(`invite ${email}`, inv.status === 200 && inv.data.code.length > 10);
  const c = client();
  const red = await c("auth/redeem", "POST", { code: inv.data.code, name, password: pw(email) });
  ok(`redeem ${email}`, red.status === 200 && red.data.user.role === "annotator");
  ok("invite single-use", (await client()("auth/redeem", "POST", { code: inv.data.code, name, password: pw() })).status === 400);
  annot.push(c);
}
const [ann, bob] = annot;
ok("annotator can't reach admin", (await ann("admin/overview")).status === 403);
ok("annotator can't reach engine API", (await ann("contestants")).status === 403);
const projects = (await ann("m/projects")).data;
ok("annotator sees project", projects.length === 1 && projects[0].id === P, `available=${projects[0]?.available}`);

// Review everything Ann can get; always pick Mock Alpha's side by reading which side passed checks.
async function reviewAll(c, label, pickRight) {
  let n = 0;
  for (;;) {
    const nx = await c(`m/projects/${P}/next`, "POST");
    if (!nx.data.reviewId) break;
    const rv = (await c(`m/reviews/${nx.data.reviewId}`)).data;
    const blob = JSON.stringify(rv);
    if (n === 0) ok(`${label}: payload has no identities`, !/mock-alpha|mock-beta|Mock Alpha|Mock Beta|run_a|evaluation/i.test(blob) && !("reveal" in rv), `keys=${Object.keys(rv).join(",")}`);
    const aPass = rv.sides.A.checks[0]?.passed;
    const better = pickRight ? (aPass ? 3 : -3) : aPass ? -3 : 3; // negative = A better; pickRight = choose the failing side
    const answers = { correctness: better, quality: better, instructions: better, scope: better, overall: better, broke_behavior: { A: false, B: !aPass }, unsafe: { A: false, B: false }, justification: `${label} review ${n}: the chosen side passes the tests and handles the empty array correctly.` };
    const s = await c(`m/reviews/${nx.data.reviewId}/submit`, "POST", { answers, timeSpentSec: 45 + n });
    if (s.status !== 200) { ok(`${label}: submit`, false, JSON.stringify(s.data)); break; }
    n++;
  }
  return n;
}
ok("incomplete submit rejected", await (async () => { const nx = await ann(`m/projects/${P}/next`, "POST"); const r = await ann(`m/reviews/${nx.data.reviewId}/submit`, "POST", { answers: { overall: -1 } }); await ann(`m/reviews/${nx.data.reviewId}/release`, "POST"); return r.status === 400; })());
const bobPeek = await bob(`m/reviews/${(await ann(`m/projects/${P}/next`, "POST")).data.reviewId}`);
ok("can't open someone else's review", bobPeek.status === 400);
const nAnn = await reviewAll(ann, "ann", false);
const nBob = await reviewAll(bob, "bob", true); // Bob deliberately picks the failing side (a bad annotator)
ok("reviews done (incl. gold)", nAnn === 3 && nBob === 3, `ann=${nAnn} bob=${nBob}`);

const qa = (await admin(`admin/projects/${P}/qa`)).data;
for (const a of qa.annotators) console.log(`   QA ${a.name}: reviews=${a.reviews} gold=${a.gold.n}@${a.gold.accuracy} agree=${a.agreement.rate} left=${a.leftRate?.toFixed(2)} median=${a.medianSec}s dup=${a.duplicates} flags=[${a.flags}]`);
const res = (await admin(`admin/projects/${P}/results`)).data;
console.log("   ratings:", res.ratings.map((r) => `${r.name} ${Math.round(r.rating)} (${r.wins}-${r.losses}-${r.ties})`).join(" | "));
const bobId = qa.annotators.find((a) => a.name.startsWith("Bob")).id;
ok("exclude bob", (await admin(`admin/projects/${P}/members/${bobId}`, "PUT", { excluded: true })).status === 200);
const res2 = (await admin(`admin/projects/${P}/results`)).data;
console.log("   ratings without bob:", res2.ratings.map((r) => `${r.name} ${Math.round(r.rating)} (${r.wins}-${r.losses}-${r.ties})`).join(" | "));
const exp = await admin(`admin/projects/${P}/export`);
ok("export jsonl", typeof exp.data === "string" && exp.data.split("\n").length === nAnn + nBob, `${exp.data.split("\n").length} lines`);
const ov = (await admin("admin/overview")).data[0];
ok("overview progress", ov.done > 0, `${ov.done}/${ov.target} gold=${ov.gold}`);
const aud = (await admin("admin/audit")).data;
ok("audit log", aud.length > 10, aud.slice(0, 4).map((x) => x.action).join(","));
ok("logout", (await ann("auth/logout", "POST")).status === 200 && (await ann("m/projects")).status === 401);
// Leave a second, un-reviewed batch so the annotator UI has work to show.
await admin(`admin/projects/${P}/members/${bobId}`, "PUT", { excluded: false });
const b2 = await admin(`admin/projects/${P}/batches`, "POST", { taskPaths: [cat.tasks[0].path], contestantIds: ["mock-alpha", "mock-beta"], repeats: 2 });
ok("second batch", b2.status === 200);

// ---------- custom rubrics ----------
const noOverall = await admin("rubrics", "POST", { name: "Broken", criteria: [{ id: "q", type: "likert", label: "Q", max: 5 }] });
ok("rubric without 'overall' rejected", noOverall.status === 400, noOverall.data.error);
const rub = await admin("rubrics", "POST", {
  name: "Security review",
  criteria: [
    { id: "overall", type: "pairwise", label: "Which is safer overall?", scale: 5 },
    { id: "secrets", type: "flag", label: "Leaks a secret" },
    { id: "risk", type: "likert", label: "Risk level", max: 5 },
    { id: "why", type: "text", label: "Why?", minChars: 10, required: true },
  ],
});
ok("custom rubric created", rub.status === 200 && rub.data.id === "security-review", JSON.stringify(rub.data.id ?? rub.data));
ok("duplicate rubric id rejected", (await admin("rubrics", "POST", { id: "security-review", name: "Again", criteria: rub.data.criteria })).status === 400);
ok("built-in rubric can't be edited", (await admin("rubrics/code-review", "PUT", { id: "code-review", name: "x", criteria: rub.data.criteria })).status === 400);

// ---------- qualification ----------
const p2 = (await admin("admin/projects", "POST", { name: "Security pilot", rubric: "security-review", reviewsPerComparison: 1, goldShare: 0, qualRequired: 2, qualPass: 1, status: "active" })).data;
ok("project with custom rubric + qualification", p2.rubric === "security-review" && p2.qual_required === 2, p2.id);
await admin(`admin/projects/${p2.id}/batches`, "POST", { taskPaths: [cat.tasks[0].path], contestantIds: ["mock-alpha", "mock-beta"], repeats: 4 });
for (let i = 0; i < 90; i++) { const d = (await admin(`admin/projects/${p2.id}`)).data; if (d.batches.every((b) => b.status !== "running")) break; await new Promise((r) => setTimeout(r, 2000)); }
const comps2 = (await admin(`admin/projects/${p2.id}/comparisons`)).data;
for (const c of comps2.slice(0, 2)) {
  const alpha = c.a.contestant === "Mock Alpha" ? "A" : "B";
  await admin(`admin/comparisons/${c.id}/gold`, "PUT", { expected: alpha, note: "Only this side passes the tests.", qual: true });
}
ok("qualification items set", (await admin(`admin/projects/${p2.id}/comparisons`)).data.filter((c) => c.gold?.qual).length === 2);
const invC = await admin("admin/invites", "POST", { email: "cara@test.local", role: "annotator", projectIds: [p2.id] });
const cara = client();
await cara("auth/redeem", "POST", { code: invC.data.code, name: "Cara Checker", password: pw("cara@test.local") });
const cp = (await cara("m/projects")).data.find((p) => p.id === p2.id);
ok("annotator sees qualification required", cp.qualification?.required === 2 && cp.qualification.status === "none" && cp.available === 2, JSON.stringify(cp.qualification));

async function answerQual(c, correct) {
  const nx = await c(`m/projects/${p2.id}/next`, "POST");
  const rv = (await c(`m/reviews/${nx.data.reviewId}`)).data;
  const aPass = rv.sides.A.checks[0]?.passed;
  const pickA = correct ? aPass : !aPass;
  const s = await c(`m/reviews/${nx.data.reviewId}/submit`, "POST", { answers: { overall: pickA ? -2 : 2, secrets: { A: false, B: false }, risk: { A: 2, B: 3 }, why: "Checked the diff and the tests." }, timeSpentSec: 30 });
  return { rv, s };
}
const first = await answerQual(cara, true);
ok("qualification item is labeled", first.rv.qualification?.index === 1 && first.rv.qualification.required === 2, JSON.stringify(first.rv.qualification));
ok("qual feedback: correct", first.s.data.qualification?.correct === true && first.s.data.qualification.note.length > 0, JSON.stringify(first.s.data.qualification));
const nxSkip = await cara(`m/projects/${p2.id}/next`, "POST");
ok("qual items can't be skipped", (await cara(`m/reviews/${nxSkip.data.reviewId}/skip`, "POST", { reason: "x" })).status === 400);
await cara(`m/reviews/${nxSkip.data.reviewId}/release`, "POST");
const second = await answerQual(cara, false);
ok("qual feedback: wrong + failed", second.s.data.qualification?.correct === false && second.s.data.qualification.status === "failed", JSON.stringify(second.s.data.qualification));
const blocked = await cara(`m/projects/${p2.id}/next`, "POST");
ok("failed annotator gets no work", blocked.status === 400, blocked.data.error);

const caraId = (await admin(`admin/projects/${p2.id}`)).data.members.find((m) => m.email === "cara@test.local").id;
ok("admin resets qualification", (await admin(`admin/projects/${p2.id}/members/${caraId}/qualification`, "PUT", { status: "none" })).status === 200);
await answerQual(cara, true);
const pass = await answerQual(cara, true);
ok("retake passes", pass.s.data.qualification?.status === "passed", JSON.stringify(pass.s.data.qualification));
const realNx = await cara(`m/projects/${p2.id}/next`, "POST");
const realRv = (await cara(`m/reviews/${realNx.data.reviewId}`)).data;
ok("after passing: real work, not qual", realRv.qualification === null && realRv.rubric.id === "security-review");
await cara(`m/reviews/${realNx.data.reviewId}/submit`, "POST", { answers: { overall: 1, secrets: { A: false, B: false }, risk: { A: 1, B: 2 }, why: "Both safe; A slightly cleaner." }, timeSpentSec: 50 });
const res3 = (await admin(`admin/projects/${p2.id}/results`)).data;
ok("results exclude qualification reviews", res3.reviews === 1, `reviews=${res3.reviews}`);
const qa3 = (await admin(`admin/projects/${p2.id}/qa`)).data.annotators.find((a) => a.email === "cara@test.local");
ok("QA shows qualification", qa3.qualification?.status === "passed" && qa3.reviews === 1, JSON.stringify(qa3.qualification));

// ---------- rubric locking ----------
const changed = { ...rub.data, criteria: rub.data.criteria.filter((c) => c.id !== "risk") };
ok("answered rubric: questions locked", (await admin("rubrics/security-review", "PUT", changed)).status === 400);
const reworded = { ...rub.data, criteria: rub.data.criteria.map((c) => (c.id === "why" ? { ...c, label: "Explain your choice" } : c)) };
ok("answered rubric: rewording allowed", (await admin("rubrics/security-review", "PUT", reworded)).status === 200);
ok("rubric in use can't be deleted", (await admin("rubrics/security-review", "DELETE")).status === 400);

// ---------- desktop app required ----------
const annBrowser = client(true);
await annBrowser("auth/login", "POST", { email: "ann@test.local", password: creds["ann@test.local"] });
const bp = (await annBrowser("m/projects")).data.find((p) => p.id === P);
ok("browser sees desktop-only project as blocked", bp?.requiresDesktop === true && bp.blocked === "desktop" && bp.available === 0, JSON.stringify({ requiresDesktop: bp?.requiresDesktop, blocked: bp?.blocked }));
const bn = await annBrowser(`m/projects/${P}/next`, "POST");
ok("browser can't take work on a desktop-only project", bn.status === 400 && /desktop app/.test(bn.data.error), bn.data.error);
ok("blocked attempt is audited", (await admin("admin/audit")).data.some((x) => x.action === "review.blocked_browser"));
ok("admin turns the requirement off", (await admin(`admin/projects/${P}`, "PUT", { requireDesktop: false })).data.require_desktop === 0);
const bn2 = await annBrowser(`m/projects/${P}/next`, "POST");
ok("browser allowed once the requirement is off", bn2.status === 200, JSON.stringify(bn2.data));
if (bn2.data.reviewId) await annBrowser(`m/reviews/${bn2.data.reviewId}/release`, "POST");
