import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface GlobalPaths {
  root: string;
  config: string;
  data: string;
  cache: string;
  projects: string;
  bindings: string;
  contexts: string;
  reviewPacks: string;
  logs: string;
  backups: string;
  codexHome: string;
}

export function globalPaths(env = process.env): GlobalPaths {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const root = resolve(env.AGENT_ROUTER_HOME ?? resolve(home, '.agent-router'));
  const codexHome = resolve(env.CODEX_HOME ?? resolve(home, '.codex'));
  return {
    root,
    config: root,
    data: root,
    cache: resolve(root, 'cache'),
    projects: resolve(root, 'projects'),
    bindings: resolve(root, 'bindings'),
    contexts: resolve(root, 'contexts'),
    reviewPacks: resolve(root, 'review-packs'),
    logs: resolve(root, 'logs'),
    backups: resolve(root, 'backups'),
    codexHome,
  };
}

export const PROFILE_IDS = [
  'development',
  'secure-development-external-brain',
  'secure-development-local-brain',
  'security-research',
] as const;
export type ProfileId = typeof PROFILE_IDS[number];

export const ROLE_IDS = [
  'main',
  'repo_janitor',
  'scout',
  'implementation_worker',
  'implementation_escalation_worker',
  'verifier',
  'architect',
  'security_reviewer',
  'security_researcher',
  'critical_reviewer',
] as const;
export type RoleId = typeof ROLE_IDS[number];

export const ROLE_METADATA: Record<RoleId, {
  name: string;
  description: string;
  developer_instructions: string;
  sandbox_mode: 'read-only' | 'workspace-write';
}> = {
  main: {
    name: 'agent_router_main',
    description: 'Long-lived Luna-low orchestration session. Never implements production code.',
    developer_instructions: 'Orchestrate only. Do not implement production code, perform broad scans, duplicate worker work, or repair rejected work. Use bounded tasks and structured handoffs.',
    sandbox_mode: 'read-only',
  },
  repo_janitor: {
    name: 'agent_router_repo_janitor',
    description: 'Plan-first repository hygiene agent.',
    developer_instructions: 'Inspect and classify repository artifacts. Never delete ambiguous evidence. Do not implement product code.',
    sandbox_mode: 'read-only',
  },
  scout: {
    name: 'agent_router_scout',
    description: 'Read-only bounded codebase exploration agent.',
    developer_instructions: 'Identify relevant files, symbols, tests, dependencies, scope, and risks. Return a compact context summary. Do not modify implementation files.',
    sandbox_mode: 'read-only',
  },
  implementation_worker: {
    name: 'agent_router_implementation_worker',
    description: 'Default Luna-xhigh bounded TDD implementation agent.',
    developer_instructions: 'Implement exactly one bounded, well-specified task using TDD. Modify only allowed paths, run targeted tests, perform required manual checks, write a structured handoff, and stop. Do not delegate recursively. If the task exceeds scope, requires broad context, becomes security-sensitive, or fails verification, stop and request Terra-high escalation instead of repeatedly retrying.',
    sandbox_mode: 'workspace-write',
  },
  implementation_escalation_worker: {
    name: 'agent_router_implementation_escalation_worker',
    description: 'Terra-high implementation escalation agent for risky, broad, ambiguous, or rejected work.',
    developer_instructions: 'Implement exactly one escalated engineering task using TDD. Use the prior task, failure evidence, verifier feedback, and bounded context. Modify only allowed paths, run targeted tests, write a structured handoff, and stop. Do not delegate recursively.',
    sandbox_mode: 'workspace-write',
  },
  verifier: {
    name: 'agent_router_verifier',
    description: 'Independent Terra-high implementation verifier.',
    developer_instructions: 'Review code correctness, behavior regressions, test quality, scope, and handoff evidence. Do not fix implementation. Return one explicit verdict. Do not substitute for the Sol security reviewer.',
    sandbox_mode: 'read-only',
  },
  architect: {
    name: 'agent_router_architect',
    description: 'Sol-high local planning and architecture brain.',
    developer_instructions: 'Create or review a bounded implementation plan, resolve architecture questions, and return explicit decisions and acceptance criteria. Do not perform the implementation.',
    sandbox_mode: 'read-only',
  },
  security_reviewer: {
    name: 'agent_router_security_reviewer',
    description: 'Sol-high security review for development changes.',
    developer_instructions: 'Review a compact security package for security regressions, trust-boundary mistakes, unsafe defaults, authorization errors, injection paths, secret exposure, and missing negative tests. Do not perform ordinary style review and do not rewrite the implementation.',
    sandbox_mode: 'read-only',
  },
  security_researcher: {
    name: 'agent_router_security_researcher',
    description: 'Sol-high authorized security-research analyst.',
    developer_instructions: 'Work only inside the explicitly authorized scope. Analyze attack surface, reachability, attacker control, root cause, impact, and safe verification requirements. Do not broaden scope or run destructive tests.',
    sandbox_mode: 'read-only',
  },
  critical_reviewer: {
    name: 'agent_router_critical_reviewer',
    description: 'Sol-xhigh reviewer for rare critical or irreversible decisions.',
    developer_instructions: 'Review only bounded destructive, immutable-history, critical-policy, high-impact security, or unresolved decisions. Require evidence and explicit stop conditions.',
    sandbox_mode: 'read-only',
  },
};

export interface ProfileDefinition {
  id: ProfileId;
  title: string;
  description: string;
  brain: 'external-chatgpt' | 'local-sol' | 'security-research';
  roles: RoleId[];
  required_review_roles: string[];
  requires_plan: boolean;
  review_pack_purpose: 'implementation' | 'security' | 'research';
}

export const PROFILE_DEFINITIONS: Record<ProfileId, ProfileDefinition> = {
  development: {
    id: 'development',
    title: 'Development',
    description: 'External ChatGPT/owner supplies the specification; Luna orchestrates; Luna-xhigh implements bounded work; Terra-high handles escalation and external review accepts the task.',
    brain: 'external-chatgpt',
    roles: ['main', 'implementation_worker', 'implementation_escalation_worker'],
    required_review_roles: ['external_reviewer'],
    requires_plan: false,
    review_pack_purpose: 'implementation',
  },
  'secure-development-external-brain': {
    id: 'secure-development-external-brain',
    title: 'Secure development with external brain',
    description: 'ChatGPT/owner supplies the plan; Luna orchestrates and runs mechanical gates; Luna-xhigh implements bounded work; Terra-high handles risky work and verifies; Sol performs a focused security review.',
    brain: 'external-chatgpt',
    roles: ['main', 'implementation_worker', 'implementation_escalation_worker', 'verifier', 'security_reviewer'],
    required_review_roles: ['verifier', 'security_reviewer'],
    requires_plan: true,
    review_pack_purpose: 'security',
  },
  'secure-development-local-brain': {
    id: 'secure-development-local-brain',
    title: 'Secure development with local Sol brain',
    description: 'Local Sol architect creates the plan; Luna orchestrates and runs mechanical gates; Luna-xhigh implements bounded work; Terra-high handles risky work and verifies; Sol performs a separate security review.',
    brain: 'local-sol',
    roles: ['main', 'architect', 'implementation_worker', 'implementation_escalation_worker', 'verifier', 'security_reviewer'],
    required_review_roles: ['verifier', 'security_reviewer'],
    requires_plan: true,
    review_pack_purpose: 'security',
  },
  'security-research': {
    id: 'security-research',
    title: 'Authorized security research / pentest',
    description: 'Distinct authorized research workflow: Luna orchestrates, Terra scouts and verifies evidence, Sol performs security research, and critical decisions receive Sol-xhigh review.',
    brain: 'security-research',
    roles: ['main', 'scout', 'security_researcher', 'verifier', 'security_reviewer', 'critical_reviewer'],
    required_review_roles: ['verifier', 'security_reviewer'],
    requires_plan: true,
    review_pack_purpose: 'research',
  },
};

export function parseProfile(value?: string): ProfileId {
  const profile = (value ?? 'development') as ProfileId;
  if (!PROFILE_IDS.includes(profile)) throw new Error(`Unknown profile: ${profile}. Available: ${PROFILE_IDS.join(', ')}`);
  return profile;
}

export function parseRoleList(value?: string, profile: ProfileId = 'development'): RoleId[] {
  if (!value) return [...PROFILE_DEFINITIONS[profile].roles];
  if (value.trim().toLowerCase() === 'all') return [...ROLE_IDS];
  const aliases: Record<string, RoleId> = {
    'repo-janitor': 'repo_janitor',
    'implementation-worker': 'implementation_worker',
    'implementation-escalation-worker': 'implementation_escalation_worker',
    'security-reviewer': 'security_reviewer',
    'security-researcher': 'security_researcher',
    'critical-reviewer': 'critical_reviewer',
  };
  const roles = value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => aliases[item] ?? item as RoleId);
  const invalid = roles.filter((role) => !ROLE_IDS.includes(role));
  if (invalid.length) throw new Error(`Unknown roles: ${invalid.join(', ')}`);
  const unique = [...new Set(roles)];
  if (!unique.includes('main')) unique.unshift('main');
  return unique;
}

export const DEFAULT_MODEL_MAP = {
  schema_version: 1,
  models: {
    cheap: { provider_model: 'gpt-5.6-luna' },
    balanced: { provider_model: 'gpt-5.6-terra' },
    expert: { provider_model: 'gpt-5.6-sol' },
  },
  roles: {
    main: { model: 'cheap', reasoning: 'low' },
    repo_janitor: { model: 'cheap', reasoning: 'low' },
    scout: { model: 'balanced', reasoning: 'low' },
    implementation_worker: { model: 'cheap', reasoning: 'xhigh' },
    implementation_escalation_worker: { model: 'balanced', reasoning: 'high' },
    verifier: { model: 'balanced', reasoning: 'high' },
    architect: { model: 'expert', reasoning: 'high' },
    security_reviewer: { model: 'expert', reasoning: 'high' },
    security_researcher: { model: 'expert', reasoning: 'high' },
    critical_reviewer: { model: 'expert', reasoning: 'xhigh' },
  },
} as const;

export function policyForProfile(profile: ProfileId): Record<string, unknown> {
  const definition = PROFILE_DEFINITIONS[profile];
  return {
    schema_version: 1,
    profile,
    zero_footprint: true,
    brain: definition.brain,
    concurrency: { max_threads: 2, max_depth: 1 },
    context: {
      maximum_files: 12,
      maximum_total_bytes: 150000,
      maximum_single_file_bytes: 50000,
      maximum_tool_output_chars: 16000,
      repository_wide_scan: false,
      include_generated_files: false,
      include_archives: false,
      include_binary_files: false,
      include_gitignored_files: false,
    },
    workflow: {
      main_may_implement: false,
      main_may_run_declared_tests: true,
      main_review_kind: 'mechanical_gate_only',
      required_review_roles: definition.required_review_roles,
      requires_plan: definition.requires_plan,
      review_pack_purpose: definition.review_pack_purpose,
    },
  };
}
