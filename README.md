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

## Assignment 02: backlog items and the briefing gates

An item's slug is its task name. Two harness-owned files sit outside the model's reach (its paths are confined to the API directory):
- `docs/contracts/<slug>.md` is the problem statement: Problem, Owner, Metric (name, window, before/after), Scenario (WHEN … THEN …), Not included, and `Read:`, the command the harness runs to read the metric.
- `ledger/<slug>.jsonl` records the proposal, the stakeholder's typed reply, metric readings, the ship and the close.

```sh
./bin/harness propose --item <slug>                  # shows the contract; the stakeholder types name + reply at a terminal (piped input refused)
./bin/harness metric  --item <slug> --phase before   # harness runs the contract's Read command, writes the value into the contract
./bin/harness run     --task tasks/<slug>.yaml --driver claude
./bin/harness ship    --run <runId>                  # also requires the recorded yes and a before reading
./bin/harness metric  --item <slug> --phase after    # after a human merges the PR
./bin/harness close   --item <slug>                  # outcome check
```

| Gate | Blocks | Skip attempt that fails |
|---|---|---|
| `problem-gate` (pre hook on `write_file`/`edit_file`) | any edit until the contract has every field; names each missing field | edit a source file with no contract |
| `contract-gate` (pre hook on `finish`, re-checked by `ship`) | the Stop, until the ledger has a typed `human` yes after the latest proposal of the *current* contract (editing the contract voids the yes) | echo "yes" from a tool result and try to finish |
| `harness close` | closing, until the PR was merged by a non-bot and the harness read the metric before the merge and again after it, with both values in the contract | close without reading the metric |

Self-tests for each skip attempt: `npm test` → "briefing gates (skip attempts)".

### Python repos outside the harness

A task can govern a different git repo: `repo:` (path from the harness root) plus `stack: python`. The worktree and the `harness/<runId>` branch are created in that repo, and `ship` commits only the files the model wrote and opens the PR there. Run evidence (`runs/<runId>`, `tokens/<runId>.json`), the contract and the ledger stay in this repo. For Python tasks:
- `run_tests` runs pytest, using the repo's `.venv` if it has one.
- `observed-red` treats non-test `.py` files as source.
- `scope-guard` limits writes to the task's `writable:` globs and owns `pytest.ini`, `pyproject.toml`, `requirements*.txt` and `conftest.py`.
- `test-integrity` blocks pytest skip and xfail.
- The required checks are `py-compile` and `agent-rule-drift`. TypeScript checks don't run.

Backlog items against `Production_Category_AI_Calling_Codebase`. Ship them in this order, because the second item's CI gate would fail while the dead agent is still on main:
1. `retire-dxnqr56` ([task](tasks/retire-dxnqr56.yaml), [contract](docs/contracts/retire-dxnqr56.md)): metric "agent-rule gaps on origin/main", before **3**.
2. `agent-rule-drift` ([task](tasks/agent-rule-drift.yaml), [contract](docs/contracts/agent-rule-drift.md)): metric "agent-rule gate in main's CI", before **0**.

**Status (10 Nov):** both items have a contract and a before-value read by the harness from `origin/main` (`ledger/*.jsonl`). Neither has shipped: each waits on its stakeholder's typed yes, which the harness will not accept from anyone else. That is the human-yes gate working, not a gap in it.

Workflow map: [docs/workflow.md](docs/workflow.md). Learnings: [docs/learnings.md](docs/learnings.md).

**Honesty boundary for these gates.** The harness cannot verify *who* is at the terminal; it records the typed name and checks it against the contract Owner. Code the model writes runs under `run_tests` with the same filesystem access as the harness, so a hostile test could write the ledger directly. The ledger is plain JSONL, so that would be visible in review, but it is not prevented.

## Task files

These are stand-ins: the assignment PDF says a task file and a sample repo would be published, but only the PDF was distributed.
- [`tasks/users-api.yaml`](tasks/users-api.yaml) is the greenfield task. It builds `generated/users-api`.
- [`tasks/orders-status.yaml`](tasks/orders-status.yaml) is the brownfield task. It adds an order-status lifecycle to [`sample/orders-api`](sample/orders-api).

The task schema rejects unknown keys, so a task cannot name a model, provider or prompt format.

## Run evidence

The drivers were routed through OpenRouter (`anthropic/claude-opus-5.5`, `openai/gpt-5.5`). Every number below comes from the run's own `runs/<runId>/summary.json` and `tokens/<runId>.json`, on branch `harness/<runId>`.

| Run | Task | Driver | Turns | Standards | Tests | Token reduction (est.) | PR opened by `harness ship` |
|---|---|---|---|---|---|---|---|
| `users-api-claude-2` | greenfield | claude | 6 | 100% | 22/22 | 45.1% | [#1](https://github.com/Zeemal-Nadeem/ts-api-harness/pull/1) |
| `users-api-openai` | greenfield | openai | 18 | 100% | 6/6 | 49.2% | [#2](https://github.com/Zeemal-Nadeem/ts-api-harness/pull/2) |
| `orders-status-claude` | brownfield | claude | 6 | 100% (contract 10/10) | 13/13 | 59.0% | [#3](https://github.com/Zeemal-Nadeem/ts-api-harness/pull/3) |
| `orders-status-openai` | brownfield | openai | 31 | 100% (contract 10/10) | 10/10 | 62.6% | [#4](https://github.com/Zeemal-Nadeem/ts-api-harness/pull/4) |
| `users-api-claude` | greenfield | claude | 40 | 0% | — | 85.0% | not shippable (branch `harness/users-api-claude`) |

`users-api-claude` is the failed first run. It hit a compaction bug: file reads were dropped after two rounds and the model looped. The gates held, the run was scored 0% and is not shippable. It is kept as evidence; the fix is in `core/context.ts` and covered by `npm test`.

**Honest read on tokens:** the reductions are well below the 90% target. These runs are short, the stand-in API is small, and the models chose to fetch most scaffold files and standards, so the front-loaded baseline is not much larger than what they fetched anyway. The one long run (the failed 40-turn one) reached 85%. The figures are what the harness measured.
