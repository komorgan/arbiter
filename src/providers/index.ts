import type { AgentContext } from "../agent/context.ts";
import type { AgentOutcome } from "../types.ts";
import { runAnthropic } from "./anthropic.ts";
import { runMock } from "./mock.ts";
import { runOpenAICompatible } from "./openai-compatible.ts";

export async function runAgent(ctx: AgentContext): Promise<AgentOutcome> {
  switch (ctx.contestant.provider) {
    case "anthropic":
      return runAnthropic(ctx);
    case "openai-compatible":
      return runOpenAICompatible(ctx);
    case "mock":
      return runMock(ctx);
    default:
      return { status: "failed", error: `unknown provider: ${String(ctx.contestant.provider)}` };
  }
}
