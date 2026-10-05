// run_checks: the standards report, compact. get_standard: one rule's text, on demand.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { standardText } from "../../core/context.ts";
import { renderFailures, renderStandards, renderSummary, runStandards } from "../../core/standards.ts";
import type { ToolPlugin } from "../../core/types.ts";

const runChecks: ToolPlugin<Record<string, never>> = {
  kind: "tool",
  name: "run_checks",
  description: "Run every standards check (Zod boundary, problem+json, tsc strict, REST conventions, plugins) on the API.",
  input: z.object({}),
  async run(_args, ctx) {
    const rep = await runStandards(ctx.registry, ctx.apiRoot, ctx.harnessRoot, { runDir: ctx.runDir, beforeRoot: ctx.beforeRoot, task: ctx.task });
    ctx.state.lastStandards = rep;
    const full = renderStandards(rep);
    const log = ctx.saveLog(`checks-${Date.now()}.txt`, full);
    const tscLog = join(ctx.runDir, "tsc.log");
    const fails = renderFailures(rep);
    return {
      content: [...renderSummary(rep), ...(fails.length ? ["failures:", ...fails] : []), `log: ${log}`].join("\n"),
      raw: full + (existsSync(tscLog) ? `\n\n${readFileSync(tscLog, "utf8")}` : ""),
      summary: `run_checks: verdict ${rep.verdict}%`,
    };
  },
};

const getStandard: ToolPlugin<{ rule: string }> = {
  kind: "tool",
  name: "get_standard",
  description: "Fetch the exact text of one standard (e.g. zod-boundary, problem-json, tsc-strict, rest-conventions).",
  input: z.object({ rule: z.string() }),
  async run({ rule }, ctx) {
    const text = standardText(ctx.harnessRoot, ctx.registry, rule);
    return { content: text, summary: `get_standard ${rule}` };
  },
};

const finish: ToolPlugin<{ summary: string }> = {
  kind: "tool",
  name: "finish",
  description: "Declare the work complete. The harness re-runs tests and checks; it is refused unless all are green.",
  input: z.object({ summary: z.string() }),
  async run({ summary }, ctx) {
    ctx.state.finished = true;
    return { content: `accepted: ${summary.slice(0, 200)}`, summary: "finish accepted" };
  },
};

export default [runChecks, getStandard, finish];
