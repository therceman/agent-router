# Persistent role sessions

Agent Router 0.8.1 records reusable Codex worker sessions under the registered
project state root. A session is bound to one project, repository, role, model,
reasoning level, sandbox, and approval policy. It can own only one active task.

`agent-router session acquire` returns `spawn` for a new worker and
`send_input` for a compatible idle worker. Provider actions are performed by
the Codex main session; Agent Router records confirmation and failure. Sessions
are retired after task, failure, rejection, idle, or fresh-session limits.

Provider resume support is recorded as `true`, `false`, or `unknown`. An
unsupported or failed resume retires the old session and returns the next task
to a fresh spawn path. No cross-project or cross-role reuse is permitted.

Assignments are phase-aware. Local review assignments use their own
revision-bound route and context; external review is represented as an
explicit handoff result without creating a local session. Session transport
state and work state are monotonic, so a late confirmation cannot downgrade an
acknowledged or completed assignment.

Session and assignment records, locks, append-only events, and histories live
under `~/.agent-router/projects/<project-id>/`; the work repository remains
unchanged. Persistent sessions reduce repeated startup and context loading, but
may accumulate conversational context, which is why bounded leases and
retirement policy remain mandatory.

Retirement queues a provider close action under `provider-actions/pending/`.
The queue is drained by explicit provider commands and is safe to retry.
