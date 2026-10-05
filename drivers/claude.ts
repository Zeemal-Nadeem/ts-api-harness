// Claude driver: translates neutral messages/tools to the Messages API and back.
// Everything provider-specific (wire format, reasoning blocks, fallbacks,
// usage accounting) stays in this file.
//
// History compaction edits older turns, so reasoning blocks would no longer
// match their prefix. The driver therefore replays only the latest assistant
// turn's thinking and sends prefix_mismatch_behavior "drop_block" so a stale
// block degrades instead of failing the request.
import Anthropic from "@anthropic-ai/sdk";
import type { Driver, DriverPlugin, Message, ToolCall, TurnRequest, TurnResult } from "../core/types.ts";

type Block = Anthropic.Beta.Messages.BetaContentBlockParam;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

function toWire(messages: Message[]): Anthropic.Beta.Messages.BetaMessageParam[] {
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });
  return messages.map((m, i): Anthropic.Beta.Messages.BetaMessageParam => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.callId, content: r.content })),
      };
    }
    const content: Block[] = [];
    if (i === lastAssistant && Array.isArray(m.opaque)) content.push(...(m.opaque as Block[]));
    if (m.text) content.push({ type: "text", text: m.text });
    for (const c of m.calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: (c.args ?? {}) as Record<string, unknown> });
    if (content.length === 0) content.push({ type: "text", text: "(no output)" });
    return { role: "assistant", content };
  });
}

function create(): Driver {
  const model = process.env.HARNESS_CLAUDE_MODEL ?? "claude-opus-5-5";
  const effort = (process.env.HARNESS_CLAUDE_EFFORT ?? "high") as Effort;
  const client = new Anthropic();
  return {
    id: "claude",
    model,
    async turn(req: TurnRequest): Promise<TurnResult> {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 32000,
        betas: ["thinking-binding-controls-2026-08-01", "server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        output_config: { effort },
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
        })),
        messages: toWire(req.messages),
      });
      const msg = await stream.finalMessage();

      const notes: string[] = [];
      const dropped = (msg.input_transformations ?? []).filter((t) => t.type === "thinking_dropped").length;
      if (dropped) notes.push(`${dropped} stale reasoning block(s) dropped by API`);
      if (msg.model !== model) notes.push(`served by fallback model ${msg.model}`);

      const usage = {
        inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
        outputTokens: msg.usage.output_tokens,
      };
      if (msg.stop_reason === "refusal") {
        return { text: "", calls: [], stop: "refused", usage, notes: [...notes, `refusal: ${msg.stop_details?.category ?? "unspecified"}`] };
      }
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const calls: ToolCall[] =
        msg.stop_reason === "max_tokens"
          ? []
          : msg.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, args: b.input }] : []));
      const reasoning = msg.content.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
      return {
        text,
        calls,
        stop: msg.stop_reason === "max_tokens" ? "length" : calls.length ? "tool" : "end",
        usage,
        opaque: reasoning,
        notes,
      };
    },
  };
}

const plugin: DriverPlugin = { kind: "driver", id: "claude", create };
export default plugin;
