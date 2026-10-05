import { z } from "zod";
import { CursorQuery, pageOf } from "../lib/pagination.ts";

export const Role = z.enum(["admin", "member", "viewer"]);
export type Role = z.infer<typeof Role>;

export const User = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  role: Role,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof User>;

export const CreateUserBody = z.object({
  email: z.email(),
  name: z.string().min(1).max(100),
  role: Role.default("member"),
});
export type CreateUserBody = z.infer<typeof CreateUserBody>;

export const UpdateUserBody = z.object({
  email: z.email().optional(),
  name: z.string().min(1).max(100).optional(),
  role: Role.optional(),
});
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;

export const UserParams = z.object({ id: z.uuid() });
export type UserParams = z.infer<typeof UserParams>;

export const ListUsersQuery = CursorQuery.extend({ role: Role.optional() });
export type ListUsersQuery = z.infer<typeof ListUsersQuery>;

export const UserPage = pageOf(User);
export type UserPage = z.infer<typeof UserPage>;
