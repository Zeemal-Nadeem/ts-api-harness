import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { resetIdempotency } from "../src/lib/idempotency.ts";
import { resetUsers } from "../src/store/users.ts";

const app = createApp();

beforeEach(() => {
  resetUsers();
  resetIdempotency();
});

describe("users API", () => {
  it("creates a user with defaults and rejects duplicate emails case-insensitively", async () => {
    const created = await request(app)
      .post("/v1/users")
      .send({ email: "Ada@example.com", name: "Ada Lovelace" })
      .expect(201);

    expect(created.body).toMatchObject({
      email: "Ada@example.com",
      name: "Ada Lovelace",
      role: "member",
    });
    expect(created.body.id).toEqual(expect.any(String));
    expect(created.body.createdAt).toEqual(expect.any(String));
    expect(created.body.updatedAt).toEqual(expect.any(String));

    const duplicate = await request(app)
      .post("/v1/users")
      .send({ email: "ada@EXAMPLE.com", name: "Another Ada" })
      .expect(409);

    expect(duplicate.headers["content-type"]).toContain("application/problem+json");
    expect(duplicate.body).toMatchObject({ status: 409, title: "Email already exists" });
  });

  it("returns 422 problem details for invalid create bodies", async () => {
    const response = await request(app)
      .post("/v1/users")
      .send({ email: "not-an-email", name: "" })
      .expect(422);

    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).toMatchObject({
      type: "https://api.sf/problems/validation",
      title: "Request failed validation",
      status: 422,
      instance: "/v1/users",
    });
    expect(response.body.detail).toContain("email");
    expect(response.body.detail).toContain("name");
  });

  it("lists users with role filtering and cursor pagination", async () => {
    const admin = await request(app)
      .post("/v1/users")
      .send({ email: "admin@example.com", name: "Admin", role: "admin" })
      .expect(201);
    await request(app)
      .post("/v1/users")
      .send({ email: "member@example.com", name: "Member", role: "member" })
      .expect(201);
    const viewer = await request(app)
      .post("/v1/users")
      .send({ email: "viewer@example.com", name: "Viewer", role: "viewer" })
      .expect(201);

    const firstPage = await request(app).get("/v1/users?limit=1").expect(200);
    expect(firstPage.body).toMatchObject({
      data: [admin.body],
    });
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get(`/v1/users?limit=1&cursor=${firstPage.body.nextCursor}`)
      .expect(200);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.data[0].email).toBe("member@example.com");

    const viewers = await request(app).get("/v1/users?role=viewer").expect(200);
    expect(viewers.body).toEqual({ data: [viewer.body], nextCursor: null });
  });

  it("gets users by id and reports malformed or unknown ids", async () => {
    const created = await request(app)
      .post("/v1/users")
      .send({ email: "get@example.com", name: "Get Me" })
      .expect(201);

    const found = await request(app).get(`/v1/users/${created.body.id}`).expect(200);
    expect(found.body).toEqual(created.body);

    await request(app).get("/v1/users/not-a-uuid").expect(422);
    await request(app).get("/v1/users/00000000-0000-4000-8000-000000000000").expect(404);
  });

  it("patches users, detects email clashes, and deletes users", async () => {
    const first = await request(app)
      .post("/v1/users")
      .send({ email: "first@example.com", name: "First" })
      .expect(201);
    await request(app)
      .post("/v1/users")
      .send({ email: "second@example.com", name: "Second" })
      .expect(201);

    const patched = await request(app)
      .patch(`/v1/users/${first.body.id}`)
      .send({ email: "renamed@example.com", name: "Renamed", role: "admin" })
      .expect(200);

    expect(patched.body).toMatchObject({
      id: first.body.id,
      email: "renamed@example.com",
      name: "Renamed",
      role: "admin",
      createdAt: first.body.createdAt,
    });
    expect(new Date(patched.body.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.body.updatedAt).getTime());

    const clash = await request(app)
      .patch(`/v1/users/${first.body.id}`)
      .send({ email: "SECOND@example.com" })
      .expect(409);
    expect(clash.headers["content-type"]).toContain("application/problem+json");

    await request(app).delete(`/v1/users/${first.body.id}`).expect(204);
    await request(app).get(`/v1/users/${first.body.id}`).expect(404);
    await request(app).delete(`/v1/users/${first.body.id}`).expect(404);
  });

  it("honours Idempotency-Key for POST and PATCH", async () => {
    const firstCreate = await request(app)
      .post("/v1/users")
      .set("Idempotency-Key", "create-key")
      .send({ email: "idem@example.com", name: "Idem" })
      .expect(201);
    const replayCreate = await request(app)
      .post("/v1/users")
      .set("Idempotency-Key", "create-key")
      .send({ email: "idem@example.com", name: "Idem" })
      .expect(201);
    expect(replayCreate.body).toEqual(firstCreate.body);

    await request(app)
      .post("/v1/users")
      .set("Idempotency-Key", "create-key")
      .send({ email: "different@example.com", name: "Different" })
      .expect(409);

    const firstPatch = await request(app)
      .patch(`/v1/users/${firstCreate.body.id}`)
      .set("Idempotency-Key", "patch-key")
      .send({ name: "Patched Once" })
      .expect(200);
    const replayPatch = await request(app)
      .patch(`/v1/users/${firstCreate.body.id}`)
      .set("Idempotency-Key", "patch-key")
      .send({ name: "Patched Once" })
      .expect(200);
    expect(replayPatch.body).toEqual(firstPatch.body);
  });
});
