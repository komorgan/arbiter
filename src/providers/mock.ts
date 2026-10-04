import type { AgentContext } from "../agent/context.ts";
import type { AgentOutcome } from "../types.ts";

/**
 * A scripted, deterministic "model" for testing the pipeline without API keys or spend.
 * params.script: a list of turns, each { say?: string, tool?: string, input?: object }.
 * params.tokensPerTurn: { input, output } fake usage per turn (default 1200 / 300).
 * Tool calls go through the real ToolRuntime and sandbox, so everything downstream is exercised.
 */
interface Step {
  say?: string;
  tool?: string;
  input?: Record<string, unknown>;
}

export async function runMock(ctx: AgentContext): Promise<AgentOutcome> {
  const { limits, log } = ctx;
  const p = ctx.contestant.params ?? {};
  const script = (p.script as Step[] | undefined) ?? [];
  const tokens = (p.tokensPerTurn as { input: number; output: number } | undefined) ?? { input: 1200, output: 300 };

  for (const step of script) {
    const reason = limits.exceeded();
    if (reason) return { status: "limit_hit", error: reason };
    limits.turns++;
    limits.addUsage(tokens.input, tokens.output);
    log({ type: "usage", usage: tokens });
    await new Promise((r) => setTimeout(r, 150)); // look like a real turn in the UI
    if (step.say) log({ type: "assistant_text", text: step.say });
    if (!step.tool) continue;
    limits.toolCalls++;
    log({ type: "tool_call", tool: step.tool, input: step.input ?? {} });
    const r = await ctx.tools.execute(step.tool, step.input ?? {});
    log({ type: "tool_result", tool: step.tool, text: r.output, isError: r.isError });
    if (r.finished !== undefined) return { status: "finished", summary: r.finished };
  }
  return { status: "finished", summary: "(script ended without calling finish)" };
}
