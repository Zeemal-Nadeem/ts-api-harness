# rest-conventions
- Paths live under a version: `/v1/<plural-noun>`; collection nouns are plural lower-kebab (`/v1/users`, `/v1/order-items`).
- Item routes end in a param: `GET|PUT|PATCH|DELETE /v1/users/:id`.
- `POST` to a collection answers **201** with the created resource; `DELETE` answers **204** with no body (`res.status(204).end()`).
- Collection `GET` is cursor-paginated: parse `CursorQuery` (cursor, limit), return `paginate(items, query)` -> `{ data, nextCursor }` validated with `pageOf(Item)`.
- `POST` and `PATCH` routes include the `idempotency` middleware: `router.post("/", idempotency, async (req, res) => ...)`.
- Problems: 404 not found, 409 conflict (duplicates, invalid state transitions, idempotency key reuse), 422 validation.
- Success statuses: 200, 201, 202, 204 only.
