// The harness's own test runner. Its results — not the model's claims — are
// what the observed-red gate and the finish gate trust.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { resolveInApi } from "../../core/paths.ts";
import { exec, sha, stripAnsi } from "../../core/util.ts";
import type { ToolPlugin } from "../../core/types.ts";

interface VitestJson {
  numTotalTests: number;
  numFailedTests: number;
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { fullName: string; title?: string; status: string; failureMessages: string[] }[];
  }[];
}

let counter = 0;

const runTests: ToolPlugin<{ file?: string | undefined }> = {
  kind: "tool",
  name: "run_tests",
  description: "Run the API's Vitest suite (or one test file) with the harness runner. Returns pass/fail lines; full log path included.",
  input: z.object({ file: z.string().optional() }),
  async run({ file }, ctx) {
    const n = ++counter;
    const jsonOut = join(ctx.runDir, "logs", `tests-${n}.json`);
    const args = [join(ctx.harnessRoot, "node_modules/vitest/vitest.mjs"), "run", "--root", ctx.apiRoot, "--reporter=default", "--reporter=json", `--outputFile.json=${jsonOut}`];
    if (file) args.push(resolveInApi(ctx.apiRoot, file).rel);
    const r = exec(process.execPath, args, { cwd: ctx.apiRoot, timeoutMs: 120_000 });
    const raw = stripAnsi(r.stdout + r.stderr);
    const logPath = ctx.saveLog(`tests-${n}.txt`, raw);
    if (r.timedOut) return { content: `UNPROVEN: test run timed out (log: ${logPath})`, raw };
    if (!existsSync(jsonOut)) return { content: `UNPROVEN: runner produced no report (exit ${r.code}); log: ${logPath}\n${raw.slice(-600)}`, raw };

    const rep = JSON.parse(readFileSync(jsonOut, "utf8")) as VitestJson;
    if (rep.testResults.length === 0) return { content: `UNPROVEN: no test files found (log: ${logPath})`, raw, summary: "run_tests: no test files" };

    const lines: string[] = [];
    const failedNames: string[] = [];
    const passed: string[] = [];
    const failed: string[] = [];
    for (const t of rep.testResults) {
      const rel = relative(ctx.apiRoot, t.name);
      const contentSha = existsSync(t.name) ? sha(readFileSync(t.name, "utf8")) : "missing";
      const bad = t.assertionResults.filter((a) => a.status === "failed");
      const ok = t.status === "passed";
      if (ok) {
        passed.push(rel);
        ctx.state.observedGreen[rel] = contentSha;
        lines.push(`  pass ${rel} (${t.assertionResults.length} tests)`);
      } else {
        failed.push(rel);
        ctx.state.observedRed[rel] = contentSha;
        if (bad.length === 0) lines.push(`  FAIL ${rel}: ${(t.message ?? "suite failed to load").split("\n")[0]?.slice(0, 200)}`);
        failedNames.push(...bad.map((a) => a.title ?? a.fullName));
        for (const a of bad.slice(0, 6)) {
          const msg = stripAnsi(a.failureMessages[0] ?? "").split("\n")[0]?.slice(0, 180) ?? "";
          lines.push(`  FAIL ${rel} › ${a.fullName}: ${msg}`);
        }
        if (bad.length > 6) lines.push(`  … ${bad.length - 6} more failures in ${rel}`);
      }
    }
    ctx.state.lastTests = { ok: failed.length === 0, failed, passed };
    const head = failed.length === 0
      ? `PASS ${passed.length} files, ${rep.numTotalTests} tests`
      : `FAIL ${failed.length}/${rep.testResults.length} files, ${rep.numFailedTests}/${rep.numTotalTests} tests failed`;
    return {
      content: `${head}\n${lines.join("\n")}\n(full log kept for reviewers: ${logPath})`,
      raw,
      summary: `run_tests${file ? ` ${file}` : ""}: ${head}${failedNames.length ? ` — ${failedNames.join("; ").slice(0, 200)}` : ""}`,
    };
  },
};

export default runTests;
