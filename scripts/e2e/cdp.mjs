// Chrome DevTools Protocol helper for testing the Electron app. Launch it with a debugging port, e.g.:
//   npm run build && npx electron . --remote-debugging-port=9333
// then: import { connect } from "./cdp.mjs"; const { ev, api } = await connect(); await api("settings");
export async function connect() {
  let pages = [];
  for (let i = 0; i < 40 && !pages.length; i++) {
    try { pages = (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((p) => p.type === "page" && p.url.startsWith("http://127.0.0.1")); } catch {}
    if (!pages.length) await new Promise((r) => setTimeout(r, 1000));
  }
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); });
  const raw = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await raw("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const api = async (path, method = "GET", body) => JSON.parse(await ev(`fetch('/api/${path}', { method: '${method}', headers: { 'content-type': 'application/json', 'x-arbiter': '1', 'x-arbiter-token': window.arbiterDesktop.token }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }).then(r => r.text())`));
  return { ws, raw, ev, api };
}
