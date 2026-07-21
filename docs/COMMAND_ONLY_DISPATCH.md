# Command-only dispatch

The parent session transports only the exact message returned by session
acquisition:

```text
Execute:
agent-router work open TASK-045 --session SES-01ABC
```

The message contains no objective, acceptance criteria, paths, source excerpts,
tests, amendments, review findings, or internal state paths. The worker loads
the authoritative current revision with `work open`, receives amendment deltas
with `work sync`, and loads retry evidence with `work reopen`.

If Agent Router cannot produce a valid assignment or the provider action fails,
the main session stops and reports the blocker. It never falls back to a long
natural-language task prompt and Agent Router never invokes native Codex tools
itself.
