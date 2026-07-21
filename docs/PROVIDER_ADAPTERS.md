# Provider Adapters

Codex is the first provider.

It generates:

- `~/.codex/agent-router.config.toml` for the Luna-low main session;
- one managed Agent Router block in `~/.codex/AGENTS.md`;
- all built-in local role definitions under `~/.codex/agents/`;
- global Agent Router configuration under `~/.agent-router/`.

Provider setup is profile-agnostic, explicit, backup-aware, idempotent, and reversible. It does not receive or persist a workflow profile. Project registration persists the profile externally and project routing enforces its permitted roles.

Future provider adapters must preserve the home-based zero-footprint invariant, deterministic routing, ordered review gates, and role ownership.

## Persistent session capabilities

The Codex adapter records spawn, send-input, resume, close, wait, and
cross-parent persistence capabilities under Agent Router global state. Agent
Router does not invoke those native provider actions. The main Codex session
performs the returned action and confirms it with `agent-router session
confirm`; failed send-input/resume attempts are reconciled and safely fall back
to a fresh spawn. Capabilities remain `unknown` until observed or configured.
