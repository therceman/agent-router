#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VERSION } from './constants.js';
import { codexSetup, codexSetupRollback, codexSetupStatus } from './provider/codex.js';
import {
  bindProject,
  doctorProject,
  ejectProject,
  registerProject,
  listRegisteredProjects,
  projectStatus,
  syncProject,
  unbindProject,
} from './project.js';
import { bootstrapSession, resolveProjectRuntime } from './state.js';
import { acceptTask, activateTask, createTask, dispatchTask, getTask, listTasks, nextTask, retryTask, routeAndPersist, startTask, supersedeTask, transitionTask } from './task.js';
import type { TaskKind } from './models.js';
import { buildContext, checkContext, readContext } from './context.js';
import { completeHandoff, createHandoff, readHandoff, validateHandoff } from './handoff.js';
import { createProjectReviewPack, createTaskReviewPack, importReview, reviewStatus, type ReviewPackPurpose } from './review.js';
import { applyDietPlan, createDietPlan, inspectRepository } from './repo.js';
import { budgetCheck, budgetShow } from './budget.js';
import { PROFILE_DEFINITIONS, PROFILE_IDS, allInstallableRoles, globalPaths, parseProfile, parseRoleList } from './config.js';
import { pathExists, readJson } from './lib/fs.js';
import { createPlan, getPlan, importPlan, listPlans, type PlanAuthor } from './plan.js';

interface ParsedArgs { positional: string[]; flags: Map<string, string[]>; }

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const item = args[i]!;
    if (!item.startsWith('--')) { positional.push(item); continue; }
    const eq = item.indexOf('=');
    const key = eq >= 0 ? item.slice(2, eq) : item.slice(2);
    let value = eq >= 0 ? item.slice(eq + 1) : 'true';
    if (eq < 0 && args[i + 1] && !args[i + 1]!.startsWith('--')) value = args[++i]!;
    const values = flags.get(key) ?? [];
    values.push(value);
    flags.set(key, values);
  }
  return { positional, flags };
}

function flag(parsed: ParsedArgs, name: string, fallback?: string): string | undefined {
  return parsed.flags.get(name)?.at(-1) ?? fallback;
}
function flags(parsed: ParsedArgs, name: string): string[] { return parsed.flags.get(name) ?? []; }
function bool(parsed: ParsedArgs, name: string): boolean { return parsed.flags.has(name); }
function required(value: string | undefined, label: string): string { if (!value) throw new Error(`Missing required ${label}`); return value; }
function cwd(parsed: ParsedArgs): string | undefined { return flag(parsed, 'project') ?? flag(parsed, 'cwd'); }
function assertAllowedFlags(parsed: ParsedArgs, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = [...parsed.flags.keys()].filter((name) => !allowedSet.has(name));
  if (unknown.length) throw new Error(`Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((name) => `--${name}`).join(', ')}`);
}

function print(value: unknown, json = false): void {
  if (json || typeof value !== 'string') console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

const HELP = `Agent Router ${VERSION}

Usage: agent-router <command> [options]

Profiles:
  profile list
  profile show PROFILE

Global setup:
  setup --provider codex [--apply|--dry-run]
  setup status | setup rollback
  doctor --global [--json]

Zero-footprint projects:
  project register --profile PROFILE [--name NAME] [--id ID] [--roles ...] [--dry-run]
  project bind PROJECT_ID REPOSITORY_PATH
  project unbind PROJECT_ID
  project list
  session bootstrap [--cwd PATH] [--json]
  doctor [--project PATH] [--json]
  status [--project PATH] [--json]
  sync [--project PATH] [--check|--dry-run]
  eject [--project PATH] [--dry-run]

Plans:
  plan create --id ID --title TITLE --author external-chatgpt|owner|local-sol --content TEXT
  plan import --id ID --file FILE --author external-chatgpt|owner|local-sol [--title TITLE]
  plan list
  plan show ID

Tasks:
  task create --id ID --title TITLE --objective TEXT --kind KIND [--plan PLAN] [--allow PATH] [--test COMMAND]
  task list | show ID | next | activate ID | route ID | dispatch ID | start ID
  task retry ID | supersede ID --by REPLACEMENT_ID
  task block ID | cancel ID | accept ID
  route explain ID
  context build|show|check ID
  handoff create ID --file FILE
  handoff complete ID [--file FILE]
  handoff validate|show ID
  review pack ID [--purpose implementation|security|research] [--output FILE]
  review import ID FILE
  review status ID
  project review-pack --base REF --head REF --output FILE

Repository and accounting:
  repo inspect | repo diet plan | repo diet apply --plan FILE --destination DIR --confirm ID
  budget show|check ID
  routing stats
`;

const SETUP_HELP = `Usage:
  agent-router setup [options]

Options:
  --provider <provider>
  --apply
  --dry-run
  --json

Workflow profiles belong to registered projects, not machine setup.
`;

const PROJECT_REGISTER_HELP = `Usage:
  agent-router project register --profile <profile> [options]

Options:
  --profile <profile>
  --name <name>
  --id <project-id>
  --roles <role,...>
  --dry-run
  --json
`;

async function globalDoctor(): Promise<Record<string, unknown>> {
  const paths = globalPaths();
  const status = await codexSetupStatus() as {
    profile_exists?: boolean;
    global_agents_managed?: boolean;
    global_override_exists?: boolean;
    profile_path?: string;
    global_agents_path?: string;
    agents?: string[];
    installed_roles?: string[];
    role_statuses?: Record<string, { exists: boolean; valid: boolean }>;
    main_profile_valid?: boolean;
    global_config?: Record<string, unknown> | null;
  };
  const expectedRoles = allInstallableRoles();
  const expectedAgents = expectedRoles
    .filter((role) => role !== 'main')
    .map((role) => `agent-router-${role.replaceAll('_', '-')}.toml`);
  const availableAgents = new Set(status.agents ?? []);
  const missingAgents = expectedAgents.filter((name) => !availableAgents.has(name));
  const invalidRoleFiles = expectedRoles
    .filter((role) => role !== 'main')
    .filter((role) => !status.role_statuses?.[role]?.exists || !status.role_statuses?.[role]?.valid);
  const installedRoles = new Set(status.installed_roles ?? []);
  const rolesComplete = expectedRoles.every((role) => installedRoles.has(role)) && installedRoles.size === expectedRoles.length;
  const globalConfig = status.global_config;
  const globalConfigObject = globalConfig && typeof globalConfig === 'object' ? globalConfig : {};
  const profileFree = Boolean(globalConfig)
    && !Object.hasOwn(globalConfigObject, 'profile')
    && !Object.hasOwn(globalConfigObject, 'installed_profiles')
    && !Object.hasOwn(globalConfigObject, 'active_profile')
    && !Object.hasOwn(globalConfigObject, 'global_profile')
    && !Object.hasOwn(globalConfigObject, 'setup_profile');
  const checks = [
    { name: 'node_version', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.versions.node },
    { name: 'agent_router_home', ok: await pathExists(paths.root), detail: paths.root },
    { name: 'global_config', ok: await pathExists(resolve(paths.root, 'config.yaml')), detail: resolve(paths.root, 'config.yaml') },
    { name: 'codex_profile', ok: Boolean(status.profile_exists), detail: String(status.profile_path) },
    { name: 'global_agents', ok: Boolean(status.global_agents_managed), detail: String(status.global_agents_path) },
    { name: 'global_agents_not_shadowed', ok: !status.global_override_exists, detail: resolve(paths.codexHome, 'AGENTS.override.md') },
    { name: 'machine_profile_free', ok: profileFree, detail: profileFree ? 'No workflow profile is stored at machine scope' : 'Remove stale setup-level workflow profile metadata' },
    { name: 'installed_version', ok: globalConfig?.installed_version === VERSION, detail: String(globalConfig?.installed_version ?? 'missing') },
    { name: 'installed_roles', ok: rolesComplete, detail: rolesComplete ? expectedRoles.join(', ') : `expected: ${expectedRoles.join(', ')}` },
    { name: 'codex_main_profile', ok: Boolean(status.main_profile_valid), detail: String(status.profile_path) },
    { name: 'custom_agents', ok: missingAgents.length === 0 && invalidRoleFiles.length === 0, detail: missingAgents.length ? `missing: ${missingAgents.join(', ')}` : invalidRoleFiles.length ? `invalid: ${invalidRoleFiles.join(', ')}` : expectedAgents.join(', ') },
  ];
  return { ok: checks.every((check) => check.ok), checks, provider: status };
}

async function routingStats(projectCwd?: string): Promise<Record<string, unknown>> {
  const status = await projectStatus(projectCwd);
  const runtime = await resolveProjectRuntime(projectCwd);
  const eventsPath = resolve(runtime.stateRoot, 'events/events.jsonl');
  const lines = (await pathExists(eventsPath)) ? (await readFile(eventsPath, 'utf8')).split(/\r?\n/).filter(Boolean) : [];
  const events = lines.map((line) => JSON.parse(line) as { type: string; details?: Record<string, unknown> });
  return {
    project_id: runtime.projectId,
    profile: runtime.project.profile,
    tasks: status.tasks,
    events: events.length,
    routed: events.filter((event) => event.type === 'task_transition' && event.details?.route).length,
    note: 'Routing quality statistics become meaningful after outcome records are accumulated.',
  };
}

async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  if (!raw.length || raw[0] === 'help' || raw[0] === '--help' || raw[0] === '-h') { console.log(HELP); return 0; }
  if (raw[0] === '--version' || raw[0] === '-V' || raw[0] === 'version') { console.log(VERSION); return 0; }
  const command = raw[0]!;
  const parsed = parseArgs(raw.slice(1));
  const json = bool(parsed, 'json');
  const projectCwd = cwd(parsed);

  if (command === 'profile') {
    const sub = required(parsed.positional[0], 'profile subcommand');
    if (sub === 'list') { print(PROFILE_IDS.map((id) => PROFILE_DEFINITIONS[id]), json); return 0; }
    if (sub === 'show') { const id = parseProfile(required(parsed.positional[1], 'profile ID')); print(PROFILE_DEFINITIONS[id], json); return 0; }
    throw new Error(`Unknown profile subcommand: ${sub}`);
  }

  if (command === 'setup') {
    if (parsed.flags.has('help')) { console.log(SETUP_HELP); return 0; }
    try {
      assertAllowedFlags(parsed, ['provider', 'apply', 'dry-run', 'json']);
    } catch (error) {
      if (parsed.flags.has('profile')) {
        throw new Error(`${(error as Error).message}\n\nWorkflow profiles belong to projects, not machine setup.\n\nUse:\n  agent-router setup --provider codex --apply\n  agent-router project register --profile development`);
      }
      throw error;
    }
    const provider = flag(parsed, 'provider', 'codex');
    if (provider !== 'codex') throw new Error(`Unsupported provider: ${provider}`);
    const sub = parsed.positional[0];
    if (sub === 'rollback') { print(await codexSetupRollback(), json); return 0; }
    if (sub === 'status') { print(await codexSetupStatus(), json); return 0; }
    print(await codexSetup({ apply: bool(parsed, 'apply'), dryRun: bool(parsed, 'dry-run') || !bool(parsed, 'apply') }), json);
    return 0;
  }

  if (command === 'doctor') {
    const result = bool(parsed, 'global') ? await globalDoctor() : await doctorProject(projectCwd);
    print(result, json); return result.ok ? 0 : 2;
  }
  if (command === 'status') { print(await projectStatus(projectCwd), json); return 0; }
  if (command === 'sync') {
    const result = await syncProject({ cwd: projectCwd, check: bool(parsed, 'check'), dryRun: bool(parsed, 'dry-run') });
    print(result, json); return bool(parsed, 'check') && !(result as { current: boolean }).current ? 2 : 0;
  }
  if (command === 'eject') { print(await ejectProject({ cwd: projectCwd, dryRun: bool(parsed, 'dry-run') }), json); return 0; }

  if (command === 'session') {
    const sub = required(parsed.positional[0], 'session subcommand');
    if (sub === 'bootstrap') { print(await bootstrapSession(projectCwd), true); return 0; }
    throw new Error(`Unknown session subcommand: ${sub}`);
  }

  if (command === 'project') {
    const sub = required(parsed.positional[0], 'project subcommand');
    if (sub === 'register') {
      if (parsed.flags.has('help')) { console.log(PROJECT_REGISTER_HELP); return 0; }
      assertAllowedFlags(parsed, ['profile', 'name', 'id', 'roles', 'dry-run', 'project', 'cwd', 'json']);
      const profile = parseProfile(flag(parsed, 'profile'));
      print(await registerProject({ cwd: projectCwd, dryRun: bool(parsed, 'dry-run'), roles: parseRoleList(flag(parsed, 'roles'), profile), profile, name: flag(parsed, 'name'), projectId: flag(parsed, 'id') }), json);
      return 0;
    }
    if (sub === 'bind') { print(await bindProject(required(parsed.positional[1], 'project ID'), required(parsed.positional[2], 'repository path')), json); return 0; }
    if (sub === 'unbind') { print(await unbindProject(required(parsed.positional[1], 'project ID')), json); return 0; }
    if (sub === 'list') { print(await listRegisteredProjects(), json); return 0; }
    if (sub === 'review-pack') {
      print(await createProjectReviewPack({ base: required(flag(parsed, 'base'), '--base'), head: required(flag(parsed, 'head'), '--head'), output: required(flag(parsed, 'output'), '--output'), cwd: projectCwd }), json); return 0;
    }
    throw new Error(`Unknown project subcommand: ${sub}`);
  }

  if (command === 'plan') {
    const sub = required(parsed.positional[0], 'plan subcommand');
    if (sub === 'create') {
      print(await createPlan({ cwd: projectCwd, id: required(flag(parsed, 'id'), '--id'), title: required(flag(parsed, 'title'), '--title'), author: required(flag(parsed, 'author'), '--author') as PlanAuthor, content: required(flag(parsed, 'content'), '--content') }), json); return 0;
    }
    if (sub === 'import') {
      print(await importPlan({ cwd: projectCwd, id: required(flag(parsed, 'id'), '--id'), title: flag(parsed, 'title'), author: required(flag(parsed, 'author'), '--author') as PlanAuthor, file: required(flag(parsed, 'file'), '--file') }), json); return 0;
    }
    if (sub === 'list') { print(await listPlans(projectCwd), json); return 0; }
    if (sub === 'show') { print(await getPlan(required(parsed.positional[1], 'plan ID'), projectCwd), json); return 0; }
    throw new Error(`Unknown plan subcommand: ${sub}`);
  }

  if (command === 'task') {
    const sub = required(parsed.positional[0], 'task subcommand');
    const id = parsed.positional[1] ?? flag(parsed, 'id');
    if (sub === 'create') {
      const task = await createTask({
        cwd: projectCwd,
        id: required(flag(parsed, 'id'), '--id'),
        title: required(flag(parsed, 'title'), '--title'),
        objective: required(flag(parsed, 'objective'), '--objective'),
        kind: flag(parsed, 'kind', 'implementation') as TaskKind,
        planRef: flag(parsed, 'plan'),
        allowedPaths: flags(parsed, 'allow'),
        acceptance: flags(parsed, 'acceptance'),
        targetedTests: flags(parsed, 'test'),
        checkpointTests: flags(parsed, 'checkpoint-test'),
      });
      print(task, json); return 0;
    }
    if (sub === 'list') { print(await listTasks(projectCwd), json); return 0; }
    if (sub === 'show') { print((await getTask(required(id, 'task ID'), projectCwd)).task, json); return 0; }
    if (sub === 'next') { print(await nextTask(projectCwd), json); return 0; }
    if (sub === 'activate') { print(await activateTask(required(id, 'task ID'), projectCwd), json); return 0; }
    if (sub === 'route') { print(await routeAndPersist(required(id, 'task ID'), projectCwd), json); return 0; }
    if (sub === 'dispatch') { print(await dispatchTask(required(id, 'task ID'), projectCwd), json); return 0; }
    if (sub === 'start') { print(await startTask(required(id, 'task ID'), projectCwd), json); return 0; }
    if (sub === 'retry') { print(await retryTask(required(id, 'task ID'), projectCwd), json); return 0; }
    if (sub === 'supersede') { print(await supersedeTask(required(id, 'task ID'), required(flag(parsed, 'by'), '--by'), projectCwd), json); return 0; }
    if (sub === 'block') { print(await transitionTask(required(id, 'task ID'), 'blocked', projectCwd), json); return 0; }
    if (sub === 'cancel') { print(await transitionTask(required(id, 'task ID'), 'cancelled', projectCwd), json); return 0; }
    if (sub === 'accept') { print(await acceptTask(required(id, 'task ID'), projectCwd), json); return 0; }
    throw new Error(`Unknown task subcommand: ${sub}`);
  }

  if (command === 'route') {
    const sub = required(parsed.positional[0], 'route subcommand');
    const id = required(parsed.positional[1], 'task ID');
    if (sub === 'explain') {
      const { stateRoot } = await getTask(id, projectCwd);
      print(await readJson(resolve(stateRoot, 'generated', `${id}.route.json`)), json); return 0;
    }
    throw new Error(`Unknown route subcommand: ${sub}`);
  }

  if (command === 'context') {
    const sub = required(parsed.positional[0], 'context subcommand');
    const id = required(parsed.positional[1], 'task ID');
    if (sub === 'build') { print(await buildContext(id, projectCwd), json); return 0; }
    if (sub === 'show') { print(await readContext(id, projectCwd), json); return 0; }
    if (sub === 'check') { const result = await checkContext(id, projectCwd); print(result, json); return result.ok ? 0 : 2; }
    throw new Error(`Unknown context subcommand: ${sub}`);
  }

  if (command === 'handoff') {
    const sub = required(parsed.positional[0], 'handoff subcommand');
    const id = required(parsed.positional[1], 'task ID');
    if (sub === 'create') { print(await createHandoff(id, required(flag(parsed, 'file'), '--file'), projectCwd), json); return 0; }
    if (sub === 'complete') { print(await completeHandoff(id, flag(parsed, 'file'), projectCwd), json); return 0; }
    if (sub === 'validate') { print(await validateHandoff(id, projectCwd), json); return 0; }
    if (sub === 'show') { print(await readHandoff(id, projectCwd), json); return 0; }
    throw new Error(`Unknown handoff subcommand: ${sub}`);
  }

  if (command === 'review') {
    const sub = required(parsed.positional[0], 'review subcommand');
    const id = required(parsed.positional[1], 'task ID');
    if (sub === 'pack') { print(await createTaskReviewPack(id, flag(parsed, 'output'), projectCwd, flag(parsed, 'purpose') as ReviewPackPurpose | undefined), json); return 0; }
    if (sub === 'import') { print(await importReview(id, required(parsed.positional[2], 'review file'), projectCwd), json); return 0; }
    if (sub === 'status') { print(await reviewStatus(id, projectCwd), json); return 0; }
    throw new Error(`Unknown review subcommand: ${sub}`);
  }

  if (command === 'repo') {
    const sub = required(parsed.positional[0], 'repo subcommand');
    if (sub === 'inspect') { print(await inspectRepository(projectCwd), json); return 0; }
    if (sub === 'diet' && parsed.positional[1] === 'plan') { print(await createDietPlan(projectCwd), json); return 0; }
    if (sub === 'diet' && parsed.positional[1] === 'apply') {
      print(await applyDietPlan({ planPath: required(flag(parsed, 'plan'), '--plan'), destination: required(flag(parsed, 'destination'), '--destination'), confirm: required(flag(parsed, 'confirm'), '--confirm'), cwd: projectCwd }), json); return 0;
    }
    throw new Error(`Unknown repo subcommand: ${parsed.positional.join(' ')}`);
  }

  if (command === 'budget') {
    const sub = required(parsed.positional[0], 'budget subcommand');
    const id = required(parsed.positional[1], 'task ID');
    if (sub === 'show') { print(await budgetShow(id, projectCwd), json); return 0; }
    if (sub === 'check') { const result = await budgetCheck(id, projectCwd); print(result, json); return result.ok ? 0 : 2; }
    throw new Error(`Unknown budget subcommand: ${sub}`);
  }

  if (command === 'routing' && parsed.positional[0] === 'stats') { print(await routingStats(projectCwd), json); return 0; }

  throw new Error(`Unknown command: ${command}`);
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`agent-router: ${(error as Error).message}`);
  process.exitCode = 1;
});
