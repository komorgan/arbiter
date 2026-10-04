import { systemPrompt, type AgentContext } from "../agent/context.ts";
import { TOOL_SPECS } from "../agent/tools.ts";
import { secrets } from "../secrets.ts";
import type { AgentOutcome } from "../types.ts";

/**
 * Agent loop for any OpenAI-compatible Chat Completions endpoint: OpenAI, OpenRouter, Ollama, vLLM, LM Studio.
 * params: baseUrl (default https://api.openai.com/v1), apiKeyEnv (default OPENAI_API_KEY; optional for local
 * servers), maxOutputTokens, price: { input, output } in USD per 1M tokens, extraBody (merged into requests).
 */
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export async function runOpenAICompatible(ctx: AgentContext): Promise<AgentOutcome> {
  const { contestant, limits, log } = ctx;
  const p = contestant.params ?? {};
  if (!contestant.model) return { status: "failed", error: "contestant has no model" };
  const baseUrl = String(p.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = secrets.get(String(p.apiKeyEnv ?? "OPENAI_API_KEY"));

  const tools = TOOL_SPECS.map((s) => ({
    type: "function" as const,
    function: { name: s.name, description: s.description, parameters: s.input_schema },
  }));
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(ctx.sandbox.cwdLabel) },
    { role: "user", content: ctx.task.prompt },
  ];
  let lastText = "";

  while (true) {
    const reason = limits.exceeded();
    if (reason) return { status: "limit_hit", error: reason };
    limits.turns++;

    const body: Record<string, unknown> = { model: contestant.model, messages, tools, ...(p.extraBody as object) };
    if (typeof p.maxOutputTokens === "number") body.max_completion_tokens = p.maxOutputTokens;

    let data: {
      choices?: { message: ChatMessage; finish_reason: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(5_000, limits.remainingSec * 1000)),
      });
      data = await res.json();
      if (!res.ok) return { status: "failed", error: `API error ${res.status}: ${data.error?.message ?? "unknown"}` };
    } catch (err) {
      const reason = limits.exceeded();
      if (reason) return { status: "limit_hit", error: reason };
      return { status: "failed", error: `request failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    const input = data.usage?.prompt_tokens ?? 0;
    const output = data.usage?.completion_tokens ?? 0;
    limits.addUsage(input, output);
    log({ type: "usage", usage: { input, output } });

    const choice = data.choices?.[0];
    if (!choice) return { status: "failed", error: "response had no choices" };
    const msg = choice.message;
    if (msg.content?.trim()) {
      lastText = msg.content;
      log({ type: "assistant_text", text: msg.content });
    }
    if (choice.finish_reason === "content_filter") return { status: "refused", error: "content filter" };
    if (choice.finish_reason === "length") return { status: "failed", error: "response hit the output token limit" };

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) return { status: "finished", summary: lastText };
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });

    let finished: string | undefined;
    for (const call of calls) {
      limits.toolCalls++;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        log({ type: "tool_call", tool: call.function.name, input: call.function.arguments });
        messages.push({ role: "tool", tool_call_id: call.id, content: "error: arguments were not valid JSON" });
        continue;
      }
      log({ type: "tool_call", tool: call.function.name, input });
      const r = await ctx.tools.execute(call.function.name, input);
      log({ type: "tool_result", tool: call.function.name, text: r.output, isError: r.isError });
      messages.push({ role: "tool", tool_call_id: call.id, content: r.output });
      if (r.finished !== undefined) finished = r.finished;
    }
    if (finished !== undefined) return { status: "finished", summary: finished };
  }
}
