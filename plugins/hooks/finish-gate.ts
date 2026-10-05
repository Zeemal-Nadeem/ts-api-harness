// Pre-hook on finish: the model's "done" is only a request. The harness re-runs
// the full test suite and every standards check itself and refuses unless all
// are green and test-first was actually observed during this run.
import { renderFailures, runStandards } from "../../core/standards.ts";
import type { HookPlugin } from "../../core/types.ts";

const hook: HookPlugin = {
  kind: "hook",
  id: "finish-gate",
  phase: "pre",
  tools: ["finish"],
  async run(_ev, ctx) {
    const reasons: string[] = [];
    if (Object.keys(ctx.state.observedRed).length === 0) reasons.push("no test was ever observed failing in this run (test-first not proven)");
    if (ctx.state.writes.length === 0) reasons.push("no files were written");

    const tests = ctx.registry.tools.get("run_tests");
    if (!tests) reasons.push("UNPROVEN: no run_tests tool registered");
    else {
      const out = await tests.run({}, ctx);
      if (!out.content.startsWith("PASS")) reasons.push(`tests: ${out.content.split("\n").slice(0, 8).join("\n")}`);
    }
    const rep = await runStandards(ctx.registry, ctx.apiRoot, ctx.harnessRoot, { runDir: ctx.runDir, beforeRoot: ctx.beforeRoot, task: ctx.task });
    ctx.state.lastStandards = rep;
    if (!rep.ok) reasons.push(`standards ${rep.verdict}%:\n${renderFailures(rep, 15).join("\n")}`);

    return reasons.length ? { action: "block", reason: `not done:\n${reasons.join("\n")}` } : { action: "record", note: `gates green (standards ${rep.verdict}%)` };
  },
};

export default hook;
