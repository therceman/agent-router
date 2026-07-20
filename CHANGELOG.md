# Changelog

## 0.6.0

### Changed

- Luna-xhigh is now the default implementation worker for bounded, well-specified, strongly testable tasks.
- Terra-high is now a distinct implementation escalation worker and remains the ordinary correctness verifier.
- A rejected default implementation escalates once to Terra-high; a second rejected implementation requires an architect review instead of repeated retries.
- Security-sensitive, destructive, historical-data, broad-context, and explicitly escalated implementation routes directly to Terra-high.
- Added explainable implementation tier and attempt metadata to task and route records.
- Added a network-resilient bootstrap path that disables npm advisory calls during dependency installation.
- Added explicit `npm run security:audit` and offline-cache-only bootstrap commands.

### Preserved

- Luna-low long-lived orchestration.
- Terra-high independent correctness verification.
- Sol-high architecture, security review, and authorized security research.
- Sol-xhigh rare critical escalation.
- Home-based zero-footprint project state.

## 0.5.0

### Added

- Added `agent-router task start TASK-ID` for `dispatched → in_progress`.
- Added `agent-router task retry TASK-ID` for guarded recovery from `blocked` or `rejected`.
- Added `agent-router task supersede OLD --by NEW` with replacement validation and `superseded_by` tracking.
- Added `agent-router handoff create TASK-ID --file RESULT.json` to validate and store a worker handoff without a state transition.
- Added `agent-router handoff complete TASK-ID [--file RESULT.json]` to validate/import the handoff and move the task to `worker_complete`.
- Added lifecycle and handoff CLI integration tests.

### Changed

- Canonical task records now use `*.json` instead of JSON content stored in `*.yaml` files.
- Legacy `*.yaml` task records are migrated on first read; duplicate legacy/current records fail closed.
- `task activate` is now reserved for `draft → ready`; `task retry` handles blocked/rejected work.
- Retrying removes stale route, context, handoff, and review artifacts while preserving append-only events.
- Global and generated agent instructions now prohibit direct mutation of Agent Router canonical records.
- Updated task protocol, installation, workflow, and verification documentation.

### Preserved

- Fixed home-based zero-footprint architecture.
- Four workflow profiles.
- Luna-low orchestration, Terra implementation/correctness verification, and bounded Sol planning/security review.
- Source Git without `dist/`; npm package with generated `dist/`.

## 0.4.0

### Changed

- Removed the storage `mode` concept from project, global, and bootstrap records.
- Removed the `agent-router init` command.
- Made `agent-router project register` the only project-registration command.
- Renamed `ExternalProjectRecord` to `ProjectRecord`.
- Renamed `registerExternalProject()` to `registerProject()`.
- Consolidated project schemas and deleted `external-project.schema.json`.
- Added strict unknown-field validation for project state.
- Added cross-platform validation that Agent Router state remains outside the work repository.
- Updated all setup and architecture documentation for the fixed home-based zero-footprint design.
