// Managed-mode admin dashboard: projects, batches, comparisons & gold, members, QA, results, people, audit.
// Served by the Arbiter server to signed-in admins. Engine pages (tasks, contestants, keys) come from manage.js.
import { api, field, fmt, getMeta, h, json, setFlash, setView, statusBadge } from "./lib.js";

const PROJECT_STATUS = { draft: "", active: "good", paused: "warn", closed: "" };
const pbadge = (s) => h("span", { class: `badge ${PROJECT_STATUS[s] ?? ""}` }, s);
const progress = (done, target) => h("div", { class: "row", style: "gap:8px;flex-wrap:nowrap" },
  h("div", { class: "progress", title: `${done} of ${target}` }, h("div", { style: `width:${target ? Math.min(100, (done / target) * 100) : 0}%` })),
  h("span", { class: "small muted" }, `${done}/${target}`));

// ---------- sign-in and first-run setup ----------

export function authView(needsSetup, onDone) {
  const email = h("input", { type: "text", autocomplete: "username" });
  const pw = h("input", { type: "password", autocomplete: needsSetup ? "new-password" : "current-password", placeholder: needsSetup ? "At least 10 characters" : "" });
  const code = h("input", { type: "text", autocomplete: "off", spellcheck: "false" });
  const name = h("input", { type: "text", autocomplete: "name" });
  const msg = h("div");
  const submit = async () => {
    msg.replaceChildren();
    try {
      if (needsSetup) await api("auth/setup", json("POST", { code: code.value.trim(), email: email.value, name: name.value, password: pw.value }));
      else await api("auth/login", json("POST", { email: email.value, password: pw.value }));
      onDone();
    } catch (err) {
      msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
    }
  };
  const box = h("div", { class: "panel form auth-box" },
    needsSetup && field("Setup code", code, "Printed in the server console the first time it starts."),
    needsSetup && field("Your name", name),
    field("Email", email),
    field(needsSetup ? "Choose a password" : "Password", pw),
    h("button", { class: "primary", onclick: submit }, needsSetup ? "Create admin account" : "Sign in"),
    msg);
  box.addEventListener("keydown", (e) => e.key === "Enter" && e.target.tagName === "INPUT" && submit());
  setView(
    h("h1", {}, needsSetup ? "Set up Arbiter Server" : "Arbiter Server"),
    h("p", { class: "muted" }, needsSetup ? "Create the first administrator account." : "Sign in to the admin dashboard. Annotators sign in at /annotate."),
    box);
}

// ---------- projects overview ----------

export async function viewProjects() {
  const projects = await api("admin/overview");
  setView(
    h("div", { class: "row" }, h("h1", {}, "Projects"), h("span", { class: "spacer" }), h("a", { class: "btn primary", href: "#/projects/new" }, "New project")),
    projects.length === 0
      ? h("div", { class: "panel empty" }, "No projects yet. A project groups tasks, contestants and annotators under one rubric. ",
          h("a", { href: "#/projects/new" }, "Create one"), ".")
      : h("div", { class: "panel", style: "padding:0" },
          h("table", {},
            h("thead", {}, h("tr", {}, ["Project", "Status", "Review progress", "Comparisons", "Gold", "Annotators", "In review now", ""].map((c) => h("th", {}, c)))),
            h("tbody", {},
              projects.map((p) =>
                h("tr", { class: "click", onclick: () => (location.hash = `#/projects/${p.id}`) },
                  h("td", {}, h("div", {}, p.name), h("div", { class: "muted small" }, `${p.rubric} · created ${fmt.date(p.createdAt)}`)),
                  h("td", {}, pbadge(p.status)),
                  h("td", {}, progress(p.done, p.target)),
                  h("td", { class: "num" }, p.comparisons),
                  h("td", { class: "num" }, p.gold),
                  h("td", { class: "num" }, p.members),
                  h("td", { class: "num" }, p.activeLeases),
                  h("td", {}, p.runningBatches > 0 && h("span", { class: "badge" }, `${p.runningBatches} batch running`)),
                ),
              ),
            ),
          ),
        ),
  );
}

export async function viewProjectForm(id) {
  const [meta, data] = await Promise.all([getMeta(true), id ? api(`admin/projects/${id}`) : null]);
  const p = data?.project ?? { name: "", instructions: "", rubric: "detailed-pairwise", reviews_per_comparison: 3, gold_share: 0.1, show_metrics: 1, show_transcript: 0, allow_guess: 0, status: "draft", qual_required: 0, qual_pass: 0.8, require_desktop: 1 };
  const name = h("input", { type: "text", value: p.name });
  const instructions = h("textarea", { rows: "8", value: p.instructions, placeholder: "What annotators should look for, how to weigh correctness vs. style, when to pick Tie, etc." });
  const rubric = h("select", {}, meta.rubrics.map((r) => h("option", { value: r.id }, r.name)));
  rubric.value = p.rubric;
  const perComp = h("input", { type: "number", min: "1", max: "20", value: String(p.reviews_per_comparison), style: "width:90px" });
  const gold = h("input", { type: "number", min: "0", max: "50", value: String(Math.round(p.gold_share * 100)), style: "width:90px" });
  const cb = (checked) => h("input", { type: "checkbox", checked: !!checked });
  const showMetrics = cb(p.show_metrics);
  const showTranscript = cb(p.show_transcript);
  const allowGuess = cb(p.allow_guess);
  const requireDesktop = cb(p.require_desktop);
  const status = h("select", {}, ["draft", "active", "paused", "closed"].map((s) => h("option", { value: s }, s)));
  status.value = p.status;
  const qualRequired = h("input", { type: "number", min: "0", max: "50", value: String(p.qual_required ?? 0), style: "width:90px" });
  const qualPass = h("input", { type: "number", min: "1", max: "100", value: String(Math.round((p.qual_pass ?? 0.8) * 100)), style: "width:90px" });
  const msg = h("div");
  const save = h("button", { class: "primary", onclick: async () => {
    msg.replaceChildren();
    try {
      const body = {
        name: name.value, instructions: instructions.value, rubric: rubric.value, reviewsPerComparison: Number(perComp.value),
        goldShare: Number(gold.value) / 100, showMetrics: showMetrics.checked, showTranscript: showTranscript.checked, allowGuess: allowGuess.checked, status: status.value,
        qualRequired: Number(qualRequired.value), qualPass: Number(qualPass.value) / 100, requireDesktop: requireDesktop.checked,
      };
      const r = await api(id ? `admin/projects/${id}` : "admin/projects", json(id ? "PUT" : "POST", body));
      setFlash("good", "Project saved.");
      location.hash = `#/projects/${r.id}`;
    } catch (err) {
      msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
    }
  } }, id ? "Save changes" : "Create project");

  setView(
    h("div", { class: "muted small" }, h("a", { href: "#/" }, "Projects"), " / ", id ? p.name : "New"),
    h("h1", {}, id ? "Edit project" : "New project"),
    h("div", { class: "panel form", style: "max-width:820px" },
      field("Name", name),
      field("Instructions for annotators", instructions, "Shown at the top of every review."),
      h("div", { class: "grid2" },
        field("Rubric", rubric, "Can't be changed once reviews exist."),
        field("Status", status, "Only active projects hand out work. Paused keeps annotators' place; closed ends the project.")),
      h("div", { class: "row" },
        field("Reviews per comparison", perComp, "How many different annotators judge each pair."),
        field("Gold share (%)", gold, "Share of work drawn from gold comparisons (known answers) to measure accuracy.")),
      h("div", { class: "row" },
        field("Qualification items", qualRequired, "Known-answer comparisons each annotator must answer before real work. 0 = no test. Set them up under Comparisons & gold."),
        field("Pass mark (%)", qualPass, "Share they must get right. Feedback is shown after each item.")),
      h("div", {},
        h("label", { class: "check" }, requireDesktop, h("span", {}, "Require the Arbiter desktop app for annotators (recommended)",
          h("span", { class: "hint", style: "display:block" }, "Reviews then open only in its protected window: screen capture blocked, nothing saved on the annotator's computer. Browser access is refused and logged. A policy control: a determined person could imitate the app."))),
        h("label", { class: "check" }, showMetrics, "Show objective metrics (tests, cost, time) to annotators"),
        h("label", { class: "check" }, showTranscript, "Show agent transcripts to annotators"),
        h("label", { class: "check" }, allowGuess, "Ask annotators to guess the models (measures how blind the review is; reveals the list of contestants)")),
      h("div", { class: "row" }, save, h("a", { class: "btn", href: id ? `#/projects/${id}` : "#/" }, "Cancel")),
      msg),
  );
}

// ---------- one project ----------

const TABS = [["", "Batches"], ["comparisons", "Comparisons & gold"], ["members", "Annotators"], ["qa", "Quality"], ["results", "Results"]];

export async function viewProject(id, tab = "") {
  const data = await api(`admin/projects/${id}`);
  const p = data.project;
  const header = [
    h("div", { class: "muted small" }, h("a", { href: "#/" }, "Projects"), " / ", p.name),
    h("div", { class: "row" },
      h("h1", {}, p.name), pbadge(p.status), h("span", { class: "spacer" }),
      h("a", { class: "btn", href: `/api/admin/projects/${id}/export`, download: `arbiter-${id}.jsonl` }, "Export reviews (JSONL)"),
      h("a", { class: "btn", href: `#/projects/${id}/edit` }, "Edit")),
    h("p", { class: "muted small" }, `${p.rubric} · ${p.reviews_per_comparison} review${p.reviews_per_comparison === 1 ? "" : "s"} per comparison · ${Math.round(p.gold_share * 100)}% gold` +
      (p.qual_required ? ` · qualification: ${p.qual_required} item${p.qual_required === 1 ? "" : "s"}, ${Math.round(p.qual_pass * 100)}% to pass` : "") +
      (p.require_desktop ? " · desktop app required" : " · browser allowed")),
    h("nav", { class: "subnav" }, TABS.map(([t, label]) => h("a", { href: `#/projects/${id}${t ? `/${t}` : ""}`, class: t === tab ? "active" : "" }, label))),
  ];
  const body = await ({ "": tabBatches, comparisons: tabComparisons, members: tabMembers, qa: tabQa, results: tabResults }[tab] ?? tabBatches)(id, data);
  setView(header, body);
}

async function tabBatches(id, data) {
  const cat = await api("admin/catalog");
  const tasks = new Set();
  const contestants = new Set();
  const repeats = h("input", { type: "number", min: "1", max: "10", value: "1", style: "width:80px" });
  const msg = h("div");
  const go = h("button", { class: "primary", onclick: async () => {
    msg.replaceChildren();
    go.disabled = true;
    try {
      const r = await api(`admin/projects/${id}/batches`, json("POST", { taskPaths: [...tasks], contestantIds: [...contestants], repeats: Number(repeats.value) }));
      setFlash("good", `Started ${r.evaluations.length} evaluation${r.evaluations.length === 1 ? "" : "s"} on the server. Comparisons appear as runs finish.`);
      viewProject(id);
    } catch (err) {
      msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
      go.disabled = false;
    }
  } }, "Run batch");
  const check = (set, value, label, sub) => h("label", { class: "check" },
    h("input", { type: "checkbox", onchange: (e) => (e.target.checked ? set.add(value) : set.delete(value)) }), label, sub && h("span", { class: "muted small" }, sub));

  const running = data.batches.some((b) => b.status === "running");
  if (running) setTimeout(() => location.hash === `#/projects/${id}` && viewProject(id), 3000);
  return [
    h("h2", {}, "Batches"),
    data.batches.length === 0
      ? h("div", { class: "panel empty" }, "No batches yet. Run one below: each task is run against the chosen contestants on this server, then paired up for review.")
      : h("div", { class: "panel", style: "padding:0" }, h("table", {},
          h("thead", {}, h("tr", {}, ["Task", "Contestants", "Status", "Runs", "Comparisons", "Started"].map((c) => h("th", {}, c)))),
          h("tbody", {}, data.batches.map((b) => h("tr", { class: "click", onclick: () => (location.hash = `#/eval/${b.id}`) },
            h("td", {}, b.task), h("td", { class: "small" }, b.contestants.join(" · ")), h("td", {}, statusBadge(b.status)),
            h("td", {}, `${b.runs.done}/${b.runs.total}`, b.runs.failed ? h("span", { class: "badge bad", style: "margin-left:6px" }, `${b.runs.failed} failed`) : null),
            h("td", { class: "num" }, b.comparisons), h("td", { class: "muted small" }, fmt.date(b.createdAt))))))),
    h("h2", {}, "Run a new batch"),
    h("div", { class: "panel stack" },
      h("h3", {}, "Tasks ", h("span", { class: "muted small" }, h("a", { href: "#/tasks/new" }, "New task"))),
      cat.tasks.length ? h("div", { class: "checklist" }, cat.tasks.map((t) => check(tasks, t.path, t.title, t.tags.join(", ")))) : h("p", { class: "muted" }, "No tasks on this server yet."),
      h("h3", {}, "Contestants ", h("span", { class: "muted small" }, h("a", { href: "#/contestants/new" }, "Add contestant"))),
      h("div", { class: "checklist" }, cat.contestants.map((c) => check(contestants, c.id, c.displayName, c.model ?? c.provider))),
      h("div", { class: "row" }, h("label", {}, "Runs per contestant ", repeats), go),
      msg),
  ];
}

async function tabComparisons(id, data) {
  const comps = await api(`admin/projects/${id}/comparisons`);
  if (!comps.length) return h("div", { class: "panel empty" }, "No comparisons yet. Run a batch first.");
  const target = data.project.reviews_per_comparison;
  const qualCount = comps.filter((c) => c.gold?.qual).length;
  const req = data.project.qual_required;
  return [
    h("p", { class: "muted" },
      "Mark a comparison as gold when one answer is clearly right (for example, only one side passes the tests). Gold is mixed into everyone's work and measures accuracy. ",
      "Tick “Qualification” to use it in the entry test instead: those items only appear in the test, and the note is shown to the annotator as feedback after they answer. Contestant names are visible to admins only."),
    req > 0 && h("div", { class: `notice ${qualCount >= req ? "good" : ""}`, style: "margin-bottom:12px" },
      qualCount >= req
        ? `Qualification is ready: ${qualCount} item${qualCount === 1 ? "" : "s"} set up, ${req} required.`
        : `Annotators must pass ${req} qualification item${req === 1 ? "" : "s"}, but only ${qualCount} ${qualCount === 1 ? "is" : "are"} set up. Nobody can start work until there are enough.`),
    h("div", { class: "panel", style: "padding:0" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Task", "A", "B", "Reviews", "Known answer", "Note (qualification feedback)", ""].map((c) => h("th", {}, c)))),
      h("tbody", {}, comps.map((c) => {
        const sel = h("select", {}, [["", "not gold"], ["A", "A is right"], ["B", "B is right"], ["tie", "Tie"]].map(([v, l]) => h("option", { value: v }, l)));
        sel.value = c.gold?.expected ?? "";
        const qual = h("input", { type: "checkbox", checked: !!c.gold?.qual });
        const note = h("input", { type: "text", value: c.gold?.note ?? "", placeholder: "Why this answer is right", style: "width:100%" });
        const save = h("button", { class: "small", onclick: async () => {
          try {
            await api(`admin/comparisons/${c.id}/gold`, json("PUT", { expected: sel.value || null, note: note.value, qual: qual.checked }));
            setFlash("good", sel.value ? (qual.checked ? "Qualification item saved." : "Gold answer saved.") : "Gold removed.");
          } catch (err) {
            setFlash("bad", err.message);
          }
          viewProject(id, "comparisons");
        } }, "Save");
        return h("tr", {},
          h("td", {}, c.task),
          h("td", {}, c.a.contestant, h("div", { class: "muted small" }, `checks ${c.a.checks}`)),
          h("td", {}, c.b.contestant, h("div", { class: "muted small" }, `checks ${c.b.checks}`)),
          h("td", {}, c.gold?.qual ? `${c.submitted} (test)` : c.gold ? `${c.submitted} (gold)` : progress(c.submitted, target), c.leased ? h("span", { class: "muted small" }, ` +${c.leased} in progress`) : null),
          h("td", {}, h("div", { class: "row", style: "flex-wrap:nowrap;gap:8px" }, sel, h("label", { class: "check small", title: "Use only in the entry test" }, qual, "Qualification"))),
          h("td", { style: "min-width:200px" }, note),
          h("td", { class: "actions" }, save));
      })))),
  ];
}

async function tabMembers(id, data) {
  const users = (await api("admin/users")).filter((u) => u.status === "active");
  const current = new Set(data.members.map((m) => m.id));
  const chosen = new Set(current);
  const msg = h("div");
  return [
    h("p", { class: "muted" }, "Who can work on this project. New people are added with an invite on the ", h("a", { href: "#/people" }, "People"), " page."),
    h("div", { class: "panel stack" },
      users.length === 0 ? h("p", { class: "muted" }, "No accounts yet.") : h("div", { class: "checklist" }, users.map((u) =>
        h("label", { class: "check" },
          h("input", { type: "checkbox", checked: chosen.has(u.id), onchange: (e) => (e.target.checked ? chosen.add(u.id) : chosen.delete(u.id)) }),
          u.name, h("span", { class: "muted small" }, u.role === "admin" ? `${u.email} · admin` : u.email)))),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => {
        await api(`admin/projects/${id}/members`, json("PUT", { userIds: [...chosen] }));
        setFlash("good", "Annotators updated.");
        viewProject(id, "members");
      } }, "Save")),
      msg),
  ];
}

/** Qualification status for one annotator, with admin overrides (retake, pass, fail). */
function qualCell(projectId, a) {
  if (!a.qualification) return h("span", { class: "muted small" }, "not required");
  const q = a.qualification;
  const set = (status, confirmText) => h("button", { class: "small", onclick: async () => {
    if (confirmText && !confirm(confirmText)) return;
    await api(`admin/projects/${projectId}/members/${a.id}/qualification`, json("PUT", { status }));
    viewProject(projectId, "qa");
  } }, { none: "Let retake", passed: "Pass", failed: "Fail" }[status]);
  const badge = { passed: "good", failed: "bad", none: "" }[q.status];
  const label = q.status === "none" ? (q.done ? `in progress ${q.done}/${q.required}` : "not started") : `${q.status} (${q.correct}/${q.done})`;
  return h("div", {},
    h("span", { class: `badge ${badge}` }, label),
    h("div", { class: "row", style: "gap:4px;margin-top:4px" },
      q.status !== "none" && set("none", `Let ${a.name} retake the qualification? Their previous answers are discarded.`),
      q.status !== "passed" && set("passed"),
      q.status === "passed" && set("failed", `Mark ${a.name} as failed? They'll get no more work in this project.`)));
}

async function tabQa(id) {
  const qa = await api(`admin/projects/${id}/qa`);
  const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
  return [
    h("div", { class: "cards" },
      h("div", { class: "card" }, h("b", {}, pct(qa.pairwiseAgreement)), h("span", {}, `agreement between annotators (${qa.pairs} pairs)`)),
      h("div", { class: "card" }, h("b", {}, qa.annotators.filter((a) => a.flags.length).length), h("span", {}, "annotators with flags")),
      h("div", { class: "card" }, h("b", {}, qa.annotators.filter((a) => a.excluded).length), h("span", {}, "excluded from results"))),
    h("p", { class: "muted small", style: "margin-top:12px" },
      `Flags: gold accuracy under ${pct(qa.thresholds.goldAccuracy)} (≥${qa.thresholds.minGoldN} gold), picking one side over ${pct(qa.thresholds.sideBias)} of the time (≥${qa.thresholds.minSideN} picks), median under ${qa.thresholds.minMedianSec}s, repeated justifications, agreement under ${pct(qa.thresholds.agreement)}. Flags prompt a look; excluding someone removes their reviews from Results and the export's included set.`),
    h("div", { class: "panel", style: "padding:0" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Annotator", "Qualification", "Reviews", "Skipped", "Gold accuracy", "Agreement", "Picks left", "Median time", "Avg justification", "Flags", ""].map((c) => h("th", {}, c)))),
      h("tbody", {}, qa.annotators.map((a) => h("tr", { class: a.excluded ? "excluded" : "" },
        h("td", {}, a.name, h("div", { class: "muted small" }, a.email)),
        h("td", {}, qualCell(id, a)),
        h("td", { class: "num" }, a.reviews),
        h("td", { class: "num" }, a.skipped),
        h("td", { class: "num" }, a.gold.n ? `${pct(a.gold.accuracy)} of ${a.gold.n}` : "–"),
        h("td", { class: "num" }, a.agreement.n ? `${pct(a.agreement.rate)} of ${a.agreement.n}` : "–"),
        h("td", { class: "num" }, a.decisive ? pct(a.leftRate) : "–"),
        h("td", { class: "num" }, a.medianSec == null ? "–" : fmt.sec(a.medianSec)),
        h("td", { class: "num" }, a.avgJustification == null ? "–" : `${a.avgJustification} chars`),
        h("td", {}, a.flags.map((f) => h("span", { class: "badge warn flag" }, f)), a.duplicates ? h("span", { class: "muted small" }, ` (${a.duplicates} repeated)`) : null),
        h("td", { class: "actions" }, h("button", { class: `small ${a.excluded ? "" : "danger"}`, onclick: async () => {
          await api(`admin/projects/${id}/members/${a.id}`, json("PUT", { excluded: !a.excluded }));
          viewProject(id, "qa");
        } }, a.excluded ? "Include" : "Exclude"))))))),
  ];
}

async function tabResults(id) {
  const r = await api(`admin/projects/${id}/results`);
  if (!r.reviews) return h("div", { class: "panel empty" }, "No reviews yet.");
  const lo = Math.min(...r.ratings.map((x) => x.ciLow)) - 20;
  const hi = Math.max(...r.ratings.map((x) => x.ciHigh)) + 20;
  const pos = (v) => `${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  return [
    h("p", { class: "muted" }, `From ${r.reviews} reviews of ${r.comparisons} comparisons by included annotators. Ratings are Bradley–Terry on an Elo scale (1000 = average) with 95% bootstrap intervals.`),
    h("div", { class: "panel", style: "padding:0" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Contestant"), h("th", { class: "num" }, "Rating"), h("th", {}, "95% interval"), h("th", { class: "num" }, "W–L–T"))),
      h("tbody", {}, r.ratings.map((x) => h("tr", {},
        h("td", {}, x.name),
        h("td", { class: "num" }, h("b", {}, Math.round(x.rating))),
        h("td", {}, h("div", { class: "ci", title: `${Math.round(x.ciLow)}–${Math.round(x.ciHigh)}` },
          h("div", { class: "bar", style: `left:${pos(x.ciLow)};width:calc(${pos(x.ciHigh)} - ${pos(x.ciLow)})` }),
          h("div", { class: "pt", style: `left:calc(${pos(x.rating)} - 1px)` }))),
        h("td", { class: "num" }, `${x.wins}–${x.losses}–${x.ties}`)))))),
    r.criteria.length > 1 && [
      h("h2", {}, "By criterion"),
      h("p", { class: "muted small" }, "Win rate per rubric question (ties count half)."),
      h("div", { class: "panel", style: "padding:0" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Criterion"), ...r.ratings.map((x) => h("th", { class: "num" }, x.name)))),
        h("tbody", {}, r.criteria.map((c) => h("tr", {},
          h("td", {}, c.label),
          ...r.ratings.map((x) => {
            const e = c.contestants.find((y) => y.id === x.id);
            return h("td", { class: "num" }, e ? `${Math.round(e.winRate * 100)}%` : "–");
          })))))),
    ],
    r.flags.length > 0 && [
      h("h2", {}, "Flags raised"),
      h("div", { class: "panel", style: "padding:0" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Flag"), ...r.ratings.map((x) => h("th", { class: "num" }, x.name)))),
        h("tbody", {}, r.flags.map((f) => h("tr", {},
          h("td", {}, f.label),
          ...r.ratings.map((x) => {
            const e = f.contestants.find((y) => y.id === x.id);
            return h("td", { class: "num" }, e ? `${Math.round(e.rate * 100)}%` : "–");
          })))))),
    ],
  ];
}

// ---------- people ----------

export async function viewPeople() {
  const [users, invites, projects, me] = await Promise.all([api("admin/users"), api("admin/invites"), api("admin/overview"), api("auth/me")]);
  const pname = new Map(projects.map((p) => [p.id, p.name]));
  const email = h("input", { type: "text", placeholder: "name@company.com", style: "width:260px" });
  const role = h("select", {}, h("option", { value: "annotator" }, "Annotator"), h("option", { value: "admin" }, "Admin"));
  const chosen = new Set();
  const result = h("div");
  const create = h("button", { class: "primary", onclick: async () => {
    result.replaceChildren();
    try {
      const r = await api("admin/invites", json("POST", { email: email.value, role: role.value, projectIds: [...chosen] }));
      result.replaceChildren(h("div", { class: "notice good stack" },
        h("div", {}, `Invite created for ${email.value}. Send them this code. It's shown only once and expires ${fmt.date(r.expiresAt)}.`),
        h("div", { class: "code-once" }, r.code),
        h("div", { class: "small" }, "They sign up in the Arbiter app (Managed workspaces → add this server) or at ", h("b", {}, `${location.origin}/annotate`), ", choosing “I have an invite”.")));
      email.value = "";
    } catch (err) {
      result.replaceChildren(h("div", { class: "notice bad" }, err.message));
    }
  } }, "Create invite");

  const act = (label, cls, fn) => h("button", { class: `small ${cls}`, onclick: async () => { await fn(); viewPeople(); } }, label);
  setView(
    h("h1", {}, "People"),
    h("h2", {}, "Invite someone"),
    h("div", { class: "panel stack" },
      h("div", { class: "row" }, field("Email", email), field("Role", role)),
      projects.length > 0 && h("div", {}, h("div", { class: "field-label" }, "Projects"), h("div", { class: "checklist" }, projects.map((p) =>
        h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => (e.target.checked ? chosen.add(p.id) : chosen.delete(p.id)) }), p.name)))),
      h("div", { class: "row" }, create),
      result),
    h("h2", {}, "Accounts"),
    h("div", { class: "panel", style: "padding:0" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Name", "Role", "Status", "Projects", "Reviews", "Last sign-in", ""].map((c) => h("th", {}, c)))),
      h("tbody", {}, users.map((u) => h("tr", { class: u.status === "disabled" ? "excluded" : "" },
        h("td", {}, u.name, h("div", { class: "muted small" }, u.email)),
        h("td", {}, u.role),
        h("td", {}, h("span", { class: `badge ${u.status === "active" ? "good" : ""}` }, u.status)),
        h("td", { class: "small" }, u.projects.map((id) => pname.get(id)).filter(Boolean).join(", ") || "–"),
        h("td", { class: "num" }, u.reviews),
        h("td", { class: "muted small" }, u.last_login ? fmt.date(u.last_login) : "never"),
        h("td", { class: "actions" },
          u.id === me.user.id ? h("span", { class: "muted small" }, "you") : [
          act(u.status === "active" ? "Disable" : "Enable", u.status === "active" ? "danger" : "", () =>
            api(`admin/users/${u.id}`, json("PUT", { status: u.status === "active" ? "disabled" : "active" }))),
          act(u.role === "admin" ? "Make annotator" : "Make admin", "", () =>
            confirm(`Change ${u.name}'s role?`) && api(`admin/users/${u.id}`, json("PUT", { role: u.role === "admin" ? "annotator" : "admin" })))],
          act("Sign out everywhere", "", () => api(`admin/users/${u.id}/revoke-sessions`, json("POST", {}))))))))),
    invites.some((i) => !i.usedAt) && [
      h("h2", {}, "Open invites"),
      h("div", { class: "panel", style: "padding:0" }, h("table", {},
        h("tbody", {}, invites.filter((i) => !i.usedAt).map((i) => h("tr", {},
          h("td", {}, i.email), h("td", {}, i.role),
          h("td", { class: "muted small" }, Date.parse(i.expiresAt) < Date.now() ? "expired" : `expires ${fmt.date(i.expiresAt)}`),
          h("td", { class: "actions" }, act("Revoke", "danger", () => api(`admin/invites/${i.id}`, { method: "DELETE" })))))))),
    ],
  );
}

// ---------- audit ----------

export async function viewAudit() {
  const rows = await api("admin/audit");
  setView(
    h("h1", {}, "Audit log"),
    h("p", { class: "muted" }, "The latest 500 events: sign-ins, admin changes, exports, and review activity."),
    h("div", { class: "panel", style: "padding:0" }, h("table", {},
      h("thead", {}, h("tr", {}, ["When", "Who", "Action", "Details", "IP"].map((c) => h("th", {}, c)))),
      h("tbody", {}, rows.map((r) => h("tr", {},
        h("td", { class: "small", style: "white-space:nowrap" }, fmt.date(r.at)),
        h("td", { class: "small" }, r.email ?? "–"),
        h("td", { class: "mono small" }, r.action),
        h("td", { class: "mono small", style: "word-break:break-all;max-width:420px" }, r.detail ? JSON.stringify(r.detail) : ""),
        h("td", { class: "muted small" }, r.ip ?? "")))))),
  );
}

// ---------- account ----------

export function viewAccount(user) {
  const cur = h("input", { type: "password", autocomplete: "current-password" });
  const next = h("input", { type: "password", autocomplete: "new-password", placeholder: "At least 10 characters" });
  const msg = h("div");
  setView(
    h("h1", {}, "Your account"),
    h("p", {}, `${user.name} · ${user.email} · ${user.role}`),
    h("div", { class: "panel form", style: "max-width:420px" },
      field("Current password", cur), field("New password", next),
      h("button", { class: "primary", onclick: async () => {
        msg.replaceChildren();
        try {
          await api("auth/password", json("POST", { current: cur.value, next: next.value }));
          location.reload(); // all sessions were revoked, including this one
        } catch (err) {
          msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
        }
      } }, "Change password"),
      msg),
  );
}
