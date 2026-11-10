// Backlog items (Assignment 02). An item's slug is its task name. Every gate
// reads two harness-owned files outside the model's reach:
//   docs/contracts/<slug>.md  the problem statement (Problem, Owner, Metric, Scenario, Not included, Read)
//   ledger/<slug>.jsonl       what happened: proposal, human reply, metric reads, ship, close
// The human-yes gate reads the ledger, never the contract's Signed line.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { exec, sha } from "./util.ts";

export const contractPath = (root: string, slug: string): string => join(root, "docs", "contracts", `${slug}.md`);
export const ledgerPath = (root: string, slug: string): string => join(root, "ledger", `${slug}.jsonl`);

export interface Contract {
  problem?: string;
  owner?: string;
  metric?: { name: string; window: string; before?: string; after?: string };
  scenarios: string[];
  notIncluded?: string;
  read?: string;
  signed?: string;
}

const FIELD = /^(Problem|Owner|Metric|Scenario|Not included|Read|Signed):\s*(.*)$/i;
// Template placeholders (<...>) and blanks (____) count as missing.
const filled = (v: string | undefined): v is string => v !== undefined && v.trim() !== "" && !/<[^>]*>|^_+$/.test(v.trim());
const blank = (v: string | undefined): string | undefined => (v === undefined || /^_*$/.test(v.trim()) ? undefined : v.trim());

export function parseContract(text: string): Contract {
  const c: Contract = { scenarios: [] };
  for (const line of text.split("\n")) {
    const m = line.trim().match(FIELD);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "problem") c.problem = value;
    else if (key === "owner") c.owner = value;
    else if (key === "scenario") c.scenarios.push(value);
    else if (key === "not included") c.notIncluded = value;
    else if (key === "read") c.read = value;
    else if (key === "signed") c.signed = value;
    else if (key === "metric") {
      const [head = "", rest = ""] = value.split(/\s+before:/i);
      const [before, after] = rest.split(/\s+after:/i);
      const comma = head.indexOf(",");
      c.metric = {
        name: (comma < 0 ? head : head.slice(0, comma)).trim(),
        window: comma < 0 ? "" : head.slice(comma + 1).trim(),
        before: blank(before),
        after: blank(after),
      };
    }
  }
  return c;
}

/** Problem-statement gate: every missing field, named. Empty = the contract is complete. */
export function missingFields(c: Contract): string[] {
  const miss: string[] = [];
  if (!filled(c.problem)) miss.push("Problem");
  if (!filled(c.owner)) miss.push("Owner");
  if (!c.metric || !filled(c.metric.name)) miss.push("Metric (name)");
  else if (!filled(c.metric.window)) miss.push("Metric (window, e.g. `p95 latency, 7 days`)");
  const scenarios = c.scenarios.filter(filled);
  if (scenarios.length === 0) miss.push("Scenario");
  else if (!scenarios.every((s) => /\bWHEN\b.+\bTHEN\b/.test(s))) miss.push("Scenario (each must read WHEN <condition> THEN <observable result>)");
  if (!filled(c.notIncluded)) miss.push("Not included");
  return miss;
}

/** What the stakeholder agreed to. Signed and the before/after values are written later by the harness, so they are excluded. */
export function contractSha(c: Contract): string {
  return sha(JSON.stringify([c.problem, c.owner, c.metric?.name, c.metric?.window, c.scenarios, c.notIncluded, c.read]));
}

export function loadContract(root: string, slug: string): { contract?: Contract; text?: string; error?: string } {
  const p = contractPath(root, slug);
  if (!existsSync(p)) return { error: `no problem statement: docs/contracts/${slug}.md does not exist` };
  const text = readFileSync(p, "utf8");
  return { contract: parseContract(text), text };
}

// ---------------------------------------------------------------- ledger

export type LedgerEvent =
  | { at: string; event: "proposal"; contractSha: string; text: string }
  | { at: string; event: "human"; by: string; text: string; contractSha: string; tty: true }
  | { at: string; event: "metric"; phase: "before" | "after"; value: string; command: string; output: string }
  | { at: string; event: "shipped"; runId: string; pr?: string; sha: string }
  | { at: string; event: "closed"; before: string; after: string; mergedAt: string; mergedBy: string };

type NewEvent = LedgerEvent extends infer E ? (E extends LedgerEvent ? Omit<E, "at"> : never) : never;

export function readLedger(root: string, slug: string): LedgerEvent[] {
  const p = ledgerPath(root, slug);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerEvent);
}

export function appendLedger(root: string, slug: string, ev: NewEvent): LedgerEvent {
  const full = { at: new Date().toISOString(), ...ev } as LedgerEvent;
  mkdirSync(join(root, "ledger"), { recursive: true });
  appendFileSync(ledgerPath(root, slug), JSON.stringify(full) + "\n");
  return full;
}

const NO = /\b(no|not|don'?t|do not|wait|hold|reject|change|but)\b/i;
const YES = /\b(yes|yep|yeah|approved?|agreed?|go ahead|lgtm|sounds good|ship it|ok(ay)?)\b/i;

/** A yes is affirmative and carries no hedge ("yes but…", "not yet"). */
export const isYes = (text: string): boolean => YES.test(text) && !NO.test(text);

/**
 * Human-yes gate. Passes only if, after the latest proposal of the *current*
 * contract, a human typed turn (recorded from a terminal by `harness propose`)
 * says yes. Assistant text, tool output and hook output are never written as
 * "human" events, so they cannot satisfy it.
 */
export function approval(root: string, slug: string): { ok: boolean; reason: string; by?: string; at?: string } {
  const { contract, error } = loadContract(root, slug);
  if (!contract) return { ok: false, reason: error ?? "no contract" };
  const miss = missingFields(contract);
  if (miss.length) return { ok: false, reason: `contract incomplete: missing ${miss.join(", ")}` };
  const current = contractSha(contract);
  const events = readLedger(root, slug);
  const lastProposal = events.map((e, i) => [e, i] as const).filter(([e]) => e.event === "proposal" && e.contractSha === current).pop();
  if (!lastProposal) {
    const stale = events.some((e) => e.event === "proposal");
    return { ok: false, reason: stale ? "the contract changed since it was proposed; run `harness propose --item " + slug + "` again" : "contract never proposed; run `harness propose --item " + slug + "` with the stakeholder" };
  }
  const replies = events.slice(lastProposal[1] + 1).filter((e): e is Extract<LedgerEvent, { event: "human" }> => e.event === "human" && e.contractSha === current);
  const last = replies.pop();
  if (!last) return { ok: false, reason: "proposed, but no typed reply from the stakeholder yet" };
  if (!isYes(last.text)) return { ok: false, reason: `stakeholder's latest reply is not a yes: "${last.text.slice(0, 80)}"` };
  return { ok: true, reason: `yes from ${last.by} at ${last.at}: "${last.text.slice(0, 80)}"`, by: last.by, at: last.at };
}

// ---------------------------------------------------------------- commands

function setContractLine(root: string, slug: string, key: "Signed" | "Metric", value: string): void {
  const p = contractPath(root, slug);
  const lines = readFileSync(p, "utf8").split("\n");
  const i = lines.findIndex((l) => new RegExp(`^${key}:`, "i").test(l.trim()));
  if (i >= 0) lines[i] = `${key}: ${value}`;
  else lines.push(`${key}: ${value}`);
  writeFileSync(p, lines.join("\n"));
}

function renderMetric(c: Contract, before?: string, after?: string): string {
  return `${c.metric?.name ?? ""}, ${c.metric?.window ?? ""}   before: ${before ?? "____"}   after: ${after ?? "____"}`;
}

/** harness propose: records the proposal, then a reply typed at a terminal. Piped input is refused. */
export async function propose(root: string, slug: string, io: { input: NodeJS.ReadableStream & { isTTY?: boolean }; output: NodeJS.WritableStream }): Promise<boolean> {
  const { contract, text, error } = loadContract(root, slug);
  if (!contract || text === undefined) throw new Error(error);
  const miss = missingFields(contract);
  if (miss.length) {
    io.output.write(`refused: contract incomplete, missing ${miss.join(", ")}\n`);
    return false;
  }
  const current = contractSha(contract);
  appendLedger(root, slug, { event: "proposal", contractSha: current, text });
  io.output.write(`${text.trim()}\n\nproposal recorded (contract ${current}).\n`);
  if (!io.input.isTTY) {
    io.output.write("no terminal: the stakeholder's reply must be typed, not piped. Run this again at a terminal with them.\n");
    return false;
  }
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const by = (await rl.question("Stakeholder name: ")).trim();
    const reply = (await rl.question(`${by || "Stakeholder"}, in your own words — do you agree to this contract? `)).trim();
    if (!by || !reply) {
      io.output.write("nothing recorded: name and reply are both required\n");
      return false;
    }
    const owner = contract.owner ?? "";
    if (!owner.toLowerCase().includes(by.toLowerCase()) && !by.toLowerCase().includes(owner.toLowerCase())) {
      io.output.write(`note: "${by}" is not the contract Owner ("${owner}"); recorded as typed\n`);
    }
    appendLedger(root, slug, { event: "human", by, text: reply, contractSha: current, tty: true });
    if (!isYes(reply)) {
      io.output.write("recorded: not a yes. Revise the contract and propose again.\n");
      return false;
    }
    setContractLine(root, slug, "Signed", `${by}, ${new Date().toISOString().slice(0, 10)}   (recorded by the harness from ledger/${slug}.jsonl)`);
    io.output.write(`recorded: yes from ${by}\n`);
    return true;
  } finally {
    rl.close();
  }
}

/** harness metric: the harness runs the contract's Read command itself and records the number. */
export function readMetric(root: string, slug: string, phase: "before" | "after"): { ok: boolean; message: string } {
  const { contract, error } = loadContract(root, slug);
  if (!contract) return { ok: false, message: error ?? "no contract" };
  if (!filled(contract.read)) return { ok: false, message: "contract has no `Read:` command; the harness reads the metric itself, never from a typed number" };
  const r = exec("sh", ["-c", contract.read], { cwd: root, timeoutMs: 120_000 });
  const output = (r.stdout + r.stderr).trim();
  const value = r.code === 0 ? r.stdout.match(/-?\d+(\.\d+)?/)?.[0] : undefined;
  if (value === undefined) return { ok: false, message: `UNPROVEN: \`${contract.read}\` exited ${r.code} without a number: ${output.split("\n")[0]?.slice(0, 160) ?? ""}` };
  appendLedger(root, slug, { event: "metric", phase, value, command: contract.read, output: output.slice(0, 2000) });
  const events = readLedger(root, slug);
  const lastOf = (p: string): string | undefined => events.filter((e) => e.event === "metric" && e.phase === p).map((e) => (e as { value: string }).value).pop();
  setContractLine(root, slug, "Metric", renderMetric(contract, lastOf("before"), lastOf("after")));
  return { ok: true, message: `${contract.metric?.name ?? "metric"} ${phase}: ${value}` };
}

export interface PrState {
  merged: boolean;
  mergedAt?: string;
  mergedBy?: string;
  error?: string;
}

export function prState(root: string, url: string): PrState {
  const r = exec("gh", ["pr", "view", url, "--json", "state,mergedAt,mergedBy"], { cwd: root, timeoutMs: 60_000 });
  if (r.code !== 0) return { merged: false, error: `UNPROVEN: gh pr view failed: ${r.stderr.trim().split("\n")[0] ?? ""}` };
  const j = JSON.parse(r.stdout) as { state: string; mergedAt?: string | null; mergedBy?: { login?: string } | null };
  return { merged: j.state === "MERGED", mergedAt: j.mergedAt ?? undefined, mergedBy: j.mergedBy?.login };
}

/**
 * Outcome check. An item closes only when: the contract had a recorded yes,
 * the harness shipped it, a human merged the PR, and the metric was read by
 * the harness before the merge and again after it, with both values standing
 * in the contract next to each other. Nobody's word counts, including yours.
 */
export function closeItem(root: string, slug: string, pr: (url: string) => PrState = (u) => prState(root, u)): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const line = (name: string, pass: boolean, detail: string): void => {
    ok &&= pass;
    lines.push(`${name.padEnd(16)}${(pass ? "PASS" : "FAIL").padEnd(8)}${detail}`);
  };
  const yes = approval(root, slug);
  line("human yes", yes.ok, yes.reason);
  const events = readLedger(root, slug);
  const shipped = events.filter((e): e is Extract<LedgerEvent, { event: "shipped" }> => e.event === "shipped" && e.pr !== undefined).pop();
  line("shipped", shipped !== undefined, shipped ? `${shipped.runId} ${shipped.pr ?? ""}` : "no harness-opened PR recorded for this item");
  let mergedAt: string | undefined;
  let mergedBy = "";
  if (shipped?.pr) {
    const s = pr(shipped.pr);
    mergedAt = s.mergedAt;
    mergedBy = s.mergedBy ?? "";
    const human = mergedBy !== "" && !/\[bot\]$|^github-actions/.test(mergedBy);
    line("merged by human", s.merged && human, s.error ?? (s.merged ? `${mergedBy} at ${s.mergedAt ?? "?"}` : "PR not merged yet"));
  } else line("merged by human", false, "nothing to check");
  const metrics = events.filter((e): e is Extract<LedgerEvent, { event: "metric" }> => e.event === "metric");
  const before = metrics.filter((m) => m.phase === "before" && (!mergedAt || m.at < mergedAt)).pop();
  const after = metrics.filter((m) => m.phase === "after" && mergedAt !== undefined && m.at > mergedAt).pop();
  line("metric before", before !== undefined, before ? `${before.value} read ${before.at}` : "never read before the merge (`harness metric --phase before`)");
  line("metric after", after !== undefined, after ? `${after.value} read ${after.at}` : "not read after the merge (`harness metric --phase after`)");
  const { contract } = loadContract(root, slug);
  const inContract = contract?.metric !== undefined && before !== undefined && after !== undefined && contract.metric.before === before.value && contract.metric.after === after.value;
  line("contract values", inContract, inContract ? `before ${before?.value} -> after ${after?.value}` : "contract before/after do not match the harness's readings");
  if (ok && before && after && mergedAt) appendLedger(root, slug, { event: "closed", before: before.value, after: after.value, mergedAt, mergedBy });
  lines.push(ok ? `closed ${slug}: ${contract?.metric?.name ?? "metric"} ${before?.value} -> ${after?.value}` : `refused: ${slug} stays open`);
  return { ok, lines };
}
