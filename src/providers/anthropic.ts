import Anthropic from "@anthropic-ai/sdk";
import { systemPrompt, type AgentContext } from "../agent/context.ts";
import { TOOL_SPECS } from "../agent/tools.ts";
import { secrets } from "../secrets.ts";
import type { AgentOutcome } from "../types.ts";

/**
 * Manual agent loop over the Messages API. A manual loop (rather than the SDK tool runner) lets the
 * harness meter every turn and stop at the task's limits exactly as it does for other providers.
 *
 * Deliberately NO server-side model fallbacks: an eval must measure the model it names. A refusal is
 * recorded as the run's outcome instead of being silently rerouted to a different model.
 */
export async function runAnthropic(ctx: AgentContext): Promise<AgentOutcome> {
  const { contestant, limits, log } = ctx;
  const p = contestant.params ?? {};
  if (!contestant.model) return { status: "failed", error: "contestant has no model" };

  const keyName = typeof p.apiKeyEnv === "string" ? p.apiKeyEnv : "ANTHROPIC_API_KEY";
  const apiKey = secrets.get(keyName);
  // No key found: let the SDK resolve credentials itself (env, an `ant auth login` profile, …).
  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    maxRetries: 2,
  });

  const tools: Anthropic.Tool[] = TOOL_SPECS.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.input_schema,
  }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: ctx.task.prompt }];
  let lastText = "";

  while (true) {
    const reason = limits.exceeded();
    if (reason) return { status: "limit_hit", error: reason };
    limits.turns++;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: contestant.model,
      max_tokens: typeof p.maxOutputTokens === "number" ? p.maxOutputTokens : 16000,
      system: systemPrompt(ctx.sandbox.cwdLabel),
      tools,
      messages,
    };
    // Adaptive thinking on current models; Haiku 4.5 predates it. Contestants can override both knobs,
    // and the override is part of the contestant spec, so it is recorded with every run.
    if (p.thinking && typeof p.thinking === "object") params.thinking = p.thinking as Anthropic.ThinkingConfigParam;
    else if (!contestant.model.startsWith("claude-haiku")) params.thinking = { type: "adaptive" };
    if (typeof p.effort === "string") params.output_config = { effort: p.effort as "low" | "medium" | "high" | "xhigh" | "max" };

    let response: Anthropic.Message;
    try {
      response = await client.messages.create(params, { timeout: Math.max(5_000, limits.remainingSec * 1000) });
    } catch (err) {
      const reason = limits.exceeded();
      if (reason) return { status: "limit_hit", error: reason };
      if (err instanceof Anthropic.APIError) return { status: "failed", error: `API error ${err.status ?? ""}: ${err.message}` };
      throw err;
    }

    const u = response.usage;
    const input = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    limits.addUsage(input, u.output_tokens);
    log({ type: "usage", usage: { input, output: u.output_tokens } });

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        lastText = block.text;
        log({ type: "assistant_text", text: block.text });
      }
    }

    if (response.stop_reason === "refusal") return { status: "refused", error: "model declined the request (stop_reason: refusal)" };
    if (response.stop_reason === "max_tokens") return { status: "failed", error: "response hit max_tokens" };

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) return { status: "finished", summary: lastText };

    // Append the full content (including thinking blocks) unchanged, as the API requires.
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    let finished: string | undefined;
    for (const tu of toolUses) {
      limits.toolCalls++;
      const input = (tu.input ?? {}) as Record<string, unknown>;
      log({ type: "tool_call", tool: tu.name, input });
      const r = await ctx.tools.execute(tu.name, input);
      log({ type: "tool_result", tool: tu.name, text: r.output, isError: r.isError });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.output, is_error: r.isError });
      if (r.finished !== undefined) finished = r.finished;
    }
    if (finished !== undefined) return { status: "finished", summary: finished };
    messages.push({ role: "user", content: results });
  }
}
