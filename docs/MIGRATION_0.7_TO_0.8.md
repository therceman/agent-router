# Migration from 0.7.0 to 0.8.0

Run `agent-router migrate --check` for an inspection-only plan, then
`agent-router migrate --apply` from a registered repository. Existing tasks
become revision 1 records with an effective contract hash. Existing handoffs,
reviews, and event history remain in place. Dispatched or in-progress legacy
tasks are marked `legacy_unassigned`; Agent Router never guesses a provider
session or agent ID for them. Reconcile or explicitly recover those tasks
before assigning new work.

Migration adds the session policy and state directories under
`~/.agent-router`. It does not write to the work repository, and repeated runs
are idempotent. Modified Agent Router files receive backups; use the reported
backup paths for rollback if required.
