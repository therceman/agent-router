# Example: Authorized Security Research

```bash
agent-router setup --provider codex --apply
cd /path/to/authorized/project
agent-router project register --profile security-research
agent-router plan import --id RESEARCH-PLAN-001 --author owner --file authorized-plan.md
```

Flow: authorized plan → Luna → Terra scout → Sol researcher → Terra evidence verification → Sol security review, with critical escalation only when required.
