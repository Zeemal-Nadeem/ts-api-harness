import { randomUUID } from "node:crypto";
import { HttpProblem } from "../lib/problem.ts";
import type { CreateUserBody, Role, UpdateUserBody, User } from "../schemas/users.ts";

// Insertion-ordered map keeps cursor pagination stable.
const users = new Map<string, User>();

function emailTaken(email: string, exceptId?: string): boolean {
  const needle = email.toLowerCase();
  for (const u of users.values()) {
    if (u.id !== exceptId && u.email.toLowerCase() === needle) return true;
  }
  return false;
}

function conflict(email: string): HttpProblem {
  return new HttpProblem(409, "Email already in use", `A user with email ${email} already exists`);
}

export function listUsers(role?: Role): User[] {
  const all = [...users.values()];
  return role === undefined ? all : all.filter((u) => u.role === role);
}

export function getUser(id: string): User | undefined {
  return users.get(id);
}

export function createUser(input: CreateUserBody): User {
  if (emailTaken(input.email)) throw conflict(input.email);
  const now = new Date().toISOString();
  const user: User = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
  users.set(user.id, user);
  return user;
}

export function updateUser(id: string, patch: UpdateUserBody): User | undefined {
  const existing = users.get(id);
  if (existing === undefined) return undefined;
  if (patch.email !== undefined && emailTaken(patch.email, id)) throw conflict(patch.email);
  let updatedAt = new Date().toISOString();
  if (updatedAt <= existing.updatedAt) updatedAt = new Date(Date.parse(existing.updatedAt) + 1).toISOString();
  const updated: User = {
    ...existing,
    email: patch.email ?? existing.email,
    name: patch.name ?? existing.name,
    role: patch.role ?? existing.role,
    updatedAt,
  };
  users.set(id, updated);
  return updated;
}

export function deleteUser(id: string): boolean {
  return users.delete(id);
}

export function resetUsers(): void {
  users.clear();
}
