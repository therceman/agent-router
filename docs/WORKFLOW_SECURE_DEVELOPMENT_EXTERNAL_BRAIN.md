# Secure Development with External Brain

Use profile: `secure-development-external-brain`.

This is a development workflow with enhanced security review. It is not pentesting.

```text
ChatGPT/owner plan
→ Luna-low orchestration
→ Luna-xhigh default implementation / Terra-high escalation
→ Luna mechanical gate
→ Terra-high ordinary code verifier
→ Sol-high focused security reviewer
→ done
```

The task must reference an imported plan:

```bash
agent-router plan import \
  --id PLAN-001 \
  --author external-chatgpt \
  --file /path/to/plan.md
```

Terra verification happens before Sol security review. Sol receives a compact security pack containing only relevant code snippets, changed files, diff, route, test evidence, handoff, and prior review.

```bash
agent-router review pack TASK-ID --purpose security
```

Sol should focus on trust boundaries, authorization, injection, unsafe defaults, filesystem/network effects, secret handling, and missing negative tests. It is not used for routine style or general implementation review.
