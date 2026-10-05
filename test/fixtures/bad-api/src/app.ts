import express from "express";

interface User {
  id: string;
  email: string;
}

const users: Record<string, User> = {};

export const userRouter = express.Router();

userRouter.get("/user/:id", async (req, res) => {
  const user = users[req.params.id];
  if (!user) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(user);
});

userRouter.post("/user", async (req, res) => {
  const body: any = req.body;
  users[body.id] = body;
  res.json(body);
});

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", userRouter);
  return app;
}

export const first = Object.values(users)[0]!;
