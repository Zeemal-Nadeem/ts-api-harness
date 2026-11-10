// JIT context: the item's agreed scenarios and exclusions, fetched when the
// model needs them instead of being front-loaded into the brief.
import { z } from "zod";
import { loadContract } from "../../core/items.ts";
import type { ToolPlugin } from "../../core/types.ts";

const tool: ToolPlugin<Record<string, never>> = {
  kind: "tool",
  name: "read_contract",
  description: "Read this item's agreed contract: problem, WHEN/THEN scenarios to test, and what is not included.",
  input: z.object({}).strict(),
  async run(_args, ctx) {
    const { contract, error } = loadContract(ctx.harnessRoot, ctx.task.name);
    if (!contract) return { content: `ERROR: ${error}` };
    const body = [`Problem: ${contract.problem ?? ""}`, ...contract.scenarios.map((s) => `Scenario: ${s}`), `Not included: ${contract.notIncluded ?? ""}`].join("\n");
    return { content: body, summary: `read_contract ${ctx.task.name}`, contextKey: `contract:${ctx.task.name}`, sticky: true };
  },
};

export default tool;
