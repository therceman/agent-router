# New Machine Setup

```bash
git clone <AGENT_ROUTER_REPOSITORY_URL>
cd agent-router
npm run bootstrap
npm run quality-gates
npm install -g .
```

Install the profiles needed on this machine. Setup accumulates role definitions and does not remove agents installed by earlier profile setup.

```bash
agent-router setup --provider codex --profile development --apply
agent-router setup --provider codex --profile secure-development-external-brain --apply
agent-router setup --provider codex --profile secure-development-local-brain --apply
agent-router setup --provider codex --profile security-research --apply
```

Installing only one profile is valid.

```bash
agent-router doctor --global
```

For an existing registered project cloned on the new machine:

```bash
cd /path/to/work-repository
agent-router project bind <PROJECT_ID> "$PWD"
agent-router doctor
```

The binding is machine-local. No project files are created.
