# Installation

## From the source repository

```bash
git clone <REPOSITORY_URL>
cd agent-router
npm run bootstrap
npm run quality-gates
npm install -g .
```

The `prepare` script builds `dist/` automatically before installation from source.

## From an npm tarball

```bash
npm install -g ./agent-router-0.6.0-npm.tgz --no-audit --no-fund
```

## Verify

```bash
agent-router --version
agent-router profile list
```

Expected version: `0.6.0`.

## Configure Codex

Inspect first:

```bash
agent-router setup --provider codex --profile development --dry-run
```

Apply:

```bash
agent-router setup --provider codex --profile development --apply
agent-router doctor --global
```

The command safely manages one block in `~/.codex/AGENTS.md`, a named profile in `~/.codex/agent-router.config.toml`, role files under `~/.codex/agents/`, and state under `~/.agent-router/`.

## Rollback

```bash
agent-router setup rollback
```

Setup creates backups before modifying existing managed files.


## Registry and audit failures

Use `npm run bootstrap`; it runs the lockfile install with `--no-audit --no-fund`. Advisory checks are intentionally separate from installation. Run `npm run security:audit` only when registry advisory endpoints are available. `npm run bootstrap:offline` requires the complete lockfile dependency set to already exist in the local npm cache.
