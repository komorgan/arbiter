// HTTP routes for Managed mode: /api/auth/* (anyone), /api/m/* (signed-in annotators and admins),
// /api/admin/* (admins). The engine's own routes (tasks, contestants, secrets, evaluations) are admin-only
// in Managed mode; server.ts enforces that.

import type http from "node:http";
import { loadContestants, paths } from "../config.ts";
import { listTasks } from "../task.ts";
import {
  authenticate, changePassword, createFirstAdmin, createInvite, ensureSetupCode, listInvites, login, logout, redeemInvite,
  revokeInvite, revokeSessions,
} from "./auth.ts";
import { audit, managedDb, type User } from "./db.ts";
import {
  addBatch, annotatorProjects, DESKTOP_REQUIRED, getProject, nextReview, projectBatches, projectComparisons, releaseReview, reviewPayload,
  saveProject, setExcluded, setGold, setMembers, setQualification, skipReview, submitReview,
} from "./projects.ts";
import { exportJsonl, overview, qaView, resultsView } from "./qa.ts";

export interface ManagedOptions {
  publicUrl?: string;
  allowedHosts: string[];
  secureCookies: boolean;
  trustProxy: boolean;
  vaultKeySource: "env" | "file";
}

export interface ApiResult {
  body?: unknown;
  raw?: { text: string; contentType: string; filename?: string };
  cookies?: string[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const COOKIE = "arb_session";

export function sessionToken(req: http.IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function clientIp(req: http.IncomingMessage, opts: ManagedOptions): string {
  if (opts.trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? "";
}

function setCookie(value: string, opts: ManagedOptions, maxAgeSec: number): string {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${opts.secureCookies ? "; Secure" : ""}`;
}

const publicUser = (u: User | null) => (u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null);
const bad = (err: unknown) => new ApiError(400, err instanceof Error ? err.message : String(err));
const wrap = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    throw bad(err);
  }
};

export async function managedApi(
  req: http.IncomingMessage,
  parts: string[],
  user: User | null,
  body: () => Promise<Record<string, unknown>>,
  opts: ManagedOptions,
): Promise<ApiResult | null> {
  const method = req.method ?? "GET";
  const ip = clientIp(req, opts);
  const ua = String(req.headers["user-agent"] ?? "");
  const [area, a, b, c, d, e] = parts;

  // ---------- auth ----------
  if (area === "auth") {
    if (method === "GET" && a === "me") {
      return { body: { mode: "managed", user: publicUser(user), needsSetup: !!ensureSetupCode() } };
    }
    if (method === "POST" && a === "setup") {
      const x = await body();
      const u = wrap(() => createFirstAdmin(x, ip));
      const s = wrap(() => login(u.email, x.password, ip, ua));
      return { body: { user: publicUser(s.user) }, cookies: [setCookie(s.token, opts, 12 * 3600)] };
    }
    if (method === "POST" && a === "login") {
      const x = await body();
      const s = wrap(() => login(x.email, x.password, ip, ua));
      return { body: { user: publicUser(s.user) }, cookies: [setCookie(s.token, opts, 12 * 3600)] };
    }
    if (method === "POST" && a === "redeem") {
      const x = await body();
      const s = wrap(() => redeemInvite(x, ip, ua));
      return { body: { user: publicUser(s.user) }, cookies: [setCookie(s.token, opts, 12 * 3600)] };
    }
    if (method === "POST" && a === "logout") {
      logout(sessionToken(req));
      if (user) audit(user.id, "auth.logout", null, ip);
      return { body: { ok: true }, cookies: [setCookie("", opts, 0)] };
    }
    if (method === "POST" && a === "password") {
      if (!user) throw new ApiError(401, "Sign in first");
      const x = await body();
      wrap(() => changePassword(user, x.current, x.next, ip));
      return { body: { ok: true }, cookies: [setCookie("", opts, 0)] };
    }
    return null;
  }

  if (!user) throw new ApiError(401, "Sign in first");

  // ---------- annotator ----------
  if (area === "m") {
    // Set by the desktop app's protected window on every request to the workspace.
    const client = { desktop: /^desktop\//.test(String(req.headers["x-arbiter-client"] ?? "")) };
    if (method === "GET" && a === "projects" && !b) return { body: annotatorProjects(user, client) };
    if (method === "POST" && a === "projects" && b && c === "next") {
      try {
        return { body: { reviewId: nextReview(user, b, client) } };
      } catch (err) {
        // Record browser attempts on desktop-only projects, so admins can see if someone keeps trying.
        if (err instanceof Error && err.message === DESKTOP_REQUIRED) audit(user.id, "review.blocked_browser", { project: b, ua: ua.slice(0, 120) }, ip);
        throw bad(err);
      }
    }
    if (a === "reviews" && b) {
      if (method === "GET" && !c) return { body: wrap(() => reviewPayload(user, b, client)) };
      if (method === "POST" && c === "submit") {
        const x = await body();
        return { body: wrap(() => submitReview(user, b, x, ip, client)) };
      }
      if (method === "POST" && c === "skip") {
        const x = await body();
        return { body: wrap(() => skipReview(user, b, x.reason, ip, client)) };
      }
      if (method === "POST" && c === "release") return { body: wrap(() => releaseReview(user, b)) };
    }
    return null;
  }

  // ---------- admin ----------
  if (area === "admin") {
    if (user.role !== "admin") throw new ApiError(403, "Admins only");
    const db = managedDb();

    if (method === "GET" && a === "overview") return { body: overview() };

    if (a === "projects") {
      if (method === "POST" && !b) {
        const x = await body();
        return { body: wrap(() => saveProject(user, null, x, ip)) };
      }
      if (!b) return null;
      if (!getProject(b)) throw new ApiError(404, "No such project");
      if (method === "GET" && !c) {
        const members = db
          .prepare("SELECT u.id, u.email, u.name, u.role, m.excluded FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name")
          .all(b);
        return { body: { project: getProject(b), batches: projectBatches(b), members } };
      }
      if (method === "PUT" && !c) {
        const x = await body();
        return { body: wrap(() => saveProject(user, b, x, ip)) };
      }
      if (method === "POST" && c === "batches") {
        const x = await body();
        return { body: { evaluations: await addBatch(user, b, x, ip).catch((e) => Promise.reject(bad(e))) } };
      }
      if (method === "GET" && c === "comparisons") return { body: projectComparisons(b) };
      if (method === "PUT" && c === "members" && !d) {
        const x = await body();
        wrap(() => setMembers(user, b, x.userIds, ip));
        return { body: { ok: true } };
      }
      if (method === "PUT" && c === "members" && d && e === "qualification") {
        const x = await body();
        wrap(() => setQualification(user, b, d, x.status, ip));
        return { body: { ok: true } };
      }
      if (method === "PUT" && c === "members" && d && !e) {
        const x = await body();
        wrap(() => setExcluded(user, b, d, !!x.excluded, ip));
        return { body: { ok: true } };
      }
      if (method === "GET" && c === "qa") return { body: qaView(b) };
      if (method === "GET" && c === "results") return { body: resultsView(b) };
      if (method === "GET" && c === "export") {
        audit(user.id, "project.export", { project: b }, ip);
        return { raw: { text: exportJsonl(b), contentType: "application/x-ndjson", filename: `arbiter-${b}.jsonl` } };
      }
      return null;
    }

    if (method === "PUT" && a === "comparisons" && b && c === "gold") {
      const x = await body();
      wrap(() => setGold(user, b, x.expected, x.note, x.qual, ip));
      return { body: { ok: true } };
    }

    if (a === "users") {
      if (method === "GET" && !b) {
        return {
          body: db.prepare(
            `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login,
                    (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id AND r.status = 'submitted') AS reviews,
                    (SELECT json_group_array(project_id) FROM project_members m WHERE m.user_id = u.id) AS projects
             FROM users u ORDER BY u.role, u.name`,
          ).all().map((r) => ({ ...(r as object), projects: JSON.parse((r as { projects: string }).projects) })),
        };
      }
      if (method === "PUT" && b && !c) {
        const x = await body();
        if (b === user.id && (x.status === "disabled" || x.role === "annotator")) throw new ApiError(400, "You can't disable or demote yourself");
        if (x.status !== undefined && x.status !== "active" && x.status !== "disabled") throw new ApiError(400, "Invalid status");
        if (x.role !== undefined && x.role !== "admin" && x.role !== "annotator") throw new ApiError(400, "Invalid role");
        if (x.status) db.prepare("UPDATE users SET status = ? WHERE id = ?").run(x.status as string, b);
        if (x.role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(x.role as string, b);
        if (x.status === "disabled") revokeSessions(b);
        audit(user.id, "user.update", { user: b, status: x.status, role: x.role }, ip);
        return { body: { ok: true } };
      }
      if (method === "POST" && b && c === "revoke-sessions") {
        revokeSessions(b);
        audit(user.id, "user.revoke_sessions", { user: b }, ip);
        return { body: { ok: true } };
      }
      return null;
    }

    if (a === "invites") {
      if (method === "GET") return { body: listInvites() };
      if (method === "POST") {
        const x = await body();
        const inv = wrap(() => createInvite(user, x.email, x.role, x.projectIds, ip));
        return { body: { ...inv, link: opts.publicUrl ? `${opts.publicUrl.replace(/\/$/, "")}/annotate.html#invite` : null } };
      }
      if (method === "DELETE" && b) {
        wrap(() => revokeInvite(user, b, ip));
        return { body: { ok: true } };
      }
      return null;
    }

    if (method === "GET" && a === "audit") {
      const rows = db
        .prepare("SELECT a.id, a.at, a.action, a.detail_json, a.ip, u.email FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500")
        .all() as { id: number; at: string; action: string; detail_json: string | null; ip: string | null; email: string | null }[];
      return { body: rows.map((r) => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null, detail_json: undefined })) };
    }

    // Choices for the batch form: server-side tasks and contestants.
    if (method === "GET" && a === "catalog") {
      return { body: { tasks: listTasks(paths.tasks()).filter((t) => !t.error), contestants: loadContestants().map((c) => ({ id: c.id, displayName: c.displayName, provider: c.provider, model: c.model ?? null })) } };
    }
  }
  return null;
}

export { authenticate };
