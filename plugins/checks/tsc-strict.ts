// Standard 03 — strict type safety.
// tsconfig must enable strict + noUncheckedIndexedAccess; `tsc --noEmit` must
// report 0 errors; source and tests may not contain `any`, non-null assertions
// or @ts-ignore / @ts-expect-error / @ts-nocheck.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findAll, lineOf, ts, walk } from "../../core/api-model.ts";
import { exec } from "../../core/util.ts";
import type { CheckPlugin, Finding } from "../../core/types.ts";

const BANNED_COMMENT = /@ts-(ignore|expect-error|nocheck)/;

const check: CheckPlugin = {
  kind: "check",
  id: "tsc-strict",
  category: "standard",
  required: true,
  async run(api) {
    const findings: Finding[] = [];
    const tsconfigPath = join(api.root, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
      return { status: "fail", passed: 0, total: 1, unit: "errors", findings: [{ file: "tsconfig.json", line: 0, ok: false, message: "missing" }] };
    }
    const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const opts = ts.parseJsonConfigFileContent(cfg.config, ts.sys, api.root).options;
    for (const flag of ["strict", "noUncheckedIndexedAccess"] as const) {
      findings.push({ file: "tsconfig.json", line: 1, ok: opts[flag] === true, message: `${flag}: ${String(opts[flag] ?? false)}` });
    }

    // AST bans over everything the model may write: src/ and tests/.
    const files = [
      ...api.sourceFiles,
      ...walk(join(api.root, "tests"), (r) => r.endsWith(".ts")).map((r) => join("tests", r)),
    ];
    for (const file of files) {
      const text = api.read(file);
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      for (const n of findAll(sf, (x): x is ts.Node => x.kind === ts.SyntaxKind.AnyKeyword)) {
        findings.push({ file, line: lineOf(sf, n), ok: false, message: "`any` type" });
      }
      for (const n of findAll(sf, ts.isNonNullExpression)) {
        findings.push({ file, line: lineOf(sf, n), ok: false, message: "non-null assertion `!`" });
      }
      text.split("\n").forEach((l, i) => {
        if (BANNED_COMMENT.test(l)) findings.push({ file, line: i + 1, ok: false, message: l.trim().slice(0, 60) });
      });
    }

    const tsc = join(api.harnessRoot, "node_modules/typescript/bin/tsc");
    const r = exec(process.execPath, [tsc, "-p", tsconfigPath, "--noEmit", "--pretty", "false"], { cwd: api.root });
    if (r.timedOut) {
      return { status: "unproven", passed: 0, total: 0, unit: "errors", findings, detail: "tsc timed out" };
    }
    const errors = (r.stdout + r.stderr).split("\n").filter((l) => /error TS\d+/.test(l));
    if (api.runDir) writeFileSync(join(api.runDir, "tsc.log"), r.stdout + r.stderr);
    for (const e of errors) {
      const m = e.match(/^(.*?)\((\d+),\d+\): (error TS\d+: .*)$/);
      findings.push({ file: m?.[1] ?? "tsc", line: Number(m?.[2] ?? 0), ok: false, message: m?.[3] ?? e });
    }
    if (r.code !== 0 && errors.length === 0) {
      return { status: "unproven", passed: 0, total: 0, unit: "errors", findings, detail: `tsc exited ${r.code} without diagnostics` };
    }
    if (errors.length === 0) findings.push({ file: "tsc", line: 0, ok: true, message: "0 errors" });

    const bad = findings.filter((f) => !f.ok).length;
    // unit "errors": rendered as `${total - passed} errors`
    return { status: bad === 0 ? "pass" : "fail", passed: 0, total: bad, unit: "errors", findings };
  },
};

export default check;
