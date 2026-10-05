import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a subprocess without a shell. Deterministic tools only — never model text as a command. */
export function exec(cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } ): ExecResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 180_000,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut: r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT",
  };
}

/** Run a TypeScript file with the harness's own tsx loader. */
export function execTs(harnessRoot: string, script: string, args: string[], timeoutMs = 60_000): ExecResult {
  return exec(process.execPath, ["--import", "tsx", script, ...args], { cwd: harnessRoot, timeoutMs });
}

export function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/**
 * Provider-independent token estimate (≈4 chars/token). Used for both columns
 * of the baseline-vs-actual comparison so the ratio is apples to apples;
 * provider-reported usage is recorded alongside it.
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
