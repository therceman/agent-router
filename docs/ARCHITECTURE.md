# Architecture

## Core invariant

Agent Router has one storage architecture: home-based zero-footprint state.

```text
~/.codex/         provider configuration consumed by Codex
~/.agent-router/  Agent Router runtime and durable state
work repository/  project source and tests only
```

There is no storage-mode selector. Agent Router always writes Codex integration under `~/.codex` and workflow state under `~/.agent-router`; it never installs workflow metadata into a work repository.

## Components

### Global Codex integration

- `~/.codex/AGENTS.md`: opt-in global orchestration contract in one managed block.
- `~/.codex/agent-router.config.toml`: Luna-low named profile.
- `~/.codex/agents/agent-router-*.toml`: all built-in local role definitions.

Machine setup is profile-agnostic and runs once:

```bash
agent-router setup --provider codex --apply
```

It installs provider integration and every local role. Project profiles are stored only under `~/.agent-router/projects/<project-id>/` and authorize which installed roles may be routed. Installing role files does not invoke a model or consume model tokens.

### Agent Router state

```text
~/.agent-router/
  config.yaml
  projects/<project-id>/
    project.yaml
    policy.yaml
    model-map.yaml
    plans/
    tasks/                 # CLI-managed canonical <task-id>.json records
    contexts/
    handoffs/
    reviews/
    events/events.jsonl
    generated/
    review-packs/
  bindings/machine.json
  contexts/
  review-packs/
  logs/
  backups/
```

Project identity is based on normalized Git remote plus a hash. Machine-specific repository paths are stored separately in bindings.

## Control flow

1. Machine setup installs provider integration and all local built-in roles.
2. Luna bootstraps compact home-based state.
3. The selected project profile determines planning brain, permitted roles, and ordered review gates.
4. Router classifies one bounded task using typed properties and deterministic hard rules.
5. Context builder enforces path and byte budgets.
6. A project- and role-scoped worker session performs one active task at a time and may remain idle for bounded reuse.
7. Worker writes a structured handoff under `~/.agent-router`.
8. Luna runs only declared deterministic checks and validates mechanics.
9. Required independent reviewers run in order.
10. Only after all gates pass may Luna accept the task.

## Trust boundaries

- Luna is trusted for orchestration and mechanical validation, not source implementation or semantic security review.
- Terra is trusted for implementation and ordinary correctness review.
- Sol is used for architecture ambiguity, focused security review, authorized security research, and critical decisions.
- The task schema, context budget, handoff schema, ordered review sequence, and event log are the control plane.

## Profiles

- `development`: external brain, Luna + Luna-xhigh default implementation with Terra-high escalation, external review.
- `secure-development-external-brain`: external plan, Luna-xhigh default implementation with Terra-high escalation/verifier, Sol security review.
- `secure-development-local-brain`: local Sol planning, Luna-xhigh default implementation with Terra-high escalation/verifier, Sol security review.
- `security-research`: authorized research with Terra scout/verifier and Sol researcher/security review.

## Packaging

`dist/` is generated. It is excluded from source Git, built by `prepare`, and included in the npm package via the package `files` list.
