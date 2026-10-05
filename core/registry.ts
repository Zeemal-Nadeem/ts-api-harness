// Discovers every extension by folder. Adding a driver, tool, hook, check,
// ORM validator or lint rule = dropping one file into the matching folder.
// Core never lists plugins by name.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CheckPlugin,
  DriverPlugin,
  HookPlugin,
  Registry,
  ToolPlugin,
} from "./types.ts";

export const PLUGIN_DIRS = {
  driver: "drivers",
  tool: "plugins/tools",
  hook: "plugins/hooks",
  check: "plugins/checks",
} as const;

type AnyPlugin = DriverPlugin | ToolPlugin | HookPlugin | CheckPlugin;

function pluginFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ts$/.test(e.name) && !e.name.startsWith("_") && !e.name.endsWith(".d.ts"))
    .map((e) => join(dir, e.name))
    .sort();
}

async function loadDir(root: string, rel: string, kind: AnyPlugin["kind"]): Promise<AnyPlugin[]> {
  const out: AnyPlugin[] = [];
  for (const file of pluginFiles(join(root, rel))) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    const exported = Array.isArray(mod.default) ? mod.default : [mod.default];
    for (const p of exported) {
      if (!p || typeof p !== "object" || (p as { kind?: unknown }).kind !== kind) {
        throw new Error(`${file}: default export must be a ${kind} plugin (kind: "${kind}")`);
      }
      out.push(p as AnyPlugin);
    }
  }
  return out;
}

export async function loadRegistry(root: string): Promise<Registry> {
  const reg: Registry = { drivers: new Map(), tools: new Map(), hooks: [], checks: [] };
  for (const d of (await loadDir(root, PLUGIN_DIRS.driver, "driver")) as DriverPlugin[]) {
    reg.drivers.set(d.id, d);
  }
  for (const t of (await loadDir(root, PLUGIN_DIRS.tool, "tool")) as ToolPlugin[]) {
    if (reg.tools.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    reg.tools.set(t.name, t);
  }
  reg.hooks = (await loadDir(root, PLUGIN_DIRS.hook, "hook")) as HookPlugin[];
  reg.checks = (await loadDir(root, PLUGIN_DIRS.check, "check")) as CheckPlugin[];
  return reg;
}
