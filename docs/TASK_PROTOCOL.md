# Task Protocol

Agent Router uses CLI-managed canonical records. Agents do not move, rename, delete, or directly edit files under `~/.agent-router/projects/`.

## Canonical storage

Tasks are stored outside the work repository:

```text
~/.agent-router/projects/<project-id>/
  tasks/
    draft/<task-id>.json
    ready/<task-id>.json
    active/<task-id>.json
    review/<task-id>.json
    blocked/<task-id>.json
    done/<task-id>.json
    cancelled/<task-id>.json
  contexts/<task-id>.json
  handoffs/<task-id>.json
  reviews/<task-id>/<role>.json
  generated/<task-id>.route.json
  events/events.jsonl
```

The lifecycle directory is the broad phase. The `state` field inside the task record is the exact state.

Legacy JSON-formatted `*.yaml` task records from v0.4 are migrated to `*.json` on first read. If both legacy and current records exist, Agent Router fails closed instead of choosing one.

## State machine

```text
draft
  → ready
  → routed
  → context_ready
  → dispatched
  → in_progress
  → worker_complete
  → review_pending
  → accepted
  → done
```

Alternative states:

```text
blocked
rejected
cancelled
superseded
```

Worker completion is never equivalent to acceptance.

## CLI-only lifecycle

```bash
agent-router task create ...
agent-router task activate TASK-ID
agent-router task route TASK-ID
agent-router context build TASK-ID
agent-router task dispatch TASK-ID
agent-router task start TASK-ID
agent-router handoff complete TASK-ID --file worker-result.json
agent-router review import TASK-ID review.json
agent-router task accept TASK-ID
```

Every command validates the transition, updates the canonical record, moves it to the correct lifecycle directory when necessary, and appends an event to `events/events.jsonl`.

Direct filesystem operations such as `mv`, `rm`, or manual state edits are unsupported and prohibited for agents.

## Retry

Use retry only after a task enters `blocked` or `rejected`:

```bash
agent-router task retry TASK-ID
```

The command returns the task to `ready`, removes stale route/context/handoff/review artifacts, and preserves the append-only event history.

## Supersede

Replace an obsolete task with another existing active task:

```bash
agent-router task supersede OLD-TASK --by REPLACEMENT-TASK
```

The old task moves to `superseded` and records `superseded_by`. Self-reference, missing replacements, completed replacements, and already terminal source tasks fail closed.

## Plans

Secure-development and security-research profiles require a plan for implementation or research tasks:

```bash
agent-router plan import --id PLAN-001 --author external-chatgpt --file plan.md
agent-router plan create --id PLAN-002 --title "Local plan" --author local-sol --content "..."
```

## Handoff

Workers should write their result to a temporary JSON file outside Agent Router state, then use the CLI:

```bash
agent-router handoff create TASK-ID --file worker-result.json
agent-router handoff complete TASK-ID
```

Or import and complete in one command:

```bash
agent-router handoff complete TASK-ID --file worker-result.json
```

`handoff create` validates and stores the record without changing task state. `handoff complete` validates the canonical handoff and advances `dispatched` or `in_progress` to `worker_complete`.

A valid handoff reports:

- files read and changed;
- targeted test commands and exit codes;
- manual checks;
- budget consumption;
- risks and unresolved questions;
- recommended next action.

Out-of-scope changes, failing tests, failed manual checks, main-session authorship, forbidden broad scans, and inconsistent budget counts fail closed.

## Review gate

A task cannot move directly from `worker_complete` to `done`:

```text
worker_complete → review_pending → accepted → done
```

All required review records must exist, be accepted, and appear in the configured order before `agent-router task accept` succeeds.

In 0.8.0, a dispatched task is assigned through `agent-router session acquire`.
The worker receives only the generated `work open` or `work reopen` command.
Task amendments are immutable and increment the task revision; an acknowledged
worker must use `work sync` before completing against a newer revision.
