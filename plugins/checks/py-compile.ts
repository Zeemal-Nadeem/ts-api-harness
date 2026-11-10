// Every Python file in the target compiles. The cheapest proof that an edit did
// not leave a module unimportable (a syntax error in a Lambda handler ships as a 500).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { walk } from "../../core/api-model.ts";
import { exec } from "../../core/util.ts";
import { repoRootOf } from "../../core/workspace.ts";
import type { CheckPlugin } from "../../core/types.ts";

const check: CheckPlugin = {
  kind: "check",
  id: "py-compile",
  category: "standard",
  required: true,
  stacks: ["python"],
  doc: "# py-compile\nEvery .py file in the target must compile (python -m py_compile).",
  async run(api) {
    const files = walk(api.root, (r) => r.endsWith(".py"));
    if (files.length === 0) return { status: "n/a", passed: 0, total: 0, unit: "files", findings: [] };
    const venv = api.task ? join(repoRootOf(api.harnessRoot, api.task), ".venv", "bin", "python") : "";
    const python = venv && existsSync(venv) ? venv : "python3";
    // One interpreter for all files; prints "path<TAB>line<TAB>message" per failure.
    const script = "import sys,py_compile\nfor f in sys.argv[1:]:\n  try: py_compile.compile(f, doraise=True, cfile='/dev/null')\n  except py_compile.PyCompileError as e:\n    ln=getattr(e.exc_value,'lineno',0) or 0\n    print(f'{f}\\t{ln}\\t{e.exc_type_name}: {e.exc_value}')";
    const r = exec(python, ["-c", script, ...files], { cwd: api.root, timeoutMs: 120_000 });
    const bad = new Map(r.stdout.split("\n").filter(Boolean).map((l) => { const [f = "", ln = "0", msg = ""] = l.split("\t"); return [f, { line: Number(ln), msg }] as const; }));
    const findings = files.map((f) => ({ file: f, line: bad.get(f)?.line ?? 1, ok: !bad.has(f), message: bad.get(f)?.msg ?? "compiles" }));
    return { status: bad.size === 0 ? "pass" : "fail", passed: files.length - bad.size, total: files.length, unit: "files", findings };
  },
};

export default check;
