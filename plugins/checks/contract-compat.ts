// Own addition — contract drift gate (brownfield).
// Compares the API's public contract after the change with the pristine copy
// the harness took when the run started: routes (method + path) and the JSON
// Schema of every exported Zod schema in src/schemas. Breaking changes fail the
// gate unless the task sets allowBreaking: true:
//   - a route or exported schema disappears
//   - a property disappears or changes type/format
//   - an enum loses a value
//   - a request schema (*Body/*Query/*Params) gains a required property
//   - a response schema stops guaranteeing a required property
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createApiContext } from "../../core/api-model.ts";
import { execTs } from "../../core/util.ts";
import type { CheckPlugin, Finding } from "../../core/types.ts";

type Schema = {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
};

function extract(harnessRoot: string, apiRoot: string): Record<string, Schema> {
  const r = execTs(harnessRoot, join(harnessRoot, "plugins/checks/_contract-extract.ts"), [apiRoot]);
  if (r.code !== 0) throw new Error(`schema extraction failed: ${r.stderr.split("\n").find((l) => l.trim()) ?? ""}`);
  return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as Record<string, Schema>;
}

const shape = (s: Schema | undefined): string => (s ? `${JSON.stringify(s.type ?? (s.anyOf ? "anyOf" : "?"))}${s.format ? `:${s.format}` : ""}` : "missing");

function diff(name: string, at: string, before: Schema, after: Schema, isRequest: boolean, out: string[]): void {
  if (shape(before) !== shape(after)) {
    out.push(`${name}${at}: type ${shape(before)} -> ${shape(after)}`);
    return;
  }
  if (before.enum) {
    const lost = before.enum.filter((v) => !(after.enum ?? []).includes(v));
    if (lost.length) out.push(`${name}${at}: enum lost ${JSON.stringify(lost)}`);
  }
  if (before.items && after.items) diff(name, `${at}[]`, before.items, after.items, isRequest, out);
  const bp = before.properties ?? {};
  const ap = after.properties ?? {};
  const breq = new Set(before.required ?? []);
  const areq = new Set(after.required ?? []);
  for (const [k, v] of Object.entries(bp)) {
    const a = ap[k];
    if (!a) out.push(`${name}${at}.${k}: removed`);
    else diff(name, `${at}.${k}`, v, a, isRequest, out);
    if (!isRequest && breq.has(k) && a && !areq.has(k)) out.push(`${name}${at}.${k}: no longer guaranteed in responses`);
  }
  if (isRequest) for (const k of areq) if (!breq.has(k)) out.push(`${name}${at}.${k}: new required request field`);
}

const check: CheckPlugin = {
  kind: "check",
  id: "contract-compat",
  category: "contract",
  required: true,
  doc: [
    "contract-compat (brownfield): the change must not break existing clients.",
    "Kept: every existing route (method+path) and every exported schema in src/schemas.",
    "Breaking: removing a field/route/schema, changing a field's type or format, removing an enum value,",
    "adding a REQUIRED field to a request schema (*Body/*Query/*Params), making a response field optional.",
    "Safe: new routes, new optional request fields, new response fields, new enum values.",
  ].join("\n"),
  async run(api) {
    if (!api.beforeRoot || !existsSync(api.beforeRoot)) {
      return { status: "n/a", passed: 0, total: 0, unit: "contract items", findings: [], detail: "no pre-change baseline (greenfield or standalone check)" };
    }
    const findings: Finding[] = [];
    const before = createApiContext(api.beforeRoot, api.harnessRoot);
    const afterRoutes = new Set(api.routes().map((r) => `${r.method.toUpperCase()} ${r.path}`));
    let total = 0;
    let passed = 0;
    for (const r of before.routes()) {
      const key = `${r.method.toUpperCase()} ${r.path}`;
      total++;
      if (afterRoutes.has(key)) {
        passed++;
        findings.push({ file: r.file, line: r.line, ok: true, message: `route kept: ${key}` });
      } else findings.push({ file: r.file, line: r.line, ok: false, message: `route removed: ${key}` });
    }

    let schemasBefore: Record<string, Schema>;
    let schemasAfter: Record<string, Schema>;
    try {
      schemasBefore = extract(api.harnessRoot, api.beforeRoot);
      schemasAfter = extract(api.harnessRoot, api.root);
    } catch (err) {
      return { status: "unproven", passed, total, unit: "contract items", findings, detail: (err as Error).message };
    }
    for (const [name, b] of Object.entries(schemasBefore)) {
      total++;
      const a = schemasAfter[name];
      const breaks: string[] = [];
      if (!a) breaks.push(`${name}: exported schema removed`);
      else diff(name, "", b, a, /(Body|Query|Params)$/.test(name), breaks);
      if (breaks.length === 0) {
        passed++;
        findings.push({ file: "src/schemas", line: 0, ok: true, message: `schema compatible: ${name}` });
      }
      for (const m of breaks) findings.push({ file: "src/schemas", line: 0, ok: false, message: `breaking: ${m}` });
    }

    const breaking = findings.filter((f) => !f.ok);
    if (breaking.length && api.task?.allowBreaking) {
      for (const f of breaking) f.ok = true;
      return { status: "pass", passed: total, total, unit: "contract items", findings, detail: `${breaking.length} breaking change(s) allowed by task` };
    }
    return { status: breaking.length ? "fail" : "pass", passed, total, unit: "contract items", findings };
  },
};

export default check;
