// Idempotency-Key support for unsafe methods (POST, PATCH).
// Same key + same request => the first response is replayed.
// Same key + different request => 409 problem.
import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { HttpProblem } from "./problem.ts";

const seen = new Map<string, { fingerprint: string; status: number; body: unknown }>();

export const idempotency: RequestHandler = (req, res, next) => {
  const key = req.get("Idempotency-Key");
  if (key === undefined) {
    next();
    return;
  }
  const scope = `${req.method} ${req.originalUrl} ${key}`;
  const fingerprint = createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex");
  const prior = seen.get(scope);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      next(new HttpProblem(409, "Idempotency key reuse", "Idempotency-Key was already used with a different request"));
      return;
    }
    res.status(prior.status).json(prior.body);
    return;
  }
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode < 400) seen.set(scope, { fingerprint, status: res.statusCode, body });
    return send(body);
  }) as typeof res.json;
  next();
};

export function resetIdempotency(): void {
  seen.clear();
}
