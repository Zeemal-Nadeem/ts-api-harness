// Core contracts. Everything outside core/ (drivers, tools, hooks, checks)
// implements one of these shapes and is discovered by core/registry.ts.
// Nothing in this file may name a model provider.
import type { z } from "zod";

export type JsonSchema = Record<string, unknown>;

/** Provider-neutral tool description. Drivers translate it to their wire format. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type Message =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      calls: ToolCall[];
      /** Driver-private payload (e.g. reasoning blocks). The engine never reads it. */
      opaque?: unknown;
    }
  | { role: "tool"; results: ToolResult[] };

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
}

export interface TurnRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
}

export type StopKind = "tool" | "end" | "length" | "refused";

export interface TurnResult {
  text: string;
  calls: ToolCall[];
  stop: StopKind;
  usage: { inputTokens: number; outputTokens: number };
  opaque?: unknown;
  /** One-line driver diagnostics worth keeping in the run log. */
  notes?: string[];
}

export interface Driver {
  id: string;
  model: string;
  turn(req: TurnRequest): Promise<TurnResult>;
}

export interface DriverPlugin {
  kind: "driver";
  id: string;
  create(): Driver;
}

// ---------------------------------------------------------------- tasks

export interface Task {
  name: string;
  mode: "greenfield" | "brownfield";
  /** API directory, relative to the harness root. */
  target: string;
  brief: string;
  resource?: {
    name: string;
    fields: Record<string, string>;
  };
  behaviours: string[];
  /** Brownfield: source glob -> test file mapping (also used for greenfield if given). */
  testMap?: Record<string, string>;
  allowBreaking: boolean;
  maxTurns: number;
}

// ---------------------------------------------------------------- tools

export interface ToolOutput {
  /** What the model sees in the actual run: compact, pass/fail lines, paths to logs. */
  content: string;
  /** What a no-JIT/no-compaction baseline would have returned (defaults to content). */
  raw?: string;
  /** One-liner that replaces content once this result is compacted out of the window. */
  summary?: string;
  /**
   * Identity of the context this result carries, e.g. "file:src/app.ts:1-80".
   * A later result whose key equals it, or is a prefix of it ("file:src/app.ts"
   * from a write), supersedes it.
   */
  contextKey?: string;
  /** Fetched knowledge: kept verbatim until superseded (or very old) instead of compacting after a couple of rounds. */
  sticky?: boolean;
}

export interface RunState {
  runId: string;
  /** test file -> sha of contents when the harness runner last saw it fail. */
  observedRed: Record<string, string>;
  /** test file -> sha of contents when the harness runner last saw it pass. */
  observedGreen: Record<string, string>;
  writes: string[];
  finished: boolean;
  lastStandards?: StandardsReport;
  lastTests?: { ok: boolean; failed: string[]; passed: string[] };
}

export interface ToolContext {
  harnessRoot: string;
  /** Absolute path of the API under governance. Tools must stay inside it. */
  apiRoot: string;
  task: Task;
  state: RunState;
  runDir: string;
  /** Pristine pre-change copy of the API (brownfield). */
  beforeRoot?: string;
  jit: boolean;
  /** Write a raw log to the run directory; returns its repo-relative path. */
  saveLog(name: string, content: string): string;
  registry: Registry;
}

export interface ToolPlugin<A = unknown> {
  kind: "tool";
  name: string;
  description: string;
  input: z.ZodType<A>;
  run(args: A, ctx: ToolContext): Promise<ToolOutput>;
}

// ---------------------------------------------------------------- hooks

export interface HookEvent {
  tool: string;
  args: unknown;
  /** Present for post hooks. */
  output?: ToolOutput;
}

export type HookDecision =
  | { action: "pass" }
  | { action: "record"; note: string }
  | { action: "block"; reason: string };

export interface HookPlugin {
  kind: "hook";
  id: string;
  phase: "pre" | "post";
  /** Tool names this hook watches; omitted = every tool. */
  tools?: string[];
  run(ev: HookEvent, ctx: ToolContext): HookDecision | Promise<HookDecision>;
}

// ---------------------------------------------------------------- checks

export interface Finding {
  file: string;
  line: number;
  ok: boolean;
  message: string;
}

export type CheckStatus = "pass" | "fail" | "unproven" | "n/a";

export interface CheckResult {
  status: CheckStatus;
  passed: number;
  total: number;
  /** Plural noun for the counted unit, e.g. "handlers", "error paths". */
  unit: string;
  findings: Finding[];
  detail?: string;
}

export interface CheckPlugin {
  kind: "check";
  id: string;
  /** standard | orm | lint | contract | anything a plugin author wants to group by. */
  category: string;
  /** Required checks gate finish/ship; optional ones only report. */
  required: boolean;
  /** Standard text served just-in-time by the get_standard tool. */
  doc?: string;
  run(api: ApiContext): Promise<CheckResult>;
}

export interface ApiContext {
  root: string;
  harnessRoot: string;
  /** Repo-relative (to root) .ts files under src/. */
  sourceFiles: string[];
  read(rel: string): string;
  sourceFile(rel: string): import("typescript").SourceFile;
  routes(): RouteInfo[];
  runDir?: string;
  /** Pristine copy of the API taken when the run started (brownfield contract baseline). */
  beforeRoot?: string;
  task?: Task;
}

export interface RouteInfo {
  file: string;
  line: number;
  method: "get" | "post" | "put" | "patch" | "delete";
  /** Full path including router mount prefix, e.g. /v1/users/:id */
  path: string;
  /** Handler function node (last argument of the router call). */
  handler: import("typescript").Node;
  /** Every argument between the path and the handler (middleware identifiers). */
  middleware: string[];
}

export interface StandardsReport {
  verdict: number;
  ok: boolean;
  results: { id: string; category: string; required: boolean; result: CheckResult }[];
}

export interface Registry {
  drivers: Map<string, DriverPlugin>;
  tools: Map<string, ToolPlugin>;
  hooks: HookPlugin[];
  checks: CheckPlugin[];
}
