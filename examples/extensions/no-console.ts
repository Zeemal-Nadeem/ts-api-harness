// Example extension — a new LINTER RULE. Install: cp examples/extensions/no-console.ts plugins/checks/
// Rule: no console.* in request-handling code (src/server.ts, the process entry point, is exempt).
import { findAll, lineOf, ts } from "../../core/api-model.ts";
import type { CheckPlugin, Finding } from "../../core/types.ts";

const check: CheckPlugin = {
  kind: "check",
  id: "no-console",
  category: "lint",
  required: true,
  doc: "no-console: do not use console.* in src/ (except src/server.ts). Use the response or throw an HttpProblem.",
  async run(api) {
    const findings: Finding[] = [];
    const files = api.sourceFiles.filter((f) => f !== "src/server.ts");
    for (const file of files) {
      const sf = api.sourceFile(file);
      const hits = findAll(sf, (n): n is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "console");
      for (const h of hits) findings.push({ file, line: lineOf(sf, h), ok: false, message: `console.${h.name.text}` });
      if (hits.length === 0) findings.push({ file, line: 1, ok: true, message: "no console" });
    }
    const passed = findings.filter((f) => f.ok).length;
    return { status: findings.every((f) => f.ok) ? "pass" : "fail", passed, total: files.length, unit: "files", findings };
  },
};

export default check;
