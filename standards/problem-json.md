# problem-json (RFC 7807)
Every non-2xx response is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`.
- Throw `new HttpProblem(status, title, detail)` from `src/lib/problem.ts`; the error middleware renders it.
- ZodError -> 422 automatically. Unknown routes -> 404 automatically.
- Never `res.status(4xx).json(...)`, `res.sendStatus(4xx)` or `{ error: "..." }` in handlers.
- The check also boots the app and probes: unknown route (404), invalid body `[]` (422), unknown id (404/422), `?limit=-1` (422).
```
HTTP/1.1 422  Content-Type: application/problem+json
{"type":"https://api.sf/problems/validation","title":"Request failed validation","status":422,"detail":"email: Invalid email","instance":"/v1/users"}
```
