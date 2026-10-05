// Runtime probe used by problem-json. Run as a subprocess:
//   node --import tsx plugins/checks/_probe.ts <apiRoot> <routes.json>
// Boots the API's exported app on an ephemeral port, sends requests that must
// fail, and prints one JSON line per probe. Never touches the network beyond 127.0.0.1.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

interface ProbeRoute { method: string; path: string }
interface Probe { name: string; method: string; url: string; body?: unknown; expect: number[] }

const [apiRoot, routesFile] = process.argv.slice(2);
if (!apiRoot || !routesFile) throw new Error("usage: _probe.ts <apiRoot> <routes.json>");
const routes = JSON.parse(readFileSync(routesFile, "utf8")) as ProbeRoute[];

const mod = (await import(pathToFileURL(join(apiRoot, "src/app.ts")).href)) as Record<string, unknown>;
const factory = mod.createApp;
const app = typeof factory === "function" ? (factory as () => unknown)() : mod.app;
if (!app || typeof (app as { listen?: unknown }).listen !== "function") {
  throw new Error("src/app.ts must export `app` or `createApp()` returning an Express app");
}

const server: Server = await new Promise((resolve) => {
  const s = (app as { listen: (port: number, host: string, cb: () => void) => Server }).listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const fill = (p: string): string => p.replace(/:[A-Za-z0-9_]+/g, "__harness_probe__");
const versionPrefix = routes[0]?.path.match(/^\/v\d+/)?.[0] ?? "/v1";

const probes: Probe[] = [
  { name: "unknown route", method: "GET", url: `${versionPrefix}/__harness_probe_missing__`, expect: [404] },
];
for (const r of routes) {
  const m = r.method.toUpperCase();
  const hasParam = r.path.includes("/:");
  if (m === "POST" || m === "PUT" || m === "PATCH") {
    probes.push({ name: `${m} ${r.path} invalid body`, method: m, url: fill(r.path), body: [], expect: hasParam ? [404, 422] : [422] });
  } else if (hasParam) {
    probes.push({ name: `${m} ${r.path} unknown id`, method: m, url: fill(r.path), expect: [404, 422] });
  } else if (m === "GET") {
    probes.push({ name: `${m} ${r.path} invalid limit`, method: m, url: `${r.path}?limit=-1`, expect: [422] });
  }
}

for (const p of probes) {
  const res = await fetch(base + p.url, {
    method: p.method,
    headers: { "content-type": "application/json", "idempotency-key": `probe-${Math.random().toString(36).slice(2)}` },
    body: p.body === undefined ? undefined : JSON.stringify(p.body),
  });
  const ctype = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const problems: string[] = [];
  if (!p.expect.includes(res.status)) problems.push(`status ${res.status}, expected ${p.expect.join("|")}`);
  if (!ctype.startsWith("application/problem+json")) problems.push(`content-type "${ctype}"`);
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    for (const k of ["type", "title", "detail", "instance"]) if (typeof body[k] !== "string") problems.push(`missing string "${k}"`);
    if (body.status !== res.status) problems.push(`body.status ${String(body.status)} != ${res.status}`);
    const extra = Object.keys(body).filter((k) => k === "error" || k === "message");
    if (extra.length) problems.push(`ad-hoc keys: ${extra.join(",")}`);
  } catch {
    problems.push("body is not JSON");
  }
  console.log(JSON.stringify({ name: p.name, status: res.status, ok: problems.length === 0, problems }));
}

server.close();
process.exit(0);
