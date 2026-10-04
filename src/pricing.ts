// USD per 1M tokens. Anthropic first-party rates as of 2026-06-24.
// Versioned with each run (PRICE_TABLE_VERSION) so old results stay reproducible.
// Other providers: set `params.price: { input, output }` on the contestant.

export const PRICE_TABLE_VERSION = "2026-06-24";

const TABLE: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Model IDs with built-in prices, offered as suggestions in the contestant editor. */
export const KNOWN_MODELS = Object.keys(TABLE);

export function priceFor(model: string | undefined, override?: unknown): { input: number; output: number } | null {
  const o = override as { input?: number; output?: number } | undefined;
  if (o && typeof o.input === "number" && typeof o.output === "number") return { input: o.input, output: o.output };
  return model ? TABLE[model] ?? null : null;
}

export function costOf(price: { input: number; output: number } | null, inputTokens: number, outputTokens: number): number | null {
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
