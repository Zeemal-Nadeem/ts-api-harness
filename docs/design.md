# Design note

## 1. Architecture

```
 task.yaml ──► engine (core/engine.ts) ──────────────────────────────────────────┐
                │ prepareWorkspace: git worktree on harness/<runId>, scaffold or   │
                │ pristine "before" copy                                           │
                ▼                                                                  │
   ┌── turn ── driver.turn({system, messages, tools})  ◄── render(history)         │
   │            │ (neutral types only)                    compaction + elision     │
   │            ▼                                                                  │
   │   for each tool call:                                                         │
   │     zod-validate args ─► PRE hooks ─► tool ─► POST hooks ─► compact result    │
   │                          block│record│pass                                     │
   └── until finish-gate accepts, or the turn budget runs out ──────────────────────┘
                ▼
   final verdict recomputed by the harness: standards + test run → runs/<id>/, tokens/<id>.json
                ▼
   harness ship: re-prove every gate → commit on feature branch → push → gh pr create
```

**What is deterministic (code):** the workspace and branch, scaffolding, test runs (`run_tests`, the harness's own Vitest runner, whose results are the only evidence of red or green), type checks, all standards checks including a runtime HTTP probe, the contract diff, compaction, the token accounting, and git and PR handling.

**What the model decides:** how to break the task down, the test cases, the schemas, handlers and store code, and when to ask to finish.

**The four gates:**

| Gate | Hook | Rule |
|---|---|---|
| Observed red | `plugins/hooks/observed-red.ts` | A `src/` file is refused until a mapped test has been seen failing by `run_tests` in this run. |
| Scope | `plugins/hooks/scope-guard.ts` | Writes are limited to `src/` and `tests/`; `tsconfig.json` and `package.json` are harness-owned. |
| Finish | `plugins/hooks/finish-gate.ts` | `finish` is refused unless a fresh test run passes, the standards verdict is 100%, and red was observed. |
| Ship | `core/ship.ts` | It re-proves all of the above plus: the branch is a feature branch, the diff has no secrets or `.env` files, and the run is not a baseline. UNPROVEN counts as not green. |

A hook that throws fails closed, and the call is blocked.

## 2. Driver abstraction

```ts
interface Driver { id: string; model: string; turn(req: TurnRequest): Promise<TurnResult> }
TurnRequest = { system: string; messages: Message[]; tools: ToolSpec[] }   // ToolSpec.parameters is plain JSON Schema
TurnResult  = { text; calls: {id,name,args}[]; stop: "tool"|"end"|"length"|"refused"; usage; opaque? }
```

Tools are defined once as Zod schemas and exported to neutral JSON Schema with `z.toJSONSchema`. Each driver translates to its own wire format:
- `drivers/claude.ts` produces `tool_use`/`tool_result` blocks.
- `drivers/openai.ts` produces `function` tool calls and `role: "tool"` messages.

**Refused leaks:**
- Task files are schema-validated with unknown keys rejected, so they cannot carry a model, provider, prompt format or tool schema.
- Hooks and checks only ever see neutral `HookEvent`/`ApiContext` values.
- Provider features stay inside the driver. These are reasoning blocks, server-side refusal fallbacks and prompt caching.
- Reasoning blocks travel in the `opaque` field, which the engine never reads.

The Claude driver replays only the latest turn's reasoning, with `prefix_mismatch_behavior: "drop_block"`, because compaction edits older turns. Switching providers is `--driver openai` instead of `--driver claude`; nothing else changes. A third driver, `replay`, plays a JSON script for offline tests. It is labelled as not a model.

## 3. Token budget

**The actual run sends:**
- a ~230-token system prompt (rules plus the names of the checks);
- the task brief with a file index (paths only);
- ~600 tokens of tool schemas.

Everything else is fetched when needed: `read_file` (ranged, at most 250 lines per call), `search`, `list_files`, and `get_standard` (one rule's text).

**Mechanisms behind the reduction:**
1. **JIT fetchers.** No source or standards text is front-loaded.
2. **Compact tool returns.** Tests return `PASS n files` or a list of failing tests with one-line reasons. Checks return the summary plus failing locations. Raw logs go to `runs/<id>/logs/` and are referenced by path.
3. **Compaction by kind.**
   - Volatile results (tests, checks, search) older than two rounds become one-line summaries; a test summary keeps the failing test names.
   - Fetched knowledge (`read_file`, `get_standard`) stays verbatim until it is superseded or 15 rounds old. A newer read of the same range or a write to the file supersedes it.
   - A repeat of a fetch whose result is still in context returns "unchanged" instead of re-sending it.
   - A stall guard nudges once after six turns without writing or testing.
   - Why: the first real run compacted file reads after two rounds, which left the model re-reading the same files until its 40-turn budget ran out. That run is kept as `harness/users-api-claude`.
4. **Write elision.** Large `write_file`/`edit_file` arguments are elided from every assistant turn except the latest, since the content is on disk.

**Measurement (`tokens/<runId>.json`).** On every turn the harness serialises the request it actually sent. In shadow, it also serialises the request a harness without fetchers or compaction would have sent for the same conversation: the whole API source and every standard front-loaded, raw tool output, nothing compacted. Both columns use the same chars/4 estimator, so the ratio is apples to apples. The provider-reported input tokens for the real request are recorded next to them. `--baseline` performs that no-JIT run for real, so the shadow figure can be checked against provider-reported numbers.

**Measured so far (offline replay scripts, not models):**

| Run | Turns | Baseline (est.) | Actual (est.) | Reduction |
|---|---|---|---|---|
| orders-status (brownfield) | 10 | 76,129 | 20,164 | 73.5% |
| users-api (greenfield) | 5 | 24,790 | 9,053 | 63.5% |

These runs are short and the stand-in API is small. The actual side has a fixed floor of about 1.1k tokens per turn while the baseline grows every turn, so the ratio rises with run length and repository size. Real-provider numbers are written to `tokens/` by the runs themselves; the README does not quote any number the harness has not produced.

## 4. Extension points

`core/registry.ts` imports every `.ts` file in `drivers/`, `plugins/tools/`, `plugins/hooks/` and `plugins/checks/` and registers the default export by its `kind`. There is no manifest and no core edit.
- A new check is automatically part of `harness check`, `run_checks`, the finish gate and ship. A check sets `required: false` to be advisory.
- A check can carry `doc` text, which `get_standard` serves just in time.
- A new tool appears in the next run's tool list for both providers.

**Core is `core/`.** `test/harness.test.ts` proves extensibility by copying the three examples into a fresh copy of the harness and asserting they register and report without any change to `core/`.

## 5. Honesty boundary

**Proven by the harness, on every run:**
- The standards verdict, recomputed after the loop ends.
- Test pass or fail from its own runner.
- That red was observed before source edits.
- That the contract is unchanged (brownfield).
- That the shipped diff contains no secret-like tokens.

**Skipped or unproven, and reported as such:**
- A check that cannot run (tsc timeout, an app that will not boot for the probe, no routes) is `UNPROVEN`, which never counts toward the verdict.
- Push and PR are `UNPROVEN` when there is no `origin` remote or `gh` fails.
- The contract gate is `n/a` for greenfield work.

**What the checks do not prove:**
- Business correctness beyond the tests the model wrote.
- Test quality. `test-integrity` only blocks skips and assertion-free files.
- Security, performance, concurrency, and persistence: the stand-in APIs use in-memory stores.
- The static checks also assume the conventional Express shapes: `router.<method>("/path", ..., handler)` and `app.use("/v1/x", router)`. Unusual code shapes fall outside them, and the runtime probe is the backstop.

**What a human still verifies:**
- That the tests express the behaviour that was asked for.
- Whether any `allowBreaking: true` is justified.
- The PR, before merging.
