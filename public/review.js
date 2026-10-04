// Blind-review building blocks shared by the personal app (app.js) and the Managed annotator client (annotate.js).
// Everything shown here is untrusted model output and only ever goes into text nodes.
import { fmt, h, pref, statusBadge } from "./lib.js";

function parseDiff(text) {
  const files = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { name: line.replace(/^diff --git a\/(.*?) b\/.*$/, "$1"), lines: [], added: 0, removed: 0, isNew: false };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("new file")) cur.isNew = true;
    else if (/^(index |--- |\+\+\+ |old mode|new mode|deleted file|similarity|rename )/.test(line)) continue;
    else {
      if (line.startsWith("+")) cur.added++;
      if (line.startsWith("-")) cur.removed++;
      cur.lines.push(line);
    }
  }
  return files;
}

export function diffView(text) {
  const files = parseDiff(text);
  if (files.length === 0) return h("div", { class: "empty" }, "No changes.");
  return files.map((f) =>
    h("div", { class: "diff" },
      h("div", { class: "diff-file" }, h("span", {}, f.name), f.isNew && h("span", { class: "badge accent" }, "new"), h("span", { class: "spacer" }), h("span", { class: "muted" }, `+${f.added} −${f.removed}`)),
      h("pre", {}, f.lines.map((l) => h("span", { class: `ln ${l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}` }, l))),
    ),
  );
}

export function checksView(checks) {
  if (checks.length === 0) return h("div", { class: "empty" }, "No checks ran.");
  return checks.map((c) =>
    h("details", { class: "stack", open: !c.passed },
      h("summary", {}, h("span", { class: `badge ${c.passed ? "good" : "bad"}` }, c.passed ? "pass" : "fail"), " ", h("b", {}, c.id), " ", h("code", { class: "muted" }, c.cmd), h("span", { class: "muted small" }, ` · ${c.durationSec.toFixed(1)}s`)),
      h("div", { class: "check-out" }, c.output.trim() || "(no output)"),
    ),
  );
}

export function transcriptView(events) {
  if (events.length === 0) return h("div", { class: "empty" }, "No transcript.");
  const label = { assistant_text: "said", tool_call: "called", tool_result: "result", error: "error", limit: "limit hit", finish: "finished", info: "info" };
  return h("div", { class: "transcript" },
    events.map((e) =>
      h("div", { class: `ev ${e.type}` },
        h("div", { class: "small" }, h("span", { class: "muted" }, `${e.t.toFixed(1)}s `), h("b", {}, label[e.type] ?? e.type), e.tool && ` ${e.tool}`, e.isError && h("span", { class: "badge bad", style: "margin-left:6px" }, "error")),
        e.type === "tool_call" ? h("pre", {}, e.input ?? "") : e.text && h(e.type === "assistant_text" || e.type === "finish" ? "div" : "pre", {}, e.text),
      ),
    ),
  );
}

export function metricsView(m) {
  if (!m) return h("div", { class: "muted small" }, "No metrics (run did not complete).");
  const item = (v, k) => h("div", { class: "metric" }, h("b", {}, v), h("span", {}, k));
  return h("div", { class: "metrics" },
    item(`${m.checksPassed}/${m.checksTotal}`, "checks passed"),
    item(fmt.usd(m.costUsd), "cost"),
    item(fmt.sec(m.wallSec), "wall time"),
    item(fmt.int(m.inputTokens + m.outputTokens), "tokens"),
    item(m.toolCalls, "tool calls"),
    item(`+${m.linesAdded} −${m.linesRemoved}`, "lines"),
    item(m.filesTouched, "files touched"),
    item(m.outOfScopeFiles, "out of scope"),
  );
}

export function sideView(label, side, showMetrics, { showTranscript = true } = {}) {
  const body = h("div");
  const tabs = showTranscript ? ["Diff", "Checks", "Transcript"] : ["Diff", "Checks"];
  let active = pref.get("reviewTab", "Diff");
  if (!tabs.includes(active)) active = "Diff";
  const tabBar = h("div", { class: "tabs" });
  const render = () => {
    tabBar.replaceChildren(...tabs.map((t) => h("button", { class: t === active ? "active" : "", onclick: () => { active = t; pref.set("reviewTab", t); render(); } }, t)));
    body.replaceChildren(...[active === "Diff" ? diffView(side.diff) : active === "Checks" ? checksView(side.checks) : transcriptView(side.transcript)].flat());
  };
  render();
  return h("div", { class: "side panel" },
    h("div", { class: "side-head" }, h("div", { class: "side-label" }, label), statusBadge(side.status), side.error && h("span", { class: "muted small" }, side.error)),
    side.summary && h("p", { class: "small" }, h("b", {}, "Agent's summary: "), side.summary),
    showMetrics && metricsView(side.metrics),
    tabBar,
    body,
  );
}

/** opts.extra: more buttons next to Submit (e.g. Skip). opts.submitLabel overrides the button text. */
export function rubricForm(rubric, guessOptions, onSubmit, opts = {}) {
  const answers = {};
  const guess = {};
  const scaleLabels = (k) => {
    const out = [];
    for (let v = -k; v <= k; v++) out.push([v, v === 0 ? "Tie" : `${v < 0 ? "A" : "B"}${Math.abs(v) === k ? " much" : Math.abs(v) === 1 ? " slightly" : ""} better`]);
    return out;
  };
  const likertRow = (c, side) =>
    h("div", { class: "scale" },
      Array.from({ length: c.max - c.min + 1 }, (_, i) => c.min + i).map((v) =>
        h("label", {}, h("input", { type: "radio", name: `${c.id}-${side}`, onchange: () => (answers[c.id] = { ...(answers[c.id] ?? {}), [side]: v }) }), String(v)),
      ),
    );

  const fields = rubric.criteria.map((c) => {
    switch (c.type) {
      case "pairwise":
        return h("div", { class: "crit" }, h("b", {}, c.label),
          h("div", { class: "scale" }, scaleLabels((c.scale - 1) / 2).map(([v, text]) =>
            h("label", {}, h("input", { type: "radio", name: c.id, onchange: () => (answers[c.id] = v) }), text))));
      case "likert":
        return h("div", { class: "crit" }, h("b", {}, c.label), h("span", { class: "muted small" }, `  score ${c.min} (lowest) to ${c.max} (highest)`),
          h("div", { class: "per-side" }, h("b", {}, "A"), likertRow(c, "A"), h("b", {}, "B"), likertRow(c, "B")));
      case "flag":
        answers[c.id] = { A: false, B: false };
        return h("div", { class: "crit row" }, h("b", {}, c.label), h("span", { class: "spacer" }),
          ["A", "B"].map((s) => h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => (answers[c.id][s] = e.target.checked) }), s)));
      case "text":
        return h("div", { class: "crit" }, h("b", {}, c.label, c.required ? " *" : ""),
          h("textarea", { placeholder: c.minChars ? `At least ${c.minChars} characters` : "", oninput: (e) => (answers[c.id] = e.target.value) }));
    }
  });

  const guessSel = (side) =>
    h("select", { onchange: (e) => (guess[side] = e.target.value || undefined) }, h("option", { value: "" }, "no guess"), guessOptions.map((o) => h("option", { value: o }, o)));
  const msg = h("div");
  const btn = h("button", { class: "primary" }, opts.submitLabel ?? "Submit review");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    msg.replaceChildren();
    try {
      await onSubmit(answers, guess);
    } catch (err) {
      msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
      btn.disabled = false;
    }
  });

  return h("div", { class: "panel rubric" },
    h("h3", {}, rubric.name),
    fields,
    guessOptions.length > 0 && h("div", { class: "crit" }, h("b", {}, "Which model do you think each side is? "), h("span", { class: "muted small" }, "(optional — measures how blind the review really was)"),
      h("div", { class: "row", style: "margin-top:6px" }, "A: ", guessSel("A"), "B: ", guessSel("B"))),
    h("div", { class: "row", style: "margin-top:12px" }, btn, opts.extra),
    msg,
  );
}
