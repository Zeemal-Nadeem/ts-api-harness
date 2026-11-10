# retire-dxnqr56 — Production_Category_AI_Calling_Codebase
Problem: agents/Fedora_Medical_AWS_DXNQR56 is still on main but is unmapped in lookup.json and missed the 27 Oct fixes, so it is the source of all 3 agent-rule gaps on origin/main (metrics/agent-rule-drift.py on 10 Nov). Its deletion exists only as an uncommitted change in a local checkout, so main keeps the dead agent and any CI gate on agent rules would fail on it.
Owner: Hamza Rasheed
Metric: agent-rule gaps on origin/main, per push   before: 3   after: ____
Scenario: WHEN an agents/ folder is not in lookup.json THEN tests/test_agent_registry.py fails naming the folder
Scenario: WHEN the change is merged THEN agents/Fedora_Medical_AWS_DXNQR56 no longer exists on main and the drift count on main is 0
Scenario: WHEN the change is merged THEN no other agent's prompt.json, config.json, config_llm.json or lead.json differs from before
Not included: deleting the agent in Retell itself; changing any live agent; the agent-rules CI gate (item agent-rule-drift)
Read: d=$(mktemp -d) && git -C ../../Production_Category_AI_Calling_Codebase fetch -q origin main && git -C ../../Production_Category_AI_Calling_Codebase archive origin/main agents lookup.json | tar -x -C "$d" && python3 metrics/agent-rule-drift.py "$d" 2>/dev/null
Signed: ____
