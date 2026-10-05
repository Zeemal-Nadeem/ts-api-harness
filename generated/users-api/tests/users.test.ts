import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.ts";
import { resetIdempotency } from "../src/lib/idempotency.ts";
import { resetUsers } from "../src/store/users.ts";
import { User } from "../src/schemas/users.ts";

const app = createApp();

function expectProblem(res: request.Response, status: number): void {
  expect(res.status).toBe(status);
  expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
  expect(res.body.status).toBe(status);
  expect(typeof res.body.type).toBe("string");
  expect(typeof res.body.title).toBe("string");
  expect(typeof res.body.detail).toBe("string");
  expect(typeof res.body.instance).toBe("string");
}

async function createUser(body: Record<string, unknown>) {
  const res = await request(app).post("/v1/users").send(body);
  expect(res.status).toBe(201);
  return User.parse(res.body);
}

beforeEach(() => {
  resetUsers();
  resetIdempotency();
});

describe("POST /v1/users", () => {
  it("creates a user with default role", async () => {
    const res = await request(app).post("/v1/users").send({ email: "a@example.com", name: "Alice" });
    expect(res.status).toBe(201);
    const user = User.parse(res.body);
    expect(user.role).toBe("member");
    expect(user.email).toBe("a@example.com");
    expect(user.createdAt).toBe(user.updatedAt);
  });

  it("rejects duplicate email case-insensitively with 409", async () => {
    await createUser({ email: "a@example.com", name: "Alice" });
    const res = await request(app).post("/v1/users").send({ email: "A@Example.com", name: "Other" });
    expectProblem(res, 409);
  });

  it("rejects invalid body with 422", async () => {
    expectProblem(await request(app).post("/v1/users").send({ email: "nope", name: "A" }), 422);
    expectProblem(await request(app).post("/v1/users").send({ email: "a@example.com", name: "" }), 422);
    expectProblem(await request(app).post("/v1/users").send({ email: "a@example.com", name: "x".repeat(101) }), 422);
    expectProblem(await request(app).post("/v1/users").send({ email: "a@example.com", name: "A", role: "owner" }), 422);
    expectProblem(await request(app).post("/v1/users").send([]), 422);
  });

  it("ignores client-supplied id", async () => {
    const res = await request(app)
      .post("/v1/users")
      .send({ email: "a@example.com", name: "A", id: "00000000-0000-4000-8000-000000000000" });
    expect([201, 422]).toContain(res.status);
    if (res.status === 201) expect(User.parse(res.body).id).not.toBe("00000000-0000-4000-8000-000000000000");
  });

  it("replays with same Idempotency-Key and body", async () => {
    const body = { email: "a@example.com", name: "Alice" };
    const first = await request(app).post("/v1/users").set("Idempotency-Key", "k1").send(body);
    const second = await request(app).post("/v1/users").set("Idempotency-Key", "k1").send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const list = await request(app).get("/v1/users");
    expect(list.body.data).toHaveLength(1);
  });

  it("409s on Idempotency-Key reuse with different body", async () => {
    await request(app).post("/v1/users").set("Idempotency-Key", "k1").send({ email: "a@example.com", name: "A" });
    const res = await request(app).post("/v1/users").set("Idempotency-Key", "k1").send({ email: "b@example.com", name: "B" });
    expectProblem(res, 409);
  });
});

describe("GET /v1/users", () => {
  it("paginates with cursor", async () => {
    for (let i = 0; i < 5; i++) await createUser({ email: `u${i}@example.com`, name: `U${i}` });
    const p1 = await request(app).get("/v1/users?limit=2");
    expect(p1.status).toBe(200);
    expect(p1.body.data).toHaveLength(2);
    expect(typeof p1.body.nextCursor).toBe("string");
    const p2 = await request(app).get(`/v1/users?limit=2&cursor=${String(p1.body.nextCursor)}`);
    expect(p2.body.data).toHaveLength(2);
    const p3 = await request(app).get(`/v1/users?limit=2&cursor=${String(p2.body.nextCursor)}`);
    expect(p3.body.data).toHaveLength(1);
    expect(p3.body.nextCursor).toBeNull();
  });

  it("defaults limit to 20", async () => {
    for (let i = 0; i < 25; i++) await createUser({ email: `u${i}@example.com`, name: `U${i}` });
    const res = await request(app).get("/v1/users");
    expect(res.body.data).toHaveLength(20);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it("filters by role", async () => {
    await createUser({ email: "a@example.com", name: "A", role: "admin" });
    await createUser({ email: "b@example.com", name: "B" });
    const res = await request(app).get("/v1/users?role=admin");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].role).toBe("admin");
  });

  it("rejects bad limit and role with 422", async () => {
    expectProblem(await request(app).get("/v1/users?limit=-1"), 422);
    expectProblem(await request(app).get("/v1/users?limit=0"), 422);
    expectProblem(await request(app).get("/v1/users?limit=101"), 422);
    expectProblem(await request(app).get("/v1/users?role=owner"), 422);
  });

  it("rejects unknown cursor with 422", async () => {
    expectProblem(await request(app).get("/v1/users?cursor=bogus"), 422);
  });
});

describe("GET /v1/users/:id", () => {
  it("returns a user", async () => {
    const u = await createUser({ email: "a@example.com", name: "A" });
    const res = await request(app).get(`/v1/users/${u.id}`);
    expect(res.status).toBe(200);
    expect(User.parse(res.body)).toEqual(u);
  });

  it("404s on unknown id", async () => {
    expectProblem(await request(app).get("/v1/users/00000000-0000-4000-8000-000000000000"), 404);
  });

  it("422s on malformed id", async () => {
    expectProblem(await request(app).get("/v1/users/not-a-uuid"), 422);
  });
});

describe("PATCH /v1/users/:id", () => {
  it("partially updates", async () => {
    const u = await createUser({ email: "a@example.com", name: "A" });
    await new Promise((r) => setTimeout(r, 5));
    const res = await request(app).patch(`/v1/users/${u.id}`).send({ name: "Alicia", role: "viewer" });
    expect(res.status).toBe(200);
    const updated = User.parse(res.body);
    expect(updated.name).toBe("Alicia");
    expect(updated.role).toBe("viewer");
    expect(updated.email).toBe("a@example.com");
    expect(updated.createdAt).toBe(u.createdAt);
    expect(updated.updatedAt).not.toBe(u.updatedAt);
  });

  it("updates email and allows own email in different case", async () => {
    const u = await createUser({ email: "a@example.com", name: "A" });
    const res = await request(app).patch(`/v1/users/${u.id}`).send({ email: "A@example.com" });
    expect(res.status).toBe(200);
    expect(User.parse(res.body).email).toBe("A@example.com");
  });

  it("409s on email clash", async () => {
    await createUser({ email: "a@example.com", name: "A" });
    const b = await createUser({ email: "b@example.com", name: "B" });
    expectProblem(await request(app).patch(`/v1/users/${b.id}`).send({ email: "A@EXAMPLE.COM" }), 409);
  });

  it("422s on invalid body and malformed id, 404s on unknown id", async () => {
    const u = await createUser({ email: "a@example.com", name: "A" });
    expectProblem(await request(app).patch(`/v1/users/${u.id}`).send({ role: "owner" }), 422);
    expectProblem(await request(app).patch(`/v1/users/${u.id}`).send({ name: "" }), 422);
    expectProblem(await request(app).patch("/v1/users/bad").send({ name: "X" }), 422);
    expectProblem(await request(app).patch("/v1/users/00000000-0000-4000-8000-000000000000").send({ name: "X" }), 404);
  });

  it("replays with same Idempotency-Key", async () => {
    const u = await createUser({ email: "a@example.com", name: "A" });
    const first = await request(app).patch(`/v1/users/${u.id}`).set("Idempotency-Key", "p1").send({ name: "B" });
    const second = await request(app).patch(`/v1/users/${u.id}`).set("Idempotency-Key", "p1").send({ name: "B" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});

describe("DELETE /v1/users/:id", () => {
  it("deletes then 404s", async () => {
    const u = await createUser({ email: "a@example.com", name: "A" });
    const res = await request(app).delete(`/v1/users/${u.id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expectProblem(await request(app).get(`/v1/users/${u.id}`), 404);
    expectProblem(await request(app).delete(`/v1/users/${u.id}`), 404);
  });

  it("422s on malformed id", async () => {
    expectProblem(await request(app).delete("/v1/users/bad"), 422);
  });
});

describe("unknown routes", () => {
  it("404 problem", async () => {
    expectProblem(await request(app).get("/v1/nope"), 404);
  });
});
