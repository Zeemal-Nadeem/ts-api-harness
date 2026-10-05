import { Router } from "express";
import { idempotency } from "../lib/idempotency.ts";
import { paginate } from "../lib/pagination.ts";
import { HttpProblem } from "../lib/problem.ts";
import {
  CreateUser,
  User,
  ListUsersQuery,
  UserPage,
  UserParams,
  UpdateUser,
} from "../schemas/users.ts";
import { createUser, deleteUser, emailExists, getUser, listUsers, updateUser } from "../store/users.ts";

export const usersRouter = Router();

usersRouter.post("/", idempotency, (req, res) => {
  const input = CreateUser.parse(req.body);
  if (emailExists(input.email)) {
    throw new HttpProblem(409, "Email already exists", "A user with that email already exists", "conflict");
  }
  const user = createUser(input);
  res.status(201).json(User.parse(user));
});

usersRouter.get("/", (req, res) => {
  const query = ListUsersQuery.parse(req.query);
  const users = listUsers(query.role);
  const page = paginate(users, query);
  res.status(200).json(UserPage.parse(page));
});

usersRouter.get("/:id", (req, res) => {
  const { id } = UserParams.parse(req.params);
  const user = getUser(id);
  if (user === undefined) {
    throw new HttpProblem(404, "User not found", `No user with id ${id}`, "not-found");
  }
  res.status(200).json(User.parse(user));
});

usersRouter.patch("/:id", idempotency, (req, res) => {
  const { id } = UserParams.parse(req.params);
  const input = UpdateUser.parse(req.body);
  const existing = getUser(id);
  if (existing === undefined) {
    throw new HttpProblem(404, "User not found", `No user with id ${id}`, "not-found");
  }
  if (input.email !== undefined && emailExists(input.email, id)) {
    throw new HttpProblem(409, "Email already exists", "A user with that email already exists", "conflict");
  }
  const user = updateUser(id, input);
  res.status(200).json(User.parse(user));
});

usersRouter.delete("/:id", (req, res) => {
  const { id } = UserParams.parse(req.params);
  if (!deleteUser(id)) {
    throw new HttpProblem(404, "User not found", `No user with id ${id}`, "not-found");
  }
  res.status(204).end();
});
