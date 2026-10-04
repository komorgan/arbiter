// Arbiter UI: evaluations, blind review, ratings, and the router. Setup pages live in manage.js.
import { api, desktop, errorView, fmt, getMeta, h, json, keyFor, onUnauthorized, poll, pref, setFlash, setView, statusBadge } from "./lib.js";
import { authView, viewAccount, viewAudit, viewPeople, viewProject, viewProjectForm, viewProjects } from "./admin.js";
import { viewContestantForm, viewContestants, viewSettings, viewTaskForm, viewTasks, viewWorkspaces } from "./manage.js";
import { rubricForm, sideView } from "./review.js";
import { viewRubricForm, viewRubrics } from "./rubrics.js";

// ---------- evaluations list ----------

async function viewEvaluations() {
  const evs = await api("evaluations");
  if (evs.length === 0) {
    return setView(
      h("h1", {}, "Evaluations"),
      h("div", { class: "panel empty" }, "No evaluations yet. ", h("a", { href: "#/new" }, "Start one"), " or run ", h("code", {}, "npm run arbiter -- run <task> --contestants a,b"), "."),
    );
  }
  setView(
    h("div", { class: "row" }, h("h1", {}, "Evaluations"), h("span", { class: "spacer" }), h("a", { class: "btn", href: "#/new" }, "New evaluation")),
    h("div", { class: "panel", style: "padding:0;margin-top:12px" },
      h("table", {},
        h("thead", {}, h("tr", {}, ["Task", "Contestants", "Status", "Runs", "Reviewed", "Created"].map((c) => h("th", {}, c)))),
        h("tbody", {},
          evs.map((e) =>
            h("tr", { class: "click", onclick: () => (location.hash = `#/eval/${e.id}`) },
              h("td", {}, h("div", {}, e.title), e.tags.map((t) => h("span", { class: "tag" }, t))),
              h("td", {}, e.contestants.join(", ")),
              h("td", {}, statusBadge(e.status)),
              h("td", {}, `${e.runs.done}/${e.runs.total}`),
              h("td", {}, e.reviews.total ? `${e.reviews.submitted}/${e.reviews.total}` : "–"),
              h("td", { class: "muted" }, fmt.date(e.createdAt)),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------- new evaluation ----------

async function viewNew(presetTaskId) {
  const [tasks, contestants, meta] = await Promise.all([api("tasks"), api("contestants"), getMeta(true)]);
  const usable = tasks.filter((t) => !t.error);
  if (usable.length === 0) {
    return setView(h("h1", {}, "New evaluation"), h("div", { class: "panel empty" }, "Create a task first. ", h("a", { href: "#/tasks/new" }, "New task")));
  }
  const keySource = Object.fromEntries(meta.keys.map((k) => [k.name, k.source]));
  const chosen = new Set(pref.get("lastContestants", []).filter((id) => contestants.some((c) => c.id === id)));
  const taskSel = h("select", { style: "width:100%" }, usable.map((t) => h("option", { value: t.path }, `${t.title}  (${t.id})`)));
  const preset = usable.find((t) => t.id === presetTaskId);
  if (preset) taskSel.value = preset.path;
  const repeats = h("input", { type: "number", min: "1", max: "10", value: "1", style: "width:80px" });
  const sandbox = h("select", {}, h("option", { value: "auto" }, `Automatic (${meta.docker ? "Docker" : "local: Docker not running"})`), h("option", { value: "docker" }, "Docker"), h("option", { value: "local" }, "Local (no isolation)"));
  const warnings = h("div", { class: "stack" });
  const msg = h("div");
  const submit = h("button", { class: "primary" }, "Run evaluation");

  const refresh = () => {
    const missing = [...chosen]
      .map((id) => contestants.find((c) => c.id === id))
      .filter((c) => c && keyFor(c) && !keySource[keyFor(c)]);
    warnings.replaceChildren(
      ...missing.map((c) => h("div", { class: "notice" }, `${c.displayName} needs ${keyFor(c)}. `, h("a", { href: "#/settings" }, "Add it in Settings"), ", or the run will fail.")),
      ...(chosen.size < 2 ? [h("div", { class: "muted small" }, "Pick at least two contestants.")] : []),
    );
    submit.disabled = chosen.size < 2;
  };

  submit.addEventListener("click", async () => {
    msg.replaceChildren();
    submit.disabled = true;
    try {
      pref.set("lastContestants", [...chosen]);
      const { id } = await api("evaluations", json("POST", { taskPath: taskSel.value, contestantIds: [...chosen], repeats: Number(repeats.value), sandbox: sandbox.value }));
      location.hash = `#/eval/${id}`;
    } catch (err) {
      msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
      submit.disabled = false;
    }
  });

  setView(
    h("h1", {}, "New evaluation"),
    h("p", { class: "muted" }, "Every contestant gets the same prompt, tools, limits and a fresh copy of the project. You'll review the results blind."),
    h("div", { class: "panel stack", style: "max-width:760px" },
      h("div", {}, h("h3", {}, "Task"), taskSel, h("div", { class: "hint" }, h("a", { href: "#/tasks/new" }, "New task"), " · ", h("a", { href: "#/tasks" }, "Manage tasks"))),
      h("div", {},
        h("h3", {}, "Contestants"),
        contestants.map((c) => {
          const key = keyFor(c);
          return h("label", { class: "check" },
            h("input", { type: "checkbox", checked: chosen.has(c.id), onchange: (e) => { e.target.checked ? chosen.add(c.id) : chosen.delete(c.id); refresh(); } }),
            h("span", {}, c.displayName),
            h("span", { class: "muted small" }, `${c.provider}${c.model ? ` · ${c.model}` : ""}`),
            key && !keySource[key] && h("span", { class: "badge warn" }, "no key"),
          );
        }),
        h("div", { class: "hint" }, h("a", { href: "#/contestants/new" }, "Add contestant")),
      ),
      h("div", { class: "row" }, h("label", {}, "Runs per contestant ", repeats), h("label", {}, "Sandbox ", sandbox)),
      !meta.git && h("div", { class: "notice bad" }, "Git isn't installed, and Arbiter needs it to snapshot projects. Install Git for Windows, then restart Arbiter."),
      !meta.docker && h("div", { class: "notice" }, "Docker isn't running, so agent commands will run directly on this computer. Use trusted models and tasks, or start Docker Desktop."),
      warnings,
      h("div", { class: "row" }, submit),
      msg,
    ),
  );
  refresh();
}

// ---------- evaluation detail ----------

async function viewEvaluation(id) {
  const ev = await api(`evaluations/${id}`);
  const running = ev.status === "running";
  const next = ev.assignments.find((a) => !a.submitted);
  const revealed = ev.reviews.complete;

  setView(
    h("div", { class: "row" },
      h("div", {}, h("h1", {}, ev.title), h("div", {}, ev.tags.map((t) => h("span", { class: "tag" }, t)), " ", statusBadge(ev.status), h("span", { class: "muted small" }, `  sandbox: ${ev.sandbox} · rubric: ${ev.rubric}`))),
      h("span", { class: "spacer" }),
      h("div", { class: "row" },
        !running && mode === "personal" && h("button", { class: "danger", onclick: async () => {
          if (!confirm("Delete this evaluation, its run artifacts and your reviews of it? This can't be undone. Ratings will be recalculated without it.")) return;
          await api(`evaluations/${id}`, { method: "DELETE" });
          setFlash("good", "Evaluation deleted.");
          location.hash = "#/";
        } }, "Delete"),
        next && !running && mode === "personal" && h("button", { class: "primary", onclick: () => (location.hash = `#/review/${next.id}`) }, ev.reviews.submitted ? "Continue reviewing" : "Start blind review"),
      ),
    ),
    h("h2", {}, "Prompt"),
    h("pre", { class: "prompt" }, ev.prompt),
    h("h2", {}, "Contestants"),
    h("p", {}, ev.contestants.join(" · "), " ", !revealed && h("span", { class: "muted small" }, "— which run belongs to whom stays hidden until every comparison is reviewed.")),
    h("h2", {}, "Runs"),
    h("div", { class: "panel", style: "padding:0" },
      h("table", {},
        h("thead", {}, h("tr", {},
          h("th", {}, revealed ? "Contestant" : "Run"), h("th", {}, "Attempt"), h("th", {}, "Status"),
          revealed && [h("th", { class: "num" }, "Checks"), h("th", { class: "num" }, "Cost"), h("th", { class: "num" }, "Time"), h("th", { class: "num" }, "Tokens"), h("th", { class: "num" }, "Files")],
          h("th", {}, "Note"),
        )),
        h("tbody", {},
          ev.runs.map((r) =>
            h("tr", {},
              h("td", {}, r.label), h("td", {}, r.attempt), h("td", {}, statusBadge(r.status)),
              revealed && [
                h("td", { class: "num" }, r.metrics ? `${r.metrics.checksPassed}/${r.metrics.checksTotal}` : "–"),
                h("td", { class: "num" }, fmt.usd(r.metrics?.costUsd)),
                h("td", { class: "num" }, fmt.sec(r.metrics?.wallSec)),
                h("td", { class: "num" }, r.metrics ? fmt.int(r.metrics.inputTokens + r.metrics.outputTokens) : "–"),
                h("td", { class: "num" }, r.metrics ? `${r.metrics.filesTouched}${r.metrics.outOfScopeFiles ? ` (${r.metrics.outOfScopeFiles} out of scope)` : ""}` : "–"),
              ],
              h("td", { class: "muted small" }, r.error ?? ""),
            ),
          ),
        ),
      ),
    ),
    ev.assignments.length > 0 && [
      h("h2", {}, `Blind comparisons (${ev.reviews.submitted}/${ev.reviews.total} reviewed)`),
      h("div", { class: "panel", style: "padding:0" },
        h("table", {}, h("tbody", {},
          ev.assignments.map((a) =>
            h("tr", { class: "click", onclick: () => (location.hash = `#/review/${a.id}`) },
              h("td", {}, a.label), h("td", {}, a.submitted ? h("span", { class: "badge good" }, "reviewed") : h("span", { class: "badge" }, "to review")),
            ),
          ),
        )),
      ),
    ],
    ev.status === "failed" && h("div", { class: "notice bad", style: "margin-top:16px" }, "No comparable runs. Check the errors above (missing API key, setup failure, …)."),
  );
  if (running) poll(() => route(), 1500);
}

// ---------- blind review ----------

async function viewReview(id) {
  const started = Date.now();
  const a = await api(`assignments/${id}`);
  const showMetrics = pref.get("showMetrics", true);
  const metricsToggle = h("label", { class: "check small" },
    h("input", { type: "checkbox", checked: showMetrics, onchange: (e) => { pref.set("showMetrics", e.target.checked); route(); } }),
    "Show objective metrics");

  const header = h("div", { class: "row" },
    h("div", {}, h("div", { class: "muted small" }, h("a", { href: `#/eval/${a.evaluationId}` }, a.task.title), ` · comparison ${a.index} of ${a.count}`), h("h1", {}, "Blind review")),
    h("span", { class: "spacer" }), metricsToggle);

  const result = a.submission
    ? h("div", { class: "notice good reveal row" },
        h("span", {}, "Revealed: ", h("b", {}, `A = ${a.reveal.A}`), " · ", h("b", {}, `B = ${a.reveal.B}`),
          `  — you preferred ${a.submission.outcome === "tie" ? "neither (tie)" : a.submission.outcome}.`),
        h("span", { class: "spacer" }),
        a.nextId ? h("button", { class: "primary", onclick: () => (location.hash = `#/review/${a.nextId}`) }, "Next comparison")
          : h("a", { class: "btn", href: "#/ratings" }, "See ratings"))
    : rubricForm(a.rubric, a.guessOptions, async (answers, guess) => {
        await api(`assignments/${id}/submit`, {
          method: "POST",
          body: JSON.stringify({ answers, modelGuess: guess, timeSpentSec: (Date.now() - started) / 1000 }),
        });
        route();
      });

  setView(
    header,
    h("details", { open: !a.submission }, h("summary", { class: "muted" }, "Task prompt"), h("pre", { class: "prompt", style: "margin-top:8px" }, a.task.prompt)),
    h("div", { class: "sides", style: "margin-top:16px" }, sideView("A", a.sides.A, showMetrics), sideView("B", a.sides.B, showMetrics)),
    h("div", { style: "margin-top:16px" }, result),
  );
}

// ---------- ratings ----------

async function viewRatings(tag) {
  const r = await api(`ratings${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
  const tagSel = h("select", { onchange: (e) => (location.hash = e.target.value ? `#/ratings/${encodeURIComponent(e.target.value)}` : "#/ratings") },
    h("option", { value: "" }, "All tasks"), r.tags.map((t) => h("option", { value: t }, t)));
  tagSel.value = tag ?? "";
  if (r.ratings.length === 0) {
    return setView(h("div", { class: "row" }, h("h1", {}, "Ratings"), h("span", { class: "spacer" }), tagSel),
      h("div", { class: "panel empty" }, "No reviewed comparisons yet. Ratings appear after you submit blind reviews."));
  }
  const lo = Math.min(...r.ratings.map((x) => x.ciLow)) - 20;
  const hi = Math.max(...r.ratings.map((x) => x.ciHigh)) + 20;
  const pos = (v) => `${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  setView(
    h("div", { class: "row" }, h("h1", {}, "Ratings"), h("span", { class: "spacer" }), tagSel),
    h("p", { class: "muted" }, `Bradley–Terry ratings (Elo scale, 1000 = average) from ${r.comparisons} blind comparison${r.comparisons === 1 ? "" : "s"}, with 95% bootstrap intervals.`,
      r.blinding && ` Model guesses were right ${fmt.pct(r.blinding.accuracy)} of the time (${r.blinding.guesses} guess${r.blinding.guesses === 1 ? "" : "es"}; ~50% is chance with two contestants).`),
    h("div", { class: "panel", style: "padding:0" },
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Contestant"), h("th", { class: "num" }, "Rating"), h("th", {}, "95% interval"), h("th", { class: "num" }, "W–L–T"),
          h("th", { class: "num" }, "Checks passed"), h("th", { class: "num" }, "Avg cost"), h("th", { class: "num" }, "Avg time"))),
        h("tbody", {},
          r.ratings.map((x) =>
            h("tr", {},
              h("td", {}, x.name, x.provisional && h("span", { class: "badge", style: "margin-left:6px", title: "Fewer than 10 comparisons" }, "provisional")),
              h("td", { class: "num" }, h("b", {}, Math.round(x.rating))),
              h("td", {}, h("div", { class: "ci", title: `${Math.round(x.ciLow)}–${Math.round(x.ciHigh)}` },
                h("div", { class: "bar", style: `left:${pos(x.ciLow)};width:calc(${pos(x.ciHigh)} - ${pos(x.ciLow)})` }),
                h("div", { class: "pt", style: `left:calc(${pos(x.rating)} - 1px)` }))),
              h("td", { class: "num" }, `${x.wins}–${x.losses}–${x.ties}`),
              h("td", { class: "num" }, fmt.pct(x.avgCheckScore)),
              h("td", { class: "num" }, fmt.usd(x.avgCostUsd)),
              h("td", { class: "num" }, fmt.sec(x.avgWallSec)),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------- router ----------

// "personal" (desktop app / arbiter serve) or "managed" (Arbiter server admin dashboard).
let mode = "personal";
let user = null;

const PERSONAL_NAV = [["", "Evaluations"], ["new", "New evaluation"], ["tasks", "Tasks"], ["contestants", "Contestants"], ["rubrics", "Rubrics"], ["ratings", "Ratings"], ["workspaces", "Managed workspaces"], ["settings", "Settings"]];
const MANAGED_NAV = [["", "Projects"], ["people", "People"], ["tasks", "Tasks"], ["contestants", "Contestants"], ["rubrics", "Rubrics"], ["settings", "Keys & settings"], ["audit", "Audit log"]];
const SECTION = { eval: "", review: "", projects: "" };

function renderNav() {
  const items = mode === "managed" ? MANAGED_NAV : PERSONAL_NAV;
  document.querySelector(".topbar nav").replaceChildren(...items.map(([k, label]) => h("a", { href: `#/${k}`, "data-nav": k }, label)));
}

async function route() {
  const [, page, a, b] = location.hash.replace(/^#\/?/, "#/").split("/");
  const arg = a && decodeURIComponent(a);
  const section = SECTION[page] ?? page ?? "";
  document.querySelectorAll("[data-nav]").forEach((el) => el.classList.toggle("active", el.dataset.nav === section));
  try {
    if (mode === "managed") {
      if (!page || page === "projects") {
        if (!arg) await viewProjects();
        else if (arg === "new") await viewProjectForm();
        else if (b === "edit") await viewProjectForm(arg);
        else await viewProject(arg, b ?? "");
      } else if (page === "people") await viewPeople();
      else if (page === "audit") await viewAudit();
      else if (page === "account") viewAccount(user);
      else if (page === "eval") await viewEvaluation(arg);
      else if (!(await sharedRoute(page, arg, b))) setView(h("div", { class: "empty" }, "Not found."));
      return;
    }
    if (!page) await viewEvaluations();
    else if (page === "new") await viewNew(arg);
    else if (page === "eval") await viewEvaluation(arg);
    else if (page === "review") await viewReview(arg);
    else if (page === "ratings") await viewRatings(arg);
    else if (page === "workspaces") await viewWorkspaces();
    else if (!(await sharedRoute(page, arg, b))) setView(h("div", { class: "empty" }, "Not found."));
  } catch (err) {
    errorView(err);
  }
}

/** Pages that exist in both modes: the engine's tasks, contestants and keys. */
async function sharedRoute(page, arg, b) {
  if (page === "tasks" && arg === "new") await viewTaskForm();
  else if (page === "tasks" && arg === "edit") await viewTaskForm(decodeURIComponent(b));
  else if (page === "tasks") await viewTasks();
  else if (page === "contestants" && arg === "new") await viewContestantForm();
  else if (page === "contestants" && arg === "edit") await viewContestantForm(decodeURIComponent(b));
  else if (page === "contestants") await viewContestants();
  else if (page === "rubrics" && arg === "new") await viewRubricForm("new");
  else if (page === "rubrics" && (arg === "edit" || arg === "copy")) await viewRubricForm(arg, decodeURIComponent(b));
  else if (page === "rubrics") await viewRubrics();
  else if (page === "settings") await viewSettings();
  else return false;
  return true;
}

async function renderStatus() {
  const el = document.getElementById("meta");
  try {
    const m = await getMeta();
    el.replaceChildren(
      ...[
        !m.git && h("a", { class: "badge bad", href: "#/settings" }, "Git missing"),
        m.docker
          ? h("a", { class: "badge good", href: "#/settings", title: "Agent commands run in Docker containers" }, "Docker sandbox")
          : m.localSandbox
            ? h("a", { class: "badge warn", href: "#/settings", title: "Agent commands run directly on this computer, without isolation" }, "Local sandbox")
            : h("a", { class: "badge bad", href: "#/settings", title: "This server only runs agents in Docker. Batches can't run until Docker is available." }, "Docker not running"),
      ].filter(Boolean),
    );
    if (mode === "managed" && user) {
      el.append(
        h("a", { class: "small", href: "#/account" }, user.name),
        h("button", { class: "small", onclick: async () => { await api("auth/logout", json("POST", {})); location.hash = "#/"; location.reload(); } }, "Sign out"));
    } else if (!desktop) el.append(h("span", { class: "muted small" }, " browser mode"));
  } catch {
    // status is decoration; the page itself reports real errors
  }
}

async function boot() {
  let info = { mode: "personal" };
  try {
    info = await api("auth/me");
  } catch {
    // an older engine without auth/me is personal mode
  }
  mode = info.mode ?? "personal";
  user = info.user ?? null;
  document.body.classList.toggle("managed", mode === "managed");
  if (mode === "managed") {
    document.title = "Arbiter Server";
    document.querySelector(".brand").textContent = "Arbiter Server";
    if (!user) {
      document.querySelector(".topbar nav").replaceChildren();
      return authView(!!info.needsSetup, () => location.reload());
    }
    if (user.role !== "admin") {
      location.replace("/annotate");
      return;
    }
    onUnauthorized(() => location.reload());
  }
  renderNav();
  renderStatus();
  window.addEventListener("hashchange", route);
  route();
}

boot();
