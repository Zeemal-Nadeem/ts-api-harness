// Cursor pagination shared by every collection GET.
import { z } from "zod";
import { HttpProblem } from "./problem.ts";

export const CursorQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

export const encodeCursor = (id: string): string => Buffer.from(id, "utf8").toString("base64url");
export const decodeCursor = (cursor: string): string => Buffer.from(cursor, "base64url").toString("utf8");

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

export function paginate<T extends { id: string }>(
  items: readonly T[],
  query: { cursor?: string | undefined; limit: number },
): { data: T[]; nextCursor: string | null } {
  let start = 0;
  if (query.cursor !== undefined) {
    const afterId = decodeCursor(query.cursor);
    const index = items.findIndex((i) => i.id === afterId);
    if (index === -1) throw new HttpProblem(422, "Invalid cursor", "cursor does not match any item", "validation");
    start = index + 1;
  }
  const data = items.slice(start, start + query.limit);
  const last = data[data.length - 1];
  const nextCursor = last !== undefined && start + query.limit < items.length ? encodeCursor(last.id) : null;
  return { data, nextCursor };
}
