import express from "express";
import { notFound, problemHandler } from "./lib/problem.ts";
import { ordersRouter } from "./routes/orders.ts";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/orders", ordersRouter);
  app.use(notFound);
  app.use(problemHandler);
  return app;
}
