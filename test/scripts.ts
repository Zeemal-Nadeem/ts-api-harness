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
