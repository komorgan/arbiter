// Local HTTP API + static UI. This is the "runner interface" from the spec: the desktop app, the browser
// (`arbiter serve`) and, later, the Managed-mode web client all talk to the engine through these endpoints.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { arbiterHome, loadContestants, paths, resourceRoot, saveContestants } from "./config.ts";
import { KNOWN_MODELS, PRICE_TABLE_VERSION } from "./pricing.ts";
import { deleteRubric, listRubrics, saveRubric } from "./rubrics.ts";
import { createEvaluation, executeEvaluation } from "./runner.ts";
import { detectDocker, localSandboxAllowed } from "./sandbox/index.ts";
import { run } from "./sandbox/exec.ts";
import { secrets, WELL_KNOWN_KEYS } from "./secrets.ts";
import { deleteTask, listTasks, readTaskInput, saveTask } from "./task.ts";
import { ApiError, managedApi, sessionToken, type ManagedOptions } from "./managed/api.ts";
import { authenticate } from "./managed/auth.ts";
import type { User } from "./managed/db.ts";
import type { Contestant } from "./types.ts";
import { assignmentView, deleteEvaluation, evaluationDetail, listEvaluations, ratingsView, submitAssignment } from "./views.ts";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ServeOptions {
  port: number; // 0 = pick a free port
  /** When set, every API request must carry it in `x-arbiter-token`. The desktop app always sets one. */
  token?: string;
  /** Host-app hooks the UI can call through the API (desktop only). */
  appInfo?: { version: string; desktop: boolean };
  /** Bind address. Personal mode is always 127.0.0.1; a Managed server may bind elsewhere (behind a TLS proxy). */
  host?: string;
  /** Present = this is a Managed-mode server: session auth, roles, annotator and admin routes. */
  managed?: ManagedOptions;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new HttpError(413, "body too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

const bad = (err: unknown) => new HttpError(400, err instanceof Error ? err.message : String(err));

let gitVersion: string | null | undefined;
async function detectGit(): Promise<string | null> {
  if (gitVersion === undefined) {
    const r = await run("git", ["--version"], { timeoutSec: 10, env: process.env });
    gitVersion = r.exitCode === 0 ? r.stdout.trim() : null;
  }
  return gitVersion;
}

/** Key names the user may need: well-known ones plus any apiKeyEnv a contestant references. */
function keyNames(contestants: Contestant[]): string[] {
  const names = new Set(WELL_KNOWN_KEYS);
  for (const c of contestants) if (typeof c.params?.apiKeyEnv === "string") names.add(c.params.apiKeyEnv);
  for (const n of secrets.storedNames()) names.add(n);
  return [...names];
}

async function api(req: http.IncomingMessage, url: URL, opts: ServeOptions): Promise<unknown> {
  const [resource, id, action] = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
  const method = req.method ?? "GET";
  const route = `${method} ${resource}${id ? "/:id" : ""}${action ? `/${action}` : ""}`;

  switch (route) {
    case "GET meta":
    case "GET settings": {
      const contestants = safe(loadContestants, []);
      return {
        home: arbiterHome(),
        docker: await detectDocker(),
        git: await detectGit(),
        version: opts.appInfo?.version ?? "dev",
        desktop: opts.appInfo?.desktop ?? false,
        priceTable: PRICE_TABLE_VERSION,
        secretStore: secrets.writable(),
        keys: keyNames(contestants).map((name) => ({ name, source: secrets.source(name) })),
        knownModels: KNOWN_MODELS,
        rubrics: listRubrics().map((r) => ({ id: r.id, name: r.name, builtin: r.builtin })),
        mode: opts.managed ? "managed" : "personal",
        vaultKeySource: opts.managed?.vaultKeySource ?? null,
        localSandbox: localSandboxAllowed(),
        publicUrl: opts.managed?.publicUrl ?? null,
      };
    }

    case "GET auth/me":
      return { mode: "personal" };

    // Managed workspaces this desktop user has joined (server URLs only; nothing sensitive).
    case "GET workspaces":
      return readWorkspaces();
    case "PUT workspaces": {
      if (opts.managed) throw new HttpError(404, "not found");
      const body = await readBody(req);
      const list = Array.isArray(body.workspaces) ? body.workspaces : [];
      const clean = list.map((w: { name?: unknown; url?: unknown }) => {
        const url = String(w?.url ?? "").trim().replace(/\/+$/, "");
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new HttpError(400, `Not a valid server URL: ${url}`);
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new HttpError(400, `Server URLs must start with https:// or http://`);
        return { name: String(w?.name ?? "").trim().slice(0, 100) || parsed.host, url: parsed.origin };
      });
      fs.writeFileSync(path.join(arbiterHome(), "workspaces.json"), JSON.stringify(clean, null, 2));
      return clean;
    }

    case "PUT secrets/:id": {
      const body = await readBody(req);
      if (typeof body.value !== "string" || !body.value.trim()) throw new HttpError(400, "value is required");
      try {
        secrets.set(id, body.value);
      } catch (err) {
        throw bad(err);
      }
      return { name: id, source: secrets.source(id) };
    }
    case "DELETE secrets/:id":
      secrets.delete(id);
      return { name: id, source: secrets.source(id) };

    case "GET contestants":
      return loadContestants();
    case "PUT contestants": {
      const body = await readBody(req);
      if (!Array.isArray(body.contestants)) throw new HttpError(400, "contestants must be a list");
      try {
        return saveContestants(body.contestants);
      } catch (err) {
        throw bad(err);
      }
    }

    case "GET tasks":
      return listTasks(paths.tasks());
    case "GET tasks/:id": {
      const dir = path.join(paths.tasks(), id);
      if (path.dirname(dir) !== paths.tasks() || !fs.existsSync(dir)) throw new HttpError(404, "no such task");
      return readTaskInput(dir);
    }
    case "POST tasks":
    case "PUT tasks/:id": {
      const body = (await readBody(req)) as never as Parameters<typeof saveTask>[0];
      if (id) body.id = id;
      return saveTask(body, paths.tasks(), { overwrite: !!id }).catch((err) => Promise.reject(bad(err)));
    }
    case "DELETE tasks/:id":
      try {
        deleteTask(id, paths.tasks());
      } catch (err) {
        throw bad(err);
      }
      return { ok: true };

    case "GET rubrics":
      return listRubrics();
    case "POST rubrics":
    case "PUT rubrics/:id": {
      const body = await readBody(req);
      try {
        return saveRubric(body, id || undefined);
      } catch (err) {
        throw bad(err);
      }
    }
    case "DELETE rubrics/:id":
      try {
        deleteRubric(id);
      } catch (err) {
        throw bad(err);
      }
      return { ok: true };

    case "GET ratings":
      return ratingsView(url.searchParams.get("tag") || undefined);

    case "GET evaluations":
      return listEvaluations();
    case "GET evaluations/:id":
      return evaluationDetail(id) ?? Promise.reject(new HttpError(404, "not found"));
    case "POST evaluations": {
      const body = await readBody(req);
      const evId = await createEvaluation({
        taskPath: String(body.taskPath ?? ""),
        contestantIds: (body.contestantIds as string[]) ?? [],
        repeats: Number(body.repeats ?? 1),
        sandbox: (body.sandbox as "auto" | "docker" | "local") ?? "auto",
      }).catch((err) => Promise.reject(bad(err)));
      // Runs in the background; the UI polls the evaluation for progress.
      executeEvaluation(evId, (m) => console.log(`[eval ${evId}] ${m}`)).catch((err) => console.error(`[eval ${evId}]`, err));
      return { id: evId };
    }
    case "DELETE evaluations/:id":
      try {
        deleteEvaluation(id);
      } catch (err) {
        throw bad(err);
      }
      return { ok: true };

    case "GET assignments/:id":
      return assignmentView(id) ?? Promise.reject(new HttpError(404, "not found"));
    case "POST assignments/:id/submit": {
      const body = await readBody(req);
      try {
        return submitAssignment(id, body as Parameters<typeof submitAssignment>[1]);
      } catch (err) {
        throw bad(err);
      }
    }
  }
  throw new HttpError(404, "not found");
}

function readWorkspaces(): { name: string; url: string }[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(arbiterHome(), "workspaces.json"), "utf8"));
  } catch {
    return [];
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function tokenOk(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function hostAllowed(host: string | undefined, opts: ServeOptions): boolean {
  if (!host) return false;
  if (LOCAL_HOST.test(host)) return true;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return !!opts.managed?.allowedHosts.some((h) => h.toLowerCase() === name);
}

/** Start the server. Resolves with the port actually bound. */
export function serve(opts: ServeOptions): Promise<{ server: http.Server; port: number }> {
  const publicDir = path.join(resourceRoot(), "public");
  const securityHeaders = {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...(opts.managed?.secureCookies ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only accept requests addressed to this machine or a configured public host (blocks DNS rebinding). Writes need a
    // custom header, which a cross-site page can't send without a CORS preflight we never grant.
    if (!hostAllowed(req.headers.host, opts)) {
      res.writeHead(403).end("forbidden host");
      return;
    }
    const isApi = url.pathname.startsWith("/api/");
    if (isApi && opts.token && !tokenOk(req.headers["x-arbiter-token"], opts.token)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (isApi && req.method !== "GET" && req.headers["x-arbiter"] !== "1") {
      res.writeHead(403).end("missing x-arbiter header");
      return;
    }
    try {
      if (isApi) {
        const json = (status: number, data: unknown, extra: Record<string, string | string[]> = {}) =>
          res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...securityHeaders, ...extra }).end(JSON.stringify(data));
        if (opts.managed) {
          const user: User | null = authenticate(sessionToken(req));
          const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
          if (["auth", "m", "admin"].includes(parts[0])) {
            const r = await managedApi(req, parts, user, () => readBody(req), opts.managed);
            if (!r) throw new HttpError(404, "not found");
            const extra: Record<string, string | string[]> = r.cookies ? { "set-cookie": r.cookies } : {};
            if (r.raw) {
              res.writeHead(200, {
                "content-type": r.raw.contentType, "cache-control": "no-store", ...securityHeaders, ...extra,
                ...(r.raw.filename ? { "content-disposition": `attachment; filename="${r.raw.filename}"` } : {}),
              }).end(r.raw.text);
            } else json(200, r.body, extra);
            return;
          }
          // Everything else is the engine's own API (tasks, contestants, keys, evaluations): admins only.
          if (!user) throw new HttpError(401, "Sign in first");
          if (user.role !== "admin") throw new HttpError(403, "Admins only");
        }
        json(200, await api(req, url, opts));
        return;
      }
      const rel = url.pathname === "/" ? "index.html" : url.pathname === "/annotate" ? "annotate.html" : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(publicDir, rel);
      if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", ...securityHeaders });
      res.end(fs.readFileSync(file));
    } catch (err) {
      const status = err instanceof HttpError || err instanceof ApiError ? err.status : 500;
      if (status === 500) console.error(err);
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ error: status === 500 ? "Internal error" : err instanceof Error ? err.message : String(err) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : opts.port });
    });
  });
}
