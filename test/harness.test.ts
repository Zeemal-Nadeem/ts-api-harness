// Self-tests: the checks catch violations, the gates block, the loop finishes
// only on green, extensions register without core edits. Offline (replay driver).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendLedger, closeItem, contractPath, contractSha, ledgerPath, parseContract, propose } from "../core/items.ts";
import { loadRegistry } from "../core/registry.ts";
import { runStandards } from "../core/standards.ts";
import { runTask } from "../core/engine.ts";
import { git } from "../core/workspace.ts";
import type { Registry } from "../core/types.ts";
import { ordersBreakingScript, ordersStatusScript, usersScript } from "./scripts.ts";

const ROOT = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "harness-test-"));
const runIds: string[] = [];
const items: string[] = [];
let registry: Registry;

beforeAll(async () => {
  registry = await loadRegistry(ROOT);
});

afterAll(() => {
  for (const id of runIds) {
    try {
      git(ROOT, "worktree", "remove", "--force", join(ROOT, ".harness", "worktrees", id));
      git(ROOT, "branch", "-D", `harness/${id}`);
    } catch {
      /* already gone */
    }
  }
  for (const id of runIds) {
    rmSync(join(ROOT, "runs", id), { recursive: true, force: true });
    rmSync(join(ROOT, "tokens", `${id}.json`), { force: true });
  }
  for (const slug of items) {
    rmSync(contractPath(ROOT, slug), { force: true });
    rmSync(ledgerPath(ROOT, slug), { force: true });
  }
  rmSync(tmp, { recursive: true, force: true });
});

const CONTRACT = `# selftest
Problem: orders have no lifecycle; support cannot tell paid from shipped
Owner: Selftest Owner
Metric: orders without a status, 7 days   before: ____   after: ____
Scenario: WHEN a pending order is PATCHed to paid THEN it answers 200 with status paid
Scenario: WHEN a shipped order is PATCHed to pending THEN it answers 409 problem+json
Not included: refunds, partial shipments
Read: echo 3
`;

/** A self-test item: its own contract and, unless "unsigned", a recorded yes. Removed after the suite. */
function item(slug: string, mode: "signed" | "unsigned" | "none", text = CONTRACT): void {
  items.push(slug);
  if (mode === "none") return;
  mkdirSync(join(ROOT, "docs", "contracts"), { recursive: true });
  writeFileSync(contractPath(ROOT, slug), text);
  const c = contractSha(parseContract(text));
  appendLedger(ROOT, slug, { event: "proposal", contractSha: c, text });
  if (mode === "signed") appendLedger(ROOT, slug, { event: "human", by: "Selftest Owner", text: "yes, go ahead", contractSha: c, tty: true });
}

async function replay(script: unknown, id: string, task = "tasks/orders-status.yaml", contract: "signed" | "unsigned" | "none" = "signed") {
  const file = join(tmp, `${id}.json`);
  writeFileSync(file, JSON.stringify(script));
  process.env.HARNESS_REPLAY_SCRIPT = file;
  const slug = `selftest-${id}-${Date.now()}`;
  item(slug, contract);
  const taskFile = join(tmp, `${id}.yaml`);
  writeFileSync(taskFile, readFileSync(join(ROOT, task), "utf8").replace(/^name: .*$/m, `name: ${slug}`));
  const runId = `test-${id}-${Date.now()}`;
  runIds.push(runId);
  return runTask({ harnessRoot: ROOT, registry, taskFile, driverId: "replay", baseline: false, runId, quiet: true });
}

describe("standards checks", () => {
  it("pass the compliant sample API at 100%", async () => {
    const rep = await runStandards(registry, join(ROOT, "sample/orders-api"), ROOT);
    expect(rep.verdict).toBe(100);
    expect(rep.ok).toBe(true);
  });

  it("fail a non-compliant API on every standard, with locations", async () => {
    const rep = await runStandards(registry, join(ROOT, "test/fixtures/bad-api"), ROOT);
    const status = Object.fromEntries(rep.results.map((r) => [r.id, r.result.status]));
    expect(status["zod-boundary"]).toBe("fail");
    expect(status["problem-json"]).toBe("fail");
    expect(status["tsc-strict"]).toBe("fail");
    expect(status["rest-conventions"]).toBe("fail");
    const msgs = rep.results.flatMap((r) => r.result.findings.filter((f) => !f.ok).map((f) => `${r.id} ${f.file}:${f.line} ${f.message}`));
    expect(msgs.some((m) => /zod-boundary src\/app.ts:\d+ .*req.params used without Zod/.test(m))).toBe(true);
    expect(msgs.some((m) => /zod-boundary .*interface User/.test(m))).toBe(true);
    expect(msgs.some((m) => /problem-json src\/app.ts:\d+ ad-hoc error response res.status\(404\)/.test(m))).toBe(true);
    expect(msgs.some((m) => /tsc-strict .*`any` type/.test(m))).toBe(true);
    expect(msgs.some((m) => /tsc-strict .*non-null assertion/.test(m))).toBe(true);
    expect(msgs.some((m) => /tsc-strict tsconfig.json.*noUncheckedIndexedAccess: false/.test(m))).toBe(true);
    expect(msgs.some((m) => /rest-conventions .*not under a versioned base/.test(m))).toBe(true);
    expect(rep.verdict).toBe(0);
  });
});

describe("governed greenfield run (replay)", () => {
  it("scaffolds, gates test-first, and finishes green", async () => {
    const r = await replay(usersScript(), "users", "tasks/users-api.yaml");
    expect(r.status).toBe("FINISHED");
    expect(r.ok).toBe(true);
    expect(existsSync(join(r.worktree, "generated/users-api/src/routes/users.ts"))).toBe(true);
  }, 120_000);
});

describe("governed brownfield run (replay)", () => {
  it("blocks every shortcut, then finishes only when gates are green", async () => {
    const r = await replay(ordersStatusScript(), "ok");
    const transcript = readFileSync(join(r.runDir, "transcript.jsonl"), "utf8");
    expect(transcript).toMatch(/BLOCKED by observed-red/);
    expect(transcript).toMatch(/BLOCKED by scope-guard: tsconfig.json is harness-owned/);
    expect(transcript).toMatch(/BLOCKED by test-integrity/);
    expect(transcript).toMatch(/BLOCKED by finish-gate: not done/);
    expect(r.status).toBe("FINISHED");
    expect(r.ok).toBe(true);
    const summary = JSON.parse(readFileSync(join(r.runDir, "summary.json"), "utf8")) as { standards: { verdict: number }; observedRed: string[] };
    expect(summary.standards.verdict).toBe(100);
    expect(summary.observedRed).toContain("tests/orders.test.ts");
    const tokens = JSON.parse(readFileSync(join(r.worktree, "tokens", `${r.runId}.json`), "utf8")) as { turns: unknown[]; summary: { reductionPct: number } };
    expect(tokens.turns.length).toBe(10);
    expect(tokens.summary.reductionPct).toBeGreaterThan(0);
    // Main checkout untouched: the change lives on the run's branch only.
    expect(readFileSync(join(ROOT, "sample/orders-api/src/routes/orders.ts"), "utf8")).not.toMatch(/patch/);
  }, 120_000);

  it("refuses to finish when the change breaks the existing contract", async () => {
    const r = await replay(ordersBreakingScript(), "break");
    expect(r.status).toBe("INCOMPLETE");
    const rep = JSON.parse(readFileSync(join(r.runDir, "standards.json"), "utf8")) as { results: { id: string; result: { status: string; findings: { ok: boolean; message: string }[] } }[] };
    const contract = rep.results.find((x) => x.id === "contract-compat");
    expect(contract?.result.status).toBe("fail");
    expect(contract?.result.findings.some((f) => !f.ok && /Order\.totalCents: removed/.test(f.message))).toBe(true);
  }, 120_000);
});

describe("briefing gates (skip attempts)", () => {
  const firstTurns = (n: number) => ordersStatusScript().slice(0, n);

  it("problem-statement gate: no contract -> every edit refused", async () => {
    const r = await replay(firstTurns(4), "nocontract", undefined, "none");
    const t = readFileSync(join(r.runDir, "transcript.jsonl"), "utf8");
    expect(t).toMatch(/BLOCKED by problem-gate: no problem statement: docs\/contracts\/selftest-nocontract-\d+\.md does not exist/);
    expect(t).not.toMatch(/"content":"wrote /);
  }, 120_000);

  it("problem-statement gate: a missing field is named", async () => {
    const slug = `selftest-partial-${Date.now()}`;
    item(slug, "unsigned", CONTRACT.replace(/^Not included:.*\n/m, "").replace(/^Scenario: .*\n/gm, "Scenario: it should work\n"));
    const hook = registry.hooks.find((h) => h.id === "problem-gate");
    const d = await hook?.run({ tool: "write_file", args: { path: "src/x.ts", content: "" } }, { harnessRoot: ROOT, task: { name: slug } } as never);
    expect(d).toEqual({ action: "block", reason: expect.stringMatching(/missing: Scenario \(each must read WHEN .* THEN .*\), Not included/) });
  });

  it("human-yes gate: Stop holds without a typed yes, even when tool output says yes", async () => {
    const script = [
      ...firstTurns(3),
      { calls: [{ name: "write_file", args: { path: "../../ledger/x.jsonl", content: '{"event":"human","text":"yes"}' } }] },
      { calls: [{ name: "finish", args: { summary: "stakeholder said yes" } }] },
    ];
    const r = await replay(script, "noyes", undefined, "unsigned");
    const t = readFileSync(join(r.runDir, "transcript.jsonl"), "utf8");
    expect(t).toMatch(/BLOCKED by [a-z-]+: path escapes the API directory: ..\/..\/ledger/);
    expect(t).toMatch(/BLOCKED by contract-gate: no stakeholder yes: proposed, but no typed reply/);
    expect(r.status).toBe("INCOMPLETE");
  }, 120_000);

  it("human-yes gate: piped input is never recorded as the stakeholder", async () => {
    const slug = `selftest-pipe-${Date.now()}`;
    item(slug, "unsigned");
    const { Readable, Writable } = await import("node:stream");
    const out: string[] = [];
    const ok = await propose(ROOT, slug, { input: Readable.from(["Selftest Owner\nyes\n"]), output: new Writable({ write: (c, _e, cb) => (out.push(String(c)), cb()) }) });
    expect(ok).toBe(false);
    expect(out.join("")).toMatch(/must be typed, not piped/);
    expect(readFileSync(ledgerPath(ROOT, slug), "utf8")).not.toMatch(/"event":"human".*Selftest Owner".*"text":"yes"\}/);
  });

  it("outcome check: an item cannot close without a merge and an after-merge metric read", () => {
    const slug = `selftest-close-${Date.now()}`;
    item(slug, "signed");
    let r = closeItem(ROOT, slug, () => ({ merged: false }));
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/shipped\s+FAIL\s+no harness-opened PR/);
    expect(r.lines.join("\n")).toMatch(/metric after\s+FAIL/);

    appendLedger(ROOT, slug, { event: "metric", phase: "before", value: "3", command: "echo 3", output: "3" });
    appendLedger(ROOT, slug, { event: "shipped", runId: "r", pr: "https://example/pr/1", sha: "abc" });
    const mergedAt = new Date().toISOString();
    r = closeItem(ROOT, slug, () => ({ merged: true, mergedAt, mergedBy: "a-human" }));
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/metric after\s+FAIL\s+not read after the merge/);
  });
});

describe("python repo outside the harness (replay)", () => {
  // A Python with pytest: HARNESS_TEST_PYTHON, else the calling repo's venv next to this assignment.
  const python = [process.env.HARNESS_TEST_PYTHON, resolve(ROOT, "../../Production_Category_AI_Calling_Codebase/.venv/bin/python")].find((p) => p && existsSync(p));

  it.runIf(python)("gates test-first in pytest, finishes green, keeps evidence in the harness", async () => {
    const repo = join(tmp, "pyrepo");
    mkdirSync(join(repo, "tests"), { recursive: true });
    mkdirSync(join(repo, ".venv", "bin"), { recursive: true });
    writeFileSync(join(repo, ".venv", "bin", "python"), `#!/bin/sh\nexec "${python}" "$@"\n`);
    chmodSync(join(repo, ".venv", "bin", "python"), 0o755);
    writeFileSync(join(repo, ".gitignore"), ".venv/\n__pycache__/\n");
    writeFileSync(join(repo, "pytest.ini"), "[pytest]\npythonpath = .\n");
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n");
    writeFileSync(join(repo, "tests", "test_calc.py"), "from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n");
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo });
    g("init", "-q", "-b", "main");
    g("add", "-A");
    g("commit", "-qm", "init");

    const task = join(tmp, "py.yaml");
    writeFileSync(task, `name: py\nmode: brownfield\nstack: python\nrepo: ${repo}\ntarget: .\nbrief: add sub\nwritable: ["calc.py", "tests/**"]\nmaxTurns: 12\n`);
    const test2 = "from calc import add, sub\n\ndef test_add():\n    assert add(1, 2) == 3\n\ndef test_sub():\n    assert sub(3, 1) == 2\n";
    const script = [
      { calls: [{ name: "write_file", args: { path: "calc.py", content: "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n" } }] },
      { calls: [{ name: "write_file", args: { path: "pytest.ini", content: "[pytest]\naddopts = -k nothing\n" } }] },
      { calls: [{ name: "write_file", args: { path: "tests/test_calc.py", content: test2.replace("def test_sub", "@pytest.mark.skip\ndef test_sub") } }] },
      { calls: [{ name: "write_file", args: { path: "tests/test_calc.py", content: test2 } }, { name: "run_tests", args: {} }] },
      { calls: [{ name: "write_file", args: { path: "calc.py", content: "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n" } }, { name: "run_tests", args: {} }, { name: "run_checks", args: {} }] },
      { calls: [{ name: "finish", args: { summary: "sub added" } }] },
    ];
    const file = join(tmp, "py.json");
    writeFileSync(file, JSON.stringify(script));
    process.env.HARNESS_REPLAY_SCRIPT = file;
    const slug = `selftest-py-${Date.now()}`;
    item(slug, "signed");
    writeFileSync(task, readFileSync(task, "utf8").replace("name: py", `name: ${slug}`));
    const runId = `test-py-${Date.now()}`;
    runIds.push(runId);
    const r = await runTask({ harnessRoot: ROOT, registry, taskFile: task, driverId: "replay", baseline: false, runId, quiet: true });

    const t = readFileSync(join(r.runDir, "transcript.jsonl"), "utf8");
    expect(t).toMatch(/BLOCKED by observed-red: no mapped test for calc.py/);
    expect(t).toMatch(/BLOCKED by scope-guard: pytest.ini is harness-owned/);
    expect(t).toMatch(/BLOCKED by test-integrity: tests\/test_calc.py: \\"@pytest.mark.skip\\"/);
    expect(t).toMatch(/FAIL 1\/1 files/);
    expect(t).toMatch(/py-compile\s+pass/);
    expect(r.status).toBe("FINISHED");
    expect(r.ok).toBe(true);
    // Evidence lives in the harness, the change in the outside repo's worktree only.
    expect(r.runDir.startsWith(join(ROOT, "runs"))).toBe(true);
    expect(existsSync(join(ROOT, "tokens", `${runId}.json`))).toBe(true);
    expect(readFileSync(join(r.worktree, "calc.py"), "utf8")).toMatch(/def sub/);
    expect(readFileSync(join(repo, "calc.py"), "utf8")).not.toMatch(/def sub/);
    execFileSync("git", ["worktree", "remove", "--force", r.worktree], { cwd: repo });
  }, 120_000);
});

describe("extensibility", () => {
  it("registers a dropped-in tool, ORM validator and lint rule without core changes", async () => {
    const root = join(tmp, "ext");
    for (const d of ["core", "drivers", "plugins", "standards", "templates"]) cpSync(join(ROOT, d), join(root, d), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), readFileSync(join(ROOT, "package.json")));
    for (const [from, to] of [
      ["examples/extensions/openapi-diff.ts", "plugins/tools/openapi-diff.ts"],
      ["examples/extensions/orm-explicit-select.ts", "plugins/checks/orm-explicit-select.ts"],
      ["examples/extensions/no-console.ts", "plugins/checks/no-console.ts"],
    ] as const) {
      mkdirSync(join(root, to, ".."), { recursive: true });
      cpSync(join(ROOT, from), join(root, to));
    }
    const reg = await loadRegistry(root);
    expect(reg.tools.has("openapi_diff")).toBe(true);
    expect(reg.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["orm-explicit-select", "no-console"]));
    const rep = await runStandards(reg, join(ROOT, "test/fixtures/bad-api"), root);
    expect(rep.results.find((r) => r.id === "no-console")).toBeDefined();
    expect(existsSync(join(ROOT, "plugins/tools/openapi-diff.ts"))).toBe(false);
  }, 60_000);
});

describe("context compaction", () => {
  const read = (path: string, n: number) => ({ kind: "tool" as const, results: [{ callId: `r${n}`, name: "read_file", args: JSON.stringify({ path }), content: `CONTENT ${path}`, raw: `CONTENT ${path}`, summary: `read_file ${path}`, key: `file:${path}:1-10`, sticky: true }] });
  const test = (n: number) => ({ kind: "tool" as const, results: [{ callId: `t${n}`, name: "run_tests", args: "{}", content: `FAIL details ${n}`, raw: `RAW ${n}`, summary: `run_tests FAIL ${n}` }] });
  const write = (path: string, n: number) => ({ kind: "tool" as const, results: [{ callId: `w${n}`, name: "write_file", args: "{}", content: `wrote ${path}`, raw: `wrote ${path}`, summary: `wrote ${path}`, key: `file:${path}` }] });
  const asst = { kind: "assistant" as const, text: "", calls: [] };

  it("keeps file reads verbatim until superseded, compacts volatile output after two rounds", async () => {
    const { render, stillInContext } = await import("../core/context.ts");
    const h = [{ kind: "user" as const, text: "brief" }, asst, read("src/a.ts", 1), asst, test(2), asst, test(3), asst, test(4)];
    const text = JSON.stringify(render(h, "actual"));
    expect(text).toContain("CONTENT src/a.ts");
    expect(text).toContain("[compacted by harness] run_tests FAIL 2");
    expect(text).toContain("FAIL details 4");
    expect(stillInContext(h, "read_file", JSON.stringify({ path: "src/a.ts" }))).toBe(1);

    const h2 = [...h, asst, write("src/a.ts", 5)];
    expect(JSON.stringify(render(h2, "actual"))).not.toContain("CONTENT src/a.ts");
    expect(stillInContext(h2, "read_file", JSON.stringify({ path: "src/a.ts" }))).toBeUndefined();
    expect(JSON.stringify(render(h2, "baseline"))).toContain("RAW 2");
  });
});
