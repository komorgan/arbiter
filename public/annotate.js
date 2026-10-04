// Managed-mode annotator client. Served by the Arbiter server at /annotate, in a browser or in the desktop app's
// protected window. It holds review content in memory only: nothing about tasks or results is written to storage.
import { api, h, json, onUnauthorized, setView } from "./lib.js";
import { rubricForm, sideView } from "./review.js";

const IDLE_MINUTES = 15;
let me = null;
let current = null; // { reviewId, projectId }
let lastInput = Date.now();
let leaseTimer = null;

// ---------- protections (deterrence; the real control is that data never leaves the server unrendered) ----------

function watermark(text) {
  const el = document.getElementById("watermark");
  const stamp = `${text} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  el.replaceChildren(...Array.from({ length: 60 }, () => h("span", {}, stamp)));
}

document.addEventListener("copy", (e) => {
  const sel = String(document.getSelection() ?? "");
  if (sel.length > 300) {
    e.preventDefault();
    toast("Copying large parts of a review is disabled.");
  }
});
document.addEventListener("contextmenu", (e) => {
  if (current) e.preventDefault();
});
for (const ev of ["mousemove", "keydown", "scroll", "click"]) document.addEventListener(ev, () => (lastInput = Date.now()), { passive: true });
setInterval(() => {
  if (current && Date.now() - lastInput > IDLE_MINUTES * 60_000) pauseForIdle();
}, 30_000);
// Give the comparison back if the window closes mid-review, so it isn't stuck until the lease expires.
window.addEventListener("pagehide", () => {
  if (current) fetch(`/api/m/reviews/${current.reviewId}/release`, { method: "POST", keepalive: true, headers: { "x-arbiter": "1", "content-type": "application/json" } });
});

function toast(text, kind = "") {
  const t = h("div", { class: `toast ${kind}` }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

// ---------- auth ----------

function authView(needsInvite) {
  const email = h("input", { type: "text", autocomplete: "username", placeholder: "you@example.com" });
  const pw = h("input", { type: "password", autocomplete: "current-password" });
  const code = h("input", { type: "text", placeholder: "Invite code", autocomplete: "off", spellcheck: "false" });
  const name = h("input", { type: "text", autocomplete: "name" });
  const newPw = h("input", { type: "password", autocomplete: "new-password", placeholder: "At least 10 characters" });
  const msg = h("div");
  let mode = needsInvite ? "join" : "login";
  const box = h("div", { class: "panel form auth-box" });
  const render = () => {
    box.replaceChildren(
      h("div", { class: "tabs" },
        h("button", { class: mode === "login" ? "active" : "", onclick: () => { mode = "login"; render(); } }, "Sign in"),
        h("button", { class: mode === "join" ? "active" : "", onclick: () => { mode = "join"; render(); } }, "I have an invite")),
      ...(mode === "login"
        ? [h("label", { class: "field" }, h("span", { class: "field-label" }, "Email"), email), h("label", { class: "field" }, h("span", { class: "field-label" }, "Password"), pw)]
        : [
            h("label", { class: "field" }, h("span", { class: "field-label" }, "Invite code"), code),
            h("label", { class: "field" }, h("span", { class: "field-label" }, "Your name"), name),
            h("label", { class: "field" }, h("span", { class: "field-label" }, "Choose a password"), newPw),
          ]),
      h("button", { class: "primary", onclick: submit }, mode === "login" ? "Sign in" : "Create account"),
      msg,
    );
  };
  async function submit() {
    msg.replaceChildren();
    try {
      if (mode === "login") await api("auth/login", json("POST", { email: email.value, password: pw.value }));
      else await api("auth/redeem", json("POST", { code: code.value, name: name.value, password: newPw.value }));
      history.replaceState(null, "", "#/");
      boot();
    } catch (err) {
      msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
    }
  }
  box.addEventListener("keydown", (e) => e.key === "Enter" && e.target.tagName === "INPUT" && submit());
  render();
  setView(h("h1", {}, "Arbiter Review"), h("p", { class: "muted" }, "Sign in to review model outputs for your team."), box);
}

async function signOut() {
  await releaseCurrent();
  await api("auth/logout", json("POST", {})).catch(() => {});
  me = null;
  document.getElementById("watermark").replaceChildren();
  boot();
}

// ---------- home ----------

async function home() {
  await releaseCurrent();
  const projects = await api("m/projects");
  setView(
    h("h1", {}, `Hi ${me.name.split(" ")[0]}`),
    projects.length === 0
      ? h("div", { class: "panel empty" }, "You're not in any active project yet. Your admin will add you.")
      : h("div", { class: "stack" },
          projects.map((p) => {
            const q = p.qualification;
            const testing = q && q.status === "none";
            const line = q?.status === "failed"
              ? "You didn't pass the qualification for this project. Your admin can let you retake it."
              : testing
                ? q.ready
                  ? `Qualification first: ${q.required} practice comparison${q.required === 1 ? "" : "s"} with known answers (${Math.round(q.passMark * 100)}% to pass). You'll see feedback after each one.${q.done ? ` ${q.done} done.` : ""}`
                  : "This project's qualification test isn't ready yet. Check back later."
                : `${p.done} reviewed · ${p.available} available${p.status === "paused" ? " · paused" : ""}`;
            const label = testing ? (q.done ? "Continue qualification" : "Start qualification") : p.done ? "Continue" : "Start reviewing";
            const desktopOnly = p.blocked === "desktop";
            return h("div", { class: "panel" },
              h("div", { class: "row" },
                h("div", {}, h("h3", {}, p.name, q?.status === "passed" && h("span", { class: "badge good", style: "margin-left:8px" }, "qualified")),
                  desktopOnly
                    ? h("div", { class: "small" }, `This project must be reviewed in the Arbiter desktop app. In the app, open Managed workspaces, add ${location.origin}, and sign in there.`)
                    : h("div", { class: `small ${q?.status === "failed" ? "" : "muted"}` }, line)),
                h("span", { class: "spacer" }),
                h("button", { class: "primary", disabled: desktopOnly || p.status !== "active" || p.available === 0 || (testing && !q.ready), onclick: () => startProject(p.id) }, desktopOnly ? "Desktop app only" : label),
              ),
              p.instructions && h("details", { style: "margin-top:8px" }, h("summary", { class: "muted" }, "Instructions"), h("div", { class: "instructions" }, p.instructions)),
            );
          }),
        ),
  );
}

// ---------- reviewing ----------

async function startProject(projectId) {
  try {
    const { reviewId } = await api(`m/projects/${projectId}/next`, json("POST", {}));
    if (!reviewId) {
      current = null;
      toast("Nothing left to review in this project. Thank you!", "good");
      return home();
    }
    current = { reviewId, projectId };
    await showReview();
  } catch (err) {
    current = null;
    setView(h("div", { class: "notice bad" }, err.message), h("p", {}, h("a", { href: "#/", onclick: (e) => { e.preventDefault(); home(); } }, "Back")));
  }
}

async function releaseCurrent() {
  clearInterval(leaseTimer);
  if (!current) return;
  const id = current.reviewId;
  current = null;
  await api(`m/reviews/${id}/release`, json("POST", {})).catch(() => {});
}

async function showReview() {
  const started = Date.now();
  const r = await api(`m/reviews/${current.reviewId}`);
  const countdown = h("span", { class: "muted small" });
  clearInterval(leaseTimer);
  const tick = () => {
    const left = Date.parse(r.leaseExpires) - Date.now();
    if (left <= 0) {
      clearInterval(leaseTimer);
      toast("Time ran out for this comparison; loading another.");
      current = null;
      return startProject(r.project.id);
    }
    const m = Math.floor(left / 60000);
    countdown.textContent = `${m} min left`;
    countdown.className = m < 5 ? "badge warn" : "muted small";
  };
  tick();
  leaseTimer = setInterval(tick, 15_000);

  const reason = h("select", {},
    ["", "The task is unclear", "A result didn't load or is empty", "I don't have the expertise for this", "Conflict of interest", "Other"].map((x) => h("option", { value: x }, x || "Skip because…")));
  const skip = h("button", { onclick: async () => {
    if (!reason.value) return toast("Pick a reason to skip.");
    await api(`m/reviews/${current.reviewId}/skip`, json("POST", { reason: reason.value }));
    current = null;
    startProject(r.project.id);
  } }, "Skip");

  const isQual = !!r.qualification;
  const form = rubricForm(r.rubric, r.guessOptions, async (answers, guess) => {
    const res = await api(`m/reviews/${current.reviewId}/submit`, json("POST", { answers, modelGuess: guess, timeSpentSec: (Date.now() - started) / 1000 }));
    current = null;
    clearInterval(leaseTimer);
    if (res.qualification) return qualFeedback(r.project.id, res.qualification);
    toast("Review submitted.", "good");
    startProject(r.project.id);
  }, { submitLabel: isQual ? "Submit answer" : "Submit and continue", extra: isQual ? [] : [h("span", { class: "spacer" }), reason, skip] });

  const showMetrics = r.sides.A.metrics !== null;
  const showTranscript = r.sides.A.transcript.length > 0 || r.sides.B.transcript.length > 0;
  setView(
    h("div", { class: "row" },
      h("div", {}, h("div", { class: "muted small" }, h("a", { href: "#/", onclick: (e) => { e.preventDefault(); home(); } }, r.project.name)), h("h1", {}, r.task.title)),
      h("span", { class: "spacer" }), countdown),
    isQual && h("div", { class: "notice", style: "margin-bottom:12px" },
      h("b", {}, `Qualification ${r.qualification.index} of ${r.qualification.required}. `),
      `This comparison has a known answer. You'll see whether you got it right, with an explanation, after you submit. ${Math.round(r.qualification.passMark * 100)}% correct is needed to start real work.`),
    r.project.instructions && h("details", { open: isQual || undefined }, h("summary", { class: "muted" }, "Project instructions"), h("div", { class: "instructions", style: "margin-top:8px" }, r.project.instructions)),
    h("details", { open: true }, h("summary", { class: "muted" }, "Task given to both models"), h("pre", { class: "prompt", style: "margin-top:8px" }, r.task.prompt)),
    h("div", { class: "sides", style: "margin-top:16px" },
      sideView("A", r.sides.A, showMetrics, { showTranscript }),
      sideView("B", r.sides.B, showMetrics, { showTranscript })),
    h("div", { style: "margin-top:16px" }, form),
  );
  window.scrollTo(0, 0); // each comparison starts at the top, even though the URL doesn't change
}

/** After each qualification answer: right or wrong, the expected answer and the admin's explanation. */
function qualFeedback(projectId, q) {
  const expected = q.expected === "tie" ? "a tie" : `${q.expected} is better`;
  const finished = q.status === "passed" || q.status === "failed";
  setView(
    h("h1", {}, q.correct ? "Correct" : "Not quite"),
    h("div", { class: `notice ${q.correct ? "good" : "bad"}`, style: "margin-bottom:12px" },
      q.correct ? `You picked the expected answer (${expected}).` : `The expected answer was: ${expected}.`),
    q.note && h("div", { class: "panel", style: "margin-bottom:12px" }, h("h3", {}, "Why"), h("div", { class: "instructions" }, q.note)),
    finished
      ? h("div", { class: `notice ${q.status === "passed" ? "good" : "bad"}` },
          q.status === "passed"
            ? `Qualification passed: ${q.score} of ${q.done} correct. You can start real reviews now.`
            : `Qualification not passed: ${q.score} of ${q.done} correct. Your admin can let you retake it.`)
      : h("p", { class: "muted" }, `${q.done} of ${q.required} qualification comparisons done.`),
    h("div", { class: "row", style: "margin-top:12px" },
      q.status === "failed"
        ? h("button", { class: "primary", onclick: () => home() }, "Back to projects")
        : h("button", { class: "primary", onclick: () => startProject(projectId) }, q.status === "passed" ? "Start reviewing" : "Next qualification item")),
  );
  window.scrollTo(0, 0);
}

function pauseForIdle() {
  const projectId = current?.projectId;
  releaseCurrent();
  setView(
    h("div", { class: "panel empty" },
      h("h2", {}, "Paused"),
      h("p", {}, `You were inactive for ${IDLE_MINUTES} minutes, so the comparison went back to the queue.`),
      h("button", { class: "primary", onclick: () => (projectId ? startProject(projectId) : home()) }, "Resume")),
  );
}

// ---------- boot ----------

async function boot() {
  let info;
  try {
    info = await api("auth/me");
  } catch (err) {
    return setView(h("div", { class: "notice bad" }, `Can't reach the Arbiter server: ${err.message}`));
  }
  const who = document.getElementById("who");
  who.replaceChildren();
  if (info.mode !== "managed") return setView(h("div", { class: "notice" }, "This page is for Managed workspaces. Open the Arbiter app instead."));
  me = info.user;
  if (!me) return authView(location.hash.includes("invite"));
  watermark(me.email);
  who.append(h("span", { class: "muted small" }, me.email), h("button", { class: "small", onclick: signOut }, "Sign out"));
  home();
}

window.addEventListener("hashchange", () => me && location.hash === "#/" && home());
onUnauthorized(() => {
  current = null;
  clearInterval(leaseTimer);
  me = null;
  toast("Your session ended. Please sign in again.");
  boot();
});
boot();
