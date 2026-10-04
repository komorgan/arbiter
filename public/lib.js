// Shared UI helpers. Everything rendered from run artifacts is untrusted model output:
// it only ever goes into text nodes (h() never sets innerHTML).

const app = document.getElementById("app");
let pollTimer = null;
let lastHash = null;

/** Desktop shell bridge (from preload), or null when running in a plain browser via `arbiter serve`. */
export const desktop = window.arbiterDesktop ?? null;

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled" || k === "value") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Called when the server says the session is gone (Managed mode), so the page can show sign-in again.
let unauthorized = null;
export function onUnauthorized(fn) {
  unauthorized = fn;
}

export async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      "x-arbiter": "1",
      ...(desktop?.token ? { "x-arbiter-token": desktop.token } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && unauthorized && !path.startsWith("auth/")) unauthorized();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const json = (method, body) => ({ method, body: JSON.stringify(body) });

export const pref = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`arbiter.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`arbiter.${k}`, JSON.stringify(v));
    } catch {}
  },
};

export const fmt = {
  usd: (x) => (x == null ? "?" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`),
  sec: (x) => (x == null ? "?" : x < 60 ? `${x.toFixed(1)}s` : `${Math.floor(x / 60)}m ${Math.round(x % 60)}s`),
  int: (x) => (x == null ? "?" : Number(x).toLocaleString()),
  pct: (x) => (x == null ? "–" : `${Math.round(x * 100)}%`),
  date: (s) => new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
};

export function statusBadge(s) {
  const cls = { finished: "good", ready: "accent", failed: "bad", refused: "warn", limit_hit: "warn", running: "", queued: "" }[s] ?? "";
  return h("span", { class: `badge ${cls}` }, s.replace("_", " "));
}

// A one-shot message shown at the top of the next page (e.g. "Task saved").
let flash = null;
export function setFlash(kind, text) {
  flash = { kind, text };
}

export function setView(...nodes) {
  clearInterval(pollTimer);
  pollTimer = null;
  const f = flash && h("div", { class: `notice ${flash.kind}`, style: "margin-bottom:16px" }, flash.text);
  flash = null;
  app.replaceChildren(...[f, nodes].flat(Infinity).filter((n) => n != null && n !== false));
  // Scroll to the top on navigation, but not when a poll re-renders the same page.
  if (location.hash !== lastHash) window.scrollTo(0, 0);
  lastHash = location.hash;
}

export function poll(fn, ms) {
  clearInterval(pollTimer);
  pollTimer = setInterval(fn, ms);
}

export function errorView(err) {
  setView(h("div", { class: "notice bad" }, err.message ?? String(err)));
}

let metaCache = null;
/** Settings/status from the engine; cached per page load, refreshed with force. */
export async function getMeta(force = false) {
  if (force || !metaCache) metaCache = await api("settings");
  return metaCache;
}

/** Labelled form field. */
export function field(label, control, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint && h("span", { class: "hint" }, hint));
}

/** A text input + "Browse…" (desktop) for choosing a folder. */
export function folderInput(value, placeholder) {
  const input = h("input", { type: "text", value: value ?? "", placeholder, style: "flex:1" });
  const browse = desktop
    ? h("button", { type: "button", onclick: async () => { const p = await desktop.pickFolder("Choose the project folder"); if (p) input.value = p; } }, "Browse…")
    : null;
  return { input, el: h("div", { class: "row", style: "flex-wrap:nowrap" }, input, browse) };
}

/** Which API key a contestant needs, if any. */
export function keyFor(c) {
  if (c.provider === "anthropic") return c.params?.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  if (c.provider === "openai-compatible") {
    const base = String(c.params?.baseUrl ?? "https://api.openai.com/v1");
    // Local servers (Ollama, LM Studio) usually need no key.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(base) && !c.params?.apiKeyEnv) return null;
    return c.params?.apiKeyEnv ?? "OPENAI_API_KEY";
  }
  return null;
}
