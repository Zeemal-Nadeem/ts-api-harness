// Pre-hook: tests cannot be neutered. Blocks .skip/.only/.todo/xit and
// writes that would leave a test file without a single expect().
import { existsSync, readFileSync } from "node:fs";
import { resolveInApi } from "../../core/paths.ts";
import type { HookPlugin } from "../../core/types.ts";

const BANNED = /\b(it|test|describe)\.(skip|only|todo)\b|\bx(it|describe)\(/;

const hook: HookPlugin = {
  kind: "hook",
  id: "test-integrity",
  phase: "pre",
  tools: ["write_file", "edit_file"],
  run(ev, ctx) {
    const args = ev.args as { path: string; content?: string; find?: string; replace?: string };
    const { abs, rel } = resolveInApi(ctx.apiRoot, args.path);
    if (!/^tests\/.*\.test\.ts$/.test(rel)) return { action: "pass" };
    let next = args.content;
    if (next === undefined && args.find !== undefined && existsSync(abs)) {
      next = readFileSync(abs, "utf8").replace(args.find, () => args.replace ?? "");
    }
    if (next === undefined) return { action: "pass" };
    const m = next.match(BANNED);
    if (m) return { action: "block", reason: `${rel}: "${m[0]}" is not allowed — every test must run` };
    if (!/\bexpect\(/.test(next)) return { action: "block", reason: `${rel}: a test file must contain assertions (expect)` };
    return { action: "pass" };
  },
};

export default hook;
