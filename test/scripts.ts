// Scripted "model" turns for the replay driver. These exercise the engine and
// every gate offline; they are test fixtures, not evidence of model behaviour.

const SCHEMAS = `import { z } from "zod";
import { CursorQuery, pageOf } from "../lib/pagination.ts";

export const OrderStatus = z.enum(["pending", "paid", "shipped", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const OrderItem = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
});

export const Order = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  items: z.array(OrderItem).min(1),
  totalCents: z.number().int().nonnegative(),
  status: OrderStatus,
  createdAt: z.iso.datetime(),
});
export type Order = z.infer<typeof Order>;

export const CreateOrderBody = z.object({
  customerId: z.uuid(),
  items: z.array(OrderItem).min(1),
});

export const UpdateOrderStatusBody = z.object({ status: OrderStatus });

export const OrderParams = z.object({ id: z.uuid() });

export const ListOrdersQuery = CursorQuery.extend({
  customerId: z.uuid().optional(),
  status: OrderStatus.optional(),
});

export const OrderPage = pageOf(Order);
`;

const STORE = `import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { CreateOrderBody, Order, OrderStatus } from "../schemas/orders.ts";

const orders = new Map<string, Order>();

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["shipped", "cancelled"],
  shipped: [],
  cancelled: [],
};

export function listOrders(customerId?: string, status?: OrderStatus): Order[] {
  return [...orders.values()].filter(
    (o) => (customerId === undefined || o.customerId === customerId) && (status === undefined || o.status === status),
  );
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function createOrder(input: z.infer<typeof CreateOrderBody>): Order {
  const order: Order = {
    id: randomUUID(),
    customerId: input.customerId,
    items: input.items,
    totalCents: input.items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

export function transitionOrder(
  id: string,
  next: OrderStatus,
): { kind: "ok"; order: Order } | { kind: "missing" } | { kind: "invalid"; from: OrderStatus } {
  const order = orders.get(id);
  if (order === undefined) return { kind: "missing" };
  if (!TRANSITIONS[order.status].includes(next)) return { kind: "invalid", from: order.status };
  const updated: Order = { ...order, status: next };
  orders.set(id, updated);
  return { kind: "ok", order: updated };
}

export function deleteOrder(id: string): boolean {
  return orders.delete(id);
}

export function resetOrders(): void {
  orders.clear();
}
`;

const ROUTES = `import { Router } from "express";
import { idempotency } from "../lib/idempotency.ts";
import { paginate } from "../lib/pagination.ts";
import { HttpProblem } from "../lib/problem.ts";
import { CreateOrderBody, ListOrdersQuery, Order, OrderPage, OrderParams, UpdateOrderStatusBody } from "../schemas/orders.ts";
import { createOrder, deleteOrder, getOrder, listOrders, transitionOrder } from "../store/orders.ts";

export const ordersRouter = Router();

ordersRouter.get("/", async (req, res) => {
  const query = ListOrdersQuery.parse(req.query);
  const page = paginate(listOrders(query.customerId, query.status), query);
  res.status(200).json(OrderPage.parse(page));
});

ordersRouter.post("/", idempotency, async (req, res) => {
  const body = CreateOrderBody.parse(req.body);
  res.status(201).json(Order.parse(createOrder(body)));
});

ordersRouter.get("/:id", async (req, res) => {
  const { id } = OrderParams.parse(req.params);
  const order = getOrder(id);
  if (order === undefined) throw new HttpProblem(404, "Order not found", \`No order with id \${id}\`);
  res.status(200).json(Order.parse(order));
});

ordersRouter.patch("/:id", idempotency, async (req, res) => {
  const { id } = OrderParams.parse(req.params);
  const { status } = UpdateOrderStatusBody.parse(req.body);
  const result = transitionOrder(id, status);
  if (result.kind === "missing") throw new HttpProblem(404, "Order not found", \`No order with id \${id}\`);
  if (result.kind === "invalid") throw new HttpProblem(409, "Invalid status transition", \`Cannot move an order from \${result.from} to \${status}\`);
  res.status(200).json(Order.parse(result.order));
});

ordersRouter.delete("/:id", async (req, res) => {
  const { id } = OrderParams.parse(req.params);
  if (!deleteOrder(id)) throw new HttpProblem(404, "Order not found", \`No order with id \${id}\`);
  res.status(204).end();
});
`;

const TEST_ANCHOR = `    expect(del.status).toBe(204);
  });
});`;

const NEW_TESTS = `${TEST_ANCHOR}

describe("order status", () => {
  async function newOrder(): Promise<string> {
    const res = await request(app).post("/v1/orders").send({ customerId, items });
    return String(res.body.id);
  }

  it("starts pending and moves pending -> paid -> shipped", async () => {
    const id = await newOrder();
    expect((await request(app).get(\`/v1/orders/\${id}\`)).body.status).toBe("pending");
    const paid = await request(app).patch(\`/v1/orders/\${id}\`).set("Idempotency-Key", "p1").send({ status: "paid" });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("paid");
    const shipped = await request(app).patch(\`/v1/orders/\${id}\`).send({ status: "shipped" });
    expect(shipped.body.status).toBe("shipped");
  });

  it("rejects an invalid transition with a 409 problem", async () => {
    const id = await newOrder();
    const res = await request(app).patch(\`/v1/orders/\${id}\`).send({ status: "shipped" });
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/application\\/problem\\+json/);
  });

  it("rejects an unknown status with 422", async () => {
    const id = await newOrder();
    const res = await request(app).patch(\`/v1/orders/\${id}\`).send({ status: "lost" });
    expect(res.status).toBe(422);
  });

  it("filters the list by status", async () => {
    const a = await newOrder();
    await newOrder();
    await request(app).patch(\`/v1/orders/\${a}\`).send({ status: "paid" });
    const res = await request(app).get("/v1/orders?status=paid");
    expect(res.body.data).toHaveLength(1);
  });
});`;

export type ScriptTurn = { text?: string; calls: { name: string; args: unknown }[] };

/** A disciplined run that also bumps into every gate on the way. */
export function ordersStatusScript(): ScriptTurn[] {
  return [
    { text: "Reading the existing conventions.", calls: [{ name: "read_file", args: { path: "src/routes/orders.ts" } }, { name: "get_standard", args: { rule: "rest-conventions" } }] },
    { calls: [{ name: "write_file", args: { path: "src/schemas/orders.ts", content: SCHEMAS } }, { name: "edit_file", args: { path: "tsconfig.json", find: '"strict": true', replace: '"strict": false' } }] },
    { calls: [{ name: "edit_file", args: { path: "tests/orders.test.ts", find: TEST_ANCHOR, replace: NEW_TESTS.replace('it("rejects an unknown', 'it.skip("rejects an unknown') } }] },
    { calls: [{ name: "edit_file", args: { path: "tests/orders.test.ts", find: TEST_ANCHOR, replace: NEW_TESTS } }] },
    { calls: [{ name: "run_tests", args: {} }] },
    { text: "Done.", calls: [{ name: "finish", args: { summary: "premature" } }] },
    {
      calls: [
        { name: "write_file", args: { path: "src/schemas/orders.ts", content: SCHEMAS } },
        { name: "write_file", args: { path: "src/store/orders.ts", content: STORE } },
        { name: "write_file", args: { path: "src/routes/orders.ts", content: ROUTES } },
      ],
    },
    { calls: [{ name: "run_tests", args: {} }] },
    { calls: [{ name: "run_checks", args: {} }] },
    { calls: [{ name: "finish", args: { summary: "orders have a status lifecycle via PATCH /v1/orders/:id" } }] },
  ];
}

/** Same change, but it renames a response field: the contract gate must refuse finish. */
export function ordersBreakingScript(): ScriptTurn[] {
  const s = ordersStatusScript().filter((_, i) => i !== 1 && i !== 2 && i !== 5);
  const breakIt = (c: string): string => c.replace(/totalCents/g, "total");
  return s.map((t) => ({
    ...t,
    calls: t.calls.map((c) => {
      const a = c.args as { path?: string; content?: string; replace?: string };
      if (c.name === "write_file" && a.content && a.path?.startsWith("src/")) return { ...c, args: { ...a, content: breakIt(a.content) } };
      return c;
    }),
  }));
}

const USERS_SCHEMAS = `import { z } from "zod";
import { CursorQuery, pageOf } from "../lib/pagination.ts";

export const Role = z.enum(["admin", "member", "viewer"]);

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

export const UpdateUserBody = z
  .object({ email: z.email(), name: z.string().min(1).max(100), role: Role })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "at least one field is required");

export const UserParams = z.object({ id: z.uuid() });

export const ListUsersQuery = CursorQuery.extend({ role: Role.optional() });

export const UserPage = pageOf(User);
`;

const USERS_STORE = `import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { HttpProblem } from "../lib/problem.ts";
import type { CreateUserBody, UpdateUserBody, User } from "../schemas/users.ts";

const users = new Map<string, User>();

function assertEmailFree(email: string, exceptId?: string): void {
  for (const u of users.values()) {
    if (u.email.toLowerCase() === email.toLowerCase() && u.id !== exceptId) {
      throw new HttpProblem(409, "Email already in use", \`A user with email \${email} already exists\`);
    }
  }
}

export function listUsers(role?: User["role"]): User[] {
  return [...users.values()].filter((u) => role === undefined || u.role === role);
}

export function getUser(id: string): User | undefined {
  return users.get(id);
}

export function createUser(input: z.infer<typeof CreateUserBody>): User {
  assertEmailFree(input.email);
  const now = new Date().toISOString();
  const user: User = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
  users.set(user.id, user);
  return user;
}

export function updateUser(id: string, patch: z.infer<typeof UpdateUserBody>): User | undefined {
  const current = users.get(id);
  if (current === undefined) return undefined;
  if (patch.email !== undefined) assertEmailFree(patch.email, id);
  const next: User = { ...current, ...patch, updatedAt: new Date().toISOString() };
  users.set(id, next);
  return next;
}

export function deleteUser(id: string): boolean {
  return users.delete(id);
}

export function resetUsers(): void {
  users.clear();
}
`;

const USERS_ROUTES = `import { Router } from "express";
import { idempotency } from "../lib/idempotency.ts";
import { paginate } from "../lib/pagination.ts";
import { HttpProblem } from "../lib/problem.ts";
import { CreateUserBody, ListUsersQuery, UpdateUserBody, User, UserPage, UserParams } from "../schemas/users.ts";
import { createUser, deleteUser, getUser, listUsers, updateUser } from "../store/users.ts";

export const usersRouter = Router();

usersRouter.get("/", async (req, res) => {
  const query = ListUsersQuery.parse(req.query);
  res.status(200).json(UserPage.parse(paginate(listUsers(query.role), query)));
});

usersRouter.post("/", idempotency, async (req, res) => {
  const body = CreateUserBody.parse(req.body);
  res.status(201).json(User.parse(createUser(body)));
});

usersRouter.get("/:id", async (req, res) => {
  const { id } = UserParams.parse(req.params);
  const user = getUser(id);
  if (user === undefined) throw new HttpProblem(404, "User not found", \`No user with id \${id}\`);
  res.status(200).json(User.parse(user));
});

usersRouter.patch("/:id", idempotency, async (req, res) => {
  const { id } = UserParams.parse(req.params);
  const patch = UpdateUserBody.parse(req.body);
  const user = updateUser(id, patch);
  if (user === undefined) throw new HttpProblem(404, "User not found", \`No user with id \${id}\`);
  res.status(200).json(User.parse(user));
});

usersRouter.delete("/:id", async (req, res) => {
  const { id } = UserParams.parse(req.params);
  if (!deleteUser(id)) throw new HttpProblem(404, "User not found", \`No user with id \${id}\`);
  res.status(204).end();
});
`;

const USERS_TEST = `import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.ts";
import { resetUsers } from "../src/store/users.ts";
import { resetIdempotency } from "../src/lib/idempotency.ts";

const app = createApp();
const alice = { email: "alice@example.com", name: "Alice" };

beforeEach(() => {
  resetUsers();
  resetIdempotency();
});

describe("users api", () => {
  it("creates a user with 201 and default role", async () => {
    const res = await request(app).post("/v1/users").set("Idempotency-Key", "a").send(alice);
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("member");
  });

  it("rejects a duplicate email with a 409 problem", async () => {
    await request(app).post("/v1/users").send(alice);
    const res = await request(app).post("/v1/users").send({ ...alice, email: "ALICE@example.com" });
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/application\\/problem\\+json/);
  });

  it("rejects an invalid body with 422", async () => {
    const res = await request(app).post("/v1/users").send({ email: "nope" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 422, instance: "/v1/users" });
  });

  it("paginates and filters by role", async () => {
    for (const n of ["a", "b", "c"]) await request(app).post("/v1/users").send({ email: \`\${n}@x.io\`, name: n, role: "viewer" });
    const first = await request(app).get("/v1/users?limit=2&role=viewer");
    expect(first.body.data).toHaveLength(2);
    const next = await request(app).get(\`/v1/users?limit=2&cursor=\${first.body.nextCursor}\`);
    expect(next.body.nextCursor).toBeNull();
  });

  it("gets, patches and deletes a user", async () => {
    const created = await request(app).post("/v1/users").send(alice);
    const id = String(created.body.id);
    expect((await request(app).get(\`/v1/users/\${id}\`)).status).toBe(200);
    const patched = await request(app).patch(\`/v1/users/\${id}\`).send({ role: "admin" });
    expect(patched.body.role).toBe("admin");
    expect((await request(app).delete(\`/v1/users/\${id}\`)).status).toBe(204);
    expect((await request(app).get(\`/v1/users/\${id}\`)).status).toBe(404);
  });

  it("answers 422 for a malformed id", async () => {
    expect((await request(app).get("/v1/users/not-a-uuid")).status).toBe(422);
  });
});
`;

/** Greenfield users API, test-first. */
export function usersScript(): ScriptTurn[] {
  return [
    { calls: [{ name: "write_file", args: { path: "tests/users.test.ts", content: USERS_TEST } }] },
    { calls: [{ name: "run_tests", args: {} }] },
    {
      calls: [
        { name: "write_file", args: { path: "src/schemas/users.ts", content: USERS_SCHEMAS } },
        { name: "write_file", args: { path: "src/store/users.ts", content: USERS_STORE } },
        { name: "write_file", args: { path: "src/routes/users.ts", content: USERS_ROUTES } },
      ],
    },
    { calls: [{ name: "run_tests", args: {} }, { name: "run_checks", args: {} }] },
    { calls: [{ name: "finish", args: { summary: "users API" } }] },
  ];
}
