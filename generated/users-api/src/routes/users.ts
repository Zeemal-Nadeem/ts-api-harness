import { Router } from "express";
import { idempotency } from "../lib/idempotency.ts";
import { paginate } from "../lib/pagination.ts";
import { HttpProblem } from "../lib/problem.ts";
import { CreateUserBody, ListUsersQuery, UpdateUserBody, User, UserPage, UserParams } from "../schemas/users.ts";
import { createUser, deleteUser, getUser, listUsers, updateUser } from "../store/users.ts";

export const usersRouter = Router();

const notFound = (id: string): HttpProblem => new HttpProblem(404, "User not found", `No user with id ${id}`);

usersRouter.post("/", idempotency, async (req, res) => {
  const body = CreateUserBody.parse(req.body);
  const user = createUser(body);
  res.status(201).json(User.parse(user));
});

usersRouter.get("/", async (req, res) => {
  const query = ListUsersQuery.parse(req.query);
  const page = paginate(listUsers(query.role), query);
  res.status(200).json(UserPage.parse(page));
});

usersRouter.get("/:id", async (req, res) => {
  const { id } = UserParams.parse(req.params);
  const user = getUser(id);
  if (user === undefined) throw notFound(id);
  res.status(200).json(User.parse(user));
});

usersRouter.patch("/:id", idempotency, async (req, res) => {
  const { id } = UserParams.parse(req.params);
  const patch = UpdateUserBody.parse(req.body);
  const user = updateUser(id, patch);
  if (user === undefined) throw notFound(id);
  res.status(200).json(User.parse(user));
});

usersRouter.delete("/:id", async (req, res) => {
  const { id } = UserParams.parse(req.params);
  if (!deleteUser(id)) throw notFound(id);
  res.status(204).end();
});
