import type { Contestant, Limits, TaskBundle, TranscriptEvent } from "../types.ts";
import type { Sandbox } from "../sandbox/index.ts";
import { costOf, priceFor } from "../pricing.ts";
import type { ToolRuntime } from "./tools.ts";

/** The system prompt every contestant receives, word for word. It must never name a model or vendor. */
export function systemPrompt(workspaceLabel: string): string {
  return [
    "You are a software engineering agent working autonomously on a task in a code repository.",
    `The repository is your working directory (${workspaceLabel}). Use the tools to inspect files, edit code, and run commands.`,
    "There is no network access. Nobody will answer questions: make reasonable decisions and proceed.",
    "Keep changes focused on the task. Verify your work by running the relevant tests or commands when possible.",
    "When you are done, call the `finish` tool once with a short summary of your changes.",
  ].join("\n");
}

/** Tracks usage against the task's limits. Shared by every provider so enforcement is identical. */
export class LimitTracker {
  readonly started = Date.now();
  inputTokens = 0;
  outputTokens = 0;
  toolCalls = 0;
  turns = 0;
  private price: { input: number; output: number } | null;

  constructor(
    private limits: Limits,
    contestant: Contestant,
  ) {
    this.price = priceFor(contestant.model, contestant.params?.price);
  }

  get elapsedSec(): number {
    return (Date.now() - this.started) / 1000;
  }

  get costUsd(): number | null {
    return costOf(this.price, this.inputTokens, this.outputTokens);
  }

  get remainingSec(): number {
    return Math.max(0, this.limits.wallClockSec - this.elapsedSec);
  }

  addUsage(input: number, output: number): void {
    this.inputTokens += input;
    this.outputTokens += output;
  }

  /** Returns a reason string if any limit is exhausted, else null. */
  exceeded(): string | null {
    const l = this.limits;
    if (this.elapsedSec >= l.wallClockSec) return `wall clock limit (${l.wallClockSec}s)`;
    if (l.maxTokens && this.inputTokens + this.outputTokens >= l.maxTokens) return `token limit (${l.maxTokens})`;
    const cost = this.costUsd;
    if (l.maxCostUsd && cost !== null && cost >= l.maxCostUsd) return `cost limit ($${l.maxCostUsd})`;
    if (l.maxToolCalls && this.toolCalls >= l.maxToolCalls) return `tool call limit (${l.maxToolCalls})`;
    if (l.maxTurns && this.turns >= l.maxTurns) return `turn limit (${l.maxTurns})`;
    return null;
  }
}

export interface AgentContext {
  task: TaskBundle;
  contestant: Contestant;
  sandbox: Sandbox;
  tools: ToolRuntime;
  limits: LimitTracker;
  log: (ev: Omit<TranscriptEvent, "t">) => void;
}
