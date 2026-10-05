// Self-tests: the checks catch violations, the gates block, the loop finishes
// only on green, extensions register without core edits. Offline (replay driver).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../core/registry.ts";
import { runStandards } from "../core/standards.ts";
import { runTask } from "../core/engine.ts";
import { git } from "../core/workspace.ts";
import type { Registry } from "../core/types.ts";
import { ordersBreakingScript, ordersStatusScript, usersScript } from "./scripts.ts";

const ROOT = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "harness-test-"));
const runIds: string[] = [];
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
  rmSync(tmp, { recursive: true, force: true });
});

async function replay(script: unknown, id: string, task = "tasks/orders-status.yaml") {
  const file = join(tmp, `${id}.json`);
  writeFileSync(file, JSON.stringify(script));
  process.env.HARNESS_REPLAY_SCRIPT = file;
  const runId = `test-${id}-${Date.now()}`;
  runIds.push(runId);
  return runTask({ harnessRoot: ROOT, registry, taskFile: join(ROOT, task), driverId: "replay", baseline: false, runId, quiet: true });
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
