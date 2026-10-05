// RFC 7807 problem details. The only place in the API that writes an error response.
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";

export const PROBLEM_BASE = "https://api.sf/problems/";

const SLUGS: Record<number, string> = {
  400: "bad-request",
  404: "not-found",
  409: "conflict",
  422: "validation",
  500: "internal",
};

export class HttpProblem extends Error {
  readonly status: number;
  readonly title: string;
  readonly slug: string;

  constructor(status: number, title: string, detail: string, slug?: string) {
    super(detail);
    this.status = status;
    this.title = title;
    this.slug = slug ?? SLUGS[status] ?? "error";
  }
}

export function sendProblem(req: Request, res: Response, status: number, title: string, detail: string, slug: string): void {
  res
    .status(status)
    .type("application/problem+json")
    .json({ type: PROBLEM_BASE + slug, title, status, detail, instance: req.originalUrl });
}

export const notFound: RequestHandler = (req, res) => {
  sendProblem(req, res, 404, "Not Found", `No route for ${req.method} ${req.path}`, "not-found");
};

export const problemHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (err instanceof HttpProblem) {
    sendProblem(req, res, err.status, err.title, err.message, err.slug);
  } else if (err instanceof ZodError) {
    const detail = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    sendProblem(req, res, 422, "Request failed validation", detail, "validation");
  } else if (err instanceof SyntaxError && "body" in err) {
    sendProblem(req, res, 400, "Malformed JSON", err.message, "bad-request");
  } else {
    sendProblem(req, res, 500, "Internal Server Error", "Unexpected error", "internal");
  }
};
