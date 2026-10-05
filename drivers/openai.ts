// OpenAI driver: translates neutral messages/tools to Chat Completions function
// calling and back. Everything provider-specific stays in this file.
import OpenAI from "openai";
import type { Driver, DriverPlugin, Message, ToolCall, TurnRequest, TurnResult } from "../core/types.ts";

type Wire = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toWire(system: string, messages: Message[]): Wire[] {
  const out: Wire[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.calls.length
          ? {
              tool_calls: m.calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.callId, content: r.content });
    }
  }
  return out;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __unparseable: raw.slice(0, 200) };
  }
}

function create(): Driver {
  const model = process.env.HARNESS_OPENAI_MODEL ?? "gpt-5.5";
  const client = new OpenAI();
  return {
    id: "openai",
    model,
    async turn(req: TurnRequest): Promise<TurnResult> {
      const res = await client.chat.completions.create({
        model,
        max_completion_tokens: 32000,
        messages: toWire(req.system, req.messages),
        tools: req.tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      });
      const choice = res.choices[0];
      const usage = { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 };
      if (!choice) return { text: "", calls: [], stop: "end", usage, notes: ["empty choices"] };
      if (choice.message.refusal) return { text: "", calls: [], stop: "refused", usage, notes: [`refusal: ${choice.message.refusal.slice(0, 120)}`] };
      const calls: ToolCall[] =
        choice.finish_reason === "length"
          ? []
          : (choice.message.tool_calls ?? []).flatMap((c) =>
              c.type === "function" ? [{ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }] : [],
            );
      return {
        text: choice.message.content ?? "",
        calls,
        stop: choice.finish_reason === "length" ? "length" : calls.length ? "tool" : "end",
        usage,
      };
    },
  };
}

const plugin: DriverPlugin = { kind: "driver", id: "openai", create };
export default plugin;
