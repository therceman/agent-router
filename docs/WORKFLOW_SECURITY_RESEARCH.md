# Authorized Security Research Workflow

Use profile: `security-research` only for explicitly authorized pentest, bug-bounty, lab, or defensive research scope.

```text
authorized scope + plan
→ Luna-low orchestration
→ Terra-low scout
→ Sol-high security researcher
→ Terra-high evidence/verifier gate
→ Sol-high security reviewer
→ optional Sol-xhigh critical escalation
```

This profile does not reuse development completion semantics. Research tasks may cover attack surface, reachability, attacker control, root cause, impact, duplicate risk, and safe bounded verification.

```bash
agent-router project register --profile security-research
agent-router plan import --id RESEARCH-PLAN-001 --author owner --file authorized-plan.md
agent-router task create \
  --id RESEARCH-001 \
  --title "Analyze authorized surface" \
  --objective "Stay inside the recorded authorization" \
  --kind security_research \
  --plan RESEARCH-PLAN-001 \
  --allow path/in/authorized/scope.py
```

Destructive or irreversible decisions escalate to the critical reviewer. The default research review is Terra evidence verification followed by Sol security review.
