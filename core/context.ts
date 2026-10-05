// What the model sees. Actual runs: a small fixed system prompt, a brief with
// a file index (paths only), and tools to fetch files/standards on demand.
// Older tool rounds are compacted to one-line summaries in windows, so the
// prefix stays stable between compactions. Baseline (--baseline, and the
// shadow measurement): the same conversation with the API source and every
// standard front-loaded, raw tool output, and no compaction.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { walk } from "./api-model.ts";
import type { Message, Registry, Task, ToolCall } from "./types.ts";

export const KEEP_ROUNDS = 2;
export const COMPACT_STEP = 4;

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; calls: ToolCall[]; opaque?: unknown }
  | { kind: "tool"; results: { callId: string; name: string; content: string; raw: string; summary: string }[] };

export function buildSystem(registry: Registry): string {
  const checks = registry.checks.map((c) => c.id).join(", ");
  return [
    "You are the coding model inside a governed harness for TypeScript REST APIs (Express 5 + Zod 4 + Vitest + supertest).",
    "You act only through the tools. Deterministic gates, not you, decide when the work is done.",
    "Enforced by hooks (a breaking call is blocked with the reason):",
    "- Test first: write/extend the mapped test, run it with run_tests and see it FAIL before editing any src/ file it covers.",
    "- Stay inside the API directory. tsconfig.json and package.json are harness-owned.",
    "- No .skip/.only/.todo in tests.",
    "- finish is refused until run_checks is 100% and run_tests passes.",
    `Standards checked: ${checks}. Fetch a rule with get_standard before relying on it.`,
    "Fetch files only when you need them (list_files, read_file, search). Prefer edit_file to rewriting files.",
    "Imports use explicit .ts extensions. Infer types with z.infer; never write interfaces for API data.",
  ].join("\n");
}

export function buildBrief(task: Task, apiRoot: string): string {
  const files = walk(apiRoot, () => true).filter((f) => !f.startsWith("node_modules"));
  const lines = [`# Task: ${task.name} (${task.mode})`, "", task.brief.trim(), ""];
  if (task.resource) {
    lines.push(`Resource: /v1/${task.resource.name}`, "Fields:");
    for (const [k, v] of Object.entries(task.resource.fields)) lines.push(`- ${k}: ${v}`);
    lines.push("");
  }
  if (task.behaviours.length) {
    lines.push("Behaviours:");
    for (const b of task.behaviours) lines.push(`- ${b}`);
    lines.push("");
  }
  if (task.testMap) {
    lines.push("Source -> test mapping:");
    for (const [g, t] of Object.entries(task.testMap)) lines.push(`- ${g} -> ${t}`);
    lines.push("");
  }
  lines.push(`Files in the API directory (fetch what you need):`, ...files.map((f) => `- ${f}`));
  if (task.mode === "brownfield") lines.push("", "Match the conventions already in the code; read an existing route before writing a new one.");
  else lines.push("", "src/lib (problem, pagination, idempotency) and src/app.ts are scaffolded; app.ts already mounts the router you must create.");
  return lines.join("\n");
}

/** Baseline: everything a fetcher-less harness would have to front-load. */
export function buildFrontload(registry: Registry, harnessRoot: string, apiRoot: string): string {
  const parts: string[] = ["", "# Standards (front-loaded)"];
  for (const c of registry.checks) parts.push(`## ${c.id}`, standardText(harnessRoot, registry, c.id));
  parts.push("", "# API source (front-loaded)");
  for (const f of walk(apiRoot, (r) => !r.startsWith("node_modules"))) {
    parts.push(`## ${f}`, "```", readFileSync(join(apiRoot, f), "utf8"), "```");
  }
  return parts.join("\n");
}

export function standardText(harnessRoot: string, registry: Registry, id: string): string {
  const md = join(harnessRoot, "standards", `${id}.md`);
  if (existsSync(md)) return readFileSync(md, "utf8");
  const doc = registry.checks.find((c) => c.id === id)?.doc;
  return doc ?? `No standard named "${id}". Known: ${registry.checks.map((c) => c.id).join(", ")}`;
}

function elideArgs(call: ToolCall): ToolCall {
  if (!call.args || typeof call.args !== "object") return call;
  const args: Record<string, unknown> = { ...(call.args as Record<string, unknown>) };
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 240) args[k] = `[${v.split("\n").length} lines elided by harness; read_file for current content]`;
  }
  return { ...call, args };
}

/**
 * Render history for a request. Rounds older than the compaction boundary are
 * reduced to summaries; the boundary only moves every COMPACT_STEP rounds.
 */
export function render(history: Entry[], mode: "actual" | "baseline"): Message[] {
  const rounds = history.filter((e) => e.kind === "tool").length;
  const boundary = mode === "baseline" ? 0 : Math.max(0, Math.floor((rounds - KEEP_ROUNDS) / COMPACT_STEP) * COMPACT_STEP);
  let seen = 0;
  const out: Message[] = [];
  for (const e of history) {
    if (e.kind === "user") out.push({ role: "user", text: e.text });
    else if (e.kind === "assistant") {
      const old = seen < boundary;
      out.push({ role: "assistant", text: e.text, calls: old ? e.calls.map(elideArgs) : e.calls, opaque: e.opaque });
    } else {
      const old = seen < boundary;
      seen++;
      out.push({
        role: "tool",
        results: e.results.map((r) => ({
          callId: r.callId,
          name: r.name,
          content: mode === "baseline" ? r.raw : old ? r.summary : r.content,
        })),
      });
    }
  }
  return out;
}
