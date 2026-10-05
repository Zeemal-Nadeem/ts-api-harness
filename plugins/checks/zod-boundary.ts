// Standard 01 — Zod at every boundary.
// Per handler: req.params / req.query / req.body may only be touched as the
// direct argument of <schema>.parse()/safeParse(); a route with :params must
// parse params, a body-carrying method must parse body, a collection GET must
// parse query, and every res.json()/res.send() payload must be <schema>.parse(...).
// Per file: no hand-written object types (interface / type X = {...}) — infer from Zod.
import { findAll, lineOf, ts } from "../../core/api-model.ts";
import type { CheckPlugin, Finding } from "../../core/types.ts";

const PARSE = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync"]);

function isParseCall(n: ts.Node): n is ts.CallExpression {
  return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && PARSE.has(n.expression.name.text);
}

function reqPart(n: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "req") {
    const p = n.name.text;
    if (p === "params" || p === "query" || p === "body") return p;
  }
  return undefined;
}

/** res.json(x) / res.status(n).json(x) / res.send(x) */
function isResponseSend(n: ts.Node): n is ts.CallExpression {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return false;
  const name = n.expression.name.text;
  if (name !== "json" && name !== "send") return false;
  let recv: ts.Expression = n.expression.expression;
  while (ts.isCallExpression(recv) && ts.isPropertyAccessExpression(recv.expression)) recv = recv.expression.expression;
  return ts.isIdentifier(recv) && recv.text === "res";
}

const check: CheckPlugin = {
  kind: "check",
  id: "zod-boundary",
  category: "standard",
  required: true,
  async run(api) {
    const findings: Finding[] = [];
    const routes = api.routes();
    let passed = 0;

    for (const r of routes) {
      const sf = api.sourceFile(r.file);
      const problems: string[] = [];
      const parsed = new Set<string>();

      for (const access of findAll(r.handler, (n): n is ts.PropertyAccessExpression => reqPart(n) !== undefined)) {
        const part = reqPart(access) ?? "";
        const parent = access.parent;
        if (parent && isParseCall(parent) && parent.arguments[0] === access) parsed.add(part);
        else problems.push(`req.${part} used without Zod parse (line ${lineOf(sf, access)})`);
      }
      const hasParams = r.path.includes("/:");
      const isCollection = !/\/:[^/]+$/.test(r.path);
      if (hasParams && !parsed.has("params")) problems.push("path params not parsed with Zod");
      if ((r.method === "post" || r.method === "put" || r.method === "patch") && !parsed.has("body"))
        problems.push("request body not parsed with Zod");
      if (r.method === "get" && isCollection && !parsed.has("query")) problems.push("query not parsed with Zod");

      for (const send of findAll(r.handler, isResponseSend)) {
        const arg = send.arguments[0];
        if (arg && !isParseCall(arg)) problems.push(`response at line ${lineOf(sf, send)} not passed through <Schema>.parse()`);
      }

      const label = `${r.method.toUpperCase()} ${r.path}`;
      if (problems.length === 0) {
        passed++;
        findings.push({ file: r.file, line: r.line, ok: true, message: label });
      } else {
        for (const p of problems) findings.push({ file: r.file, line: r.line, ok: false, message: `${label}: ${p}` });
      }
    }

    // Types are inferred from schemas, never hand-written a second time.
    for (const file of api.sourceFiles) {
      const sf = api.sourceFile(file);
      for (const st of sf.statements) {
        if (ts.isInterfaceDeclaration(st)) {
          findings.push({ file, line: lineOf(sf, st), ok: false, message: `interface ${st.name.text}: hand-written type, use z.infer<typeof Schema>` });
        } else if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type)) {
          findings.push({ file, line: lineOf(sf, st), ok: false, message: `type ${st.name.text}: hand-written object type, use z.infer<typeof Schema>` });
        }
      }
    }

    if (routes.length === 0) {
      return { status: "unproven", passed: 0, total: 0, unit: "handlers", findings, detail: "no routes found" };
    }
    const failed = findings.some((f) => !f.ok);
    return { status: failed ? "fail" : "pass", passed, total: routes.length, unit: "handlers", findings };
  },
};

export default check;
