# Provider Adapters

Codex is the first provider.

It generates:

- `~/.codex/agent-router.config.toml` for the Luna-low main session;
- one managed Agent Router block in `~/.codex/AGENTS.md`;
- all built-in local role definitions under `~/.codex/agents/`;
- global Agent Router configuration under `~/.agent-router/`.

Provider setup is profile-agnostic, explicit, backup-aware, idempotent, and reversible. It does not receive or persist a workflow profile. Project registration persists the profile externally and project routing enforces its permitted roles.

Future provider adapters must preserve the home-based zero-footprint invariant, deterministic routing, ordered review gates, and role ownership.
