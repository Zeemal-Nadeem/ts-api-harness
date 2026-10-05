// Pre-hook: writes stay inside the API directory and never touch harness-owned
// config (loosening tsconfig would be the cheapest way to "pass" tsc --strict).
import { resolveInApi } from "../../core/paths.ts";
import type { HookPlugin } from "../../core/types.ts";

const OWNED = /^(tsconfig[^/]*\.json|package(-lock)?\.json|vitest\.config\.[cm]?[jt]s|\.npmrc)$/;

const hook: HookPlugin = {
  kind: "hook",
  id: "scope-guard",
  phase: "pre",
  tools: ["write_file", "edit_file"],
  run(ev, ctx) {
    const path = (ev.args as { path: string }).path;
    let rel: string;
    try {
      rel = resolveInApi(ctx.apiRoot, path).rel;
    } catch (err) {
      return { action: "block", reason: (err as Error).message };
    }
    if (OWNED.test(rel)) return { action: "block", reason: `${rel} is harness-owned configuration and cannot be edited by the model` };
    if (!/^(src|tests)\//.test(rel)) return { action: "block", reason: `writes are limited to src/ and tests/ (got ${rel})` };
    return { action: "pass" };
  },
};

export default hook;
