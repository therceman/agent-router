import type { ProfileId, RoleId } from './config.js';

export type TaskKind =
  | 'orchestration'
  | 'mechanical'
  | 'repository_hygiene'
  | 'exploration'
  | 'implementation'
  | 'migration'
  | 'verification'
  | 'architecture'
  | 'security_sensitive_development'
  | 'security_research'
  | 'security_verification';

export type TaskState =
  | 'draft'
  | 'ready'
  | 'routed'
  | 'context_ready'
  | 'dispatched'
  | 'in_progress'
  | 'worker_complete'
  | 'review_pending'
  | 'accepted'
  | 'done'
  | 'blocked'
  | 'rejected'
  | 'cancelled'
  | 'superseded';

export interface TaskProfile {
  task_kind: TaskKind;
  ambiguity: number;
  semantic_complexity: number;
  security_criticality: number;
  blast_radius: number;
  novelty: number;
  verification_strength: number;
  context_scope: number;
  destructive_potential: number;
  historical_data_impact: number;
}

export interface TaskScope {
  allowed_paths: string[];
  forbidden_paths: string[];
}

export interface TaskBudgets {
  maximum_files_read: number;
  maximum_context_bytes: number;
  maximum_single_file_bytes: number;
  maximum_tool_output_chars: number;
  repository_wide_scan: boolean;
  full_test_suite: boolean;
  recursive_delegation: boolean;
}

export interface TaskRecord {
  schema_version: 1 | 2;
  task_id: string;
  title: string;
  profile: ProfileId;
  state: TaskState;
  objective: string;
  plan_ref?: string;
  superseded_by?: string;
  execution?: {
    implementation_tier: 'default' | 'escalated';
    attempt: number;
    escalation_reason?: string;
  };
  task_profile: TaskProfile;
  scope: TaskScope;
  budgets: TaskBudgets;
  acceptance: string[];
  tests: { targeted: string[]; checkpoint: string[] };
  manual_verification: string[];
  outputs: string[];
  review: { required: boolean; required_roles: string[]; sequence: string[] };
  created_at: string;
  updated_at: string;
  /** v0.8 revision fields are optional in the type so v0.7 fixtures can be read before migration. */
  revision?: number;
  previous_revision?: number | null;
  latest_amendment_id?: string;
  effective_contract_sha256?: string;
  last_assignment_id?: string;
  last_session_id?: string;
  legacy_unassigned?: boolean;
  route_revision?: number;
  context_revision?: number;
  derived_state_status?: 'current' | 'stale';
}

export interface TaskContract {
  task_id: string;
  title: string;
  profile: ProfileId;
  objective: string;
  plan_ref?: string;
  task_profile: TaskProfile;
  scope: TaskScope;
  budgets: TaskBudgets;
  acceptance: string[];
  tests: { targeted: string[]; checkpoint: string[] };
  manual_verification: string[];
  outputs: string[];
  review: { required: boolean; required_roles: string[]; sequence: string[] };
}

export interface RouteRecord {
  schema_version: 1;
  task_id: string;
  role: string;
  model_class: 'cheap' | 'balanced' | 'expert';
  provider_model: string;
  reasoning: 'low' | 'medium' | 'high' | 'xhigh';
  confidence: number;
  hard_rules: string[];
  explanation: Record<string, string | number | boolean>;
  scout_required: boolean;
  review: {
    required: boolean;
    required_roles: string[];
    escalation: string[];
  };
  budget: TaskBudgets;
  created_at: string;
  task_revision?: number;
  effective_contract_sha256?: string;
  phase?: AssignmentPhase;
  approval_policy?: string;
  sandbox_mode?: 'read-only' | 'workspace-write';
}

export interface ContextFile {
  path: string;
  bytes: number;
  sha256: string;
  excerpt: string;
}

export interface ContextBundle {
  schema_version: 1;
  task_id: string;
  route_path: string;
  files: ContextFile[];
  total_bytes: number;
  excluded: Array<{ path: string; reason: string }>;
  budget: TaskBudgets;
  created_at: string;
  task_revision?: number;
  effective_contract_sha256?: string;
  phase?: AssignmentPhase;
  role?: RoleId;
}

export interface HandoffRecord {
  schema_version: 1;
  task_id: string;
  status: 'worker_complete';
  agent: {
    role: string;
    model_class: string;
    provider_model: string;
    reasoning: string;
  };
  files_read: string[];
  files_changed: string[];
  tests: Array<{ command: string; exit_code: number; passed?: number; failed?: number }>;
  manual_checks: Array<{ description: string; result: 'passed' | 'failed' | 'blocked' }>;
  budget: {
    files_read: number;
    context_bytes: number;
    tool_output_chars: number;
    repository_wide_scan_used: boolean;
    full_test_suite_used: boolean;
  };
  known_risks: string[];
  unresolved_questions: string[];
  recommended_next_action: string;
  session_id?: string;
  assignment_id?: string;
  task_revision?: number;
  effective_contract_sha256?: string;
}

export type ReviewVerdict =
  | 'accepted'
  | 'rejected'
  | 'accepted_with_followup'
  | 'blocked'
  | 'architect_review_required'
  | 'critical_review_required';

export interface ReviewRecord {
  schema_version: 1;
  task_id: string;
  reviewer: { type?: string; role: string; model_class?: string; provider_model?: string; reasoning?: string };
  verdict: ReviewVerdict;
  acceptance_criteria?: Array<{ criterion: string; result: 'passed' | 'failed'; evidence?: string }>;
  tests_verified?: boolean;
  manual_checks_verified?: boolean;
  scope_verified?: boolean;
  unrelated_changes_found?: boolean;
  false_success_paths_found?: boolean;
  required_followups: string[];
  risks: string[];
  findings?: string[];
  required_changes?: string[];
}

export interface EventRecord {
  schema_version: 1;
  event_id: string;
  task_id?: string;
  type: string;
  from_state?: TaskState;
  to_state?: TaskState;
  at: string;
  details?: Record<string, unknown>;
}

export type SessionStatus =
  | 'pending_spawn' | 'idle' | 'reserved' | 'busy' | 'stale' | 'retiring' | 'retired' | 'failed';

export type SessionRetireReason =
  | 'explicit' | 'task_limit' | 'failure_limit' | 'idle_timeout' | 'implementation_rejected'
  | 'scope_violation' | 'handoff_validation_failed' | 'model_changed' | 'reasoning_changed'
  | 'role_changed' | 'repository_changed' | 'sandbox_changed' | 'approval_policy_changed'
  | 'provider_agent_unavailable' | 'resume_failed' | 'session_corrupt' | 'project_unbound'
  | 'project_ejected' | 'campaign_complete' | 'critical_freshness_policy';

export interface SessionRecord {
  schema_version: 1;
  session_id: string;
  project_id: string;
  provider: 'codex';
  provider_agent_id?: string;
  role: RoleId;
  model_class: 'cheap' | 'balanced' | 'expert';
  provider_model: string;
  reasoning: 'low' | 'medium' | 'high' | 'xhigh';
  repository_root: string;
  sandbox_mode: 'read-only' | 'workspace-write';
  approval_policy: string;
  status: SessionStatus;
  current_phase?: AssignmentPhase;
  current_assignment_id?: string;
  assigned_task?: string;
  assigned_revision?: number;
  acknowledged_revision?: number;
  compatibility_key: string;
  tasks_completed: number;
  failed_tasks: number;
  rejected_tasks: number;
  created_at: string;
  updated_at: string;
  last_used_at: string;
  idle_since?: string;
  lease_expires_at?: string;
  retire_reason?: SessionRetireReason;
  retired_at?: string;
  last_transport_action?: 'spawn' | 'send_input' | 'resume';
  last_transport_result?: 'pending' | 'succeeded' | 'failed';
  last_transport_error?: string;
}

export type AssignmentStatus =
  | 'pending_transport' | 'transport_confirmed' | 'acknowledged' | 'completed'
  | 'blocked' | 'relinquished' | 'stale' | 'cancelled';

export type AssignmentPhase = 'primary' | 'review';
export type AssignmentTransportStatus = 'pending' | 'succeeded' | 'failed';
export type AssignmentWorkStatus = 'reserved' | 'acknowledged' | 'completed' | 'blocked' | 'relinquished' | 'stale' | 'cancelled';

export interface AssignmentRecord {
  schema_version: 1 | 2;
  assignment_id: string;
  project_id: string;
  task_id: string;
  task_revision: number;
  effective_contract_sha256?: string;
  session_id: string;
  phase?: AssignmentPhase;
  role: RoleId;
  route_sha256: string;
  context_sha256: string;
  transport_action: 'spawn' | 'send_input' | 'resume';
  provider_agent_id?: string;
  dispatch_command: string;
  dispatch_message: string;
  status: AssignmentStatus;
  work_status?: AssignmentWorkStatus;
  transport_status?: AssignmentTransportStatus;
  sync_required?: boolean;
  created_at: string;
  updated_at: string;
  transport_confirmed_at?: string;
  acknowledged_at?: string;
  completed_at?: string;
  failure_code?: string;
  failure_detail?: string;
}

export interface PhaseRouteRecord {
  schema_version: 1;
  task_id: string;
  task_revision: number;
  effective_contract_sha256: string;
  phase: AssignmentPhase;
  role: RoleId;
  model_class: 'cheap' | 'balanced' | 'expert';
  provider_model: string;
  reasoning: 'low' | 'medium' | 'high' | 'xhigh';
  sandbox_mode: 'read-only' | 'workspace-write';
  approval_policy: string;
  created_at: string;
}

export interface PhaseContextRecord {
  schema_version: 1;
  task_id: string;
  task_revision: number;
  effective_contract_sha256: string;
  phase: AssignmentPhase;
  role: RoleId;
  files: ContextFile[];
  total_bytes: number;
  excluded: Array<{ path: string; reason: string }>;
  budget: TaskBudgets;
  created_at: string;
}

export interface TaskAmendmentRecord {
  schema_version: 1;
  amendment_id: string;
  task_id: string;
  from_revision: number;
  to_revision: number;
  amendment_kind: 'owner_change' | 'scope_change' | 'acceptance_change' | 'test_change' | 'review_feedback' | 'retry' | 'clarification';
  source: 'owner' | 'external_chatgpt' | 'main' | 'verifier' | 'security_reviewer' | 'critical_reviewer' | 'system';
  changes: {
    objective?: string;
    allowed_paths_add?: string[]; allowed_paths_remove?: string[];
    forbidden_paths_add?: string[]; forbidden_paths_remove?: string[];
    acceptance_add?: string[]; acceptance_remove?: string[];
    targeted_tests_add?: string[]; targeted_tests_remove?: string[];
    checkpoint_tests_add?: string[]; checkpoint_tests_remove?: string[];
    manual_verification_add?: string[]; manual_verification_remove?: string[];
    review_feedback?: string[]; required_changes?: string[]; notes?: string[];
  };
  source_review_role?: string;
  source_review_sha256?: string;
  previous_contract_sha256: string;
  resulting_contract_sha256: string;
  created_at: string;
}

export interface SessionEventRecord {
  schema_version: 1;
  event_id: string;
  project_id: string;
  session_id: string;
  task_id?: string;
  assignment_id?: string;
  type: string;
  from_status?: SessionStatus;
  to_status?: SessionStatus;
  at: string;
  details?: Record<string, unknown>;
}

export interface SessionPolicy {
  enabled: true;
  maximum_tasks_per_session: number;
  maximum_failed_tasks: number;
  maximum_rejected_tasks: number;
  maximum_idle_minutes: number;
  retire_after_implementation_rejection: boolean;
  reuse_across_projects: false;
  reuse_across_roles: false;
  maximum_parallel_tasks_per_session: 1;
  overflow_sessions: { enabled: boolean; maximum_per_role: number; persistent: false };
  role_policies: Partial<Record<RoleId, { persistent: boolean; maximum_tasks_per_session?: number; maximum_idle_minutes?: number; fresh_session_required?: boolean }>>;
}

export interface WorkResultEnvelope {
  schema_version: 1;
  task_id: string;
  task_revision: number;
  session_id: string;
  assignment_id: string;
  role: RoleId;
  result_kind: 'implementation_handoff' | 'verification_review' | 'security_review' | 'critical_review' | 'architecture_decision' | 'scout_discovery' | 'repository_hygiene_report' | 'security_research_result';
  payload: unknown;
}

export interface ProviderSessionCapabilities {
  provider: 'codex';
  spawn: boolean;
  send_input: boolean;
  resume: boolean | 'unknown';
  close: boolean;
  wait: boolean;
  persistent_across_parent_restart: boolean | 'unknown';
  detected_at: string;
  source: 'configured' | 'manual-smoke-test' | 'runtime-observation';
}

export interface ProviderActionRecord {
  schema_version: 1;
  action_id: string;
  provider: 'codex';
  action: 'close';
  project_id: string;
  session_id: string;
  provider_agent_id: string;
  reason: SessionRetireReason;
  status: 'pending' | 'confirmed' | 'failed';
  created_at: string;
  updated_at: string;
  confirmed_at?: string;
  failed_at?: string;
  failure_detail?: string;
}

export interface StateTransactionRecord {
  schema_version: 1;
  transaction_id: string;
  project_id: string;
  operation: string;
  status: 'prepared' | 'committing' | 'committed' | 'rolling_back' | 'rolled_back' | 'recovery_required';
  created_at: string;
  updated_at: string;
  operations: Array<{
    kind: 'write' | 'move' | 'remove';
    target: string;
    staged_path?: string;
    backup_path?: string;
    before_sha256?: string | null;
    after_sha256?: string | null;
  }>;
  error?: string;
}
