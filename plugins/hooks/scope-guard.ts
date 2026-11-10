// Pre-hook: writes stay inside the API directory and never touch harness-owned
// config (loosening tsconfig would be the cheapest way to "pass" tsc --strict).
import { globToRegExp } from "../../core/mapping.ts";
import { resolveInApi } from "../../core/paths.ts";
import type { HookPlugin } from "../../core/types.ts";

const OWNED = /^(tsconfig[^/]*\.json|package(-lock)?\.json|vitest\.config\.[cm]?[jt]s|\.npmrc)$/;
// Loosening test config or swapping dependencies is the Python way to "pass".
const PY_OWNED = /(^|\/)(pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|requirements[^/]*\.txt|conftest\.py)$/;

const hook: HookPlugin = {
  kind: "hook",
  id: "scope-guard",
  phase: "pre",
  tools: ["write_file", "edit_file", "delete_file"],
  run(ev, ctx) {
    const path = (ev.args as { path: string }).path;
    let rel: string;
    try {
      rel = resolveInApi(ctx.apiRoot, path).rel;
    } catch (err) {
      return { action: "block", reason: (err as Error).message };
    }
    if (OWNED.test(rel) || (ctx.task.stack === "python" && PY_OWNED.test(rel))) return { action: "block", reason: `${rel} is harness-owned configuration and cannot be edited by the model` };
    const allowed = ctx.task.writable ?? (ctx.task.stack === "python" ? ["tests/**"] : ["src/**", "tests/**"]);
    if (!allowed.some((g) => globToRegExp(g).test(rel))) return { action: "block", reason: `writes are limited to ${allowed.join(", ")} (got ${rel})` };
    return { action: "pass" };
  },
};

export default hook;
