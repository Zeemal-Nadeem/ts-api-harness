# ts-api-harness

A harness (not an agent) that governs TypeScript REST API work. It drives a model through a provider-neutral driver, wraps every tool call in blocking hooks, fetches context just in time, and only stops when deterministic checks say the API is done. The harness ships the change; the model never touches git.

Design note: [docs/design.md](docs/design.md).

## Setup (one command)

```sh
npm run setup            # npm ci  (Node >= 22)
```

Provider keys come from the environment only: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Optional model overrides: `HARNESS_CLAUDE_MODEL` (default `claude-opus-5-5`), `HARNESS_CLAUDE_EFFORT` (default `high`), `HARNESS_OPENAI_MODEL` (default `gpt-5.5`).

## Commands

```sh
./bin/harness run   --task tasks/users-api.yaml     --driver claude     # greenfield
./bin/harness run   --task tasks/users-api.yaml     --driver openai     # same task, other provider
./bin/harness run   --task tasks/orders-status.yaml --driver claude     # brownfield change to sample/orders-api
./bin/harness run   --task <task> --driver <id> --baseline              # measurement run: no JIT, no compaction
./bin/harness check --api ./generated/users-api                         # standards report, exit 0 only at 100%
./bin/harness ship  --run <runId> [--dry-run] [--base main]             # re-prove gates, commit, push branch, open PR
./bin/harness tokens <runId>                                            # token summary
./bin/harness plugins                                                   # what the registry discovered
npm test                                                                # offline self-tests (replay driver)
```

Each run happens in its own git worktree, `.harness/worktrees/<runId>`, on the branch `harness/<runId>`. The run writes:

| Evidence | Where (on the run's branch) |
|---|---|
| Console log, transcript, hook decisions | `runs/<runId>/console.log`, `transcript.jsonl`, `hooks.log` |
| Standards report (one line per rule per file + verdict) | `runs/<runId>/standards.txt`, `standards.json` |
| Final test run by the harness runner | `runs/<runId>/tests.txt`, raw logs in `runs/<runId>/logs/` |
| Token report: baseline vs actual input tokens per turn | `tokens/<runId>.json` |
| The API itself | `generated/users-api/` or `sample/orders-api/` |

`harness ship` commits exactly those paths, pushes the feature branch and opens the PR. Merging the PR is the human sign-off.

## Core directory: `core/`

**`core/` is the engine and must stay untouched when you extend the harness.** Everything else is discovered by folder:

| To add a… | Drop one file in | Example to copy |
|---|---|---|
| Tool | `plugins/tools/` | `examples/extensions/openapi-diff.ts` |
| ORM validator | `plugins/checks/` (`category: "orm"`) | `examples/extensions/orm-explicit-select.ts` |
| Linter rule | `plugins/checks/` (`category: "lint"`) | `examples/extensions/no-console.ts` |
| Hook | `plugins/hooks/` | `plugins/hooks/test-integrity.ts` |
| Model provider | `drivers/` | `drivers/openai.ts` |

```sh
cp examples/extensions/openapi-diff.ts       plugins/tools/
cp examples/extensions/orm-explicit-select.ts plugins/checks/
cp examples/extensions/no-console.ts          plugins/checks/
./bin/harness plugins && ./bin/harness check --api sample/orders-api   # new lines appear
git diff --stat                                                          # only plugins/ changed
```

There is no registry manifest to edit. A plugin file's default export (one plugin, or an array of them) is its registration. Files starting with `_` are helpers and are not loaded.

## Standards enforced (each is a check with a pass rate)

| Check | What it proves |
|---|---|
| `zod-boundary` | Per handler: params, query and body are only read through `Schema.parse()`, and every response payload goes through `Schema.parse()`. Hand-written `interface`/object `type`s in `src/` fail. |
| `problem-json` | Static: one module emits `application/problem+json` with type, title, status, detail and instance; there are no ad-hoc `res.status(4xx)` or `{ error }` responses. Runtime: the check boots the app and probes an unknown route, invalid bodies, unknown ids and bad pagination. |
| `tsc-strict` | `strict` and `noUncheckedIndexedAccess` are set, `tsc --noEmit` reports 0 errors, and there is no `any`, `!` or `@ts-ignore` in `src/` or `tests/`. |
| `rest-conventions` | `/v1/` base path, plural collection nouns, item routes ending in `/:param`, POST answering 201, DELETE answering 204, cursor-paginated lists, idempotency middleware on POST and PATCH, and only agreed status codes. |
| `contract-compat` (own addition) | Brownfield changes cannot break existing clients. |

## Own addition: the contract drift gate

sf-harness gates *how* code is written (test first, standards). It does not gate *what the change does to existing clients*. When a brownfield run starts, the harness takes a pristine copy of the API. `contract-compat` then compares every route and the JSON Schema of every exported Zod schema before and after the change. The change is refused at finish and at ship if any of these happen:
- a route, schema or field disappears;
- a field changes type or format;
- an enum loses a value;
- a request schema gains a required field;
- a response stops guaranteeing a field.

The only way past it is an explicit `allowBreaking: true` in the task file, which a reviewer can see.

Two smaller gates also come from this harness:
- `test-integrity` blocks `.skip`, `.only` and `.todo`, and blocks test files with no assertions.
- `scope-guard` stops the model from loosening `tsconfig.json` or `package.json`.

## Task files

These are stand-ins: the assignment PDF says a task file and a sample repo would be published, but only the PDF was distributed.
- [`tasks/users-api.yaml`](tasks/users-api.yaml) is the greenfield task. It builds `generated/users-api`.
- [`tasks/orders-status.yaml`](tasks/orders-status.yaml) is the brownfield task. It adds an order-status lifecycle to [`sample/orders-api`](sample/orders-api).

The task schema rejects unknown keys, so a task cannot name a model, provider or prompt format.

## Status of the evidence

| Item | Status |
|---|---|
| Harness, gates, checks, extension examples | Done; covered by `npm test` (offline replay driver) |
| Standards on `sample/orders-api` | 100% (`./bin/harness check --api sample/orders-api`) |
| Runs with `--driver claude` / `--driver openai` | **UNPROVEN until run with real keys.** Logs and token reports land on the run branches. |
| PR opened by the harness | **UNPROVEN until `harness ship` runs against a repo with an `origin` remote.** |
