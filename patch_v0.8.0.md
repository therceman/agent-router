# Agent Router v0.8.0 Implementation Patch Specification
## Persistent Role Sessions, Command-Only Dispatch, Task Revisions, and Worker-Scoped CLI

You are modifying the Agent Router repository.

Current release:
0.7.0

Target release:
0.8.0

Treat this specification as authoritative.

The primary objective is to reduce repeated sub-agent startup and prompt cost while preserving deterministic routing, bounded context, role authorization, zero-footprint storage, review isolation, and fail-closed task execution.

The patch introduces:

1. persistent reusable sub-agent sessions;
2. one active task per session;
3. command-only parent-to-sub-agent dispatch;
4. worker-scoped Agent Router CLI commands;
5. immutable task amendments and monotonic revisions;
6. session assignment, lease, retirement, and recovery logic;
7. role-specific completion handling;
8. provider capability reporting and native Codex-tool orchestration contracts;
9. token-efficiency and session-reuse metrics;
10. migration from v0.7.0 state.

The final architecture must preserve this separation:

```text
Agent Router CLI
  = control plane, state, policy, lifecycle, validation

Codex main session
  = invokes native sub-agent tools

Codex sub-agent session
  = executor for one role and one task at a time

Prompt transport
  = exact Agent Router CLI command only

~/.agent-router/
  = canonical task, session, assignment, context, handoff, review, and event state

work repository
  = project source and tests only
````

Agent Router must not integrate `airelay`.

Agent Router must not call OpenAI APIs directly.

Agent Router must not implement its own daemon or background process.

---

# 1. Non-negotiable invariants

The implementation must enforce all invariants below.

## 1.1 Command-only dispatch

Sub-agent transport carries an Agent Router CLI invocation, never task content.

Allowed parent-to-agent message:

```text
Execute:
agent-router work open TASK-045 --session SES-01ABC
```

Allowed update message:

```text
Execute:
agent-router work sync TASK-045 --session SES-01ABC
```

Allowed retry message:

```text
Execute:
agent-router work reopen TASK-045 --session SES-02XYZ
```

The parent must not include:

* task objective;
* acceptance criteria;
* repository paths;
* source excerpts;
* test commands;
* amendments;
* review findings;
* required changes;
* architecture guidance;
* internal Agent Router state paths;
* implementation hints;
* copied context bundles.

The Agent Router-generated dispatch message is authoritative and must be copied exactly.

There must be no fallback that sends a long natural-language task prompt when Agent Router CLI fails.

Failure behavior:

```text
CLI unavailable or assignment invalid
→ stop
→ report blocker
→ do not send task content manually
```

## 1.2 Persistent but bounded sessions

Compatible sessions remain available after successful task completion.

They must not be treated as immortal.

A persistent session is reusable only while it remains compatible, healthy, authorized, within policy limits, and idle.

## 1.3 One task per session

A session may have at most one active assignment.

Two tasks must never be active concurrently in one sub-agent session.

## 1.4 No cross-project reuse

A session created for one project must never be reused for another project.

## 1.5 No cross-role reuse

A session created for one role must never be reused for another role.

Examples:

```text
implementation_worker
!= verifier

architect
!= security_reviewer

security_researcher
!= implementation_worker
```

## 1.6 Current canonical state overrides session memory

A persistent agent may remember earlier work, but that memory is not authoritative.

The current task revision loaded through Agent Router CLI overrides:

* prior prompts;
* prior task revisions;
* remembered acceptance criteria;
* remembered file scope;
* remembered review feedback;
* previous session history.

## 1.7 Project profile remains the authorization boundary

A globally installed role is not automatically authorized for every project.

Every session acquisition, task assignment, work open, work sync, completion, review, and manual override must validate the current project profile.

## 1.8 Zero footprint remains mandatory

Agent Router must not create or modify project-local framework state.

Forbidden work-repository changes include:

```text
.agent-router/
.codex/
Agent Router state inside AGENTS.md
AGENTS.override.md
.gitignore changes for Agent Router state
.git/info/exclude changes for Agent Router state
task records
session records
assignment records
context records
handoff records
review records
amendment records
```

All Agent Router state remains under `~/.agent-router`.

All Codex integration remains under `~/.codex`.

## 1.9 Native Codex tools remain outside Agent Router CLI

Agent Router CLI must not pretend to directly invoke:

```text
spawn_agent
send_input
resume_agent
close_agent
wait
```

The Luna main session invokes those provider-native tools.

Agent Router:

* chooses the required action;
* records state;
* returns the exact dispatch command;
* receives action success/failure confirmation;
* reconciles state;
* validates completion.

---

# 2. Target runtime flow

## 2.1 First task for a role

```text
task ready
→ route
→ context build
→ task dispatch
→ session acquire
→ action = spawn
→ Luna invokes spawn_agent
→ sub-agent receives exact work-open CLI command
→ work open
→ task in_progress
→ implementation/review/research
→ work complete
→ canonical result written
→ task worker_complete/review_pending
→ session idle
```

## 2.2 Next compatible task

```text
new task dispatched
→ session acquire
→ compatible idle session found
→ action = send_input
→ Luna invokes send_input
→ same provider agent receives new work-open command
→ work open
→ work complete
→ session idle
```

## 2.3 Parent session restarted

```text
new Luna main session
→ session acquire
→ persistent provider agent is recorded
→ attempt send_input or resume according to capability/state
→ provider action succeeds
    → continue
→ provider action fails
    → report failure through Agent Router CLI
    → mark session stale
    → attempt resume where supported
→ resume fails
    → retire old session
    → spawn replacement
```

Cross-parent resume must never be assumed without evidence.

## 2.4 Rejected implementation

```text
implementation completes
→ reviewer rejects
→ task retry authorized
→ immutable retry amendment created
→ task revision increments
→ old implementation session retired
→ implementation tier escalates to Terra-high
→ new escalation session acquired
→ work reopen
```

The rejected Luna implementation session must not receive the Terra escalation task.

---

# 3. Required external state layout

Extend each registered project state root.

Expected structure:

```text
~/.agent-router/projects/<project-id>/
  project.yaml
  policy.yaml

  tasks/
    draft/
    ready/
    active/
    review/
    blocked/
    done/
    cancelled/
    amendments/
      TASK-045/
        0002.json
        0003.json

  contexts/
    TASK-045.json

  generated/
    TASK-045.route.json

  handoffs/
    TASK-045.json

  reviews/
    TASK-045/
      verifier.json
      security_reviewer.json

  sessions/
    active/
      SES-01ABC.json
    retired/
      SES-00OLD.json
    events.jsonl

  assignments/
    active/
      TASK-045.json
    history/
      TASK-045/
        0001.json
        0002.json

  locks/
    session-state.lock
    task-TASK-045.lock

  events/
    events.jsonl
```

Exact naming may follow existing project conventions, but the following must remain separate:

* task state;
* task amendment history;
* session records;
* task-to-session assignment records;
* session lifecycle events;
* task lifecycle events.

Do not store provider session data in work-repository files.

---

# 4. Canonical identifiers

Use strict opaque identifiers.

## 4.1 Session ID

Format:

```text
SES-<ULID-or-equivalent>
```

Example:

```text
SES-01K2ABCDEF1234567890
```

Requirements:

* globally unique enough for local state;
* filesystem-safe;
* non-sequential where practical;
* validated before use;
* maximum bounded length.

## 4.2 Assignment ID

Format:

```text
ASN-<ULID-or-equivalent>
```

Each task assignment attempt receives a separate assignment ID.

A retry must not reuse the previous assignment ID.

## 4.3 Amendment revision

Task revisions are monotonically increasing integers:

```text
1
2
3
```

Amendment filename:

```text
0002.json
0003.json
```

No revision may be overwritten.

---

# 5. Session record schema

Add:

```text
schemas/session.schema.json
```

Canonical TypeScript shape:

```ts
type SessionStatus =
  | 'pending_spawn'
  | 'idle'
  | 'reserved'
  | 'busy'
  | 'stale'
  | 'retiring'
  | 'retired'
  | 'failed';

interface SessionRecord {
  schema_version: 1;

  session_id: string;
  project_id: string;

  provider: 'codex';
  provider_agent_id?: string;

  role: RoleId;

  model_class: 'cheap' | 'balanced' | 'expert';
  provider_model: string;
  reasoning: 'low' | 'medium' | 'high' | 'xhigh';

  repository_root: string;
  sandbox_mode: 'read-only' | 'workspace-write';
  approval_policy: string;

  status: SessionStatus;

  current_assignment_id?: string;
  assigned_task?: string;
  assigned_revision?: number;
  acknowledged_revision?: number;

  compatibility_key: string;

  tasks_completed: number;
  failed_tasks: number;
  rejected_tasks: number;

  created_at: string;
  updated_at: string;
  last_used_at: string;
  idle_since?: string;

  lease_expires_at?: string;

  retire_reason?: SessionRetireReason;
  retired_at?: string;

  last_transport_action?: 'spawn' | 'send_input' | 'resume';
  last_transport_result?: 'pending' | 'succeeded' | 'failed';
  last_transport_error?: string;
}
```

Allowed retire reasons:

```ts
type SessionRetireReason =
  | 'explicit'
  | 'task_limit'
  | 'failure_limit'
  | 'idle_timeout'
  | 'implementation_rejected'
  | 'scope_violation'
  | 'handoff_validation_failed'
  | 'model_changed'
  | 'reasoning_changed'
  | 'role_changed'
  | 'repository_changed'
  | 'sandbox_changed'
  | 'approval_policy_changed'
  | 'provider_agent_unavailable'
  | 'resume_failed'
  | 'session_corrupt'
  | 'project_unbound'
  | 'project_ejected'
  | 'campaign_complete'
  | 'critical_freshness_policy';
```

Schema requirements:

* `additionalProperties: false`;
* strict enum validation;
* ISO-8601 timestamps;
* non-negative counters;
* active assignment fields required for `reserved` and `busy`;
* active assignment fields absent for `idle`;
* `provider_agent_id` required for reusable `idle` sessions;
* `retire_reason` and `retired_at` required for `retired`;
* repository path must be absolute and normalized;
* session role must be a canonical local role;
* external reviewer must not be a session role.

---

# 6. Assignment record schema

Add:

```text
schemas/assignment.schema.json
```

Canonical TypeScript shape:

```ts
type AssignmentStatus =
  | 'pending_transport'
  | 'transport_confirmed'
  | 'acknowledged'
  | 'completed'
  | 'blocked'
  | 'relinquished'
  | 'stale'
  | 'cancelled';

interface AssignmentRecord {
  schema_version: 1;

  assignment_id: string;
  project_id: string;

  task_id: string;
  task_revision: number;

  session_id: string;
  role: RoleId;

  route_sha256: string;
  context_sha256: string;

  transport_action: 'spawn' | 'send_input' | 'resume';
  provider_agent_id?: string;

  dispatch_command: string;
  dispatch_message: string;

  status: AssignmentStatus;

  created_at: string;
  updated_at: string;

  transport_confirmed_at?: string;
  acknowledged_at?: string;
  completed_at?: string;

  failure_code?: string;
  failure_detail?: string;
}
```

Requirements:

* one active assignment per task;
* one active assignment per session;
* assignment revision must match the task revision at acquisition;
* role must match route role;
* route/context hashes must match current canonical files;
* dispatch message must be generated by Agent Router;
* assignment history must be retained after completion or retirement;
* completed assignments are immutable.

Canonical dispatch command:

```text
agent-router work open TASK-045 --session SES-01ABC
```

Canonical dispatch message:

```text
Execute:
agent-router work open TASK-045 --session SES-01ABC
```

Do not add objective, paths, or other task information.

---

# 7. Task schema v2

Upgrade the canonical task schema to version 2.

Add:

```ts
interface TaskRevision {
  revision: number;
  previous_revision: number | null;
  latest_amendment_id?: string;
  effective_contract_sha256: string;
}
```

TaskRecord additions:

```ts
interface TaskRecordV2 {
  schema_version: 2;

  // existing fields...

  revision: number;
  previous_revision: number | null;
  latest_amendment_id?: string;
  effective_contract_sha256: string;

  last_assignment_id?: string;
  last_session_id?: string;
}
```

Requirements:

* new tasks begin at revision `1`;
* revision must be a positive integer;
* `previous_revision` is `null` for revision 1;
* every amendment increments revision by exactly 1;
* task completion must use the current revision;
* stale worker completion must fail;
* `effective_contract_sha256` must change whenever the effective task contract changes;
* assignment metadata must not be treated as authorization without the active assignment record.

Do not rewrite historical task event records.

---

# 8. Task amendment schema

Add:

```text
schemas/task-amendment.schema.json
```

Canonical shape:

```ts
interface TaskAmendmentRecord {
  schema_version: 1;

  amendment_id: string;
  task_id: string;

  from_revision: number;
  to_revision: number;

  amendment_kind:
    | 'owner_change'
    | 'scope_change'
    | 'acceptance_change'
    | 'test_change'
    | 'review_feedback'
    | 'retry'
    | 'clarification';

  source:
    | 'owner'
    | 'external_chatgpt'
    | 'main'
    | 'verifier'
    | 'security_reviewer'
    | 'critical_reviewer'
    | 'system';

  changes: {
    objective?: string;

    allowed_paths_add?: string[];
    allowed_paths_remove?: string[];

    forbidden_paths_add?: string[];
    forbidden_paths_remove?: string[];

    acceptance_add?: string[];
    acceptance_remove?: string[];

    targeted_tests_add?: string[];
    targeted_tests_remove?: string[];

    checkpoint_tests_add?: string[];
    checkpoint_tests_remove?: string[];

    manual_verification_add?: string[];
    manual_verification_remove?: string[];

    review_feedback?: string[];
    required_changes?: string[];
    notes?: string[];
  };

  source_review_role?: string;
  source_review_sha256?: string;

  previous_contract_sha256: string;
  resulting_contract_sha256: string;

  created_at: string;
}
```

Rules:

* immutable after creation;
* filename revision must match `to_revision`;
* `to_revision = from_revision + 1`;
* exact-string removal only;
* removing a missing value must fail unless explicit idempotent mode exists;
* duplicate additions must normalize or fail deterministically;
* relative project paths only;
* internal Agent Router paths forbidden;
* no empty amendment;
* amendment creation and task revision update must be atomic;
* prior amendment files must never be rewritten.

---

# 9. Session policy schema

Add or extend project policy with:

```ts
interface SessionPolicy {
  enabled: true;

  maximum_tasks_per_session: number;
  maximum_failed_tasks: number;
  maximum_rejected_tasks: number;
  maximum_idle_minutes: number;

  retire_after_implementation_rejection: boolean;

  reuse_across_projects: false;
  reuse_across_roles: false;

  maximum_parallel_tasks_per_session: 1;

  overflow_sessions:
    enabled: boolean;
    maximum_per_role: number;
    persistent: false;

  role_policies: Partial<Record<RoleId, {
    persistent: boolean;
    maximum_tasks_per_session?: number;
    maximum_idle_minutes?: number;
    fresh_session_required?: boolean;
  }>>;
}
```

Default project policy:

```json
{
  "enabled": true,
  "maximum_tasks_per_session": 8,
  "maximum_failed_tasks": 1,
  "maximum_rejected_tasks": 1,
  "maximum_idle_minutes": 120,
  "retire_after_implementation_rejection": true,
  "reuse_across_projects": false,
  "reuse_across_roles": false,
  "maximum_parallel_tasks_per_session": 1,
  "overflow_sessions": {
    "enabled": false,
    "maximum_per_role": 1,
    "persistent": false
  },
  "role_policies": {
    "repo_janitor": {
      "persistent": false,
      "fresh_session_required": true
    },
    "critical_reviewer": {
      "persistent": false,
      "fresh_session_required": true
    },
    "scout": {
      "persistent": true,
      "maximum_tasks_per_session": 4,
      "maximum_idle_minutes": 60
    },
    "implementation_escalation_worker": {
      "persistent": true,
      "maximum_tasks_per_session": 2
    }
  }
}
```

Main is not managed as a child session pool role.

External reviewer is not a local session role.

Profile authorization remains independent of session persistence policy.

---

# 10. Session compatibility key

Create one authoritative compatibility-key builder.

Input:

```text
project_id
role
provider
provider_model
reasoning
repository_root
sandbox_mode
approval_policy
```

Canonical serialization must be deterministic.

Output:

```text
sha256(canonical-json)
```

A session is reusable only when:

* status is `idle`;
* provider agent ID exists;
* compatibility key matches;
* task and route authorize the role;
* session is within task/failure/rejection limits;
* idle timeout has not expired;
* session is not stale;
* session is not marked fresh-only;
* no current assignment exists.

Do not duplicate compatibility logic in CLI, session manager, doctor, and tests.

Use one authoritative helper.

---

# 11. Project-scoped locking

Session acquisition and assignment must be concurrency-safe.

Implement a zero-dependency filesystem lock using atomic creation, for example:

```text
fs.open(path, 'wx')
```

Required lock scopes:

```text
project session-state lock
task-specific assignment lock
```

Requirements:

* bounded wait;
* clear timeout error;
* stale-lock detection;
* lock metadata includes PID, timestamp, command, project ID;
* lock is removed in `finally`;
* malformed stale locks fail safely;
* concurrent acquire calls cannot assign one idle session twice;
* concurrent acquire calls cannot create two active assignments for one task.

Do not add a runtime dependency only for locking.

---

# 12. Session state machine

Allowed transitions:

```text
pending_spawn
  → reserved
  → busy
  → stale
  → retiring
  → retired
  → failed

idle
  → reserved
  → retiring
  → retired
  → stale

reserved
  → busy
  → idle
  → stale
  → retiring

busy
  → idle
  → stale
  → retiring
  → failed

stale
  → reserved
  → retiring
  → retired
  → failed

retiring
  → retired
  → failed
```

Disallowed examples:

```text
retired → idle
retired → busy
busy → busy for another task
idle → completed
```

Every transition must:

1. validate source and destination;
2. update timestamps;
3. atomically persist session record;
4. append session event;
5. update related assignment where needed;
6. never silently discard an assignment.

---

# 13. Session event schema

Add:

```text
schemas/session-event.schema.json
```

Event examples:

```text
session_created
session_reserved
transport_requested
transport_confirmed
transport_failed
work_acknowledged
session_released
session_reused
session_resume_requested
session_resume_failed
session_marked_stale
session_retiring
session_retired
session_reconciled
```

Canonical event shape:

```ts
interface SessionEventRecord {
  schema_version: 1;
  event_id: string;

  project_id: string;
  session_id: string;

  task_id?: string;
  assignment_id?: string;

  type: string;
  from_status?: SessionStatus;
  to_status?: SessionStatus;

  at: string;
  details?: Record<string, unknown>;
}
```

Session event log must be append-only.

---

# 14. CLI: session namespace

Preserve:

```bash
agent-router session bootstrap
```

Add the following commands.

## 14.1 `session acquire`

```bash
agent-router session acquire \
  --task TASK-045 \
  [--role implementation_worker] \
  [--project PATH] \
  [--json]
```

Role may be omitted when a route already exists.

Preconditions:

* project registered;
* task exists;
* task state is `dispatched`;
* route exists;
* context exists;
* context passes checks;
* route role authorized by project;
* no active assignment for task;
* task revision valid.

Behavior:

1. load route;
2. derive required role/model/reasoning/sandbox;
3. apply session policy;
4. retire expired/incompatible sessions where required;
5. find compatible idle session;
6. reserve it, or create `pending_spawn` session;
7. create active assignment;
8. generate exact command-only dispatch message;
9. return transport action.

Possible output:

```json
{
  "action": "spawn",
  "project_id": "agent-router-...",
  "session_id": "SES-01ABC",
  "task_id": "TASK-045",
  "task_revision": 1,
  "role": "implementation_worker",
  "provider_model": "gpt-5.6-luna",
  "reasoning": "xhigh",
  "dispatch_command": "agent-router work open TASK-045 --session SES-01ABC",
  "dispatch_message": "Execute:\nagent-router work open TASK-045 --session SES-01ABC"
}
```

Reuse output:

```json
{
  "action": "send_input",
  "session_id": "SES-01ABC",
  "provider_agent_id": "provider-thread-id",
  "dispatch_command": "agent-router work open TASK-046 --session SES-01ABC",
  "dispatch_message": "Execute:\nagent-router work open TASK-046 --session SES-01ABC"
}
```

Recovery output may use:

```json
{
  "action": "resume",
  "session_id": "SES-01ABC",
  "provider_agent_id": "provider-thread-id",
  "dispatch_command": "agent-router work open TASK-046 --session SES-01ABC"
}
```

The output must not contain task objective or context.

## 14.2 `session confirm`

```bash
agent-router session confirm \
  --session SES-01ABC \
  --action spawn|send-input|resume \
  [--provider-agent-id PROVIDER_ID]
```

Use after the Luna main session successfully invokes the native provider action.

Rules:

* `provider-agent-id` required after successful spawn;
* provider ID must match stored ID for send-input/resume where present;
* updates transport result;
* must not mark task `in_progress`;
* worker acknowledgement occurs only through `work open`.

## 14.3 `session transport-failed`

```bash
agent-router session transport-failed \
  --session SES-01ABC \
  --action spawn|send-input|resume \
  --reason CODE \
  [--detail TEXT]
```

Behavior:

* record failure;
* keep task incomplete;
* mark assignment stale where appropriate;
* for failed send-input, permit resume attempt;
* for failed resume, retire session and permit fresh spawn;
* never silently complete or release task.

## 14.4 `session release`

Normally invoked internally by `work complete`.

Manual form:

```bash
agent-router session release \
  --session SES-01ABC \
  --task TASK-045
```

Manual release must be restricted to valid completed, blocked, or relinquished assignments.

Do not allow release of an unfinished busy assignment without explicit relinquish/block flow.

## 14.5 `session retire`

```bash
agent-router session retire \
  --session SES-01ABC \
  --reason explicit
```

Behavior:

* if idle: retire immediately;
* if busy: require `--force` only for administrator recovery;
* forced retirement blocks or stales the task assignment;
* return provider action:

```json
{
  "action": "close",
  "provider_agent_id": "...",
  "session_id": "SES-01ABC"
}
```

Agent Router records the requested close action, but Luna invokes the native close tool.

## 14.6 `session reconcile`

```bash
agent-router session reconcile [--project PATH] [--apply] [--json]
```

Default without `--apply` is inspection-only.

Checks:

* busy session without active assignment;
* active assignment without session;
* task assigned to two sessions;
* session assigned to two tasks;
* task revision mismatch;
* route/context hash mismatch;
* expired lease;
* idle session without provider agent ID;
* stale pending spawn;
* retired session still referenced by active assignment;
* project path mismatch;
* unauthorized role;
* task state incompatible with assignment state.

Apply behavior:

* unambiguous safe repair only;
* ambiguous state becomes `stale`;
* affected unfinished task becomes `blocked`;
* never mark task complete;
* never delete evidence.

## 14.7 Listing and status

```bash
agent-router session list
agent-router session show SES-01ABC
agent-router session status
agent-router session stats
```

Support `--json`.

`session list` defaults to active sessions.

Optional:

```bash
agent-router session list --retired
agent-router session list --role verifier
```

---

# 15. CLI: work namespace

Add a worker-scoped namespace.

Commands:

```bash
agent-router work open TASK-045 --session SES-01ABC
agent-router work sync TASK-045 --session SES-01ABC
agent-router work reopen TASK-045 --session SES-01ABC
agent-router work status --session SES-01ABC
agent-router work complete TASK-045 --session SES-01ABC --file RESULT.json
agent-router work block TASK-045 --session SES-01ABC --reason CODE
agent-router work relinquish TASK-045 --session SES-01ABC --reason CODE
```

The worker must not need internal state paths.

## 15.1 `work open`

Preconditions:

* session exists;
* session is reserved/pending spawn;
* task assigned to that session;
* task state is `dispatched`;
* task revision matches assignment revision;
* route role matches session role;
* project profile authorizes role;
* compatibility key remains valid;
* route/context hashes match;
* no stale amendment exists;
* assignment not already acknowledged by another session.

Behavior:

1. validate assignment;
2. mark assignment acknowledged;
3. mark session busy;
4. transition task to `in_progress`;
5. set acknowledged revision;
6. return effective task contract.

Human-readable output must include:

```text
Task
Revision
Role
Objective
Allowed paths
Forbidden paths
Acceptance criteria
Targeted tests
Checkpoint tests
Manual verification
Bounded context excerpts
Output/result contract
Exact completion command
```

It must not include:

* absolute Agent Router internal paths;
* raw state root;
* unrelated tasks;
* other session data;
* secrets.

Repository-relative source paths are allowed because the worker needs them.

JSON output:

```bash
agent-router work open TASK-045 \
  --session SES-01ABC \
  --json
```

The JSON must be bounded by task/context budgets.

## 15.2 `work sync`

Used when task revision changes after acknowledgement.

```bash
agent-router work sync TASK-045 --session SES-01ABC
```

Preconditions:

* session owns active task assignment;
* current revision is greater than acknowledged revision.

Output only amendment delta from acknowledged revision to current revision.

Example:

```text
Task: TASK-045
Acknowledged revision: 1
Current revision: 2

Added allowed paths:
- src/session.ts

Added acceptance criteria:
- Reuse a compatible idle worker.

Review-required changes:
- Prevent cross-project reuse.
```

After successful output:

* update acknowledged revision;
* update assignment revision/hash if the amendment remains compatible;
* preserve amendment history.

If scope change invalidates the current session role/model/sandbox:

```text
work sync
→ fail with reassignment-required
→ current assignment stale
→ task blocked or redispatched
```

## 15.3 `work reopen`

Used after an authorized retry.

```bash
agent-router work reopen TASK-045 --session SES-02XYZ
```

Preconditions:

* task has retry amendment;
* new assignment exists;
* session is the new assigned session;
* implementation tier and route are current;
* prior rejected assignment is inactive.

Output includes:

* current effective task;
* retry revision;
* prior review findings;
* required changes;
* prior failed evidence relevant to retry;
* current scope and acceptance criteria.

All of this must come from canonical files, not the parent prompt.

## 15.4 `work status`

Returns only current session and assignment information.

Example:

```json
{
  "session_id": "SES-01ABC",
  "status": "busy",
  "role": "implementation_worker",
  "task_id": "TASK-045",
  "assigned_revision": 2,
  "acknowledged_revision": 2
}
```

## 15.5 `work complete`

```bash
agent-router work complete TASK-045 \
  --session SES-01ABC \
  --file result.json
```

Preconditions:

* session busy with this task;
* assignment acknowledged;
* acknowledged revision equals current revision;
* assignment, route, and context hashes valid;
* result file schema matches role;
* task state compatible;
* project profile authorizes role.

Behavior:

1. validate result;
2. validate changed/read paths;
3. validate test evidence;
4. validate budget;
5. write canonical result through existing handlers;
6. perform task lifecycle transition;
7. mark assignment completed;
8. move assignment to history;
9. increment session task counter;
10. clear active task/session fields;
11. leave reusable session idle;
12. retire non-persistent/fresh-only session;
13. append task/session events;
14. return next provider action where relevant.

Do not release session when validation fails.

Validation failure:

```text
task remains in_progress
session remains busy
assignment remains active
failure counter increments
```

If failure threshold is reached, mark session for retirement but preserve task evidence.

## 15.6 `work block`

```bash
agent-router work block TASK-045 \
  --session SES-01ABC \
  --reason scope-exceeded
```

Allowed reason codes must be enumerated.

Examples:

```text
scope-exceeded
missing-context
requirements-conflict
environment-blocked
test-infrastructure-blocked
security-boundary
authorization-required
```

Behavior:

* save structured block result;
* transition task to blocked;
* finalize assignment as blocked;
* release or retire session according to reason;
* do not fabricate a handoff.

## 15.7 `work relinquish`

Used when the agent cannot continue but the task should be reassigned.

```bash
agent-router work relinquish TASK-045 \
  --session SES-01ABC \
  --reason model-mismatch
```

Behavior:

* mark assignment relinquished;
* preserve task revision;
* move task to blocked or dispatched according to explicit policy;
* release/retire current session;
* require new acquisition;
* no automatic long-prompt fallback.

---

# 16. Role-specific result contracts

Add a generic result envelope:

```ts
interface WorkResultEnvelope {
  schema_version: 1;
  task_id: string;
  task_revision: number;
  session_id: string;
  assignment_id: string;
  role: RoleId;
  result_kind:
    | 'implementation_handoff'
    | 'verification_review'
    | 'security_review'
    | 'critical_review'
    | 'architecture_decision'
    | 'scout_discovery'
    | 'repository_hygiene_report'
    | 'security_research_result';
  payload: unknown;
}
```

`work complete` must dispatch to strict role-specific validation.

## 16.1 Implementation roles

Roles:

```text
implementation_worker
implementation_escalation_worker
```

Result kind:

```text
implementation_handoff
```

Use existing handoff validation and extend it with:

* session ID;
* assignment ID;
* task revision;
* effective contract hash.

## 16.2 Verifier

Role:

```text
verifier
```

Result kind:

```text
verification_review
```

Use existing review schema and ordered review gate logic.

Verifier must not modify implementation.

## 16.3 Security reviewer

Role:

```text
security_reviewer
```

Result kind:

```text
security_review
```

Use existing review import logic and role sequence validation.

## 16.4 Critical reviewer

Role:

```text
critical_reviewer
```

Result kind:

```text
critical_review
```

Fresh session by default.

## 16.5 Architect

Role:

```text
architect
```

Result kind:

```text
architecture_decision
```

Payload must include:

* decision;
* constraints;
* rejected alternatives;
* task decomposition;
* acceptance criteria;
* unresolved questions.

Do not allow architect to submit implementation handoff.

## 16.6 Scout

Role:

```text
scout
```

Result kind:

```text
scout_discovery
```

Payload includes:

* relevant files;
* symbols;
* tests;
* dependencies;
* risks;
* recommended bounded scope.

Read-only enforcement remains.

## 16.7 Repository janitor

Role:

```text
repo_janitor
```

Result kind:

```text
repository_hygiene_report
```

Fresh or ephemeral by default.

## 16.8 Security researcher

Role:

```text
security_researcher
```

Result kind:

```text
security_research_result
```

Payload must preserve:

* authorization scope;
* attack surface;
* reachability;
* attacker control;
* root cause;
* impact;
* evidence;
* safe verification boundaries;
* unresolved questions.

No destructive testing authorization is added by this patch.

---

# 17. Task amendment CLI

Add:

```bash
agent-router task amend TASK-045 \
  --file amendment.json
```

Optional structured flags may be added only if they map exactly to the amendment schema.

Do not require the main model to manually edit task files.

Behavior:

1. lock task;
2. load current revision;
3. validate amendment;
4. materialize effective next contract;
5. compute old/new hashes;
6. write immutable amendment file;
7. update task revision atomically;
8. append task event;
9. mark active assignment as revision-changed;
10. require `work sync`.

Add:

```bash
agent-router task amendments TASK-045
agent-router task amendment TASK-045 --revision 2
```

Support JSON output.

---

# 18. Effective task contract materialization

Implement one authoritative function:

```ts
materializeEffectiveTaskContract(task, amendments)
```

It must:

* apply amendments in revision order;
* reject gaps;
* reject duplicate revisions;
* reject hash-chain mismatch;
* normalize arrays deterministically;
* preserve forbidden-path priority;
* validate resulting task;
* compute canonical SHA-256.

Do not copy amendment-application logic into `work open`, `work sync`, task display, migration, and tests separately.

All consumers use the same materializer.

---

# 19. Retry integration

Preserve current Luna-to-Terra escalation semantics.

For a rejected default implementation:

```text
implementation_tier: default
attempt: 1
```

After authorized retry:

```text
implementation_tier: escalated
attempt: 2
escalation_reason: implementation_rejected
```

`task retry` must:

1. verify retry is legal;
2. gather rejected review records;
3. create immutable retry amendment;
4. increment revision;
5. retire previous implementation session;
6. clear stale active assignment;
7. preserve old assignment in history;
8. clear obsolete context/route/handoff/review artifacts only according to existing safe retry rules;
9. preserve review evidence referenced by amendment;
10. return task to ready state.

A second rejected Terra escalation must continue to require architect review rather than another implementation retry.

---

# 20. Review rejection integration

When an implementation result is rejected:

* preserve review file;
* record which session produced implementation;
* mark `rejected_tasks += 1` on that implementation session;
* retire the implementation session when policy requires;
* do not retire verifier/security reviewer solely because they issued rejection;
* task retry creates the revision/amendment;
* review findings are never copied into a parent-to-worker prompt.

---

# 21. Provider capability model

Add:

```ts
interface ProviderSessionCapabilities {
  provider: 'codex';

  spawn: boolean;
  send_input: boolean;
  resume: boolean | 'unknown';
  close: boolean;
  wait: boolean;

  persistent_across_parent_restart: boolean | 'unknown';

  detected_at: string;
  source: 'configured' | 'manual-smoke-test' | 'runtime-observation';
}
```

Store provider capabilities in global or provider state, not the work repository.

Default Codex capability record may state:

```json
{
  "spawn": true,
  "send_input": true,
  "resume": "unknown",
  "close": true,
  "wait": true,
  "persistent_across_parent_restart": "unknown"
}
```

Do not claim support until verified.

Add commands:

```bash
agent-router provider capabilities
agent-router provider capability set \
  --resume true|false|unknown \
  --persistent-across-parent-restart true|false|unknown \
  --source manual-smoke-test
```

Only provider capability metadata is updated.

Agent Router must not invoke provider tools.

---

# 22. Transport-action fallback state machine

For a recorded idle session:

```text
session acquire
→ action send_input
```

If send-input succeeds:

```text
continue
```

If send-input fails with agent unavailable:

```text
session transport-failed
→ session stale
→ next acquire may return resume
```

If resume succeeds:

```text
session confirm --action resume
→ continue
```

If resume fails:

```text
session transport-failed --action resume
→ retire old session
→ next acquire returns spawn
```

If capability explicitly says resume is unsupported:

```text
skip resume
→ retire
→ spawn
```

At no point may Agent Router return a long natural-language task prompt.

---

# 23. Command-only dispatch builder

Implement one authoritative function:

```ts
buildDispatchMessage({
  operation,
  taskId,
  sessionId,
})
```

Allowed operations:

```text
open
sync
reopen
```

Exact output:

```text
Execute:
agent-router work <operation> <task-id> --session <session-id>
```

Requirements:

* bounded length;
* newline-normalized;
* no objective;
* no context;
* no repository path;
* no internal state path;
* no review content;
* no uncontrolled user text;
* task/session IDs validated before interpolation.

All session-acquire outputs must use this builder.

---

# 24. Main and role instruction changes

Update generated global `~/.codex/AGENTS.md` managed block.

Remove wording that requires a disposable agent for every task.

Add:

```text
Sub-agent dispatch is command-only.

The main session MUST send only the exact dispatch message returned by
Agent Router session acquire.

The main session MUST NOT include task descriptions, acceptance criteria,
file paths, source excerpts, test commands, amendments, review findings,
or implementation guidance in spawn-agent, send-input, or resume messages.

The sub-agent MUST load authoritative work through Agent Router CLI.

A compatible idle session should be reused.

The main session must not close a persistent session after successful work
unless Agent Router returns a close or retire action.

Current Agent Router task state and revision override all prior session memory.
```

Update role TOML instructions.

Implementation worker wording must no longer say it always exits permanently after one task.

Replace with semantics:

```text
Perform one active assignment at a time.

After successful Agent Router work completion, stop the current turn and wait
idle for another command-only Agent Router assignment.

Do not infer a new task from chat context.

Accept task requirements only from `agent-router work open`, `work sync`,
or `work reopen`.
```

Verifier, architect, security reviewer, scout, and research role instructions must follow the same command-only authority rule.

Critical reviewer must remain fresh by default.

---

# 25. Session bootstrap changes

Extend:

```bash
agent-router session bootstrap --json
```

Return compact session-aware state:

```json
{
  "project_id": "...",
  "profile": "development",
  "session_policy": {
    "enabled": true,
    "maximum_tasks_per_session": 8
  },
  "active_sessions": {
    "idle": 1,
    "busy": 0,
    "stale": 0
  },
  "next_task": "...",
  "required_action": "route|context|dispatch|acquire|review|none"
}
```

Do not return full session records unless explicitly requested.

Bootstrap output must remain bounded.

---

# 26. Doctor changes

## 26.1 Global doctor

Add checks for:

* session schemas shipped;
* provider capability state structurally valid;
* generated role instructions contain command-only protocol;
* no profile-specific session state stored globally;
* Agent Router version 0.8.0.

Global doctor must not require any active sessions.

## 26.2 Project doctor

Add checks for:

* session policy validity;
* session directories;
* assignment consistency;
* no duplicate active assignments;
* no cross-project session paths;
* role authorization;
* task revision integrity;
* amendment chain integrity;
* session/task assignment consistency;
* stale active leases;
* zero-footprint.

Doctor must be inspection-only.

Use `session reconcile --apply` for repair.

---

# 27. Session statistics

Add:

```bash
agent-router session stats [--json]
```

Aggregate from append-only events.

Required metrics:

```text
sessions_created
sessions_spawned
sessions_reused
sessions_resumed
sessions_retired
sessions_stale
resume_failures
send_input_failures
tasks_completed
tasks_blocked
tasks_relinquished
tasks_per_session_average
maximum_tasks_in_one_session
dispatch_messages_generated
dispatch_message_characters_total
dispatch_message_characters_average
retirement_reasons
role_breakdown
```

Do not claim exact token savings unless real provider usage data is available.

Optional provider usage fields may be added later, but are not required.

---

# 28. Security and trust-boundary requirements

The implementation must validate:

* task ID;
* session ID;
* assignment ID;
* role;
* profile authorization;
* task revision;
* route hash;
* context hash;
* contract hash;
* repository root;
* relative project paths;
* session compatibility key;
* state transition;
* one-task-per-session rule.

Do not trust:

* user-controlled result files;
* remembered agent state;
* provider agent ID alone;
* task ID alone;
* session ID alone;
* stale route/context records;
* parent prompt text.

Canonical records must be written atomically.

Do not expose secrets through:

* session records;
* dispatch messages;
* statistics;
* events;
* error messages;
* generated review packs.

Session records may contain provider thread IDs, but those must not be treated as credentials.

---

# 29. Migration from v0.7.0

Implement explicit migration.

## 29.1 Task migration

Existing v0.7.0 task:

```json
{
  "schema_version": 1
}
```

must migrate to:

```json
{
  "schema_version": 2,
  "revision": 1,
  "previous_revision": null,
  "effective_contract_sha256": "..."
}
```

Requirements:

* preserve task ID;
* preserve state;
* preserve timestamps;
* preserve execution attempt/tier;
* preserve plan reference;
* preserve scope;
* preserve reviews;
* preserve handoffs;
* preserve event history;
* do not fabricate session assignment;
* do not infer prior provider agent ID.

## 29.2 Existing active tasks

For tasks in:

```text
dispatched
in_progress
worker_complete
review_pending
```

migration must not guess a session.

Mark them:

```text
session assignment: absent
legacy_unassigned: true
```

Provide a safe recovery command.

For dispatched/in-progress tasks without valid assignment:

```text
project doctor
→ warn/error
session reconcile --apply
→ task blocked with migration recovery reason
```

Do not silently reassign active legacy work.

## 29.3 Project policy migration

Add default session policy to existing project policy.

Preserve profile, role permissions, routing policy, context policy, and review policy.

## 29.4 Global setup migration

Running:

```bash
agent-router setup --provider codex --apply
```

must update managed global AGENTS and role TOML instructions to v0.8.0.

Preserve:

* unrelated user AGENTS content;
* unrelated custom agents;
* registered projects;
* unmanaged Codex configuration.

## 29.5 Idempotency

Migration may run multiple times safely.

No repeated revision increments.

No duplicate amendment files.

No duplicate session directories.

No duplicate managed blocks.

---

# 30. Migration CLI

Extend existing sync/migration behavior or add:

```bash
agent-router migrate --from 0.7.0 --to 0.8.0
agent-router migrate --check
agent-router migrate --apply
```

Use existing project sync conventions where practical.

Minimum requirements:

* dry-run/check mode;
* changed-file plan;
* backup of modified Agent Router state;
* no work-repository changes;
* rollback guidance;
* idempotency.

Do not force users to re-register projects.

---

# 31. Required implementation order

Follow this order exactly.

## Phase 1 — Baseline analysis

Read:

```text
README.md
CHANGELOG.md
docs/ARCHITECTURE.md
docs/TASK_PROTOCOL.md
docs/ROLE_MODEL.md
docs/PROVIDER_ADAPTERS.md
docs/CONTEXT_BUDGETS.md
docs/HANDOFF or equivalent
docs/SECURITY.md
docs/TROUBLESHOOTING.md
src/config.ts
src/models.ts
src/task.ts
src/state.ts
src/context.ts
src/handoff.ts
src/review.ts
src/provider/codex.ts
src/templates.ts
src/cli.ts
tests/
schemas/
```

Document current:

* task lifecycle;
* route lifecycle;
* context lifecycle;
* handoff lifecycle;
* review lifecycle;
* global setup;
* project registration;
* session bootstrap;
* state paths;
* atomic-write helpers.

Do not start implementation before understanding current invariants.

## Phase 2 — Specifications and ADRs

Update or add:

```text
docs/ARCHITECTURE.md
docs/TASK_PROTOCOL.md
docs/ROLE_MODEL.md
docs/PROVIDER_ADAPTERS.md
docs/SECURITY.md
docs/CONTEXT_BUDGETS.md
docs/PERSISTENT_SESSIONS.md
docs/COMMAND_ONLY_DISPATCH.md
docs/MIGRATION_0.7_TO_0.8.md
```

Add ADRs if repository uses ADRs:

```text
Persistent role session pool
Command-only dispatch
Task revisions and immutable amendments
Provider capability fallback
```

Documentation/spec changes come before production code.

## Phase 3 — Schemas and fixtures

Add/update:

```text
session.schema.json
assignment.schema.json
session-event.schema.json
session-policy.schema.json
task-amendment.schema.json
work-result.schema.json
task.schema.json v2
project/policy schemas
```

Add fixtures for:

* fresh session;
* reusable idle session;
* stale session;
* retired session;
* assignment;
* amendment chain;
* migrated v0.7 task;
* role-specific results;
* provider capability states.

## Phase 4 — Core models and pure functions

Implement and test pure logic first:

```text
session compatibility key
session policy resolution
dispatch message builder
task effective-contract materializer
amendment application
revision hashing
session transition validation
assignment transition validation
retirement decision
provider fallback decision
```

## Phase 5 — Filesystem storage and locking

Implement:

```text
session store
assignment store
amendment store
session event log
project-scoped lock
atomic acquisition
history movement
migration reader/writer
```

## Phase 6 — Session manager

Implement:

```text
acquire
reserve
confirm
transport failure
release
retire
reconcile
list/show/status/stats
```

## Phase 7 — Work API

Implement:

```text
work open
work sync
work reopen
work status
work complete
work block
work relinquish
```

Integrate existing task, context, handoff, plan, and review logic instead of replacing it.

## Phase 8 — Retry/review integration

Implement:

```text
review rejection linkage
retry amendment
revision increment
old-session retirement
new escalation assignment
```

## Phase 9 — Provider and instruction updates

Update:

```text
global AGENTS managed block
role TOMLs
main profile docs
provider capabilities
setup status
global doctor
project doctor
```

## Phase 10 — Migration

Implement and test v0.7.0 → v0.8.0 migration.

## Phase 11 — CLI

Expose all commands only after core behavior is tested.

Update help and error messages.

## Phase 12 — Automated tests

Add full unit/integration coverage.

## Phase 13 — Pre-dependency source review

Before installing packages:

* inspect complete diff;
* check schemas;
* inspect task/session state machines;
* search for direct Agent Router state writes;
* search for prompt task-content duplication;
* check zero-footprint;
* check no `airelay`;
* check no runtime dependency added without need.

## Phase 14 — Dependency installation and verification

Only after source-complete review:

```bash
npm run bootstrap
```

Then targeted tests, full quality gates, package verification, isolated install, and manual Codex smoke tests.

---

# 32. Required automated tests

Preserve all existing tests.

Do not delete valid tests to make the patch pass.

## 32.1 Session lifecycle tests

Test:

1. fresh session creation;
2. pending spawn;
3. provider ID registration;
4. work acknowledgement;
5. successful completion;
6. transition to idle;
7. compatible reuse;
8. task counter increment;
9. task-limit retirement;
10. idle-timeout retirement;
11. explicit retirement;
12. failed session state;
13. retired session cannot be reused.

## 32.2 Compatibility tests

Test no reuse when any differs:

```text
project ID
role
provider model
reasoning
repository root
sandbox
approval policy
```

Test compatible key deterministic across runs.

## 32.3 Concurrency tests

Test:

* two concurrent acquires for same task;
* two concurrent acquires against one idle session;
* one task cannot receive two assignments;
* one session cannot receive two active tasks;
* lock timeout;
* stale lock recovery;
* no partially written state after forced error.

## 32.4 Command-only dispatch tests

Assert generated dispatch message:

* contains exactly one Agent Router command;
* contains task ID;
* contains session ID;
* contains no objective;
* contains no acceptance criteria;
* contains no repository-relative paths from task;
* contains no internal paths;
* contains no context excerpt;
* contains no review findings;
* contains no test command;
* stays below configured maximum length;
* uses normalized newline;
* rejects invalid IDs.

## 32.5 Work open tests

Test:

* correct session/task works;
* wrong session rejected;
* wrong role rejected;
* role not allowed by profile rejected;
* wrong revision rejected;
* stale route hash rejected;
* stale context hash rejected;
* unauthorized task rejected;
* already acknowledged assignment rejected;
* task moves to in_progress;
* session moves to busy;
* output excludes internal state paths.

## 32.6 Amendment tests

Test:

* revision 1 → 2;
* immutable amendment file;
* hash chain;
* missing revision rejected;
* duplicate revision rejected;
* empty amendment rejected;
* invalid path rejected;
* add/remove semantics;
* exact-string removal;
* active assignment becomes revision-changed;
* stale completion blocked;
* work sync returns delta only;
* acknowledgement updated;
* incompatible amendment requires reassignment.

## 32.7 Retry tests

Test:

* rejected Luna task creates retry amendment;
* revision increments;
* implementation tier escalates;
* previous implementation session retires;
* new Terra session acquired;
* prior review linked by hash;
* second Terra rejection does not permit third implementation attempt.

## 32.8 Work completion tests

Test:

* implementation handoff accepted;
* verifier review accepted;
* security review accepted;
* architect result accepted;
* scout result accepted;
* research result accepted;
* wrong result kind rejected;
* wrong role rejected;
* stale revision rejected;
* scope violation rejected;
* failed tests rejected;
* failed validation leaves session busy;
* successful completion makes reusable session idle;
* fresh-only session retires.

## 32.9 Provider fallback tests

With fake provider-state simulation:

* send-input success;
* send-input failure;
* resume offered;
* resume success;
* resume failure;
* no-resume capability;
* spawn replacement;
* old session retirement;
* no task-content fallback.

## 32.10 Reconcile tests

Test:

* orphan assignment;
* orphan session;
* duplicate assignment;
* expired lease;
* stale pending spawn;
* retired session referenced by task;
* revision mismatch;
* authorization mismatch;
* dry-run produces plan only;
* apply blocks ambiguous task;
* apply never marks work complete.

## 32.11 Migration tests

Test:

* v0.7 task becomes schema v2 revision 1;
* migration idempotent;
* existing handoff preserved;
* existing review preserved;
* event history preserved;
* active legacy task not guessed into session;
* project profile preserved;
* session policy added;
* unmanaged Codex files preserved;
* work repository unchanged.

## 32.12 Doctor tests

Test:

* global doctor without projects;
* project doctor with no sessions;
* project doctor with valid idle session;
* inconsistent assignment detected;
* stale amendment chain detected;
* extra globally installed roles allowed;
* zero-footprint check passes.

## 32.13 Statistics tests

Test event aggregation and role breakdown.

Do not assert fake token savings.

---

# 33. Required CLI integration tests

Run CLI as a real compiled binary against isolated homes and repositories.

Test full sequence:

```bash
agent-router setup --provider codex --apply

cd test-repository
agent-router project register --profile development

agent-router task create ...
agent-router task activate TASK-001
agent-router task route TASK-001
agent-router context build TASK-001
agent-router task dispatch TASK-001

agent-router session acquire --task TASK-001 --json
agent-router session confirm ...
agent-router work open TASK-001 --session SES-...
agent-router work complete TASK-001 --session SES-... --file result.json

agent-router session list
agent-router session stats
```

Then second task:

```bash
agent-router session acquire --task TASK-002 --json
```

Verify action is:

```text
send_input
```

and session ID is unchanged.

---

# 34. Manual native Codex smoke test

This is a required release verification when the environment exposes native sub-agent tools.

## Test A — Same-parent reuse

1. Start Luna-low main through Agent Router Codex profile.
2. Create and dispatch TASK-A.
3. Run session acquire.
4. Verify action `spawn`.
5. Invoke native spawn-agent using only returned dispatch message.
6. Worker runs `work open`.
7. Worker completes TASK-A.
8. Do not close worker.
9. Create and dispatch TASK-B.
10. Run session acquire.
11. Verify action `send_input`.
12. Invoke native send-input using only returned dispatch message.
13. Verify the same provider agent/thread ID.
14. Worker completes TASK-B.
15. Verify session task count is 2 and status idle.

## Test B — Command-only transport

Inspect tool history.

Confirm spawn/send-input payload contains:

```text
Execute:
agent-router work ...
```

Confirm it does not contain:

* task objective;
* acceptance criteria;
* paths;
* tests;
* excerpts;
* review feedback.

## Test C — Rejection and escalation

1. Complete Luna implementation.
2. Import rejection.
3. Run task retry.
4. Verify old Luna implementation session retires.
5. Verify new acquisition selects Terra escalation worker.
6. Verify retry message is only `work reopen` command.
7. Verify review feedback is read from Agent Router state.

## Test D — Parent restart

1. Leave a reusable idle worker recorded.
2. End main session.
3. Start a new Luna main session.
4. Attempt provider send-input/resume according to available tools.
5. Record actual behavior.
6. Update provider capability metadata.
7. If resume unavailable, verify safe retire-and-spawn fallback.
8. Do not treat unsupported cross-parent resume as patch failure when fallback works and capability is recorded accurately.

## Test E — Close on retirement

1. Retire a session.
2. Agent Router returns close action.
3. Luna invokes native close-agent.
4. Confirm retired session is not reused.

---

# 35. Documentation requirements

Update:

```text
README.md
CHANGELOG.md
docs/ARCHITECTURE.md
docs/INSTALLATION.md
docs/NEW_MACHINE_SETUP.md
docs/NEW_PROJECT_WORKFLOW.md
docs/TASK_PROTOCOL.md
docs/ROLE_MODEL.md
docs/ROUTING_POLICY.md
docs/PROVIDER_ADAPTERS.md
docs/CONTEXT_BUDGETS.md
docs/REPOSITORY_HYGIENE.md
docs/SECURITY.md
docs/TROUBLESHOOTING.md
docs/PERSISTENT_SESSIONS.md
docs/COMMAND_ONLY_DISPATCH.md
docs/MIGRATION_0.7_TO_0.8.md
examples/profiles/*
```

Only modify files that exist.

Documentation must clearly explain:

```text
Machine setup
Project registration
Task routing
Session acquisition
Native provider dispatch
Worker CLI loading
Session reuse
Revision sync
Retry escalation
Session retirement
Crash reconciliation
```

Include examples for:

* development;
* secure development external brain;
* secure development local brain;
* security research.

Explain that persistent sessions reduce repeated startup/context loading but may accumulate context, so leases and retirement limits remain mandatory.

Do not make unsupported claims about exact token savings.

---

# 36. Versioning

Update all canonical release locations:

```text
0.7.0
→ 0.8.0
```

Including:

* package.json;
* package-lock.json;
* CLI version;
* changelog;
* schemas where versioned;
* docs;
* fixtures;
* snapshots;
* package examples.

Preserve historical `0.7.0` references in migration documentation.

---

# 37. Non-goals

Do not:

* integrate `airelay`;
* invoke OpenAI APIs directly;
* implement a daemon;
* add a database;
* add Docker;
* switch package manager;
* change current model assignments;
* change the four project profiles;
* add recursive delegation;
* allow two active tasks in one session;
* permit cross-project reuse;
* permit cross-role reuse;
* send task content through prompts as fallback;
* store framework metadata in work repositories;
* automatically publish npm package;
* force-push Git history;
* redesign unrelated task/review behavior.

Keep runtime dependencies at zero unless an unavoidable requirement is demonstrated and approved.

---

# 38. Pre-test source-complete archive

Follow the established release workflow.

After:

* documentation;
* schemas;
* fixtures;
* production code;
* tests;

but before installing/updating dependencies or running tests:

1. inspect the full source diff;
2. create a source-complete pre-test archive;
3. calculate SHA-256;
4. verify archive extraction;
5. confirm it excludes:

   * node_modules;
   * dist;
   * test build output;
   * package tarballs;
   * temporary homes;
   * Git metadata;
   * secrets.

Name example:

```text
agent-router-v0.8.0-source-complete-pretest.zip
```

Do not treat this as the final release archive.

---

# 39. Dependency and quality-gate order

After the pre-test archive:

```bash
npm run bootstrap
```

Expected underlying behavior remains:

```bash
npm ci --no-audit --no-fund
```

Then run targeted tests first.

Recommended:

```bash
npm run test:unit
npm run test:integration
npm run test:project
```

Add dedicated scripts where useful:

```text
test:sessions
test:work
test:migration
```

Then run:

```bash
npm run quality-gates
```

Also explicitly verify:

```bash
npm test
npm run typecheck
npm run build
```

Avoid redundant runs before source completeness, but the final state must pass the complete quality gate.

---

# 40. Final packaging verification

Run:

```bash
npm pack --json
```

Verify package:

* version `0.8.0`;
* compiled CLI present;
* schemas included;
* new docs included;
* no node_modules;
* no test homes;
* no generated package inside package;
* no credentials;
* no local machine paths;
* zero runtime dependencies preserved.

Install in isolated prefix:

```bash
INSTALL_ROOT="$(mktemp -d)"

npm install -g ./<generated-0.8.0-package.tgz> \
  --prefix "$INSTALL_ROOT" \
  --no-audit \
  --no-fund
```

Run:

```bash
"$INSTALL_ROOT/bin/agent-router" --version
"$INSTALL_ROOT/bin/agent-router" --help
"$INSTALL_ROOT/bin/agent-router" session --help
"$INSTALL_ROOT/bin/agent-router" work --help
"$INSTALL_ROOT/bin/agent-router" task --help
```

Expected version:

```text
0.8.0
```

---

# 41. Zero-footprint verification

Create a test repository.

Hash all non-Git files before:

```bash
agent-router setup --provider codex --apply
agent-router project register --profile development
agent-router task create ...
agent-router session acquire ...
agent-router doctor
agent-router session reconcile
```

Hash all non-Git files after.

The work repository must remain unchanged except for deliberate source/test modifications performed by an assigned implementation worker.

Agent Router metadata must never appear in the work repository.

---

# 42. Secret and internal-path scan

Search source, generated role files, dispatch messages, package, and fixtures for:

* credentials;
* API keys;
* tokens;
* private keys;
* real local home paths;
* hard-coded provider thread IDs;
* internal test temporary paths.

Dispatch messages must not include:

```text
~/.agent-router
~/.codex
/home/<user>
C:\Users\<user>
```

---

# 43. Acceptance criteria

The patch is accepted only when every criterion below passes.

## Persistent sessions

* first compatible task returns spawn;
* successful session remains idle;
* next compatible task returns send_input;
* same provider agent ID is reused;
* session limits trigger retirement;
* critical reviewer is fresh by default.

## Command-only transport

* parent dispatch contains only generated CLI invocation;
* no task content in spawn/send-input/resume message;
* no long-prompt fallback exists.

## Worker CLI

* work open loads authoritative task/context;
* work sync loads amendment delta;
* work reopen loads retry/review evidence;
* work complete writes validated canonical result;
* wrong session/role/revision fails closed.

## Revisions

* tasks begin at revision 1;
* amendments are immutable;
* revisions increment monotonically;
* stale completion is rejected;
* task contract hash chain validates.

## Authorization

* project profile constrains role;
* no cross-project reuse;
* no cross-role reuse;
* no two tasks per session.

## Retry

* rejected Luna implementation retires;
* retry creates amendment;
* Terra escalation session is new;
* second escalation rejection requires architect review.

## Recovery

* stale state detected;
* reconcile dry-run is safe;
* ambiguous recovery blocks rather than completes;
* failed resume falls back to fresh spawn.

## Migration

* v0.7 tasks migrate safely;
* existing projects remain registered;
* handoffs/reviews/events preserved;
* no guessed session assignment;
* migration idempotent.

## Quality

* all automated tests pass;
* TypeScript strict typecheck passes;
* production build passes;
* package inspection passes;
* isolated installation passes;
* native Codex same-parent reuse smoke test passes;
* cross-parent capability accurately recorded;
* zero-footprint passes;
* secret scan passes.

---

# 44. Final verification gates

The final release status may be `SUCCESS` only after all gates below pass.

## Gate 1 — Source review

```text
PASS:
- architecture coherent
- no duplicated state-machine logic
- no prompt task-content transport
- no Agent Router direct provider-tool invocation
- zero runtime dependency regression
```

## Gate 2 — Schema validation

```text
PASS:
- all new fixtures validate
- invalid fixtures reject
- migrations produce valid canonical records
```

## Gate 3 — Targeted tests

```text
PASS:
- session tests
- work API tests
- amendment tests
- migration tests
- provider fallback tests
```

## Gate 4 — Full quality gates

```bash
npm run quality-gates
```

Must pass with zero failed tests.

## Gate 5 — Build

```bash
npm run typecheck
npm run build
```

Both pass.

## Gate 6 — Package

```text
PASS:
- npm pack
- package inspection
- isolated installation
- CLI 0.8.0
```

## Gate 7 — Native Codex smoke

```text
PASS:
- same child session reused for two tasks
- command-only dispatch confirmed
- retirement close flow confirmed
- cross-parent behavior recorded honestly
```

## Gate 8 — Migration

```text
PASS:
- representative v0.7 state migrated
- no data loss
- idempotent rerun
```

## Gate 9 — Zero footprint and secret scan

Must pass.

## Gate 10 — Final archive

Create:

```text
agent-router-v0.8.0-source.zip
agent-router-v0.8.0-source.tar.gz
therceman-agent-router-0.8.0.tgz
SHA256SUMS-agent-router-v0.8.0.txt
AGENT_ROUTER_V0.8.0_FINAL_VERIFICATION_REPORT.md
agent-router-v0.8.0-manual-verification.log
```

Verify every checksum after final file generation.

---

# 45. Failure reporting

Final status must be one of:

```text
SUCCESS
```

or:

```text
BLOCKED
```

For `BLOCKED`, report:

* exact command;
* exit code;
* failing test or gate;
* root cause;
* files affected;
* whether source state remains safe;
* whether any commit or push occurred.

Do not call partially verified work complete.

Do not hide unsupported provider behavior.

Do not claim native session reuse unless the real smoke test observed it.

---

# 46. Final deliverables

Return:

1. implementation summary;
2. architectural decisions;
3. complete changed-file list grouped by:

   * docs/ADRs;
   * schemas;
   * fixtures;
   * production code;
   * tests;
   * package/version;
4. migration behavior;
5. exact CLI commands added;
6. session state machine summary;
7. task revision/amendment summary;
8. command-only dispatch evidence;
9. automated test totals;
10. typecheck result;
11. build result;
12. package result;
13. isolated installation result;
14. native Codex smoke-test result;
15. cross-parent resume capability result;
16. zero-footprint result;
17. secret scan result;
18. final diff stat;
19. pre-test archive SHA-256;
20. final artifact SHA-256 values;
21. remaining risks and limitations;
22. final Git status.

Do not commit or push unless the owner explicitly authorizes commit and push in the current instruction.

Do not publish the npm package.

```
```
