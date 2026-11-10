#!/usr/bin/env python3
"""Metric for item agent-rule-drift: how many (agent, required rule) pairs are missing.

Each rule is a fix that was once applied to every agent by hand. Prints the count on
stdout (the harness reads the first number) and each gap on stderr.

usage: agent-rule-drift.py <path to Production_Category_AI_Calling_Codebase>
"""
import json
import re
import sys
from pathlib import Path


def text(p: Path) -> str:
    return p.read_text(encoding="utf-8") if p.exists() else ""


# rule id -> (applies to agent folder?, file, passes?)  — each traced to the commit that first fixed it
RULES = {
    # 9680f09: extract_user_details was never invoked, so calls extracted no variables
    "extract-before-ending": (lambda a: True, "prompt.json",
                              lambda s: "priority_0_extract_before_ending" in s and "extract_user_details" in s),
    # ff83f22: email copied as spelled out ("Z-I-M dash ...") instead of written form
    "email-written-form": (lambda a: True, "config_llm.json",
                           lambda s: re.search(r'"name":\s*"email"[^}]*written form', s) is not None),
    # 2549565: HR agents quoted Paychex/ADP prices that put prospects off
    "hr-no-pricing": (lambda a: "_HR_" in a, "prompt.json",
                      lambda s: "NEVER quote" in s and re.search(r"\$\s?\d", s) is None),
}


def main(repo: Path) -> int:
    agents = sorted(p.name for p in (repo / "agents").iterdir() if p.is_dir())
    registered = set(json.loads(text(repo / "lookup.json") or "{}"))
    gaps = []
    for agent in agents:
        for rule, (applies, file, ok) in RULES.items():
            if applies(agent) and not ok(text(repo / "agents" / agent / file)):
                gaps.append(f"{agent}: {rule} ({file})")
    for agent in sorted(registered - set(agents)):
        gaps.append(f"{agent}: in lookup.json but no agents/ folder")
    for agent in sorted(set(agents) - registered):
        gaps.append(f"{agent}: agents/ folder not in lookup.json")
    for g in gaps:
        print(g, file=sys.stderr)
    print(len(gaps))
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("../Production_Category_AI_Calling_Codebase")))
