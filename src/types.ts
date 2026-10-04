// Core data types shared across the engine. Mirrors the "Data model" section of the spec.

export interface Limits {
  wallClockSec: number;
  maxTokens?: number; // input + output, summed over the whole run
  maxCostUsd?: number;
  maxToolCalls?: number;
  maxTurns?: number;
}

export interface Check {
  id: string;
  cmd: string;
  weight: number;
  kind: "test" | "lint" | "typecheck" | "build" | "custom";
}

export interface TaskBundle {
  id: string;
  title: string;
  contentHash: string;
  dir: string; // directory containing arbiter.task.yaml
  prompt: string;
  workspace: { path?: string; repo?: string; commit?: string };
  env: { image: string; setup?: string; network: "none" | "open" };
  limits: Limits;
  checks: Check[];
  tags: string[];
  rubric: string;
  scopeGlobs?: string[];
}

export type AdapterKind = "api-agent" | "mock";
export type ProviderKind = "anthropic" | "openai-compatible" | "mock";

export interface Contestant {
  id: string;
  displayName: string;
  adapter: AdapterKind;
  provider: ProviderKind;
  model?: string;
  params?: Record<string, unknown>;
}

export type RunStatus = "queued" | "running" | "finished" | "limit_hit" | "refused" | "failed";

export interface CheckResult {
  id: string;
  kind: Check["kind"];
  cmd: string;
  weight: number;
  passed: boolean;
  exitCode: number | null;
  durationSec: number;
  output: string;
}

export interface RunMetrics {
  wallSec: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  toolCalls: number;
  turns: number;
  filesTouched: number;
  linesAdded: number;
  linesRemoved: number;
  outOfScopeFiles: number;
  checksPassed: number;
  checksTotal: number;
  checkScore: number | null; // weighted pass rate, 0..1
  limitHit?: string;
}

export interface TranscriptEvent {
  t: number; // seconds since run start
  type: "assistant_text" | "tool_call" | "tool_result" | "usage" | "limit" | "error" | "finish" | "info";
  text?: string;
  tool?: string;
  input?: unknown;
  isError?: boolean;
  usage?: { input: number; output: number };
}

export interface AgentOutcome {
  status: "finished" | "limit_hit" | "refused" | "failed";
  summary?: string;
  error?: string;
}
