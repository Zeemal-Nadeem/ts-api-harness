// Subprocess: node --import tsx plugins/checks/_contract-extract.ts <apiRoot>
// Imports every src/schemas/*.ts module and prints the JSON Schema of each
// exported Zod schema. Runs in its own process so API code never loads into the harness.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const apiRoot = process.argv[2];
if (!apiRoot) throw new Error("usage: _contract-extract.ts <apiRoot>");
const dir = join(apiRoot, "src/schemas");
const out: Record<string, unknown> = {};
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (value instanceof z.ZodType) {
        out[name] = z.toJSONSchema(value, { unrepresentable: "any", io: "output" });
      }
    }
  }
}
console.log(JSON.stringify(out));
