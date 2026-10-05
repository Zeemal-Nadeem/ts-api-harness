// Example extension — a new TOOL. Install: cp examples/extensions/openapi-diff.ts plugins/tools/
// Shows the model which routes its change added or removed versus the run's starting point.
import { z } from "zod";
import { createApiContext } from "../../core/api-model.ts";
import type { ToolPlugin } from "../../core/types.ts";

const tool: ToolPlugin<Record<string, never>> = {
  kind: "tool",
  name: "openapi_diff",
  description: "Diff the API's routes against the state at the start of the run (added/removed endpoints).",
  input: z.object({}),
  async run(_args, ctx) {
    if (!ctx.beforeRoot) return { content: "n/a: no starting snapshot (greenfield run)" };
    const key = (r: { method: string; path: string }): string => `${r.method.toUpperCase()} ${r.path}`;
    const before = new Set(createApiContext(ctx.beforeRoot, ctx.harnessRoot).routes().map(key));
    const after = new Set(createApiContext(ctx.apiRoot, ctx.harnessRoot).routes().map(key));
    const lines = [
      ...[...after].filter((r) => !before.has(r)).map((r) => `+ ${r}`),
      ...[...before].filter((r) => !after.has(r)).map((r) => `- ${r}`),
    ];
    return { content: lines.join("\n") || "no route changes", summary: `openapi_diff: ${lines.length} changes` };
  },
};

export default tool;
