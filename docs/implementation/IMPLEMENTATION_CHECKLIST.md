# Agent Router v0.6.0 Implementation Checklist

- [x] Make Luna-xhigh the default bounded implementation worker.
- [x] Add Terra-high implementation escalation role and Codex profile.
- [x] Route security-sensitive, destructive, historical-data, broad-context, and explicit escalation work to Terra-high.
- [x] Persist implementation tier and attempt metadata.
- [x] Escalate one rejected Luna implementation to Terra-high.
- [x] Stop after a rejected Terra escalation and require architect review.
- [x] Preserve Terra-high independent correctness verification.
- [x] Preserve Sol-high architecture/security roles and Sol-xhigh critical review.
- [x] Add audit-free dependency bootstrap and explicit security audit command.
- [x] Add regression tests for model routing, escalation, bootstrap, and zero runtime dependencies.
- [x] Run strict typecheck, build, automated tests, npm pack, and isolated install verification.
