// The loop: driver turn -> for each tool call: validate args -> pre hooks ->
// tool -> post hooks -> append results. Ends only when the finish gate accepts
// (deterministic checks green) or the turn budget runs out. Writes the run log,
// the token report and the final standards/test verdict on every run.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { buildBrief, buildFrontload, buildSystem, render, type Entry } from "./context.ts";
import { renderStandards, runStandards } from "./standards.ts";
import { loadTask } from "./task.ts";
import { estimateTokens } from "./util.ts";
import { prepareWorkspace } from "./workspace.ts";
import type { HookDecision, HookEvent, HookPlugin, Registry, RunState, ToolCall, ToolContext, ToolOutput, ToolSpec, TurnRequest } from "./types.ts";

export interface RunOptions {
  harnessRoot: string;
  registry: Registry;
  taskFile: string;
  driverId: string;
  baseline: boolean;
  maxTurns?: number;
  runId?: string;
  quiet?: boolean;
}

export interface RunResult {
  ok: boolean;
  runId: string;
  runDir: string;
  worktree: string;
  status: "FINISHED" | "INCOMPLETE" | "REFUSED" | "ERROR";
}

export function toolSpecs(registry: Registry): ToolSpec[] {
  return [...registry.tools.values()].map((t) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}

// Driver-private payloads (e.g. reasoning blocks) are excluded from both columns.
const estimate = (req: TurnRequest): number => estimateTokens(JSON.stringify(req, (k, v: unknown) => (k === "opaque" ? undefined : v)));

export function saveState(runDir: string, state: RunState): void {
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
}

export async function runTask(opts: RunOptions): Promise<RunResult> {
  const { registry, harnessRoot } = opts;
  const { task } = loadTask(opts.taskFile);
  const plugin = registry.drivers.get(opts.driverId);
  if (!plugin) throw new Error(`unknown driver "${opts.driverId}" (have: ${[...registry.drivers.keys()].join(", ")})`);
  const driver = plugin.create();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const runId = opts.runId ?? `${task.name}-${driver.id}${opts.baseline ? "-baseline" : ""}-${stamp}`;
  const ws = prepareWorkspace(harnessRoot, runId, task);
  const runDir = join(ws.worktree, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const say = (s: string): void => {
    if (!opts.quiet) console.log(s);
    appendFileSync(join(runDir, "console.log"), s + "\n");
  };

  const state: RunState = { runId, observedRed: {}, observedGreen: {}, writes: [], finished: false };
  const ctx: ToolContext = {
    harnessRoot,
    apiRoot: ws.apiRoot,
    task,
    state,
    runDir,
    beforeRoot: ws.beforeRoot,
    jit: !opts.baseline,
    registry,
    saveLog(name, content) {
      const p = join(runDir, "logs", name);
      mkdirSync(join(runDir, "logs"), { recursive: true });
      writeFileSync(p, content);
      return relative(ws.worktree, p);
    },
  };
  const standardsOpts = { runDir, beforeRoot: ws.beforeRoot, task };
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({ runId, task: task.name, mode: task.mode, driver: driver.id, model: driver.model, baseline: opts.baseline, branch: ws.branch, baseRef: ws.baseRef, target: task.target, taskSpec: task, startedAt: new Date().toISOString() }, null, 2),
  );

  const tools = toolSpecs(registry);
  const system = buildSystem(registry);
  const baselineSystem = system + buildFrontload(registry, harnessRoot, ws.apiRoot);
  const history: Entry[] = [{ kind: "user", text: buildBrief(task, ws.apiRoot) }];
  const rows: { turn: number; baselineInputTokens: number; actualInputTokens: number; providerInputTokens: number; providerOutputTokens: number }[] = [];
  const maxTurns = opts.maxTurns ?? task.maxTurns;
  let status: RunResult["status"] = "INCOMPLETE";

  say(`run ${runId}  driver=${driver.id} model=${driver.model}  mode=${opts.baseline ? "BASELINE (no JIT, no compaction)" : "actual"}`);
  say(`workspace ${relative(harnessRoot, ws.worktree)} on ${ws.branch}`);

  for (let turn = 1; turn <= maxTurns && !state.finished; turn++) {
    const req: TurnRequest = opts.baseline
      ? { system: baselineSystem, messages: render(history, "baseline"), tools }
      : { system, messages: render(history, "actual"), tools };
    const shadow: TurnRequest = { system: baselineSystem, messages: render(history, "baseline"), tools };

    let res;
    try {
      res = await driver.turn(req);
    } catch (err) {
      say(`turn ${turn}: driver error: ${(err as Error).message}`);
      status = "ERROR";
      break;
    }
    rows.push({
      turn,
      baselineInputTokens: estimate(shadow),
      actualInputTokens: estimate(req),
      providerInputTokens: res.usage.inputTokens,
      providerOutputTokens: res.usage.outputTokens,
    });
    for (const n of res.notes ?? []) say(`turn ${turn}: driver note: ${n}`);
    history.push({ kind: "assistant", text: res.text, calls: res.calls, opaque: res.opaque });
    appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify({ turn, role: "assistant", text: res.text, calls: res.calls, stop: res.stop, usage: res.usage }) + "\n");

    if (res.stop === "refused") {
      say(`turn ${turn}: model refused`);
      status = "REFUSED";
      break;
    }
    if (res.calls.length === 0) {
      history.push({ kind: "user", text: "Harness: no tool call. The run ends only when `finish` is accepted by the gates. Continue with tools." });
      say(`turn ${turn}: no tool call -> nudged`);
      continue;
    }

    const results: Extract<Entry, { kind: "tool" }>["results"] = [];
    for (const call of res.calls) {
      const out = await executeCall(call, ctx);
      results.push({ callId: call.id, name: call.name, content: out.content, raw: out.raw ?? out.content, summary: out.summary ?? `${call.name}: ${out.content.split("\n")[0]?.slice(0, 120) ?? ""}` });
      say(`turn ${turn}: ${call.name} ${argPreview(call)} -> ${out.content.split("\n")[0]?.slice(0, 140) ?? ""}`);
      appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify({ turn, role: "tool", name: call.name, content: out.content }) + "\n");
    }
    history.push({ kind: "tool", results });
    saveState(runDir, state);
  }
  if (state.finished) status = "FINISHED";

  // Final verdict is recomputed by the harness, independent of anything the model said.
  const report = await runStandards(registry, ws.apiRoot, harnessRoot, standardsOpts);
  const standardsText = renderStandards(report);
  writeFileSync(join(runDir, "standards.txt"), `$ harness check --api ${task.target}\n${standardsText}\n`);
  writeFileSync(join(runDir, "standards.json"), JSON.stringify(report, null, 2));
  const testsTool = registry.tools.get("run_tests");
  const finalTests = testsTool ? await testsTool.run({}, ctx) : { content: "UNPROVEN: no run_tests tool registered" };
  writeFileSync(join(runDir, "tests.txt"), finalTests.content + "\n");
  saveState(runDir, state);

  const sum = (k: keyof (typeof rows)[number]): number => rows.reduce((a, r) => a + r[k], 0);
  const baselineTotal = sum("baselineInputTokens");
  const actualTotal = sum("actualInputTokens");
  const peakB = Math.max(0, ...rows.map((r) => r.baselineInputTokens));
  const peakA = Math.max(0, ...rows.map((r) => r.actualInputTokens));
  const pct = (a: number, b: number): number => (b === 0 ? 0 : Math.round((1 - a / b) * 1000) / 10);
  const tokenReport = {
    runId,
    task: task.name,
    driver: driver.id,
    model: driver.model,
    mode: opts.baseline ? "baseline" : "actual",
    method:
      "Per turn, the harness serialises the exact request it sent (system+tools+messages) and, in shadow, the request a no-JIT/no-compaction harness would have sent for the same conversation (API source + all standards front-loaded, raw tool output, no compaction). Both columns use the same chars/4 estimator; providerInputTokens is the provider-reported usage for the request actually sent.",
    turns: rows,
    summary: {
      turns: rows.length,
      baselineInputTokens: baselineTotal,
      actualInputTokens: actualTotal,
      reductionPct: pct(actualTotal, baselineTotal),
      peakBaselineInputTokens: peakB,
      peakActualInputTokens: peakA,
      peakReductionPct: pct(peakA, peakB),
      providerInputTokens: sum("providerInputTokens"),
      providerOutputTokens: sum("providerOutputTokens"),
    },
  };
  mkdirSync(join(ws.worktree, "tokens"), { recursive: true });
  writeFileSync(join(ws.worktree, "tokens", `${runId}.json`), JSON.stringify(tokenReport, null, 2));

  const testsGreen = /^PASS/m.test(finalTests.content);
  const ok = status === "FINISHED" && report.ok && testsGreen;
  const summary = {
    runId,
    status,
    ok,
    standards: { verdict: report.verdict, ok: report.ok },
    tests: testsGreen ? "PASS" : finalTests.content.split("\n")[0],
    observedRed: Object.keys(state.observedRed),
    writes: state.writes,
    tokens: tokenReport.summary,
    branch: ws.branch,
    worktree: relative(harnessRoot, ws.worktree),
  };
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  say("");
  say(standardsText);
  say(`tests             ${finalTests.content.split("\n")[0] ?? ""}`);
  say(`tokens            actual ${actualTotal} vs baseline ${baselineTotal} (est.) -> ${tokenReport.summary.reductionPct}% reduction; peak ${tokenReport.summary.peakReductionPct}%`);
  say(`status            ${status}${ok ? " — ready to ship: harness ship --run " + runId : " — not shippable"}`);
  return { ok, runId, runDir, worktree: ws.worktree, status };
}

function argPreview(call: ToolCall): string {
  const a = call.args as Record<string, unknown> | undefined;
  const p = a && typeof a === "object" ? (a.path ?? a.rule ?? a.pattern ?? a.file ?? "") : "";
  return typeof p === "string" ? p : "";
}

export async function executeCall(call: ToolCall, ctx: ToolContext): Promise<ToolOutput> {
  const tool = ctx.registry.tools.get(call.name);
  if (!tool) return { content: `ERROR: unknown tool "${call.name}". Available: ${[...ctx.registry.tools.keys()].join(", ")}` };
  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) {
    return { content: `ERROR: invalid arguments for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  const watching = (phase: "pre" | "post") => ctx.registry.hooks.filter((h) => h.phase === phase && (!h.tools || h.tools.includes(call.name)));
  const record = (line: string): void => appendFileSync(join(ctx.runDir, "hooks.log"), line + "\n");

  // A hook that throws fails closed: the call is blocked.
  const runHook = async (hook: HookPlugin, ev: HookEvent): Promise<HookDecision> => {
    try {
      return await hook.run(ev, ctx);
    } catch (err) {
      return { action: "block", reason: (err as Error).message };
    }
  };
  for (const hook of watching("pre")) {
    const d = await runHook(hook, { tool: call.name, args: parsed.data });
    if (d.action === "block") {
      record(`BLOCK ${hook.id} ${call.name} ${argPreview(call)}: ${d.reason.split("\n")[0]}`);
      return { content: `BLOCKED by ${hook.id}: ${d.reason}`, summary: `${call.name} blocked by ${hook.id}` };
    }
    if (d.action === "record") record(`RECORD ${hook.id} ${call.name}: ${d.note}`);
  }
  let output: ToolOutput;
  try {
    output = await tool.run(parsed.data, ctx);
  } catch (err) {
    output = { content: `ERROR: ${(err as Error).message}` };
  }
  for (const hook of watching("post")) {
    const d = await runHook(hook, { tool: call.name, args: parsed.data, output });
    if (d.action === "block") {
      record(`BLOCK ${hook.id} ${call.name} (post): ${d.reason.split("\n")[0]}`);
      output = { ...output, content: `${output.content}\nREJECTED by ${hook.id}: ${d.reason}` };
    } else if (d.action === "record") record(`RECORD ${hook.id} ${call.name}: ${d.note}`);
  }
  return output;
}
