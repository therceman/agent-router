import type { ProfileId } from './config.js';

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
  schema_version: 1;
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
