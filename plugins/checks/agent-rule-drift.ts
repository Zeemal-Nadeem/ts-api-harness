// My repeated mistake as a check: a fix lands in one Retell agent and not the
// others (e491652 fixed LMS only; 9680f09 had to repeat it for 14 more agents).
// Every required rule must be present in every agent it applies to, and
// agents/ must match lookup.json. Same logic as the item's metric script.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { exec } from "../../core/util.ts";
import type { CheckPlugin } from "../../core/types.ts";

const check: CheckPlugin = {
  kind: "check",
  id: "agent-rule-drift",
  category: "workflow",
  required: true,
  stacks: ["python"],
  doc: "# agent-rule-drift\nEvery agent folder carries every required rule (extract_user_details before ending, email in written form, HR never quotes prices) and agents/ matches lookup.json. Rules: metrics/agent-rule-drift.py.",
  async run(api) {
    if (!existsSync(join(api.root, "agents")) || !existsSync(join(api.root, "lookup.json"))) return { status: "n/a", passed: 0, total: 0, unit: "gaps", findings: [] };
    const r = exec("python3", [join(api.harnessRoot, "metrics", "agent-rule-drift.py"), api.root], { cwd: api.root, timeoutMs: 60_000 });
    const count = Number(r.stdout.trim());
    if (r.code !== 0 || Number.isNaN(count)) return { status: "unproven", passed: 0, total: 0, unit: "gaps", findings: [], detail: r.stderr.split("\n")[0] };
    const findings = r.stderr.split("\n").filter(Boolean).map((g) => ({ file: `agents/${g.split(":")[0] ?? ""}`, line: 1, ok: false, message: g }));
    return { status: count === 0 ? "pass" : "fail", passed: count === 0 ? 1 : 0, total: 1, unit: "repos drift-free", findings, detail: count ? `${count} gaps` : undefined };
  },
};

export default check;
