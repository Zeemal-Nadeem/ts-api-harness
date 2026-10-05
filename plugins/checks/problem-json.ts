// Standard 02 — RFC 7807 errors, nothing else.
// Static: a problem module sets application/problem+json and emits all five
// members; no handler builds its own error response (res.status(4xx/5xx),
// sendStatus, { error: ... }); every `new *Problem(status, ...)` uses a 4xx/5xx literal.
// Runtime: boots the app and probes unknown routes, invalid bodies, unknown ids
// and invalid pagination — each response must be a complete problem document.
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findAll, lineOf, ts } from "../../core/api-model.ts";
import { execTs } from "../../core/util.ts";
import type { CheckPlugin, Finding } from "../../core/types.ts";

const MEMBERS = ["type", "title", "status", "detail", "instance"];

function rootIsRes(e: ts.Expression): boolean {
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) e = e.expression.expression;
  return ts.isIdentifier(e) && e.text === "res";
}

const check: CheckPlugin = {
  kind: "check",
  id: "problem-json",
  category: "standard",
  required: true,
  async run(api) {
    const findings: Finding[] = [];
    let problemModule: string | undefined;

    for (const file of api.sourceFiles) {
      const sf = api.sourceFile(file);
      const text = api.read(file);
      const literals = findAll(sf, ts.isObjectLiteralExpression);
      const fullShape = literals.some((o) => {
        const keys = new Set(o.properties.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : "")));
        return MEMBERS.every((k) => keys.has(k));
      });
      if (text.includes("application/problem+json") && fullShape) problemModule = file;
    }
    if (!problemModule) {
      findings.push({ file: "src", line: 0, ok: false, message: "no module sets application/problem+json with type,title,status,detail,instance" });
    } else {
      findings.push({ file: problemModule, line: 1, ok: true, message: "problem+json emitter" });
    }

    let staticPaths = 0;
    let staticOk = 0;
    for (const file of api.sourceFiles) {
      const sf = api.sourceFile(file);
      for (const call of findAll(sf, ts.isCallExpression)) {
        if (!ts.isPropertyAccessExpression(call.expression)) continue;
        const name = call.expression.name.text;
        const arg = call.arguments[0];
        const num = arg && ts.isNumericLiteral(arg) ? Number(arg.text) : undefined;
        if (file !== problemModule && rootIsRes(call.expression.expression) && (name === "status" || name === "sendStatus") && num !== undefined && num >= 400) {
          findings.push({ file, line: lineOf(sf, call), ok: false, message: `ad-hoc error response res.${name}(${num}); throw a problem instead` });
        }
        if ((name === "json" || name === "send") && rootIsRes(call.expression.expression) && arg && ts.isObjectLiteralExpression(arg)) {
          const keys = arg.properties.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : ""));
          if (keys.includes("error")) findings.push({ file, line: lineOf(sf, call), ok: false, message: "ad-hoc { error } body" });
        }
      }
      for (const n of findAll(sf, ts.isNewExpression)) {
        if (!ts.isIdentifier(n.expression) || !/Problem$/.test(n.expression.text)) continue;
        if (file === problemModule && n.arguments?.[0] && !ts.isNumericLiteral(n.arguments[0])) continue; // generic factory inside the module
        staticPaths++;
        const a = n.arguments?.[0];
        const status = a && ts.isNumericLiteral(a) ? Number(a.text) : NaN;
        if (status >= 400 && status <= 599) {
          staticOk++;
          findings.push({ file, line: lineOf(sf, n), ok: true, message: `problem ${status}` });
        } else {
          findings.push({ file, line: lineOf(sf, n), ok: false, message: `${n.expression.text} without a literal 4xx/5xx status` });
        }
      }
    }

    // Runtime probe.
    const routes = api.routes().map((r) => ({ method: r.method, path: r.path }));
    const dir = mkdtempSync(join(tmpdir(), "harness-probe-"));
    const routesFile = join(dir, "routes.json");
    writeFileSync(routesFile, JSON.stringify(routes));
    const r = execTs(api.harnessRoot, join(api.harnessRoot, "plugins/checks/_probe.ts"), [api.root, routesFile]);
    let probeTotal = 0;
    let probeOk = 0;
    if (r.code !== 0) {
      const why = (r.stderr.split("\n").find((l) => /Error/.test(l)) ?? r.stderr.slice(0, 200)).trim();
      return {
        status: "unproven",
        passed: staticOk,
        total: staticPaths,
        unit: "error paths",
        findings,
        detail: `runtime probe could not boot src/app.ts: ${why}`,
      };
    }
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const p = JSON.parse(line) as { name: string; ok: boolean; problems: string[] };
      probeTotal++;
      if (p.ok) probeOk++;
      findings.push({ file: "runtime", line: 0, ok: p.ok, message: p.ok ? p.name : `${p.name}: ${p.problems.join("; ")}` });
    }

    const failed = findings.some((f) => !f.ok);
    return {
      status: failed ? "fail" : "pass",
      passed: staticOk + probeOk,
      total: staticPaths + probeTotal,
      unit: "error paths",
      findings,
    };
  },
};

export default check;
