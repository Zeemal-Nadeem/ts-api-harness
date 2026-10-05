// Loads provider keys from a .env file (git-ignored) without overriding the
// real environment. Accepts `KEY=value`, `KEY = "value"`, `export KEY=value`;
// key names are normalised to upper case (openrouter_api_key -> OPENROUTER_API_KEY).
import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || !m[1]) continue;
    const key = m[1].toUpperCase();
    const value = (m[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[key] === undefined && value !== "") process.env[key] = value;
  }
}
