// API keys. The engine asks for a key by name (e.g. ANTHROPIC_API_KEY); where it comes from is pluggable.
// CLI: environment variables only. Desktop app: an OS-encrypted store (Electron safeStorage), falling back to env.
// Keys are never put into process.env, so they can't leak into sandboxed commands.

export interface SecretBackend {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  names(): string[];
}

let backend: SecretBackend | null = null;

/** Called once by the desktop app to install its encrypted store. */
export function installSecretBackend(b: SecretBackend): void {
  backend = b;
}

export const secrets = {
  writable: () => backend !== null,
  get(name: string): string | undefined {
    return backend?.get(name) || process.env[name] || undefined;
  },
  source(name: string): "store" | "env" | null {
    if (backend?.get(name)) return "store";
    return process.env[name] ? "env" : null;
  },
  set(name: string, value: string): void {
    if (!backend) throw new Error("this build has no secret store; set the environment variable instead");
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error("key names look like ANTHROPIC_API_KEY");
    backend.set(name, value.trim());
  },
  delete(name: string): void {
    backend?.delete(name);
  },
  storedNames: () => backend?.names() ?? [],
};

export const WELL_KNOWN_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
