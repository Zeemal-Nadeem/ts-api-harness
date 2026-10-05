// Source -> test mapping. Used by the observed-red gate and the brownfield scope.
// A task may give an explicit testMap ({ "src/**": "tests/users.test.ts" });
// otherwise src/**/<name>.ts maps to tests/<name>.test.ts when that file exists,
// and to every test file under tests/ when it does not.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { walk, isTestFile } from "./api-model.ts";
import type { Task } from "./types.ts";

export function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`);
}

export function isSourceFile(rel: string): boolean {
  return rel.startsWith("src/") && rel.endsWith(".ts") && !isTestFile(rel);
}

export function mappedTests(task: Task, apiRoot: string, srcRel: string): string[] {
  if (task.testMap) {
    const hits = Object.entries(task.testMap)
      .filter(([glob]) => globToRegExp(glob).test(srcRel))
      .map(([, test]) => test);
    if (hits.length) return hits;
  }
  const direct = join("tests", basename(srcRel).replace(/\.ts$/, ".test.ts"));
  if (existsSync(join(apiRoot, direct))) return [direct];
  return walk(join(apiRoot, "tests"), (r) => r.endsWith(".test.ts")).map((r) => join("tests", r));
}
