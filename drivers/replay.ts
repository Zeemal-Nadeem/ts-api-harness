// Scripted driver for offline tests and CI. NOT a model: it replays a JSON
// script of turns from HARNESS_REPLAY_SCRIPT, so the engine, hooks and gates
// can be exercised deterministically without provider keys.
// Script: [{ "text"?: string, "calls": [{ "name": string, "args": object }] }, ...]
import { readFileSync } from "node:fs";
import { estimateTokens } from "../core/util.ts";
import type { Driver, DriverPlugin, TurnRequest, TurnResult } from "../core/types.ts";

interface ScriptTurn {
  text?: string;
  calls: { name: string; args: unknown }[];
}

function create(): Driver {
  const file = process.env.HARNESS_REPLAY_SCRIPT;
  if (!file) throw new Error("replay driver needs HARNESS_REPLAY_SCRIPT=<script.json>");
  const script = JSON.parse(readFileSync(file, "utf8")) as ScriptTurn[];
  let i = 0;
  return {
    id: "replay",
    model: `script:${file.split("/").pop() ?? file}`,
    async turn(req: TurnRequest): Promise<TurnResult> {
      const t = script[i++];
      const usage = { inputTokens: estimateTokens(JSON.stringify(req)), outputTokens: 0 };
      if (!t) return { text: "script exhausted", calls: [], stop: "end", usage };
      return {
        text: t.text ?? "",
        calls: t.calls.map((c, k) => ({ id: `call_${i}_${k}`, name: c.name, args: c.args })),
        stop: t.calls.length ? "tool" : "end",
        usage,
      };
    },
  };
}

const plugin: DriverPlugin = { kind: "driver", id: "replay", create };
export default plugin;
