# New Machine Setup

```bash
git clone <AGENT_ROUTER_REPOSITORY_URL>
cd agent-router
npm run bootstrap
npm run quality-gates
npm install -g .
```

Configure the machine once. Setup is profile-agnostic and installs every built-in local role. Workflow profiles are selected only when projects are registered.

```bash
agent-router setup --provider codex --apply
agent-router doctor --global
```

Installing all roles does not invoke agents or consume model tokens. Project profiles still constrain routing and dispatch.

For an existing registered project cloned on the new machine:

```bash
cd /path/to/work-repository
agent-router project bind <PROJECT_ID> "$PWD"
agent-router doctor
```

The binding is machine-local. No project files are created.
