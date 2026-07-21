# Agent Router v0.8.0 Implementation Checklist

- [x] Add persistent project-bound session, assignment, event, lock, and policy state.
- [x] Add compatible idle reuse, stale recovery, retirement, and fresh-spawn fallback.
- [x] Enforce exact command-only dispatch with no prompt-content fallback.
- [x] Add worker `open`, `sync`, `reopen`, `complete`, `block`, and `relinquish` APIs.
- [x] Add role-specific result envelopes and ordered review validation.
- [x] Upgrade tasks to schema v2 with immutable revisions and amendment hash chains.
- [x] Preserve rejected-review evidence during retry and retire superseded execution state.
- [x] Add explicit v0.7-to-v0.8 migration check/apply flow with backups and idempotence.
- [x] Add provider capability metadata without direct provider-tool invocation.
- [x] Add schemas, documentation, CLI help, doctor/reconcile/stats support, and examples.
- [x] Add regression tests for sessions, work API, amendments, migration, and fallback.
- [x] Run strict typecheck, production build, quality gates, package inspection, and isolated install.
- [x] Do not publish, commit, or push automatically.
