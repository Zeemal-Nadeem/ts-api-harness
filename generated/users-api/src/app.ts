import express from "express";
import { notFound, problemHandler } from "./lib/problem.ts";
import { usersRouter } from "./routes/users.ts";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/users", usersRouter);
  app.use(notFound);
  app.use(problemHandler);
  return app;
}
