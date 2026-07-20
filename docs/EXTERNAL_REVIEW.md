# External Review

Review packs are stored outside the work repository:

```text
~/.agent-router/review-packs/<project-id>/
```

Create a pack:

```bash
agent-router review pack TASK-ID
agent-router review pack TASK-ID --purpose security
agent-router review pack TASK-ID --purpose research
```

Implementation packs contain task, route, compact context summary, handoff, diff, diff stat, changed files, prior reviews, manifest, and hashes.

Security/research packs additionally contain bounded context snippets selected by the task context policy.

Secret-like content blocks pack creation. Dependency trees, Git internals, caches, binaries, and unrelated files are excluded.

Import a review:

```bash
agent-router review import TASK-ID /path/to/review.json
agent-router review status TASK-ID
```

Reviews must follow the task’s ordered sequence. In secure development, the Terra verifier review must be accepted before the Sol security review can be imported.
