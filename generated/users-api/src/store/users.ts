import { randomUUID } from "node:crypto";
import type { CreateUser, UpdateUser, User, UserRole } from "../schemas/users.ts";

const users = new Map<string, User>();

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeEmail(email: string): string {
  return email.toLocaleLowerCase();
}

function hasEmailClash(email: string, exceptId?: string): boolean {
  const normalized = normalizeEmail(email);
  return Array.from(users.values()).some((user) => user.id !== exceptId && normalizeEmail(user.email) === normalized);
}

export function listUsers(role?: UserRole): User[] {
  const all = Array.from(users.values());
  if (role === undefined) return all;
  return all.filter((user) => user.role === role);
}

export function getUser(id: string): User | undefined {
  return users.get(id);
}

export function emailExists(email: string, exceptId?: string): boolean {
  return hasEmailClash(email, exceptId);
}

export function createUser(input: CreateUser): User {
  const timestamp = nowIso();
  const user: User = {
    id: randomUUID(),
    email: input.email,
    name: input.name,
    role: input.role,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  users.set(user.id, user);
  return user;
}

export function updateUser(id: string, input: UpdateUser): User | undefined {
  const existing = users.get(id);
  if (existing === undefined) return undefined;

  const updated: User = {
    ...existing,
    ...input,
    updatedAt: nowIso(),
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
