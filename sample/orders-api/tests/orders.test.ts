import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.ts";
import { resetOrders } from "../src/store/orders.ts";
import { resetIdempotency } from "../src/lib/idempotency.ts";

const app = createApp();
const customerId = "6f1c2b8e-3d4a-4c5b-9e6f-7a8b9c0d1e2f";
const items = [{ sku: "SKU-1", quantity: 2, unitPriceCents: 1250 }];

beforeEach(() => {
  resetOrders();
  resetIdempotency();
});

describe("orders api", () => {
  it("creates an order with 201, pending status, and computes the total", async () => {
    const res = await request(app).post("/v1/orders").set("Idempotency-Key", "k1").send({ customerId, items });
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(2500);
    expect(res.body.status).toBe("pending");
  });

  it("updates order status through allowed transitions", async () => {
    const created = await request(app).post("/v1/orders").send({ customerId, items });
    const paid = await request(app).patch(`/v1/orders/${created.body.id}`).send({ status: "paid" });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("paid");

    const shipped = await request(app).patch(`/v1/orders/${created.body.id}`).send({ status: "shipped" });
    expect(shipped.status).toBe(200);
    expect(shipped.body.status).toBe("shipped");
  });

  it("replays patch responses for a repeated idempotency key", async () => {
    const created = await request(app).post("/v1/orders").send({ customerId, items });
    const a = await request(app).patch(`/v1/orders/${created.body.id}`).set("Idempotency-Key", "patch-1").send({ status: "paid" });
    const b = await request(app).patch(`/v1/orders/${created.body.id}`).set("Idempotency-Key", "patch-1").send({ status: "paid" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });

  it("rejects disallowed status transitions with a 409 problem", async () => {
    const created = await request(app).post("/v1/orders").send({ customerId, items });
    const res = await request(app).patch(`/v1/orders/${created.body.id}`).send({ status: "shipped" });
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
  });

  it("returns 404 for unknown patch id and 422 for invalid status", async () => {
    const missing = await request(app).patch("/v1/orders/00000000-0000-4000-8000-000000000000").send({ status: "paid" });
    expect(missing.status).toBe(404);

    const created = await request(app).post("/v1/orders").send({ customerId, items });
    const invalid = await request(app).patch(`/v1/orders/${created.body.id}`).send({ status: "refunded" });
    expect(invalid.status).toBe(422);
    expect(invalid.headers["content-type"]).toMatch(/application\/problem\+json/);
  });

  it("replays the same response for a repeated idempotency key", async () => {
    const a = await request(app).post("/v1/orders").set("Idempotency-Key", "k2").send({ customerId, items });
    const b = await request(app).post("/v1/orders").set("Idempotency-Key", "k2").send({ customerId, items });
    expect(b.body.id).toBe(a.body.id);
  });

  it("rejects an invalid body with a 422 problem", async () => {
    const res = await request(app).post("/v1/orders").send({ customerId: "nope", items: [] });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 422, instance: "/v1/orders" });
  });

  it("filters list results by status", async () => {
    const pending = await request(app).post("/v1/orders").send({ customerId, items });
    const paidOrder = await request(app).post("/v1/orders").send({ customerId, items });
    await request(app).patch(`/v1/orders/${paidOrder.body.id}`).send({ status: "paid" });

    const paid = await request(app).get("/v1/orders?status=paid");
    expect(paid.status).toBe(200);
    expect(paid.body.data).toHaveLength(1);
    expect(paid.body.data[0].id).toBe(paidOrder.body.id);

    const pendingOnly = await request(app).get("/v1/orders?status=pending");
    expect(pendingOnly.body.data.map((o: { id: string }) => o.id)).toEqual([pending.body.id]);
  });

  it("paginates with a cursor", async () => {
    for (let i = 0; i < 3; i++) await request(app).post("/v1/orders").send({ customerId, items });
    const first = await request(app).get("/v1/orders?limit=2");
    expect(first.body.data).toHaveLength(2);
    const second = await request(app).get(`/v1/orders?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it("returns 404 problem for an unknown order and 204 on delete", async () => {
    const missing = await request(app).get("/v1/orders/00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);
    const created = await request(app).post("/v1/orders").send({ customerId, items });
    const del = await request(app).delete(`/v1/orders/${created.body.id}`);
    expect(del.status).toBe(204);
  });
});
