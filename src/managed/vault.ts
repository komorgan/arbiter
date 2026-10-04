// Server-side key vault for Managed mode: provider API keys encrypted at rest with AES-256-GCM.
// The master key comes from ARBITER_MASTER_KEY (base64, 32 bytes). Without it, a key file is generated in the
// data dir, which protects against casual disclosure but not against someone who can read the whole data dir.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { arbiterHome, paths } from "../config.ts";
import type { SecretBackend } from "../secrets.ts";

function masterKey(): { key: Buffer; source: "env" | "file" } {
  const env = process.env.ARBITER_MASTER_KEY;
  if (env) {
    const key = Buffer.from(env, "base64");
    if (key.length !== 32) throw new Error("ARBITER_MASTER_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    return { key, source: "env" };
  }
  const file = path.join(arbiterHome(), "master.key");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  return { key: Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64"), source: "file" };
}

export function createVault(): { backend: SecretBackend; keySource: "env" | "file" } {
  const { key, source } = masterKey();
  const file = paths.secrets();
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const seal = (name: string, value: string) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(name)); // binds the ciphertext to its name, so entries can't be swapped
    const enc = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  };
  const open = (name: string, blob: string) => {
    const b = Buffer.from(blob, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAAD(Buffer.from(name));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  };
  return {
    keySource: source,
    backend: {
      get(name) {
        const blob = read()[name];
        if (!blob) return undefined;
        try {
          return open(name, blob);
        } catch {
          console.warn(`vault: could not decrypt ${name} (wrong master key?)`);
          return undefined;
        }
      },
      set(name, value) {
        write({ ...read(), [name]: seal(name, value) });
      },
      delete(name) {
        const d = read();
        delete d[name];
        write(d);
      },
      names: () => Object.keys(read()),
    },
  };
}
