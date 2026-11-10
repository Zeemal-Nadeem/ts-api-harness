// Pre-hook: tests cannot be neutered. Blocks .skip/.only/.todo/xit and
// writes that would leave a test file without a single expect().
import { existsSync, readFileSync } from "node:fs";
import { isPyTest } from "../../core/mapping.ts";
import { resolveInApi } from "../../core/paths.ts";
import type { HookPlugin } from "../../core/types.ts";

const BANNED = /\b(it|test|describe)\.(skip|only|todo)\b|\bx(it|describe)\(/;
const PY_BANNED = /@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.(skip|xfail)\(|@unittest\.skip/;

const hook: HookPlugin = {
  kind: "hook",
  id: "test-integrity",
  phase: "pre",
  tools: ["write_file", "edit_file", "delete_file"],
  run(ev, ctx) {
    const args = ev.args as { path: string; content?: string; find?: string; replace?: string };
    const { abs, rel } = resolveInApi(ctx.apiRoot, args.path);
    const py = ctx.task.stack === "python";
    if (py ? !isPyTest(rel) : !/^tests\/.*\.test\.ts$/.test(rel)) return { action: "pass" };
    if (ev.tool === "delete_file") return { action: "block", reason: `${rel}: deleting a test is not allowed — fix the code or the test` };
    let next = args.content;
    if (next === undefined && args.find !== undefined && existsSync(abs)) {
      next = readFileSync(abs, "utf8").replace(args.find, () => args.replace ?? "");
    }
    if (next === undefined) return { action: "pass" };
    const m = next.match(py ? PY_BANNED : BANNED);
    if (m) return { action: "block", reason: `${rel}: "${m[0]}" is not allowed — every test must run` };
    if (!(py ? /\bassert\b|pytest\.raises\(/ : /\bexpect\(/).test(next)) return { action: "block", reason: `${rel}: a test file must contain assertions (${py ? "assert" : "expect"})` };
    return { action: "pass" };
  },
};

export default hook;
