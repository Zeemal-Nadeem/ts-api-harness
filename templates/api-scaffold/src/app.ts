import express from "express";
import { notFound, problemHandler } from "./lib/problem.ts";
import { __RESOURCE__Router } from "./routes/__RESOURCE__.ts";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/__RESOURCE__", __RESOURCE__Router);
  app.use(notFound);
  app.use(problemHandler);
  return app;
}
