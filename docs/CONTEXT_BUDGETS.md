# Context Budgets

Default limits:

```text
maximum files          12
maximum total bytes    150000
maximum single file    50000
maximum tool output    16000 characters
```

Broad scans, archives, binaries, dependencies, generated files, Git-ignored files, and recursive delegation are disabled by default.

The context builder resolves real paths and rejects traversal or symlink escape. Contexts are stored under `~/.agent-router`, not in the work repository.
