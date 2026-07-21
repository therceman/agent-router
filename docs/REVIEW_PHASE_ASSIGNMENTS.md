# Review-phase assignments

After implementation reaches `worker_complete`, `session acquire` derives the
next role from the task’s ordered review sequence. A local reviewer receives a
new assignment, route, and context under:

```text
generated/phases/<TASK>/review-<ROLE>.route.json
contexts/phases/<TASK>/review-<ROLE>.json
```

The review context contains the revision-bound contract, implementation
handoff, prior reviews, and bounded review evidence. It is separate from the
primary implementation context. A reviewer cannot acquire the next phase
until earlier reviews are accepted or accepted with follow-up.

`external_reviewer` is a handoff boundary, not a local session. Agent Router
returns an explicit `external_review_required` result and the owner imports
the review with:

```bash
agent-router review import TASK REVIEW.json
```

Amendments invalidate all derived phase records. Run `agent-router task refresh
TASK` before acquiring or synchronizing an assignment. If the new revision is
compatible, the active worker receives a revision-bound `work sync` requirement;
if role, model, reasoning, sandbox, approval, or repository compatibility
changes, the assignment is retired and must be reassigned.
