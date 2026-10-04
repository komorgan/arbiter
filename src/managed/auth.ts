// Accounts, passwords, sessions and invites for Managed mode.
// Passwords: scrypt with a per-user salt. Session tokens and invite codes are random and stored only as SHA-256.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { arbiterHome } from "../config.ts";
import { newId, now } from "../db.ts";
import { audit, managedDb, type User } from "./db.ts";

const SESSION_HOURS = 12;
const IDLE_MINUTES = 60;
const INVITE_DAYS = 7;
const MIN_PASSWORD = 10;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const token = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

// ---------- passwords ----------

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const N = 32768, r = 8, p = 1;
  const hash = crypto.scryptSync(pw, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(got, expected);
}

function checkPassword(pw: unknown): string {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  if (pw.length > 256) throw new Error("Password is too long");
  return pw;
}

function checkEmail(email: unknown): string {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw new Error("Enter a valid email address");
  return e;
}

// ---------- first-run setup ----------

const setupFile = () => path.join(arbiterHome(), "setup-code.txt");

export function hasAdmin(): boolean {
  return !!managedDb().prepare("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1").get();
}

/** When no admin exists, create (or reuse) a one-time setup code. It's printed to the server console only. */
export function ensureSetupCode(): string | null {
  if (hasAdmin()) {
    if (fs.existsSync(setupFile())) fs.rmSync(setupFile());
    return null;
  }
  if (!fs.existsSync(setupFile())) fs.writeFileSync(setupFile(), token(18), { mode: 0o600 });
  return fs.readFileSync(setupFile(), "utf8").trim();
}

export function createFirstAdmin(input: { code?: unknown; email?: unknown; name?: unknown; password?: unknown }, ip: string): User {
  const code = ensureSetupCode();
  if (!code) throw new Error("Setup is already complete");
  if (typeof input.code !== "string" || !crypto.timingSafeEqual(Buffer.from(sha256(input.code)), Buffer.from(sha256(code)))) {
    throw new Error("That setup code is wrong. It's printed in the server console.");
  }
  const user = insertUser(checkEmail(input.email), String(input.name ?? "").trim() || "Admin", "admin", checkPassword(input.password));
  fs.rmSync(setupFile(), { force: true });
  audit(user.id, "setup.first_admin", { email: user.email }, ip);
  return user;
}

function insertUser(email: string, name: string, role: User["role"], password: string): User {
  const db = managedDb();
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new Error("An account with that email already exists");
  const id = newId();
  db.prepare("INSERT INTO users (id, email, name, role, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, email, name.slice(0, 100), role, hashPassword(password), now());
  return getUser(id)!;
}

export function getUser(id: string): User | undefined {
  return managedDb().prepare("SELECT id, email, name, role, status, created_at, last_login FROM users WHERE id = ?").get(id) as unknown as User | undefined;
}

// ---------- login rate limiting (per IP and per email) ----------

const attempts = new Map<string, { n: number; reset: number }>();
function throttle(key: string): void {
  const t = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < t) attempts.set(key, { n: 1, reset: t + 15 * 60_000 });
  else if (++a.n > 10) throw new Error("Too many attempts. Try again in 15 minutes.");
}

// ---------- sessions ----------

export function login(emailIn: unknown, pw: unknown, ip: string, userAgent: string): { token: string; user: User } {
  const email = typeof emailIn === "string" ? emailIn.trim().toLowerCase() : "";
  throttle(`ip:${ip}`);
  throttle(`email:${email}`);
  const row = managedDb().prepare("SELECT id, pw_hash, status FROM users WHERE email = ?").get(email) as { id: string; pw_hash: string; status: string } | undefined;
  // Verify against a dummy hash when the user doesn't exist, so timing doesn't reveal which emails have accounts.
  const ok = verifyPassword(typeof pw === "string" ? pw : "", row?.pw_hash ?? DUMMY_HASH);
  if (!row || !ok || row.status !== "active") {
    audit(row?.id ?? null, "auth.login_failed", { email }, ip);
    throw new Error("Wrong email or password");
  }
  managedDb().prepare("UPDATE users SET last_login = ? WHERE id = ?").run(now(), row.id);
  audit(row.id, "auth.login", null, ip);
  return { token: createSession(row.id, userAgent), user: getUser(row.id)! };
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

function createSession(userId: string, userAgent: string): string {
  const t = token();
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_HOURS * 3600_000);
  managedDb()
    .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)")
    .run(sha256(t), userId, created.toISOString(), expires.toISOString(), created.toISOString(), userAgent.slice(0, 200));
  return t;
}

/** Resolve a session token to its user, enforcing absolute and idle expiry. */
export function authenticate(t: string | undefined): User | null {
  if (!t) return null;
  const db = managedDb();
  const s = db.prepare("SELECT user_id, expires_at, last_seen FROM sessions WHERE token_hash = ?").get(sha256(t)) as
    | { user_id: string; expires_at: string; last_seen: string }
    | undefined;
  if (!s) return null;
  const t0 = Date.now();
  if (Date.parse(s.expires_at) < t0 || Date.parse(s.last_seen) + IDLE_MINUTES * 60_000 < t0) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(t));
    return null;
  }
  const user = getUser(s.user_id);
  if (!user || user.status !== "active") return null;
  // Touch at most once a minute to keep writes low.
  if (Date.parse(s.last_seen) + 60_000 < t0) db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(new Date(t0).toISOString(), sha256(t));
  return user;
}

export function logout(t: string | undefined): void {
  if (t) managedDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(t));
}

export function revokeSessions(userId: string): void {
  managedDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// ---------- invites ----------

export function createInvite(by: User, emailIn: unknown, role: unknown, projectIds: unknown, ip: string): { code: string; expiresAt: string } {
  const email = checkEmail(emailIn);
  if (role !== "admin" && role !== "annotator") throw new Error("role must be admin or annotator");
  const ids = Array.isArray(projectIds) ? projectIds.filter((x): x is string => typeof x === "string") : [];
  const code = token(18);
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString();
  managedDb()
    .prepare("INSERT INTO invites (code_hash, email, role, project_ids_json, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(sha256(code), email, role, JSON.stringify(ids), by.id, now(), expiresAt);
  audit(by.id, "invite.create", { email, role, projects: ids }, ip);
  return { code, expiresAt };
}

export function listInvites() {
  return managedDb()
    .prepare("SELECT substr(code_hash, 1, 12) AS id, email, role, project_ids_json, created_at, expires_at, used_at FROM invites ORDER BY created_at DESC")
    .all()
    .map((r) => {
      const x = r as Record<string, string>;
      return { id: x.id, email: x.email, role: x.role, projectIds: JSON.parse(x.project_ids_json), createdAt: x.created_at, expiresAt: x.expires_at, usedAt: x.used_at };
    });
}

export function revokeInvite(by: User, idPrefix: string, ip: string): void {
  if (!/^[0-9a-f]{12}$/.test(idPrefix)) throw new Error("invalid invite id");
  const r = managedDb().prepare("DELETE FROM invites WHERE substr(code_hash, 1, 12) = ? AND used_at IS NULL").run(idPrefix);
  if (!r.changes) throw new Error("No open invite with that id");
  audit(by.id, "invite.revoke", { id: idPrefix }, ip);
}

/** Redeem an invite: creates the account, adds it to the invite's projects, and signs in. */
export function redeemInvite(input: { code?: unknown; name?: unknown; password?: unknown }, ip: string, userAgent: string): { token: string; user: User } {
  throttle(`ip:${ip}`);
  const db = managedDb();
  const inv = db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(sha256(String(input.code ?? "").trim())) as Record<string, string> | undefined;
  if (!inv || inv.used_at || Date.parse(inv.expires_at) < Date.now()) throw new Error("This invite code is invalid, used, or expired. Ask for a new one.");
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("Enter your name");
  const user = insertUser(inv.email, name, inv.role as User["role"], checkPassword(input.password));
  db.prepare("UPDATE invites SET used_at = ? WHERE code_hash = ?").run(now(), inv.code_hash);
  db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(now(), user.id);
  const add = db.prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)");
  for (const pid of JSON.parse(inv.project_ids_json) as string[]) {
    if (db.prepare("SELECT 1 FROM projects WHERE id = ?").get(pid)) add.run(pid, user.id, now());
  }
  audit(user.id, "invite.redeem", { email: user.email, role: user.role }, ip);
  return { token: createSession(user.id, userAgent), user };
}

export function changePassword(user: User, current: unknown, next: unknown, ip: string): void {
  const row = managedDb().prepare("SELECT pw_hash FROM users WHERE id = ?").get(user.id) as { pw_hash: string };
  if (typeof current !== "string" || !verifyPassword(current, row.pw_hash)) throw new Error("Current password is wrong");
  managedDb().prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword(checkPassword(next)), user.id);
  revokeSessions(user.id);
  audit(user.id, "auth.password_changed", null, ip);
}
