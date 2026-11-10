// Pre-hook: no file edit until docs/contracts/<item>.md exists and names the
// owner, the metric to move, WHEN/THEN scenarios and the Not-included list.
// A missing field is a refusal with the field named.
import { loadContract, missingFields } from "../../core/items.ts";
import type { HookPlugin } from "../../core/types.ts";

const hook: HookPlugin = {
  kind: "hook",
  id: "problem-gate",
  phase: "pre",
  tools: ["write_file", "edit_file", "delete_file"],
  run(_ev, ctx) {
    const slug = ctx.task.name;
    const { contract, error } = loadContract(ctx.harnessRoot, slug);
    if (!contract) return { action: "block", reason: `${error}. A human writes the problem statement before any edit.` };
    const miss = missingFields(contract);
    if (miss.length) return { action: "block", reason: `docs/contracts/${slug}.md is missing: ${miss.join(", ")}` };
    return { action: "pass" };
  },
};

export default hook;
