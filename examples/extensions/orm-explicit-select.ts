// Example extension — a custom ORM VALIDATOR. Install: cp examples/extensions/orm-explicit-select.ts plugins/checks/
// Rule: every Prisma or Drizzle query on users must select explicit columns.
//   Prisma:  prisma.user.findMany({ ... })   must pass `select:`
//   Drizzle: db.select().from(users)         must pass a column map to select({...})
import { findAll, lineOf, ts } from "../../core/api-model.ts";
import type { CheckPlugin, Finding } from "../../core/types.ts";

const PRISMA_READS = new Set(["findMany", "findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow"]);

const check: CheckPlugin = {
  kind: "check",
  id: "orm-explicit-select",
  category: "orm",
  required: true,
  doc: "orm-explicit-select: Prisma/Drizzle queries on users must select explicit columns (no implicit SELECT *).",
  async run(api) {
    const findings: Finding[] = [];
    for (const file of api.sourceFiles) {
      const sf = api.sourceFile(file);
      for (const call of findAll(sf, ts.isCallExpression)) {
        const callee = call.expression;
        if (!ts.isPropertyAccessExpression(callee)) continue;
        // prisma.user.findMany(...)
        if (PRISMA_READS.has(callee.name.text) && ts.isPropertyAccessExpression(callee.expression) && /^users?$/.test(callee.expression.name.text)) {
          const arg = call.arguments[0];
          const hasSelect = !!arg && ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "select");
          findings.push({ file, line: lineOf(sf, call), ok: hasSelect, message: hasSelect ? `prisma ${callee.name.text} selects columns` : `prisma ${callee.name.text} on users without explicit select` });
        }
        // db.select().from(users)
        if (callee.name.text === "from" && call.arguments[0] && ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === "users") {
          const sel = callee.expression;
          if (ts.isCallExpression(sel) && ts.isPropertyAccessExpression(sel.expression) && sel.expression.name.text === "select") {
            const ok = sel.arguments.length > 0;
            findings.push({ file, line: lineOf(sf, call), ok, message: ok ? "drizzle select with columns" : "drizzle select() on users without explicit columns" });
          }
        }
      }
    }
    if (findings.length === 0) return { status: "n/a", passed: 0, total: 0, unit: "queries", findings };
    const passed = findings.filter((f) => f.ok).length;
    return { status: passed === findings.length ? "pass" : "fail", passed, total: findings.length, unit: "queries", findings };
  },
};

export default check;
