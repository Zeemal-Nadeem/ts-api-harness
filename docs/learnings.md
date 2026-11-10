# Learnings — Assignment 02

<!-- Interim, 10 Nov: written before any backlog item has shipped. Update after each item closes. -->

## What the harness caught
- **The dead agent on main.** Running the drift metric against `origin/main` found 3 gaps, all in `Fedora_Medical_AWS_DXNQR56`: unmapped in `lookup.json`, and it missed both 27 Oct fixes. My local checkout showed 0 because the folder was deleted there and never committed. That became item `retire-dxnqr56`.
- **Item order.** `agent-rule-drift` adds a CI gate that would fail on main while DXNQR56 exists. The harness's own required `agent-rule-drift` check refuses that item's finish until the dead agent is gone, so `retire-dxnqr56` has to ship first.

## What it got wrong
- The contract parser split the metric on its first comma, so `(0 = absent, 1 = present)` became part of the time window. I reworded the metric. The parser still assumes no comma in a metric name.
- My first drift reading (0) came from my working copy, not `main`. Every `Read:` line now fetches `origin/main` first.
- The model had no way to delete a file, so retiring an agent was impossible through the harness. Added `delete_file`. `test-integrity` now blocks deleting a test file.

## What I removed
- The original item 1 ("fix drift in every agent"): nothing was left to fix in my checkout, so it was reframed as a CI gate.
- The pristine pre-change copy for Python runs: it only fed `contract-compat`, which is TypeScript-only.
- Laiba's post-call fixes as an item: `35ee3ec` already applied part of her review, and only she can say what is still pending.

## What I would add next
- A metric for agent-rule-drift that measures prevention (partial fixes blocked per month), not just gate presence.
- Read the ledger's integrity from git (commit each ledger line) so a test process cannot rewrite it unseen.
- TODO after shipping: what the gates refused during the real runs, and whether any refusal was wrong.
