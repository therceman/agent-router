# Provider Adapters

Codex is the first provider.

It generates:

- `~/.codex/agent-router.config.toml` for the Luna-low main session;
- one managed Agent Router block in `~/.codex/AGENTS.md`;
- role definitions under `~/.codex/agents/`;
- global Agent Router configuration under `~/.agent-router/`.

Provider setup is explicit, plan-first, backup-aware, and reversible. Installing another workflow profile accumulates required custom-agent files rather than deleting previously installed roles.

Future provider adapters must preserve the home-based zero-footprint invariant, deterministic routing, ordered review gates, and role ownership.
