// Pre-hook: a src/ file is refused until a mapped test has been written and
// seen FAILING by the harness's own runner (run_tests) during this run.
import { resolveInApi } from "../../core/paths.ts";
import { isSourceFile, mappedTests } from "../../core/mapping.ts";
import type { HookPlugin } from "../../core/types.ts";

const hook: HookPlugin = {
  kind: "hook",
  id: "observed-red",
  phase: "pre",
  tools: ["write_file", "edit_file"],
  run(ev, ctx) {
    const { rel } = resolveInApi(ctx.apiRoot, (ev.args as { path: string }).path);
    if (!isSourceFile(rel)) return { action: "pass" };
    const tests = mappedTests(ctx.task, ctx.apiRoot, rel);
    if (tests.length === 0) {
      return { action: "block", reason: `${rel} has no mapped test. Write tests/<name>.test.ts covering the change, run_tests, see it fail, then edit ${rel}.` };
    }
    const red = tests.filter((t) => ctx.state.observedRed[t] !== undefined);
    if (red.length === 0) {
      return { action: "block", reason: `no mapped test for ${rel} (${tests.join(", ")}) has been observed failing by run_tests yet. Write/extend the test, run it, see it fail, then edit the source.` };
    }
    return { action: "record", note: `${rel} unlocked by observed red in ${red.join(", ")}` };
  },
};

export default hook;
