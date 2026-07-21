# Agent Router

Agent Router is a token-efficient orchestration framework for Codex development and authorized security workflows.

It keeps a cheap long-lived **Luna-low** main session, delegates bounded implementation to **Luna-xhigh**, escalates difficult or rejected implementation to **Terra-high**, and uses **Sol** only where stronger architecture or security reasoning is justified.

Agent Router is **zero-footprint by design**. All framework state lives under the user home directory; work repositories contain only project code and tests.

```text
~/.codex/         Codex profile, global AGENTS.md block, custom agents
~/.agent-router/  project state, plans, tasks, contexts, handoffs, reviews
work repository/  only actual source and test changes
```

It does not create or modify these inside a work repository:

```text
.agent-router/
.codex/
AGENTS.md
.gitignore
.git/info/exclude
```

## Model policy

| Responsibility | Model | Default effort |
|---|---|---:|
| Long-lived orchestration and mechanical gates | GPT-5.6 Luna | low |
| Bounded exploration | GPT-5.6 Terra | low |
| Default bounded implementation | GPT-5.6 Luna | xhigh |
| Escalated/risky implementation | GPT-5.6 Terra | high |
| Ordinary code-correctness verification | GPT-5.6 Terra | high |
| Architecture planning | GPT-5.6 Sol | high |
| Focused security review | GPT-5.6 Sol | high |
| Rare critical review | GPT-5.6 Sol | xhigh |

Sol is not the normal code reviewer. Luna-xhigh performs the default bounded implementation because it offers the best expected cost/intelligence ratio for well-specified, strongly testable tasks. Terra-high is the one-step implementation escalation and the ordinary correctness verifier. Sol is reserved for architecture ambiguity, security reasoning, authorized research, and critical adjudication.

## Workflow profiles

### 1. `development`

For normal development where ChatGPT or the owner supplies the specification.

```text
ChatGPT/owner specification
→ Luna main
→ Luna-xhigh implementation worker
→ Terra-high only after explicit escalation
→ Luna declared tests + mechanical gate
→ compact external review pack
→ external reviewer
→ acceptance
```

Default enabled roles:

```text
main                  Luna-low
implementation_worker            Luna-xhigh
implementation_escalation_worker Terra-high
```

### 2. `secure-development-external-brain`

For a normal software-development project that needs stronger security review. This is not pentesting.

```text
ChatGPT/owner architecture plan
→ Luna main
→ Luna-xhigh implementation worker
→ Terra-high only after explicit escalation
→ Luna declared tests + mechanical gate
→ Terra code-correctness verifier
→ Sol focused security reviewer
→ acceptance
```

### 3. `secure-development-local-brain`

The same secure-development flow, but local Sol is the planning brain instead of external ChatGPT.

```text
Local Sol architect plan
→ Luna main
→ Luna-xhigh implementation worker
→ Terra-high only after explicit escalation
→ Luna declared tests + mechanical gate
→ Terra code-correctness verifier
→ Sol focused security reviewer
→ acceptance
```

Planning Sol and security-review Sol are separate bounded tasks. Luna-xhigh writes bounded implementation by default; Terra-high handles escalation and correctness verification.

### 4. `security-research`

For explicitly authorized pentest or bug-bounty research. It is isolated from development semantics.

```text
Authorized scope + research plan
→ Luna orchestration
→ Terra scout
→ Sol security researcher
→ Terra evidence/verifier gate
→ Sol security review
→ optional Sol-xhigh critical escalation
```

## Install from a Git repository

```bash
git clone <AGENT_ROUTER_REPOSITORY_URL>
cd agent-router
npm run bootstrap
npm run quality-gates
npm install -g .
```

`npm install -g .` runs the package `prepare` script and builds `dist/` locally.

Check:

```bash
agent-router --version
# 0.8.1
```

## Persistent worker sessions

Agent Router 0.8.1 keeps compatible Codex worker sessions idle for bounded
reuse. Run `agent-router session acquire --task TASK-ID --json`, send only the
returned command-only dispatch message, and let the worker load canonical state
with `agent-router work open`. Use `work sync` for amendments and `work reopen`
for an authorized retry. Sessions remain project- and role-scoped and are
retired by policy.

The parent session never places task content in provider transport and Agent
Router never invokes provider-native tools directly.

## Configure Codex globally

Machine setup is profile-agnostic and runs once per machine. It installs the complete local Agent Router role set; it does not select a workflow profile:

```bash
agent-router setup --provider codex --apply
agent-router doctor --global
```

All custom role files under `~/.codex/agents/` are available to the provider, but a project profile still authorizes which roles may be routed for that project. Installing a role does not invoke a model or consume model tokens.

Setup safely updates:

```text
~/.codex/AGENTS.md
~/.codex/agent-router.config.toml
~/.codex/agents/agent-router-*.toml
~/.agent-router/config.yaml
```

Existing `~/.codex/AGENTS.md` content is preserved outside one managed block. Setup supports dry-run, backups, migration from v0.6.0, and rollback:

```bash
agent-router setup --provider codex --dry-run
agent-router setup rollback
agent-router doctor --global
```

If `~/.codex/AGENTS.override.md` exists, Agent Router warns because it can shadow the normal global file.

## Register a work project

```bash
cd /path/to/work-repository

agent-router project register \
  --profile development
```

Or select another profile:

```bash
agent-router project register \
  --profile secure-development-external-brain
```

The same machine setup supports different profiles in different repositories:

```bash
cd ~/git/application
agent-router project register --profile development

cd ~/git/payment-service
agent-router project register --profile secure-development-external-brain

cd ~/git/bugbounty
agent-router project register --profile security-research
```

Registration reads Git identity and stores state externally:

```text
~/.agent-router/projects/<stable-project-id>/
~/.agent-router/bindings/machine.json
```

Verify zero footprint:

```bash
agent-router doctor
agent-router status
```

## Start the Luna main session

```bash
cd /path/to/work-repository
codex --profile agent-router
```

Initial instruction:

```text
Bootstrap Agent Router for the current repository and continue the next bounded task.
Keep the work repository zero-footprint.
```

The global Agent Router contract instructs Luna to run:

```bash
agent-router session bootstrap --cwd "$PWD" --json
```

## Normal development example

```bash
agent-router task create \
  --id DEV-001 \
  --title "Implement parser" \
  --objective "Implement the parser from the approved specification" \
  --kind implementation \
  --allow src/parser.ts \
  --allow tests/parser.test.ts \
  --test "npm test -- parser"

agent-router task activate DEV-001
agent-router task route DEV-001
agent-router context build DEV-001
agent-router task dispatch DEV-001
agent-router task start DEV-001
```

The routed implementation worker writes a temporary worker result and completes the handoff through the CLI:

```bash
agent-router handoff complete DEV-001 --file worker-result.json
```

Luna then runs only the exact declared tests and mechanical checks. It does not move or edit task files manually. For external review:

```bash
agent-router review pack DEV-001
```

The ZIP is created under `~/.agent-router/review-packs/` for external review.


## CLI-managed task lifecycle

All task metadata lives under `~/.agent-router/`. Agents communicate through typed task, context, handoff, and review records, but every lifecycle change is performed by the CLI:

```text
draft → ready → routed → context_ready → dispatched
→ in_progress → worker_complete → review_pending → accepted → done
```

Core commands:

```bash
agent-router task activate TASK-ID
agent-router task route TASK-ID
agent-router context build TASK-ID
agent-router task dispatch TASK-ID
agent-router task start TASK-ID
agent-router task refresh TASK-ID
agent-router handoff complete TASK-ID --file worker-result.json
agent-router review import TASK-ID review.json
agent-router task accept TASK-ID
```

Recovery and replacement:

```bash
agent-router task retry TASK-ID
agent-router task supersede OLD-TASK --by REPLACEMENT-TASK
agent-router provider action next --json
agent-router state transactions --pending --json
agent-router state recover --check --json
```

Canonical task files use `.json`. Legacy JSON-in-`.yaml` task records require the explicit migration command; read-only commands never migrate them. Agents must never use `mv`, `rm`, or direct edits inside `~/.agent-router/projects/`.

## Secure development with external ChatGPT brain

Import the plan prepared in ChatGPT:

```bash
agent-router plan import \
  --id PLAN-001 \
  --title "Secure implementation plan" \
  --author external-chatgpt \
  --file /path/to/plan.md
```

Create a task referencing it:

```bash
agent-router task create \
  --id SECDEV-001 \
  --title "Implement signed callback validation" \
  --objective "Implement the approved plan" \
  --kind security_sensitive_development \
  --plan PLAN-001 \
  --allow src/callback.ts \
  --allow tests/callback.test.ts \
  --test "npm test -- callback"
```

Ordered gates:

```text
Luna-xhigh bounded implementation or Terra-high escalation
→ Luna mechanical gate
→ Terra verifier review
→ Sol security review
```

Generate the Sol package:

```bash
agent-router review pack SECDEV-001 --purpose security
```

Security packs include bounded context snippets, changed files, diff, tests, handoff, route, and prior review records.

## Secure development with local Sol brain

Ask the local `architect` agent for a bounded plan, then persist it:

```bash
agent-router plan create \
  --id PLAN-LOCAL-001 \
  --title "Local Sol architecture plan" \
  --author local-sol \
  --content "<PLAN CONTENT RETURNED BY SOL>"
```

Create tasks with `--plan PLAN-LOCAL-001`. The rest of the flow is identical to secure development: Luna-xhigh implements bounded work by default, Terra-high handles escalation and verifies correctness, and Sol performs focused security review.

## Authorized security-research example

```bash
agent-router project register --profile security-research

agent-router plan import \
  --id RESEARCH-PLAN-001 \
  --title "Authorized test plan" \
  --author owner \
  --file /path/to/authorized-plan.md

agent-router task create \
  --id RESEARCH-001 \
  --title "Analyze authorized attack surface" \
  --objective "Analyze only the explicit authorized scope" \
  --kind security_research \
  --plan RESEARCH-PLAN-001 \
  --allow src/authorized/module.py
```

Research tasks route to Sol security research, not to the development implementation worker.

## Source Git versus npm package

Do **not** commit `dist/` to the source repository.

The source repository should contain:

```text
src/
tests/
schemas/
docs/
examples/
package.json
package-lock.json
TypeScript configs
```

`dist/` is generated and ignored by Git. It is built by `npm run build`; source installation and `npm pack` invoke the package build hooks automatically.

The published or installable npm `.tgz` **does include `dist/`**, because the package binary points to `dist/cli.js`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Installation](docs/INSTALLATION.md)
- [New machine setup](docs/NEW_MACHINE_SETUP.md)
- [New project workflow](docs/NEW_PROJECT_WORKFLOW.md)
- [Development workflow](docs/WORKFLOW_DEVELOPMENT.md)
- [Secure development with external brain](docs/WORKFLOW_SECURE_DEVELOPMENT_EXTERNAL_BRAIN.md)
- [Secure development with local brain](docs/WORKFLOW_SECURE_DEVELOPMENT_LOCAL_BRAIN.md)
- [Authorized security research](docs/WORKFLOW_SECURITY_RESEARCH.md)
- [Role model](docs/ROLE_MODEL.md)
- [Routing policy](docs/ROUTING_POLICY.md)
- [Task protocol](docs/TASK_PROTOCOL.md)
- [External review](docs/EXTERNAL_REVIEW.md)
- [Security](docs/SECURITY.md)

## Development

```bash
npm run bootstrap
npm run typecheck
npm test
npm run quality-gates
npm pack
```

The package runtime uses Node.js built-ins; TypeScript is a development dependency.


## Dependency installation policy

Normal installation uses `npm run bootstrap`, which executes `npm ci --no-audit --no-fund`. npm audit is deliberately separated from dependency installation because advisory endpoints can be slower or unavailable even when the package registry is reachable. Run `npm run security:audit` explicitly when network access is reliable.

Offline bootstrap is supported only when every locked package is already present in the local npm cache:

```bash
npm run bootstrap:offline
```

The shipped npm tarball has zero runtime dependencies and can be installed from a local file without registry access:

```bash
npm install -g ./therceman-agent-router-0.8.1.tgz --no-audit --no-fund
```
