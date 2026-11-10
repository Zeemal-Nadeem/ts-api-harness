// Pre-hook on finish: the Stop holds until the stakeholder's yes to the current
// contract is in the ledger as a typed human turn. The model cannot write the
// ledger (its paths are confined to the API directory), and nothing it says or
// any tool returns is ever recorded as a human turn.
import { approval } from "../../core/items.ts";
import type { HookPlugin } from "../../core/types.ts";

const hook: HookPlugin = {
  kind: "hook",
  id: "contract-gate",
  phase: "pre",
  tools: ["finish"],
  run(_ev, ctx) {
    const a = approval(ctx.harnessRoot, ctx.task.name);
    return a.ok ? { action: "record", note: a.reason } : { action: "block", reason: `no stakeholder yes: ${a.reason}` };
  },
};

export default hook;
