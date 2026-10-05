// Static model of an Express + Zod API: source files, parsed ASTs and routes.
// Checks receive this instead of parsing on their own, so every rule agrees on
// what "a handler" is.
import ts from "typescript";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ApiContext, RouteInfo, Task } from "./types.ts";

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export function walk(dir: string, filter: (rel: string) => boolean, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, filter, base));
    else {
      const rel = relative(base, abs);
      if (filter(rel)) out.push(rel);
    }
  }
  return out;
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function isTestFile(rel: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.ts$/.test(rel);
}

export interface ApiContextOptions {
  runDir?: string;
  beforeRoot?: string;
  task?: Task;
}

export function createApiContext(root: string, harnessRoot: string, opts: ApiContextOptions = {}): ApiContext {
  const cache = new Map<string, ts.SourceFile>();
  const sourceFiles = walk(join(root, "src"), (r) => r.endsWith(".ts") && !r.endsWith(".d.ts"))
    .map((r) => join("src", r))
    .filter((r) => !isTestFile(r));
  let routes: RouteInfo[] | undefined;

  const ctx: ApiContext = {
    root,
    harnessRoot,
    ...opts,
    sourceFiles,
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    sourceFile(rel) {
      let sf = cache.get(rel);
      if (!sf) {
        sf = ts.createSourceFile(rel, ctx.read(rel), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
        cache.set(rel, sf);
      }
      return sf;
    },
    routes() {
      routes ??= extractRoutes(ctx);
      return routes;
    },
  };
  return ctx;
}

function isFn(n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression {
  return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
}

/** Router mount points: app.use("/v1/users", usersRouter) -> usersRouter => /v1/users */
function mounts(ctx: ApiContext): Map<string, string> {
  const m = new Map<string, string>();
  for (const file of ctx.sourceFiles) {
    const sf = ctx.sourceFile(file);
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "use" &&
        n.arguments.length >= 2
      ) {
        const [first] = n.arguments;
        const last = n.arguments[n.arguments.length - 1];
        if (first && ts.isStringLiteralLike(first) && last && ts.isIdentifier(last)) {
          m.set(last.text, first.text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return m;
}

function joinPath(prefix: string, path: string): string {
  const p = (prefix + (path === "/" ? "" : path)).replace(/\/+/g, "/");
  return p === "" ? "/" : p;
}

function extractRoutes(ctx: ApiContext): RouteInfo[] {
  const prefixes = mounts(ctx);
  const out: RouteInfo[] = [];
  for (const file of ctx.sourceFiles) {
    const sf = ctx.sourceFile(file);
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        METHODS.has(n.expression.name.text) &&
        n.arguments.length >= 2
      ) {
        const [pathArg] = n.arguments;
        const handler = n.arguments[n.arguments.length - 1];
        if (pathArg && ts.isStringLiteralLike(pathArg) && isFn(handler)) {
          const target = n.expression.expression;
          const prefix = ts.isIdentifier(target) ? (prefixes.get(target.text) ?? "") : "";
          out.push({
            file,
            line: lineOf(sf, n),
            method: n.expression.name.text as RouteInfo["method"],
            path: joinPath(prefix, pathArg.text),
            handler,
            middleware: n.arguments.slice(1, -1).map((a) => a.getText(sf)),
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** Depth-first search for nodes matching a predicate. */
export function findAll<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

export { ts };
