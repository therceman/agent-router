# State transactions

0.8.1 records multi-file lifecycle changes in
`~/.agent-router/projects/<project-id>/transactions/<transaction-id>/`.
Each journal records the operation, before/after SHA-256 values, staged data,
and backups. Staged writes are renamed into place only after the journal is
durable.

Inspect without changing state:

```bash
agent-router state transactions --pending --json
agent-router state recover --check --json
```

Apply recovery only after reviewing the journal:

```bash
agent-router state recover --apply --json
```

Prepared transactions roll back. Committing transactions are completed only
when every target is still at its recorded before-state or already at its
recorded after-state. If an operator changed a target in the meantime, the
journal remains `recovery_required` and no data is overwritten.

Task state transitions use the journal. Fault-injection coverage exercises
prepared, staged, rename, and recovery paths; the provider and session layers
continue to preserve append-only event and history records around those
transitions.
