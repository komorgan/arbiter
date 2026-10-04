// Rubric list and editor, shared by the personal app and the Managed admin dashboard.
import { api, field, h, json, setFlash, setView } from "./lib.js";

const QTYPES = { pairwise: "Pairwise (A vs B scale)", likert: "Score each side", flag: "Checkbox per side", text: "Written answer" };
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

export async function viewRubrics() {
  const list = await api("rubrics");
  setView(
    h("div", { class: "row" }, h("h1", {}, "Rubrics"), h("span", { class: "spacer" }), h("a", { class: "btn primary", href: "#/rubrics/new" }, "New rubric")),
    h("p", { class: "muted" }, "The questions a reviewer answers for each comparison. Once reviews use a rubric its questions are locked (you can still reword them), so stored answers keep their meaning."),
    h("div", { class: "panel", style: "padding:0" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Rubric", "Questions", "Used by", ""].map((c) => h("th", {}, c)))),
      h("tbody", {}, list.map((r) => h("tr", {},
        h("td", {},
          h("div", {}, r.name,
            r.builtin && h("span", { class: "badge", style: "margin-left:6px" }, "built-in"),
            !r.builtin && r.locked && h("span", { class: "badge", style: "margin-left:6px", title: "Reviews use this rubric" }, "locked")),
          h("div", { class: "muted small mono" }, r.id),
          r.description && h("div", { class: "muted small" }, r.description)),
        h("td", { class: "small" }, r.criteria.map((c) => c.label).join(" · ")),
        h("td", { class: "muted small" }, r.usedBy.length ? r.usedBy.join(", ") : "–"),
        h("td", { class: "actions" },
          !r.builtin && h("a", { class: "btn small", href: `#/rubrics/edit/${encodeURIComponent(r.id)}` }, "Edit"),
          h("a", { class: "btn small", href: `#/rubrics/copy/${encodeURIComponent(r.id)}` }, "Duplicate"),
          !r.builtin && h("button", { class: "small danger", onclick: async () => {
            if (!confirm(`Delete the rubric "${r.name}"?`)) return;
            try {
              await api(`rubrics/${encodeURIComponent(r.id)}`, { method: "DELETE" });
              setFlash("good", "Rubric deleted.");
            } catch (err) {
              setFlash("bad", err.message);
            }
            viewRubrics();
          } }, "Delete"))))))),
  );
}

/** mode: "new" | "edit" | "copy". For edit and copy, id names the source rubric. */
export async function viewRubricForm(mode, id) {
  const list = await api("rubrics");
  const src = id ? list.find((r) => r.id === id) : null;
  if (id && !src) throw new Error(`No rubric "${id}"`);
  const editing = mode === "edit";
  const locked = editing && src.locked;
  const start = src
    ? JSON.parse(JSON.stringify(src))
    : { name: "", description: "", criteria: [{ id: "overall", type: "pairwise", label: "Which result is better overall?", scale: 7 }, { id: "notes", type: "text", label: "Notes" }] };
  if (mode === "copy") start.name = `${src.name} (copy)`;

  const name = h("input", { type: "text", value: start.name });
  const rid = h("input", { type: "text", value: editing ? start.id : "", placeholder: "auto from name", disabled: editing });
  const description = h("textarea", { rows: "2", value: start.description ?? "", placeholder: "Optional: when to use this rubric" });
  // Questions copied from an existing rubric keep their ids when reworded; new ones derive an id from the label.
  const criteria = start.criteria.map((c) => ({ ...c, _keepId: !!src }));
  const listEl = h("div", { class: "stack" });
  const msg = h("div");

  const renderCriteria = () => {
    listEl.replaceChildren(...criteria.map((c, i) => {
      const fixed = locked || c.id === "overall";
      const cid = h("input", { type: "text", value: c.id, class: "mono", style: "width:150px", disabled: fixed, oninput: (e) => { c.id = e.target.value; c._keepId = true; } });
      const label = h("input", { type: "text", value: c.label, placeholder: "The question reviewers answer", style: "width:100%", oninput: (e) => {
        c.label = e.target.value;
        if (!c._keepId && !fixed) cid.value = c.id = slugify(c.label) || `q${i + 1}`;
      } });
      const type = h("select", { disabled: fixed, onchange: (e) => { c.type = e.target.value; renderCriteria(); } }, Object.entries(QTYPES).map(([v, l]) => h("option", { value: v }, l)));
      type.value = c.type;
      const opts = [];
      if (c.type === "pairwise") {
        const sel = h("select", { disabled: locked, onchange: (e) => (c.scale = Number(e.target.value)) }, [3, 5, 7].map((n) => h("option", { value: String(n) }, `${n}-point`)));
        sel.value = String(c.scale ?? 7);
        opts.push(field("Scale", sel));
      }
      if (c.type === "likert") {
        const sel = h("select", { disabled: locked, onchange: (e) => (c.max = Number(e.target.value)) }, [5, 7].map((n) => h("option", { value: String(n) }, `1 to ${n}`)));
        sel.value = String(c.max ?? 5);
        opts.push(field("Range", sel));
      }
      if (c.type === "text") {
        opts.push(field("Min. characters", h("input", { type: "number", min: "0", value: String(c.minChars ?? 0), disabled: locked, style: "width:90px", oninput: (e) => (c.minChars = Number(e.target.value)) })));
        opts.push(h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!c.required, disabled: locked, onchange: (e) => (c.required = e.target.checked) }), "Required"));
      }
      const move = (d) => {
        const j = i + d;
        if (j < 0 || j >= criteria.length) return;
        [criteria[i], criteria[j]] = [criteria[j], criteria[i]];
        renderCriteria();
      };
      return h("div", { class: "panel" },
        h("div", { class: "row", style: "flex-wrap:nowrap" },
          h("b", { class: "muted" }, `${i + 1}.`), h("div", { style: "flex:1" }, label),
          !locked && h("button", { class: "small", title: "Move up", onclick: () => move(-1) }, "↑"),
          !locked && h("button", { class: "small", title: "Move down", onclick: () => move(1) }, "↓"),
          !locked && c.id !== "overall" && h("button", { class: "small danger", onclick: () => { criteria.splice(i, 1); renderCriteria(); } }, "Remove")),
        h("div", { class: "row", style: "margin-top:8px" }, field("Type", type), field("ID", cid), ...opts),
        c.id === "overall" && h("div", { class: "hint" }, "Required: this question decides who wins each comparison."));
    }));
  };
  renderCriteria();

  const save = h("button", { class: "primary", onclick: async () => {
    msg.replaceChildren();
    try {
      const body = {
        id: editing ? start.id : rid.value.trim(),
        name: name.value,
        description: description.value,
        criteria: criteria.map(({ _keepId, ...c }) => c),
      };
      await api(editing ? `rubrics/${encodeURIComponent(start.id)}` : "rubrics", json(editing ? "PUT" : "POST", body));
      setFlash("good", "Rubric saved.");
      location.hash = "#/rubrics";
    } catch (err) {
      msg.replaceChildren(h("div", { class: "notice bad" }, err.message));
    }
  } }, editing ? "Save changes" : "Create rubric");

  setView(
    h("div", { class: "muted small" }, h("a", { href: "#/rubrics" }, "Rubrics"), " / ", editing ? start.name : "New"),
    h("h1", {}, editing ? "Edit rubric" : mode === "copy" ? "Duplicate rubric" : "New rubric"),
    locked && h("div", { class: "notice" }, "Reviews already use this rubric, so its questions are locked. You can still reword the name, description and question labels."),
    h("div", { class: "panel form", style: "max-width:900px" },
      h("div", { class: "grid2" }, field("Name", name), field("ID", rid, editing ? "IDs can't change." : "Used in task files (rubric: …).")),
      field("Description", description),
      h("h3", {}, "Questions"),
      listEl,
      !locked && h("div", { class: "row" }, h("button", { onclick: () => { criteria.push({ id: `q${criteria.length + 1}`, type: "pairwise", label: "", scale: 7, _keepId: false }); renderCriteria(); } }, "Add question")),
      h("div", { class: "row" }, save, h("a", { class: "btn", href: "#/rubrics" }, "Cancel")),
      msg),
  );
}
