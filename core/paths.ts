// Confine model-supplied paths to the API directory.
import { isAbsolute, normalize, relative, resolve } from "node:path";

export function resolveInApi(apiRoot: string, p: string): { abs: string; rel: string } {
  if (isAbsolute(p)) throw new Error(`absolute paths are not allowed: ${p}`);
  const abs = resolve(apiRoot, normalize(p));
  const rel = relative(apiRoot, abs);
  if (rel === "" ? false : rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes the API directory: ${p}`);
  if (/(^|\/)(node_modules|\.git|\.harness)(\/|$)/.test(rel)) throw new Error(`path is off-limits: ${p}`);
  return { abs, rel };
}
