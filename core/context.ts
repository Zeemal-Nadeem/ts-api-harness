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

/** Volatile results (tests, checks, search) stay verbatim for this many rounds. */
export const KEEP_ROUNDS = 2;
/** Sticky results (file reads, standards) stay verbatim until superseded or this old. */
export const STICKY_MAX_ROUNDS = 15;

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; calls: ToolCall[]; opaque?: unknown }
  | { kind: "tool"; results: ToolEntryResult[] };

export interface ToolEntryResult {
  callId: string;
  name: string;
  /** Canonical JSON of the call arguments (for repeat detection). */
  args: string;
  content: string;
  raw: string;
  summary: string;
  key?: string;
  sticky?: boolean;
}

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

const supersedes = (later: string, earlier: string): boolean => later === earlier || earlier.startsWith(`${later}:`);

/** For each tool result (by round, index): is it shown verbatim in an actual-mode request? */
function verbatimMap(history: Entry[]): Map<ToolEntryResult, boolean> {
  const rounds = history.filter((e): e is Extract<Entry, { kind: "tool" }> => e.kind === "tool");
  const flat = rounds.flatMap((e, r) => e.results.map((res, i) => ({ res, r, i })));
  const out = new Map<ToolEntryResult, boolean>();
  for (const { res, r, i } of flat) {
    const age = rounds.length - 1 - r;
    const superseded =
      res.key !== undefined &&
      flat.some((o) => o.res.key !== undefined && (o.r > r || (o.r === r && o.i > i)) && supersedes(o.res.key, res.key ?? ""));
    out.set(res, res.sticky ? !superseded && age < STICKY_MAX_ROUNDS : age < KEEP_ROUNDS);
  }
  return out;
}

/** If an identical sticky call's result is still verbatim in context, return its round number. */
export function stillInContext(history: Entry[], name: string, args: string): number | undefined {
  const verbatim = verbatimMap(history);
  let round = 0;
  let found: number | undefined;
  for (const e of history) {
    if (e.kind !== "tool") continue;
    round++;
    for (const r of e.results) if (r.sticky && r.name === name && r.args === args && verbatim.get(r)) found = round;
  }
  return found;
}

/**
 * Render history for a request. Volatile tool results older than KEEP_ROUNDS
 * and superseded/stale sticky results are reduced to one-line summaries.
 */
export function render(history: Entry[], mode: "actual" | "baseline"): Message[] {
  const verbatim = verbatimMap(history);
  // Large write arguments are already on disk; only the latest assistant turn keeps them verbatim.
  const lastAssistant = history.map((e) => e.kind).lastIndexOf("assistant");
  const out: Message[] = [];
  history.forEach((e, i) => {
    if (e.kind === "user") out.push({ role: "user", text: e.text });
    else if (e.kind === "assistant") {
      const elide = mode === "actual" && i !== lastAssistant;
      out.push({ role: "assistant", text: e.text, calls: elide ? e.calls.map(elideArgs) : e.calls, opaque: e.opaque });
    } else {
      out.push({
        role: "tool",
        results: e.results.map((r) => ({
          callId: r.callId,
          name: r.name,
          content:
            mode === "baseline"
              ? r.raw
              : verbatim.get(r)
                ? r.content
                : `[compacted by harness] ${r.summary}${r.sticky ? " — content no longer in context; fetch again if you need it" : ""}`,
        })),
      });
    }
  });
  return out;
}
