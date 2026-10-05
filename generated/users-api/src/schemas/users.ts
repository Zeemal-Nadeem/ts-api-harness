import { z } from "zod";
import { pageOf } from "../lib/pagination.ts";

export const UserRole = z.enum(["admin", "member", "viewer"]);
export type UserRole = z.infer<typeof UserRole>;

export const User = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(100),
  role: UserRole,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type User = z.infer<typeof User>;

export const CreateUser = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  role: UserRole.default("member"),
});
export type CreateUser = z.infer<typeof CreateUser>;

export const UpdateUser = z
  .object({
    email: z.string().email().optional(),
    name: z.string().min(1).max(100).optional(),
    role: UserRole.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field is required" });
export type UpdateUser = z.infer<typeof UpdateUser>;

export const UserParams = z.object({
  id: z.string().uuid(),
});
export type UserParams = z.infer<typeof UserParams>;

export const ListUsersQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: UserRole.optional(),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuery>;

export const UserPage = pageOf(User);
export type UserPage = z.infer<typeof UserPage>;
