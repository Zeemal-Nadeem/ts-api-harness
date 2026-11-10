# Workflow — Zeemal Nadeem

<!-- DRAFT, built from my git history in Production_Category_AI_Calling_Codebase. Each line cites
its evidence. TODO(Zeemal): correct anything that is not how I work before submitting. -->

## How work reaches me
- Assignments and priorities from Hamza Rasheed by email (e.g. the 30 Oct harness assignment).
- Review feedback on agent behaviour from Laiba (35ee3ec "from Laiba's review"; `laiba_fixes.json`, 28 Oct).
- Production symptoms in call results: "No Extracted Dynamic Variables" (e491652), emails captured as spelled out (ff83f22), HR agents quoting prices (2549565).
- TODO: which of these I act on first.

## Where I lose time
- Applying one fix by hand to every agent folder: ff83f22 touched 15 `config_llm.json`, 9680f09 14 `prompt.json`, 35ee3ec 15 `config.json`.
- Doing a fix twice because the first pass reached one agent only (e491652 on 27 Oct, then 9680f09 the same day for the other 14).
- My checkout drifting from `main`: an agent deletion sat uncommitted locally while `main` still had the folder.

## What I repeat
- Copy the same rule into each `agents/<name>/prompt.json` or config.
- Conventional-commit messages (`fix(agents): …`), AI-assisted (Co-Authored-By on most commits).
- Check that `agents/` and `lookup.json` agree after adding or removing an agent (642a9c0, 2abb24a).

## What breaks
- **A fix lands in some agents and not others** (made twice: e491652 → 9680f09; the retired DXNQR56 agent missed both 27 Oct fixes). → `agent-rule-drift` check.
- **A registry file points at a missing agent, or an agent is unmapped** (2abb24a had to clean this up; DXNQR56 is unmapped on main). → `agent-rule-drift` check + item `retire-dxnqr56`.
- **"Done" measured on my local copy, not on main.** → metrics read from `origin/main` by the harness (`Read:` lines), never from my checkout.

## The three backlog items
- `agent-rule-drift` — owner: Hamza Rasheed — metric: agent-rule gate present in main's CI (0/1), per push
- `retire-dxnqr56` — owner: Hamza Rasheed (TODO: confirm who asked for the removal) — metric: agent-rule gaps on origin/main, per push (before: 3)
- TODO third item — owner: <who> — metric: <what, window>. Candidate: Laiba's pending post-call fixes, once she confirms what is still pending after 35ee3ec.

## Gate by gate
| Habit or failure | Mechanism | File |
|---|---|---|
| problem statement before any edit | hook (pre write/edit/delete) | `plugins/hooks/problem-gate.ts` |
| stakeholder yes, typed, after the proposal | hook (pre finish) + ship gate | `plugins/hooks/contract-gate.ts`, `core/ship.ts` |
| metric read before close, by the harness | check (`harness close`) | `core/items.ts` (`closeItem`) |
| scenarios fetched when needed, not front-loaded | context tool | `plugins/tools/contract.ts` |
| a fix lands in one agent but not the others | check (required, python) | `plugins/checks/agent-rule-drift.ts`, `metrics/agent-rule-drift.py` |
| registry points at a missing agent / agent unmapped | same check | `metrics/agent-rule-drift.py` |
| "done" measured locally instead of on main | contract `Read:` runs against `origin/main` | `docs/contracts/*.md`, `core/items.ts` (`readMetric`) |
| a syntax error in a Lambda handler ships | check (required, python) | `plugins/checks/py-compile.ts` |
| work happens in the production calling repo, not a sample | task `repo:` + `stack: python` | `core/workspace.ts`, `tasks/*.yaml` |
| deleting a failing test to go green | hook | `plugins/hooks/test-integrity.ts` |
