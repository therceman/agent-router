# Troubleshooting

## Global AGENTS instructions are not active

```bash
echo "${CODEX_HOME:-$HOME/.codex}"
ls -la "${CODEX_HOME:-$HOME/.codex}"/AGENTS*
agent-router doctor --global
```

An `AGENTS.override.md` may shadow the normal global file. Restart Codex after changing global instructions.

## Project is not registered

```bash
cd /path/to/repository
agent-router project register --profile development
```

On another machine, bind existing home-based state:

```bash
agent-router project bind PROJECT-ID "$PWD"
```

## Doctor detects workflow files inside the work repository

Agent Router stores framework state only under `~/.agent-router` and `~/.codex`. Review and manually remove unintended repository-local `.agent-router/`, `.codex/`, or Agent Router-managed blocks after backing up anything important. Agent Router will not remove them automatically.

## A secure task cannot route

Secure-development and security-research profiles require an existing plan reference. Import/create the plan and create the task with `--plan`.

## Sol security review cannot be imported

Complete the Terra verifier gate first. Review order is enforced.


## npm ci hangs during the security-advisory request

Use the project bootstrap command instead of raw `npm ci`:

```bash
npm run bootstrap
```

It executes `npm ci --no-audit --no-fund`; `.npmrc` also disables automatic audit and funding calls. Advisory checking is separate:

```bash
npm run security:audit
```

Use `npm run bootstrap:offline` only when all lockfile packages are already cached. An offline error naming a package such as `undici-types` means the local cache is incomplete, not that the Agent Router source is invalid.

For installation rather than source development, use the local release tarball. It contains compiled `dist/` and no runtime dependencies:

```bash
npm install -g ./therceman-agent-router-0.8.0.tgz --no-audit --no-fund
```
