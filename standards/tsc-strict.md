# tsc-strict
- `tsc --noEmit` passes with `strict` and `noUncheckedIndexedAccess` (tsconfig.json is harness-owned).
- No `any`, no non-null assertions (`x!`), no `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` in src/ or tests/.
- Indexed access returns `T | undefined`: check it (`if (x === undefined) throw new HttpProblem(404, ...)`).
- In tests, read response bodies through a schema or narrow them; `res.body` from supertest is already `any`-typed by the library, which is allowed, but do not write `any` yourself.
