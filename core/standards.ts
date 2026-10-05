// Runs every registered check against an API directory and renders the
// report: one line per rule per file (with offending locations), then one
// summary line per rule and a verdict. Verdict counts only required checks;
// UNPROVEN is never counted as a pass.
import { createApiContext, type ApiContextOptions } from "./api-model.ts";
import type { CheckResult, Registry, StandardsReport } from "./types.ts";

export async function runStandards(
  registry: Registry,
  apiRoot: string,
  harnessRoot: string,
  opts: ApiContextOptions = {},
): Promise<StandardsReport> {
  const api = createApiContext(apiRoot, harnessRoot, opts);
  const results: StandardsReport["results"] = [];
  for (const check of registry.checks) {
    let result: CheckResult;
    try {
      result = await check.run(api);
    } catch (err) {
      result = {
        status: "unproven",
        passed: 0,
        total: 0,
        unit: "checks",
        findings: [],
        detail: `check crashed: ${(err as Error).message}`,
      };
    }
    results.push({ id: check.id, category: check.category, required: check.required, result });
  }
  const gating = results.filter((r) => r.required && r.result.status !== "n/a");
  const passed = gating.filter((r) => r.result.status === "pass").length;
  const verdict = gating.length === 0 ? 0 : Math.round((passed / gating.length) * 100);
  return { verdict, ok: gating.length > 0 && passed === gating.length, results };
}

const pad = (s: string, n: number): string => (s.length >= n ? s + " " : s + " ".repeat(n - s.length));

/** Full human report. */
export function renderStandards(rep: StandardsReport): string {
  const w = Math.max(16, ...rep.results.map((r) => r.id.length + 2));
  const lines: string[] = [];
  for (const { id, result } of rep.results) {
    const byFile = new Map<string, { ok: number; bad: string[] }>();
    for (const f of result.findings) {
      const e = byFile.get(f.file) ?? { ok: 0, bad: [] };
      if (f.ok) e.ok++;
      else e.bad.push(`${f.file}:${f.line} ${f.message}`);
      byFile.set(f.file, e);
    }
    for (const [file, e] of byFile) {
      if (e.bad.length === 0) lines.push(`${pad(id, w)}${pad("pass", 10)}${file} (${e.ok} ok)`);
      for (const b of e.bad) lines.push(`${pad(id, w)}${pad("fail", 10)}${b}`);
    }
  }
  if (lines.length) lines.push("");
  lines.push(...renderSummary(rep, w));
  return lines.join("\n");
}

/** Summary only: what the model sees after a write (compact tool return). */
export function renderSummary(rep: StandardsReport, w = 18): string[] {
  const lines: string[] = [];
  for (const { id, required, result } of rep.results) {
    const label = result.status === "unproven" ? "UNPROVEN" : result.status;
    const count =
      result.status === "n/a"
        ? "no targets"
        : result.unit === "errors"
          ? `${result.total - result.passed} errors`
          : `${result.passed}/${result.total} ${result.unit}`;
    const extra = result.detail ? `  (${result.detail})` : "";
    lines.push(`${pad(id, w)}${pad(label, 10)}${count}${required ? "" : "  [advisory]"}${extra}`);
  }
  lines.push(`${pad("verdict", w)}${pad(`${rep.verdict}%`, 10)}${rep.ok ? "→ all required checks green" : "→ NOT green"}`);
  return lines;
}

/** Only the failing locations, capped — for model feedback. */
export function renderFailures(rep: StandardsReport, cap = 25): string[] {
  const out: string[] = [];
  for (const { id, result } of rep.results) {
    if (result.status === "unproven") out.push(`${id}: UNPROVEN ${result.detail ?? ""}`.trim());
    for (const f of result.findings) if (!f.ok) out.push(`${id}: ${f.file}:${f.line} ${f.message}`);
  }
  return out.length > cap ? [...out.slice(0, cap), `… ${out.length - cap} more`] : out;
}
