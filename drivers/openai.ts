// OpenAI driver: Chat Completions function calling. Native with OPENAI_API_KEY,
// otherwise routed through OpenRouter with OPENROUTER_API_KEY.
import OpenAI from "openai";
import { chatTurn, openRouterClient, openRouterKey } from "./_chat-completions.ts";
import type { Driver, DriverPlugin } from "../core/types.ts";

function create(): Driver {
  const base = process.env.HARNESS_OPENAI_MODEL ?? "gpt-5.5";
  const router = !process.env.OPENAI_API_KEY ? openRouterKey() : undefined;
  if (!process.env.OPENAI_API_KEY && !router) throw new Error("openai driver needs OPENAI_API_KEY or OPENROUTER_API_KEY");
  const client = router ? openRouterClient(router) : new OpenAI();
  const model = router ? `openai/${base}` : base;
  return {
    id: "openai",
    model: router ? `${model} (via OpenRouter)` : model,
    turn: (req) => chatTurn(client, model, req, { maxTokensField: router ? "max_tokens" : "max_completion_tokens" }),
  };
}

const plugin: DriverPlugin = { kind: "driver", id: "openai", create };
export default plugin;
