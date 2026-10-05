// Standard 04 — REST conventions, per route:
//  - versioned base path (/v<N>/...) and a plural, lower-kebab collection noun
//  - item routes for GET-one / PUT / PATCH / DELETE end in a :param
//  - POST to a collection answers 201; DELETE answers 204 with no body
//  - collection GET is cursor-paginated (returns nextCursor / uses paginate())
//  - POST and PATCH carry the idempotency middleware (safe retries)
//  - success statuses limited to 200/201/202/204; problem statuses to the agreed set
import { findAll, lineOf, ts } from "../../core/api-model.ts";
import type { CheckPlugin, Finding } from "../../core/types.ts";

const OK_SUCCESS = new Set([200, 201, 202, 204]);
const OK_PROBLEM = new Set([400, 401, 403, 404, 409, 412, 415, 422, 429, 500, 503]);

function statusesIn(node: ts.Node): number[] {
  return findAll(node, ts.isCallExpression)
    .filter((c) => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "status")
    .map((c) => c.arguments[0])
    .filter((a): a is ts.NumericLiteral => !!a && ts.isNumericLiteral(a))
    .map((a) => Number(a.text));
}

const check: CheckPlugin = {
  kind: "check",
  id: "rest-conventions",
  category: "standard",
  required: true,
  async run(api) {
    const findings: Finding[] = [];
    const routes = api.routes();
    let passed = 0;
    for (const r of routes) {
      const sf = api.sourceFile(r.file);
      const body = r.handler.getText(sf);
      const problems: string[] = [];
      const segs = r.path.split("/").filter(Boolean);
      const isItem = /\/:[^/]+$/.test(r.path);

      if (!/^v\d+$/.test(segs[0] ?? "")) problems.push("path is not under a versioned base (/v1/...)");
      const noun = segs[1] ?? "";
      if (!/^[a-z][a-z0-9-]*s$/.test(noun)) problems.push(`collection "${noun}" is not a plural lower-kebab noun`);
      for (const s of segs.slice(2)) {
        if (!s.startsWith(":") && !/^[a-z][a-z0-9-]*$/.test(s)) problems.push(`segment "${s}" is not lower-kebab`);
      }
      if ((r.method === "put" || r.method === "patch" || r.method === "delete") && !isItem) {
        problems.push(`${r.method.toUpperCase()} must target an item (/:id)`);
      }
      const statuses = statusesIn(r.handler);
      if (r.method === "post" && !isItem && !statuses.includes(201)) problems.push("POST to a collection must respond 201");
      if (r.method === "delete") {
        if (!statuses.includes(204)) problems.push("DELETE must respond 204");
        if (/\.json\(/.test(body)) problems.push("DELETE 204 must not send a body");
      }
      if (r.method === "get" && !isItem && !/nextCursor|paginate\(/.test(body)) {
        problems.push("collection GET is not cursor-paginated (nextCursor/paginate)");
      }
      if ((r.method === "post" || r.method === "patch") && !r.middleware.some((m) => /idempoten/i.test(m))) {
        problems.push("unsafe method without idempotency middleware");
      }
      for (const s of statuses) if (!OK_SUCCESS.has(s) && s < 400) problems.push(`unexpected success status ${s}`);
      for (const n of findAll(r.handler, ts.isNewExpression)) {
        const a = n.arguments?.[0];
        if (ts.isIdentifier(n.expression) && /Problem$/.test(n.expression.text) && a && ts.isNumericLiteral(a) && !OK_PROBLEM.has(Number(a.text))) {
          problems.push(`problem status ${a.text} at line ${lineOf(sf, n)} outside the agreed set`);
        }
      }

      const label = `${r.method.toUpperCase()} ${r.path}`;
      if (problems.length === 0) {
        passed++;
        findings.push({ file: r.file, line: r.line, ok: true, message: label });
      } else {
        for (const p of problems) findings.push({ file: r.file, line: r.line, ok: false, message: `${label}: ${p}` });
      }
    }
    if (routes.length === 0) {
      return { status: "unproven", passed: 0, total: 0, unit: "routes", findings, detail: "no routes found" };
    }
    return { status: passed === routes.length ? "pass" : "fail", passed, total: routes.length, unit: "routes", findings };
  },
};

export default check;
