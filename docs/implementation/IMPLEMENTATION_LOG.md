# Agent Router v0.8.0 Implementation Log

## Persistent execution

Sessions are project-bound and keyed by role, provider model, reasoning,
repository, sandbox, approval policy, and compatibility metadata. A compatible
idle session returns `send_input`; stale sessions attempt `resume` when
supported, otherwise a fresh spawn is requested. Transport failures are
recorded and fail closed.

## Command-only worker API

Parent dispatch messages contain only the bounded command:

`Execute:\nagent-router work open|sync|reopen TASK --session SES`

Workers load authoritative task/context state through the CLI and return a
schema-valid result envelope. Task content is never transported through the
provider prompt.

## Revisions and migration

Task revision 1 is materialized for legacy v0.7 records. Immutable amendments
increment revisions and update the effective contract hash. Retry preserves
rejected evidence, records required changes, and creates a new assignment path.
The migration command is explicit, idempotent, backed up, and never guesses a
historical session assignment.

## Verification

The final quality gate passed with 88 tests. The 0.8.0 package installed from a
local tarball and reported version 0.8.0. Native provider reuse was not claimed
because no callable native sub-agent transport was exposed in this invocation;
the provider-neutral lifecycle simulation passed.
