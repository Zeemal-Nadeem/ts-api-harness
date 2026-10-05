// The harness ships; the model never does. Re-proves every gate from scratch
// (nothing is taken from the run's own state except what it claims), then
// commits on the run's feature branch, pushes that branch, and opens a PR.
// Never pushes a protected branch, never force-pushes, never commits on red.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderSummary, runStandards } from "./standards.ts";
import { exec } from "./util.ts";
import { git, worktreePath } from "./workspace.ts";
import type { Registry, RunState, Task, ToolContext } from "./types.ts";

const PROTECTED = /^(main|master|develop|trunk|production|release\/.*)$/;
const SECRET = /(sk-ant-[A-Za-z0-9_-]{10,}|sk-or-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,})/;

export interface ShipOptions {
  harnessRoot: string;
  registry: Registry;
  runId: string;
  dryRun: boolean;
  base: string;
  openPr: boolean;
}

type Gate = { name: string; status: "PASS" | "FAIL" | "UNPROVEN"; detail: string };

export async function ship(opts: ShipOptions): Promise<boolean> {
  const worktree = worktreePath(opts.harnessRoot, opts.runId);
  const runDir = join(worktree, "runs", opts.runId);
  if (!existsSync(join(runDir, "meta.json"))) throw new Error(`no run ${opts.runId} (expected ${runDir})`);
  const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as { branch: string; target: string; baseline: boolean; task: string; driver: string; model: string; taskSpec?: Task };
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as RunState;
  const apiRoot = join(worktree, meta.target);
  const beforeRoot = join(worktree, ".harness", "before");
  const gates: Gate[] = [];
  const gate = (name: string, ok: boolean | "unproven", detail: string): void => {
    gates.push({ name, status: ok === "unproven" ? "UNPROVEN" : ok ? "PASS" : "FAIL", detail });
  };

  gate("feature branch", !PROTECTED.test(meta.branch) && meta.branch !== opts.base, meta.branch);
  gate("measurement run", !meta.baseline, meta.baseline ? "baseline runs are for token measurement only" : "actual run");
  gate("finish accepted", state.finished, state.finished ? "finish gate passed during run" : "run never passed the finish gate");
  gate("observed red", Object.keys(state.observedRed).length > 0, Object.keys(state.observedRed).join(", ") || "none");

  const ctx: ToolContext = {
    harnessRoot: opts.harnessRoot,
    apiRoot,
    task: meta.taskSpec ?? ({ name: meta.task, mode: "greenfield", target: meta.target, brief: "", behaviours: [], allowBreaking: false, maxTurns: 1 } as Task),
    state: { ...state },
    runDir: join(opts.harnessRoot, ".harness", "ship", opts.runId),
    beforeRoot: existsSync(beforeRoot) ? beforeRoot : undefined,
    jit: true,
    registry: opts.registry,
    saveLog(name, content) {
      mkdirSync(join(ctx.runDir, "logs"), { recursive: true });
      writeFileSync(join(ctx.runDir, "logs", name), content);
      return join(".harness", "ship", opts.runId, "logs", name);
    },
  };
  mkdirSync(ctx.runDir, { recursive: true });
  const tests = opts.registry.tools.get("run_tests");
  if (!tests) gate("tests", "unproven", "no run_tests tool registered");
  else {
    const out = await tests.run({}, ctx);
    gate("tests", out.content.startsWith("PASS") ? true : out.content.startsWith("UNPROVEN") ? "unproven" : false, out.content.split("\n")[0] ?? "");
  }
  const rep = await runStandards(opts.registry, apiRoot, opts.harnessRoot, { runDir: ctx.runDir, beforeRoot: ctx.beforeRoot, task: ctx.task });
  gate("standards", rep.ok, `${rep.verdict}%`);

  const diff = exec("git", ["diff", "--no-color", `${opts.base}`, "--", "."], { cwd: worktree }).stdout
    + exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: worktree }).stdout.split("\0").filter(Boolean)
      .map((f) => (existsSync(join(worktree, f)) ? readFileSync(join(worktree, f), "utf8") : "")).join("\n");
  const leak = diff.match(SECRET);
  gate("no secrets", !leak, leak ? `secret-like token: ${leak[0].slice(0, 8)}…` : "diff scanned");
  const envFiles = exec("git", ["status", "--porcelain"], { cwd: worktree }).stdout.split("\n").filter((l) => /(^|\/)\.env(\.|$)/.test(l));
  gate("no env files", envFiles.length === 0, envFiles.join(", ") || "none");

  for (const g of gates) console.log(`${g.name.padEnd(18)}${g.status.padEnd(10)}${g.detail}`);
  const green = gates.every((g) => g.status === "PASS");
  if (!green) {
    console.log("ship refused: every gate must PASS (UNPROVEN is not green)");
    return false;
  }
  if (opts.dryRun) {
    console.log("dry run: gates green, nothing committed");
    return true;
  }

  const tokens = join("tokens", `${opts.runId}.json`);
  git(worktree, "add", "--", meta.target, join("runs", opts.runId), tokens);
  const title = `harness(${meta.task}): ${meta.driver} run ${opts.runId}`;
  git(worktree, "commit", "-q", "-m", title, "-m", `Gates: ${gates.map((g) => `${g.name}=${g.status}`).join(", ")}\nStandards: ${rep.verdict}%\nDriver: ${meta.driver} (${meta.model})`);
  const sha = git(worktree, "rev-parse", "--short", "HEAD");
  console.log(`committed ${sha} on ${meta.branch}`);

  const remote = exec("git", ["remote"], { cwd: worktree }).stdout.trim();
  if (!remote.split("\n").includes("origin")) {
    console.log("push UNPROVEN: no 'origin' remote; commit stays on the local feature branch");
    return true;
  }
  git(worktree, "push", "-u", "origin", meta.branch);
  console.log(`pushed ${meta.branch}`);
  if (!opts.openPr) return true;

  const tok = existsSync(join(worktree, tokens)) ? (JSON.parse(readFileSync(join(worktree, tokens), "utf8")) as { summary: Record<string, number> }).summary : undefined;
  const body = [
    `Opened by the harness after every gate passed. Run \`${opts.runId}\`, driver \`${meta.driver}\` (\`${meta.model}\`).`,
    "",
    "### Gates (re-proved at ship time)",
    "```",
    ...gates.map((g) => `${g.name.padEnd(18)}${g.status.padEnd(10)}${g.detail}`),
    "```",
    "### Standards",
    "```",
    ...renderSummary(rep),
    "```",
    tok ? `### Tokens\nactual ${tok.actualInputTokens} vs baseline ${tok.baselineInputTokens} (est.) → **${tok.reductionPct}%** reduction (peak ${tok.peakReductionPct}%). Report: \`${tokens}\`` : "",
    "",
    "### Honesty boundary",
    "Proven: the gates above, by the harness's own runner. Not proven: behaviour beyond the tests the model wrote, performance, security review. A human reviews and merges.",
  ].join("\n");
  writeFileSync(join(ctx.runDir, "pr.md"), body);
  const pr = exec("gh", ["pr", "create", "--base", opts.base, "--head", meta.branch, "--title", title, "--body-file", join(ctx.runDir, "pr.md")], { cwd: worktree });
  if (pr.code !== 0) {
    console.log(`pull request UNPROVEN: ${pr.stderr.trim().split("\n")[0]}`);
    return true;
  }
  const url = pr.stdout.trim().split("\n").pop() ?? "";
  writeFileSync(join(ctx.runDir, "pr.json"), JSON.stringify({ runId: opts.runId, url, sha }, null, 2));
  console.log(`pull request ${url}`);
  return true;
}
