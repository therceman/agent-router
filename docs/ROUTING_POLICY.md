# Routing Policy

Routing is deterministic and explainable. Luna supplies typed task properties; code selects the role/model.

## Task kinds

- `orchestration`, `mechanical` → Luna-low main
- `repository_hygiene` → Luna-low janitor
- `exploration` → Terra-low scout
- `implementation` → Luna-xhigh by default when bounded and strongly testable; `migration`, broad/risky work, rejected work, and `security_sensitive_development` → Terra-high escalation worker
- `verification`, `security_verification` → Terra-high verifier
- `architecture` → Sol-high architect
- `security_research` → Sol-high security researcher
- destructive or immutable-history critical decisions → Sol-xhigh critical reviewer

Security-sensitive development routes implementation directly to Terra-high. Sol reviews the resulting security package rather than writing ordinary implementation code.

## Scout refinement

Broad context or uncertain scope lowers confidence and requires a bounded scout. The scout may not modify implementation files.

## Ordered review gates

The profile, not the implementation route, defines required reviews:

- development: external reviewer;
- secure development: Terra verifier, then Sol security reviewer;
- security research: Terra verifier, then Sol security reviewer;
- critical reviewer: only when escalation rules trigger.
