# Example: Development

```bash
agent-router setup --provider codex --apply
cd /path/to/project
agent-router project register --profile development
codex --profile agent-router
```

Flow: external specification → Luna → Luna-xhigh bounded implementation / Terra-high escalation → Luna mechanical gate → external review.

For each dispatched task, run `agent-router session acquire --task TASK-ID --json` and transport only its exact `work open` command. Compatible idle workers are reused within policy limits.
