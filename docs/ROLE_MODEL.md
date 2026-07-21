# Role Model

## Luna-low main

Long-lived coordinator. It selects one task, bootstraps compact state, acquires a compatible worker session, transports only the exact Agent Router command, runs declared tests, validates mechanical evidence, and moves state through legal transitions.

It must not implement code, perform broad exploration, repair worker output, or claim semantic/security review.

## Luna-xhigh implementation worker with Terra-high escalation

Implements one bounded task using TDD, modifies only allowed files, runs targeted tests, writes a handoff, and stops.

## Terra verifier

Performs independent ordinary code-correctness review: behavior, regressions, test quality, scope, false-success paths, and handoff evidence. It does not modify code and does not claim security completeness.

## Terra scout

Read-only bounded discovery for files, symbols, tests, dependencies, and actual scope.

## Sol architect

Creates or reviews a bounded plan where architecture is ambiguous. It does not implement the task.

## Sol security reviewer

Reviews a compact security package for security regressions and trust-boundary defects. It is not the routine code reviewer.

## Sol security researcher

Performs authorized attack-surface and vulnerability reasoning only within explicit scope.

## Sol-xhigh critical reviewer

Escalation-only role for destructive, irreversible, high-impact, or unresolved critical decisions.

## Cost rule

```text
mechanical orchestration         → Luna
bounded implementation           → Luna-xhigh
escalation/correctness            → Terra-high
architecture/security judgment   → Sol
rare critical verdict            → Sol-xhigh
```

All local roles are installed by machine setup so different projects can use different profiles without rerunning setup. Installation only creates configuration; a role consumes model capacity only when a session is invoked. Project profiles remain the authorization boundary for routing and dispatch.
