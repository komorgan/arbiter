// Identity scrubbing: redact strings that reveal which model or vendor produced a result.
// Perfect blinding is impossible (style leaks); the review UI measures what's left via model guesses.

const BUILTIN = [
  "anthropic", "claude", "opus", "sonnet", "haiku", "fable", "mythos",
  "openai", "chatgpt", "gpt-?\\d[\\w.-]*", "gpt", "codex", "o\\d-(?:mini|pro)",
  "gemini", "bard", "deepmind",
  "llama[\\w.-]*", "mistral", "mixtral", "codestral", "qwen[\\w.-]*", "deepseek[\\w.-]*", "grok[\\w.-]*", "kimi", "glm-?\\d[\\w.-]*",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function makeScrubber(extraNames: string[]): (text: string) => string {
  const extras = extraNames.filter((n) => n && n.length >= 3).map(escape);
  // Longest first, so "claude-opus-5" is replaced whole rather than piecewise.
  const alts = [...extras, ...BUILTIN].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\w-])(?:${alts.join("|")})(?![\\w])`, "gi");
  return (text: string) => text.replace(re, "[MODEL]");
}
