# zod-boundary
Every route handler parses its inputs and output with Zod; types are inferred, never hand-written.
- `req.params`, `req.query`, `req.body` may only appear as the direct argument of `Schema.parse(...)` / `safeParse(...)`.
- A path with `:param` must parse `req.params`; POST/PUT/PATCH must parse `req.body`; a collection GET must parse `req.query`.
- Every `res.json(x)` / `res.send(x)` payload is `ResponseSchema.parse(x)`.
- No `interface X {}` or `type X = { ... }` in src/. Use `export type X = z.infer<typeof X>`.
Example:
```ts
usersRouter.get("/:id", async (req, res) => {
  const { id } = UserParams.parse(req.params);
  const user = getUser(id);
  if (user === undefined) throw new HttpProblem(404, "User not found", `No user with id ${id}`);
  res.status(200).json(User.parse(user));
});
```
