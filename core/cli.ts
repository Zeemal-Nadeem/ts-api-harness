// harness <command>
//   run     --task <file> --driver <id> [--baseline] [--max-turns N]
//   check   --api <dir> [--json]
//   ship    --run <runId> [--dry-run] [--base <branch>] [--no-pr]
//   tokens  <runId | tokens/file.json>
//   plugins
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadRegistry } from "./registry.ts";
import { renderStandards, runStandards } from "./standards.ts";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const registry = await loadRegistry(HARNESS_ROOT);

  switch (command) {
    case "check": {
      const { values } = parseArgs({ args: rest, options: { api: { type: "string" }, json: { type: "boolean" } } });
      if (!values.api) throw new Error("check needs --api <dir>");
      const apiRoot = resolve(process.cwd(), values.api);
      if (!existsSync(apiRoot)) throw new Error(`no such API directory: ${apiRoot}`);
      const report = await runStandards(registry, apiRoot, HARNESS_ROOT);
      console.log(values.json ? JSON.stringify(report, null, 2) : `$ harness check --api ${values.api}\n${renderStandards(report)}`);
      return report.ok ? 0 : 1;
    }
    case "run": {
      const { values } = parseArgs({
        args: rest,
        options: {
          task: { type: "string" },
          driver: { type: "string" },
          baseline: { type: "boolean", default: false },
          "max-turns": { type: "string" },
          "run-id": { type: "string" },
        },
      });
      if (!values.task || !values.driver) throw new Error("run needs --task <file> --driver <id>");
      const { runTask } = await import("./engine.ts");
      const result = await runTask({
        harnessRoot: HARNESS_ROOT,
        registry,
        taskFile: resolve(process.cwd(), values.task),
        driverId: values.driver,
        baseline: values.baseline,
        maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
        runId: values["run-id"],
      });
      return result.ok ? 0 : 1;
    }
    case "ship": {
      const { values } = parseArgs({
        args: rest,
        options: {
          run: { type: "string" },
          "dry-run": { type: "boolean", default: false },
          base: { type: "string", default: "main" },
          "no-pr": { type: "boolean", default: false },
        },
      });
      if (!values.run) throw new Error("ship needs --run <runId>");
      const { ship } = await import("./ship.ts");
      return (await ship({ harnessRoot: HARNESS_ROOT, registry, runId: values.run, dryRun: values["dry-run"], base: values.base, openPr: !values["no-pr"] })) ? 0 : 1;
    }
    case "tokens": {
      const arg = rest[0];
      if (!arg) throw new Error("tokens needs <runId>");
      const file = existsSync(arg) ? arg : join(HARNESS_ROOT, "tokens", `${arg}.json`);
      const rep = JSON.parse(readFileSync(file, "utf8")) as { summary: unknown };
      console.log(JSON.stringify(rep.summary, null, 2));
      return 0;
    }
    case "plugins": {
      console.log(`drivers: ${[...registry.drivers.keys()].join(", ")}`);
      console.log(`tools:   ${[...registry.tools.keys()].join(", ")}`);
      console.log(`hooks:   ${registry.hooks.map((h) => `${h.id}(${h.phase})`).join(", ")}`);
      console.log(`checks:  ${registry.checks.map((c) => `${c.id}[${c.category}${c.required ? "" : ",advisory"}]`).join(", ")}`);
      return 0;
    }
    default:
      console.error("usage: harness <run|check|ship|tokens|plugins> ...");
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`harness: ${(err as Error).message}`);
    process.exit(2);
  },
);
