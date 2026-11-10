# agent-rule-drift — Production_Category_AI_Calling_Codebase
Problem: Fixes to the 15 Retell agents are copied by hand into each agents/ folder and have landed partially: on 27 Oct the extract_user_details fix reached the LMS agent only (e491652) and needed a second commit (9680f09) for the other 14, while calls showed "No Extracted Dynamic Variables". At that point metrics/agent-rule-drift.py counts 32 gaps; today it counts 0, but nothing stops the next partial fix from merging.
Owner: Hamza Rasheed
Metric: agent-rule gate present in main's CI (1 present / 0 absent), per push   before: 0   after: ____
Scenario: WHEN a PR adds the extract_user_details rule to one agent's prompt.json but not the others THEN the agent-rules gauntlet gate fails and names each agent missing it
Scenario: WHEN an HR agent's prompt.json quotes a price such as $39 THEN the gate fails naming that agent and hr-no-pricing
Scenario: WHEN an agents/ folder is not listed in lookup.json THEN the gate fails naming the folder
Scenario: WHEN every agent carries every rule THEN the gate passes
Not included: changing any agent prompt or config; new rules beyond the three already fixed by hand; checking post-call scoring fields; deploying agents
Read: git -C ../../Production_Category_AI_Calling_Codebase fetch -q origin main && git -C ../../Production_Category_AI_Calling_Codebase show origin/main:gauntlet.yaml | grep -c check_agent_rules || true
Signed: ____
