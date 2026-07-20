# Development Workflow

Use profile: `development`.

This is the cheapest normal workflow. ChatGPT or the owner supplies the specification and can perform the final external review.

```text
external specification
→ Luna-low main
→ Luna-xhigh default implementation / Terra-high escalation
→ Luna exact declared tests + mechanical validation
→ external review pack
→ external reviewer
→ done
```

Luna may validate exit codes, changed-file scope, handoff fields, budget use, diff statistics, and secret scans. It must not rewrite code or claim semantic code review.

Setup and registration:

```bash
agent-router setup --provider codex --apply
cd /path/to/project
agent-router project register --profile development
```

A normal task does not require a stored plan, although one may be imported.
