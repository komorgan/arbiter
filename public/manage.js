// Setup pages: tasks, contestants, settings (API keys, environment).
import { api, desktop, field, folderInput, getMeta, h, json, keyFor, setFlash, setView } from "./lib.js";

const csv = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

// ---------- tasks ----------

export async function viewTasks() {
  const tasks = await api("tasks");
  setView(
    h("div", { class: "row" }, h("h1", {}, "Tasks"), h("span", { class: "spacer" }), h("a", { class: "btn primary", href: "#/tasks/new" }, "New task")),
    h("p", { class: "muted" }, "A task is a prompt plus a project folder. Every contestant gets a fresh copy of the folder, and the same checks (tests, linters) run on each result."),
    tasks.length === 0
      ? h("div", { class: "panel empty" }, "No tasks yet.")
      : h("div", { class: "panel", style: "padding:0" },
          h("table", {},
            h("thead", {}, h("tr", {}, ["Task", "Source", "Checks", "Rubric", ""].map((c) => h("th", {}, c)))),
            h("tbody", {},
              tasks.map((t) =>
                h("tr", {},
                  h("td", {}, h("div", {}, t.title), h("div", { class: "muted small" }, t.id), t.tags.map((x) => h("span", { class: "tag" }, x)),
                    t.error && h("div", { class: "notice bad small" }, t.error)),
                  h("td", { class: "muted small", style: "word-break:break-all;max-width:360px" }, t.source),
                  h("td", {}, t.checks || "–"),
                  h("td", { class: "small" }, t.rubric),
                  h("td", { class: "actions" },
                    !t.error && h("a", { class: "btn small primary", href: `#/new/${encodeURIComponent(t.id)}` }, "Run"),
                    h("a", { class: "btn small", href: `#/tasks/edit/${encodeURIComponent(t.id)}` }, "Edit"),
                    h("button", { class: "small danger", onclick: async () => {
                      if (!confirm(`Delete task "${t.title}"? Past evaluations are kept. Your project folder is not touched.`)) return;
                      await api(`tasks/${encodeURIComponent(t.id)}`, { method: "DELETE" });
                      setFlash("good", "Task deleted.");
                      viewTasks();
                    } }, "Delete"),
                  ),
                ),
              ),
            ),
          ),
        ),
  );
}

export async function viewTaskForm(id) {
  const [meta, existing] = await Promise.all([getMeta(true), id ? api(`tasks/${encodeURIComponent(id)}`) : null]);
  const t = existing ?? { title: "", prompt: "", source: "", tags: [], rubric: "quick-pairwise", checks: [], limits: {}, scopeGlobs: [] };

  const title = h("input", { type: "text", value: t.title, placeholder: "e.g. Add pagination to the users API" });
  const source = folderInput(t.source, "C:\\path\\to\\your\\project");
  const prompt = h("textarea", { rows: "8", value: t.prompt, placeholder: "What should the model do? Be as specific as you would be with a colleague." });
  const tags = h("input", { type: "text", value: (t.tags ?? []).join(", "), placeholder: "bugfix, typescript" });
  const rubric = h("select", {}, meta.rubrics.map((r) => h("option", { value: r.id }, r.name)));
  rubric.value = t.rubric;
  const checks = h("textarea", { rows: "3", value: (t.checks ?? []).map((c) => c.cmd).join("\n"), placeholder: "npm test\nnpm run lint" });
  const minutes = h("input", { type: "number", min: "1", max: "240", value: String(Math.round((t.limits?.wallClockSec ?? 600) / 60)), style: "width:90px" });
  const cost = h("input", { type: "number", min: "0", step: "0.1", value: t.limits?.maxCostUsd ?? "", placeholder: "none", style: "width:90px" });
  const calls = h("input", { type: "number", min: "1", value: String(t.limits?.maxToolCalls ?? 60), style: "width:90px" });
  const setup = h("input", { type: "text", value: t.setup ?? "", placeholder: "npm ci" });
  const image = h("input", { type: "text", value: t.image ?? "", placeholder: "node:22-bookworm-slim" });
  const network = h("select", {}, h("option", { value: "none" }, "No network (recommended)"), h("option", { value: "open" }, "Network allowed"));
  network.value = t.network ?? "none";
  const scope = h("input", { type: "text", value: (t.scopeGlobs ?? []).join(", "), placeholder: "src/**, test/**" });
  const msg = h("div");
  const save = h("button", { class: "primary" }, id ? "Save changes" : "Create task");

  save.addEventListener("click", async () => {
    save.disabled = true;
    msg.replaceChildren();
    try {
      const body = {
        title: title.value, prompt: prompt.value, source: source.input.value, tags: csv(tags.value), rubric: rubric.value,
        checks: checks.value.split("\n").map((cmd) => ({ cmd: cmd.trim(), kind: "test" })).filter((c) => c.cmd),
        setup: setup.value.trim() || undefined, image: image.value.trim() || undefined, network: network.value,
        limits: { wallClockSec: Math.round(Number(minutes.value || 10) * 60), maxCostUsd: cost.value ? Number(cost.value) : undefined, maxToolCalls: Number(calls.value || 60) },
        scopeGlobs: csv(scope.value),
      };
      const r = await api(id ? `tasks/${encodeURIComponent(id)}` : "tasks", json(id ? "PUT" : "POST", body));
      setFlash(r.warnings.length ? "" : "good", [`Task "${r.task.title}" saved.`, ...r.warnings].join(" "));
      location.hash = "#/tasks";
    } catch (err) {
      msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
      save.disabled = false;
    }
  });

  setView(
    h("div", { class: "muted small" }, h("a", { href: "#/tasks" }, "Tasks"), " / ", id ? "Edit" : "New"),
    h("h1", {}, id ? `Edit task` : "New task"),
    h("div", { class: "panel form", style: "max-width:820px" },
      field("Title", title),
      field("Project folder", source.el, "A git repo is pinned to its current commit, so every run starts from the same code. Uncommitted changes aren't included."),
      field("Prompt", prompt, "Given word for word to every contestant."),
      h("div", { class: "grid2" },
        field("Tags", tags, "Comma-separated. Ratings can be filtered by tag."),
        field("Rubric", rubric, "Quick pairwise: one question. Code review: 5 criteria + justification."),
      ),
      field("Checks", checks, "One command per line, run in the workspace after each contestant finishes. Exit code 0 = pass."),
      h("div", { class: "row" }, field("Time limit (min)", minutes), field("Cost cap ($)", cost), field("Max tool calls", calls)),
      h("details", {},
        h("summary", {}, "Advanced"),
        h("div", { class: "form", style: "margin-top:12px" },
          field("Setup command", setup, "Runs before the agent starts (e.g. install dependencies). Its changes aren't counted in the diff."),
          h("div", { class: "grid2" }, field("Docker image", image), field("Network", network)),
          field("Expected files (scope)", scope, "Comma-separated globs. Edits outside them are flagged as out of scope."),
        ),
      ),
      h("div", { class: "row" }, save, h("a", { class: "btn", href: "#/tasks" }, "Cancel")),
      msg,
    ),
  );
}

// ---------- contestants ----------

export async function viewContestants() {
  const [list, meta] = await Promise.all([api("contestants"), getMeta(true)]);
  const keySource = Object.fromEntries(meta.keys.map((k) => [k.name, k.source]));
  setView(
    h("div", { class: "row" }, h("h1", {}, "Contestants"), h("span", { class: "spacer" }), h("a", { class: "btn primary", href: "#/contestants/new" }, "Add contestant")),
    h("p", { class: "muted" }, "The models you can put head to head. Every contestant gets the same system prompt, tools and limits, so a comparison measures the model."),
    h("div", { class: "panel", style: "padding:0" },
      h("table", {},
        h("thead", {}, h("tr", {}, ["Name", "Provider", "Model", "API key", ""].map((c) => h("th", {}, c)))),
        h("tbody", {},
          list.map((c) => {
            const key = keyFor(c);
            return h("tr", {},
              h("td", {}, h("div", {}, c.displayName), h("div", { class: "muted small" }, c.id)),
              h("td", {}, c.provider),
              h("td", { class: "small" }, c.model ?? "–"),
              h("td", {}, key ? (keySource[key] ? h("span", { class: "badge good" }, `${key} ✓`) : h("a", { class: "badge warn", href: "#/settings" }, `${key} missing`)) : h("span", { class: "muted small" }, "not needed")),
              h("td", { class: "actions" },
                h("a", { class: "btn small", href: `#/contestants/edit/${encodeURIComponent(c.id)}` }, "Edit"),
                h("button", { class: "small danger", onclick: async () => {
                  if (!confirm(`Remove "${c.displayName}"? Past results keep their own copy of this contestant.`)) return;
                  await api("contestants", json("PUT", { contestants: list.filter((x) => x.id !== c.id) }));
                  setFlash("good", "Contestant removed.");
                  viewContestants();
                } }, "Remove"),
              ),
            );
          }),
        ),
      ),
    ),
  );
}

const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
// Params the structured form owns; anything else stays in "Advanced params".
const OWNED = { anthropic: ["effort", "apiKeyEnv"], "openai-compatible": ["baseUrl", "apiKeyEnv", "price"], mock: [] };

export async function viewContestantForm(id) {
  const [list, meta] = await Promise.all([api("contestants"), getMeta()]);
  const existing = id ? list.find((c) => c.id === id) : null;
  if (id && !existing) throw new Error(`No contestant "${id}"`);
  const c = existing ?? { id: "", displayName: "", provider: "anthropic", model: "", params: {} };
  const p = c.params ?? {};

  const name = h("input", { type: "text", value: c.displayName, placeholder: "Claude Opus 5 (high effort)" });
  const cid = h("input", { type: "text", value: c.id, placeholder: "auto from name", disabled: !!existing });
  if (!existing) name.addEventListener("input", () => { if (!cid.dataset.touched) cid.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); });
  cid.addEventListener("input", () => (cid.dataset.touched = "1"));
  const provider = h("select", {}, h("option", { value: "anthropic" }, "Anthropic (Claude)"), h("option", { value: "openai-compatible" }, "OpenAI-compatible (OpenAI, OpenRouter, Ollama, …)"), h("option", { value: "mock" }, "Mock (scripted, for testing)"));
  provider.value = c.provider;
  const model = h("input", { type: "text", value: c.model ?? "", list: "known-models" });
  const models = h("datalist", { id: "known-models" }, meta.knownModels.map((m) => h("option", { value: m })));
  const effort = h("select", {}, EFFORTS.map((e) => h("option", { value: e }, e || "model default")));
  effort.value = p.effort ?? "";
  const baseUrl = h("input", { type: "text", value: p.baseUrl ?? "", placeholder: "https://api.openai.com/v1  ·  http://localhost:11434/v1 for Ollama" });
  const keyEnv = h("input", { type: "text", value: p.apiKeyEnv ?? "", placeholder: "default" });
  const priceIn = h("input", { type: "number", min: "0", step: "0.01", value: p.price?.input ?? "", style: "width:110px" });
  const priceOut = h("input", { type: "number", min: "0", step: "0.01", value: p.price?.output ?? "", style: "width:110px" });
  const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !(OWNED[c.provider] ?? []).includes(k)));
  const advanced = h("textarea", { rows: "6", class: "mono", value: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : "" , placeholder: "{ }" });

  const providerFields = h("div", { class: "form" });
  const renderProvider = () => {
    const v = provider.value;
    providerFields.replaceChildren(
      ...[
        v !== "mock" && field("Model ID", model, v === "anthropic" ? "e.g. claude-opus-5, claude-sonnet-5" : "The provider's model name, e.g. qwen2.5-coder:14b"),
        v === "anthropic" && field("Effort", effort, "How hard the model thinks. Higher = better on hard tasks, more tokens."),
        v === "openai-compatible" && field("Base URL", baseUrl),
        v === "openai-compatible" && h("div", { class: "row" }, field("Input $ / 1M tokens", priceIn), field("Output $ / 1M tokens", priceOut), h("span", { class: "hint" }, "Needed for cost metrics; leave empty for free local models.")),
        v !== "mock" && field("API key name", keyEnv, `Which saved key to use. Default: ${v === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}. Set keys in Settings.`),
        v === "mock" && h("p", { class: "muted small" }, "Mock contestants replay a script (params.script) and cost nothing. Useful for trying Arbiter without API keys."),
      ].filter(Boolean),
    );
  };
  provider.addEventListener("change", renderProvider);
  renderProvider();

  const msg = h("div");
  const save = h("button", { class: "primary" }, existing ? "Save changes" : "Add contestant");
  save.addEventListener("click", async () => {
    save.disabled = true;
    msg.replaceChildren();
    try {
      let params = {};
      if (advanced.value.trim()) {
        try {
          params = JSON.parse(advanced.value);
        } catch {
          throw new Error("Advanced params must be valid JSON");
        }
      }
      const v = provider.value;
      if (v === "anthropic" && effort.value) params.effort = effort.value;
      if (v !== "mock" && keyEnv.value.trim()) params.apiKeyEnv = keyEnv.value.trim().toUpperCase();
      if (v === "openai-compatible") {
        if (baseUrl.value.trim()) params.baseUrl = baseUrl.value.trim();
        if (priceIn.value !== "" && priceOut.value !== "") params.price = { input: Number(priceIn.value), output: Number(priceOut.value) };
      }
      const next = { id: cid.value.trim(), displayName: name.value.trim(), provider: v, ...(v !== "mock" ? { model: model.value.trim() } : {}), params };
      const updated = existing ? list.map((x) => (x.id === existing.id ? next : x)) : [...list, next];
      await api("contestants", json("PUT", { contestants: updated }));
      setFlash("good", `Saved "${next.displayName}".`);
      location.hash = "#/contestants";
    } catch (err) {
      msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
      save.disabled = false;
    }
  });

  setView(
    h("div", { class: "muted small" }, h("a", { href: "#/contestants" }, "Contestants"), " / ", existing ? "Edit" : "New"),
    h("h1", {}, existing ? `Edit ${existing.displayName}` : "Add contestant"),
    h("div", { class: "panel form", style: "max-width:720px" },
      h("div", { class: "grid2" }, field("Display name", name, "Shown only after a blind review is submitted."), field("ID", cid, existing ? "IDs can't change: past results refer to them." : "Letters, digits, - _ .")),
      field("Provider", provider),
      providerFields,
      models,
      h("details", { open: Object.keys(rest).length > 0 || undefined },
        h("summary", {}, "Advanced params (JSON)"),
        h("div", { style: "margin-top:8px" }, advanced, h("span", { class: "hint" }, "Extra provider options, e.g. maxOutputTokens, thinking, extraBody, or a mock script."))),
      h("div", { class: "row" }, save, h("a", { class: "btn", href: "#/contestants" }, "Cancel")),
      msg,
    ),
  );
}

// ---------- settings ----------

export async function viewSettings() {
  const meta = await getMeta(true);
  const status = (ok, good, badText) => (ok ? h("span", { class: "badge good" }, good) : h("span", { class: "badge bad" }, badText));

  const keyRow = (k) => {
    const input = h("input", { type: "password", placeholder: k.source ? "Replace key…" : "Paste key…", autocomplete: "off", spellcheck: "false", style: "flex:1;min-width:180px" });
    const save = h("button", { onclick: async () => {
      if (!input.value.trim()) return;
      await api(`secrets/${k.name}`, json("PUT", { value: input.value }));
      setFlash("good", `${k.name} saved (encrypted).`);
      viewSettings();
    } }, "Save");
    const remove = k.source === "store" && h("button", { class: "danger", onclick: async () => {
      if (!confirm(`Remove the saved ${k.name}?`)) return;
      await api(`secrets/${k.name}`, { method: "DELETE" });
      setFlash("good", `${k.name} removed.`);
      viewSettings();
    } }, "Remove");
    return h("tr", {},
      h("td", { class: "mono small" }, k.name),
      h("td", {}, k.source === "store" ? h("span", { class: "badge good" }, "saved") : k.source === "env" ? h("span", { class: "badge accent" }, "from environment") : h("span", { class: "badge" }, "not set")),
      h("td", {}, meta.secretStore ? h("div", { class: "row", style: "flex-wrap:nowrap" }, input, save, remove) : h("span", { class: "muted small" }, "Set as an environment variable")),
    );
  };

  const custom = h("input", { type: "text", placeholder: "OTHER_API_KEY", style: "width:220px" });

  setView(
    h("h1", {}, "Settings"),
    h("h2", {}, "API keys"),
    h("p", { class: "muted" }, meta.mode === "managed"
      ? `Keys live on this server only, encrypted (AES-256-GCM) with ${meta.vaultKeySource === "env" ? "the ARBITER_MASTER_KEY you provided" : "a key file in the server's data folder. For stronger protection, start the server with ARBITER_MASTER_KEY set"}. Annotators never see them, and they're never passed to agent commands.`
      : meta.secretStore
        ? "Keys are encrypted by your operating system and stored in the data folder. They're sent only to the provider they belong to, and are never shown again or passed to agent commands."
        : "Running without the desktop app: keys come from environment variables."),
    h("div", { class: "panel", style: "padding:0" }, h("table", {}, h("tbody", {}, meta.keys.map(keyRow)))),
    meta.secretStore && h("div", { class: "row", style: "margin-top:8px" }, custom,
      h("button", { onclick: () => {
        const n = custom.value.trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(n)) return alert("Key names look like MY_PROVIDER_API_KEY");
        meta.keys.push({ name: n, source: null });
        document.querySelector("#app table tbody").append(keyRow({ name: n, source: null }));
        custom.value = "";
      } }, "Add key name")),

    h("h2", {}, "Environment"),
    h("div", { class: "panel" },
      h("table", {}, h("tbody", {},
        h("tr", {}, h("td", {}, "Git"), h("td", {}, status(meta.git, meta.git ?? "", "not found")), h("td", { class: "muted small" }, meta.git ? "Used to snapshot workspaces and capture diffs." : "Required. Install Git for Windows (git-scm.com), then restart Arbiter.")),
        h("tr", {}, h("td", {}, "Docker"), h("td", {}, meta.docker ? h("span", { class: "badge good" }, "running") : h("span", { class: "badge warn" }, "not running")),
          h("td", { class: "muted small" }, meta.docker ? "Agent commands run in isolated containers." : "Agent commands will run directly on this computer (no isolation). Start Docker Desktop for isolation.")),
        h("tr", {}, h("td", {}, "Data folder"), h("td", { class: "mono small", style: "word-break:break-all" }, meta.home),
          h("td", {}, desktop && h("button", { class: "small", onclick: () => desktop.openPath(meta.home) }, "Open"))),
        h("tr", {}, h("td", {}, "Version"), h("td", {}, meta.version), h("td", { class: "muted small" }, `Price table ${meta.priceTable}`)),
      )),
    ),
  );
}

// ---------- managed workspaces (joining an evaluation team's Arbiter server) ----------

export async function viewWorkspaces() {
  const list = await api("workspaces");
  const name = h("input", { type: "text", placeholder: "Acme Evals" });
  const url = h("input", { type: "text", placeholder: "https://arbiter.example.com", style: "width:320px" });
  const msg = h("div");
  const save = async (next) => {
    await api("workspaces", json("PUT", { workspaces: next }));
    viewWorkspaces();
  };
  const open = async (w) => {
    msg.replaceChildren();
    if (!desktop?.openManaged) return window.open(`${w.url}/annotate`, "_blank", "noopener");
    const r = await desktop.openManaged(w.url);
    if (!r.ok) msg.replaceChildren(h("div", { class: "notice bad" }, r.error ?? "Couldn't open the workspace"));
  };
  setView(
    h("h1", {}, "Managed workspaces"),
    h("p", { class: "muted" }, "Evaluation teams run an Arbiter server and invite annotators. Add a team's server here to review for them. ",
      "Their review work opens in a protected window: screenshots and screen recording are blocked, nothing is saved to this computer, and closing the window signs you out."),
    !desktop && h("div", { class: "notice" }, "You're in browser mode, so workspaces open in a normal browser tab without these protections. Use the Arbiter desktop app for protected reviewing."),
    list.length === 0
      ? h("div", { class: "panel empty" }, "No workspaces yet. Add the server address your team gave you.")
      : h("div", { class: "panel", style: "padding:0" }, h("table", {}, h("tbody", {}, list.map((w, i) => h("tr", {},
          h("td", {}, h("div", {}, w.name), h("div", { class: "muted small mono" }, w.url)),
          h("td", { class: "actions" },
            h("button", { class: "primary small", onclick: () => open(w) }, "Open"),
            h("button", { class: "small danger", onclick: () => confirm(`Remove ${w.name}?`) && save(list.filter((_, j) => j !== i)) }, "Remove"))))))),
    h("h2", {}, "Add a workspace"),
    h("div", { class: "panel stack" },
      h("div", { class: "row" }, field("Name", name), field("Server address", url)),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => {
        msg.replaceChildren();
        try {
          await api("workspaces", json("PUT", { workspaces: [...list, { name: name.value, url: url.value }] }));
          viewWorkspaces();
        } catch (err) {
          msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
        }
      } }, "Add")),
      h("p", { class: "hint" }, "New to the team? Open the workspace and choose “I have an invite” to create your account with the code you were sent."),
      msg),
  );
}
