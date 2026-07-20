# New Project Workflow

Choose a profile before registration.

```bash
cd /path/to/work-repository
agent-router project register --profile development
agent-router doctor
agent-router status
```

Other profiles:

```bash
agent-router project register --profile secure-development-external-brain
agent-router project register --profile secure-development-local-brain
agent-router project register --profile security-research
```

Start Codex:

```bash
codex --profile agent-router
```

Initial prompt:

```text
Bootstrap Agent Router for the current repository and continue the next bounded task.
Keep the work repository zero-footprint.
```

Registration must leave the repository byte-for-byte unchanged except for later real source/test work performed by workers.

## CLI-managed task execution

The main session and workers must use Agent Router commands rather than manipulating state files:

```bash
agent-router task activate TASK-ID
agent-router task route TASK-ID
agent-router context build TASK-ID
agent-router task dispatch TASK-ID
agent-router task start TASK-ID
agent-router handoff complete TASK-ID --file worker-result.json
```

Use `task retry` after `blocked` or `rejected`, and `task supersede OLD --by NEW` when a replacement task makes the old task obsolete. Canonical records remain under `~/.agent-router`; no task metadata is written into the work repository.
