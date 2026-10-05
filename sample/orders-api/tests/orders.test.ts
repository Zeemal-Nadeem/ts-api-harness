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
  it("creates an order with 201 and computes the total", async () => {
    const res = await request(app).post("/v1/orders").set("Idempotency-Key", "k1").send({ customerId, items });
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(2500);
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

describe("order status lifecycle", () => {
  const unknownId = "00000000-0000-4000-8000-000000000000";
  const create = async () => (await request(app).post("/v1/orders").send({ customerId, items })).body;

  it("new orders start as pending", async () => {
    const order = await create();
    expect(order.status).toBe("pending");
    const fetched = await request(app).get(`/v1/orders/${order.id}`);
    expect(fetched.body.status).toBe("pending");
  });

  it("transitions pending -> paid -> shipped with 200", async () => {
    const order = await create();
    const paid = await request(app).patch(`/v1/orders/${order.id}`).send({ status: "paid" });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ id: order.id, status: "paid", totalCents: 2500 });
    const shipped = await request(app).patch(`/v1/orders/${order.id}`).send({ status: "shipped" });
    expect(shipped.status).toBe(200);
    expect(shipped.body.status).toBe("shipped");
  });

  it("allows pending -> cancelled and paid -> cancelled", async () => {
    const a = await create();
    expect((await request(app).patch(`/v1/orders/${a.id}`).send({ status: "cancelled" })).status).toBe(200);
    const b = await create();
    await request(app).patch(`/v1/orders/${b.id}`).send({ status: "paid" });
    const res = await request(app).patch(`/v1/orders/${b.id}`).send({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("rejects disallowed transitions with a 409 problem", async () => {
    const order = await create();
    const skip = await request(app).patch(`/v1/orders/${order.id}`).send({ status: "shipped" });
    expect(skip.status).toBe(409);
    expect(skip.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(skip.body).toMatchObject({ status: 409, instance: `/v1/orders/${order.id}` });
    const same = await request(app).patch(`/v1/orders/${order.id}`).send({ status: "pending" });
    expect(same.status).toBe(409);
    await request(app).patch(`/v1/orders/${order.id}`).send({ status: "cancelled" });
    const fromCancelled = await request(app).patch(`/v1/orders/${order.id}`).send({ status: "paid" });
    expect(fromCancelled.status).toBe(409);
  });

  it("returns 404 problem for an unknown id", async () => {
    const res = await request(app).patch(`/v1/orders/${unknownId}`).send({ status: "paid" });
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
  });

  it("returns 422 problem for an invalid status", async () => {
    const order = await create();
    const res = await request(app).patch(`/v1/orders/${order.id}`).send({ status: "lost" });
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    const empty = await request(app).patch(`/v1/orders/${order.id}`).send({});
    expect(empty.status).toBe(422);
  });

  it("honours Idempotency-Key on PATCH", async () => {
    const order = await create();
    const a = await request(app).patch(`/v1/orders/${order.id}`).set("Idempotency-Key", "p1").send({ status: "paid" });
    const b = await request(app).patch(`/v1/orders/${order.id}`).set("Idempotency-Key", "p1").send({ status: "paid" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const reuse = await request(app).patch(`/v1/orders/${order.id}`).set("Idempotency-Key", "p1").send({ status: "cancelled" });
    expect(reuse.status).toBe(409);
  });

  it("filters the collection by status", async () => {
    const a = await create();
    await create();
    await request(app).patch(`/v1/orders/${a.id}`).send({ status: "paid" });
    const paid = await request(app).get("/v1/orders?status=paid");
    expect(paid.status).toBe(200);
    expect(paid.body.data).toHaveLength(1);
    expect(paid.body.data[0].id).toBe(a.id);
    const pending = await request(app).get("/v1/orders?status=pending");
    expect(pending.body.data).toHaveLength(1);
    const all = await request(app).get("/v1/orders");
    expect(all.body.data).toHaveLength(2);
    const bad = await request(app).get("/v1/orders?status=lost");
    expect(bad.status).toBe(422);
  });
});
