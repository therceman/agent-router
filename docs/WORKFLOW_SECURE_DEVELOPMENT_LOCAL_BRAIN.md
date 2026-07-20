# Secure Development with Local Sol Brain

Use profile: `secure-development-local-brain`.

Local Sol replaces external ChatGPT only for architecture planning. The execution path remains cost-controlled.

```text
local Sol-high architect
→ stored bounded plan
→ Luna-low orchestration
→ Luna-xhigh default implementation / Terra-high escalation
→ Luna mechanical gate
→ Terra-high correctness verifier
→ separate Sol-high security reviewer
→ done
```

Create or import the plan:

```bash
agent-router plan create \
  --id PLAN-LOCAL-001 \
  --title "Architecture plan" \
  --author local-sol \
  --content "<bounded plan returned by the architect agent>"
```

Then reference it with `--plan PLAN-LOCAL-001` when creating implementation tasks.

The architect and security reviewer are separate bounded Sol invocations. Luna-xhigh writes bounded code by default; Terra-high handles escalation and verifies correctness.
