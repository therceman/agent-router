# Migration from 0.8.0 to 0.8.1

The 0.8.1 migration is explicit and home-state-only. Reads such as `status`,
`doctor`, `task show`, and `migrate --check` do not rename, rewrite, or delete
legacy records.

Inspect first:

```bash
agent-router migrate --from 0.8.0 --to 0.8.1 --check --json
```

Apply only after reviewing the plan:

```bash
agent-router migrate --from 0.8.0 --to 0.8.1 --apply --json
```

The migration creates 0.8.1 state directories, adds the session/assignment
phase fields, upgrades legacy assignment records, and migrates JSON task data
stored in `.yaml` paths to canonical `.json` paths. Existing records are
backed up before rewriting. No work-repository files are modified.

Mutating task, context, handoff, review, amendment, and worker commands fail
closed with the migration command when a legacy task is encountered. Ambiguous
duplicate `.yaml`/`.json` records remain untouched and must be resolved by the
owner.
