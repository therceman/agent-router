import type { RouteRecord, TaskRecord } from './models.js';

const MODELS = {
  cheap: 'gpt-5.6-luna',
  balanced: 'gpt-5.6-terra',
  expert: 'gpt-5.6-sol',
} as const;

function implementationNeedsTerra(task: TaskRecord): boolean {
  const p = task.task_profile;
  if (task.execution?.implementation_tier === 'escalated') return true;
  if (p.task_kind === 'security_sensitive_development') return true;
  if (p.destructive_potential >= 2 || p.historical_data_impact >= 2) return true;
  if (p.context_scope >= 3 || p.ambiguity >= 3) return true;
  if (p.security_criticality >= 3) return true;
  return false;
}

export function routeTask(task: TaskRecord): RouteRecord {
  const p = task.task_profile;
  const hardRules: string[] = [];
  let role = 'implementation_worker';
  let modelClass: RouteRecord['model_class'] = 'cheap';
  let reasoning: RouteRecord['reasoning'] = 'xhigh';
  let confidence = 0.91;
  let scoutRequired = false;

  if (p.destructive_potential >= 3 || p.historical_data_impact >= 3) {
    role = 'critical_reviewer';
    modelClass = 'expert';
    reasoning = 'xhigh';
    confidence = 0.98;
    hardRules.push('critical_or_irreversible_decision');
  } else if (p.task_kind === 'security_research') {
    role = 'security_researcher';
    modelClass = 'expert';
    reasoning = 'high';
    confidence = 0.96;
    hardRules.push('authorized_security_research');
  } else if (p.task_kind === 'security_verification') {
    role = 'verifier';
    modelClass = 'balanced';
    reasoning = 'high';
    confidence = 0.95;
    hardRules.push('bounded_security_verification');
  } else if (p.task_kind === 'architecture' || p.ambiguity >= 3 || p.novelty >= 3) {
    role = 'architect';
    modelClass = 'expert';
    reasoning = 'high';
    confidence = 0.94;
    hardRules.push('high_ambiguity_architecture');
  } else if (['orchestration', 'mechanical'].includes(p.task_kind)) {
    role = 'main';
    modelClass = 'cheap';
    reasoning = 'low';
    confidence = 0.99;
    hardRules.push('deterministic_orchestration');
  } else if (p.task_kind === 'repository_hygiene') {
    role = 'repo_janitor';
    modelClass = 'cheap';
    reasoning = 'low';
    confidence = 0.97;
    hardRules.push('plan_first_repository_hygiene');
  } else if (p.task_kind === 'exploration') {
    role = 'scout';
    modelClass = 'balanced';
    reasoning = 'low';
    confidence = p.context_scope >= 2 ? 0.90 : 0.93;
    hardRules.push('bounded_read_only_exploration');
  } else if (p.task_kind === 'verification') {
    role = 'verifier';
    modelClass = 'balanced';
    reasoning = 'high';
    confidence = 0.95;
    hardRules.push('independent_code_verification');
  } else if (['implementation', 'migration', 'security_sensitive_development'].includes(p.task_kind)) {
    if (implementationNeedsTerra(task)) {
      role = 'implementation_escalation_worker';
      modelClass = 'balanced';
      reasoning = 'high';
      confidence = 0.96;
      hardRules.push(task.execution?.implementation_tier === 'escalated'
        ? 'explicit_terra_escalation'
        : 'risk_or_scope_requires_terra');
    } else {
      role = 'implementation_worker';
      modelClass = 'cheap';
      reasoning = 'xhigh';
      confidence = 0.93;
      hardRules.push('bounded_testable_luna_implementation');
    }
  }

  if (p.context_scope >= 3 || (p.ambiguity >= 2 && confidence < 0.95)) {
    scoutRequired = true;
    confidence = Math.min(confidence, 0.84);
    hardRules.push('scout_refinement_required');
  }

  return {
    schema_version: 1,
    task_id: task.task_id,
    role,
    model_class: modelClass,
    provider_model: MODELS[modelClass],
    reasoning,
    confidence,
    hard_rules: hardRules,
    explanation: {
      profile: task.profile,
      task_kind: p.task_kind,
      ambiguity: p.ambiguity,
      semantic_complexity: p.semantic_complexity,
      security_criticality: p.security_criticality,
      blast_radius: p.blast_radius,
      context_scope: p.context_scope,
      verification_strength: p.verification_strength,
      implementation_tier: task.execution?.implementation_tier ?? 'default',
      implementation_attempt: task.execution?.attempt ?? 1,
    },
    scout_required: scoutRequired,
    review: {
      required: task.review.required,
      required_roles: task.review.required_roles,
      escalation: ['default_worker_rejected', 'worker_verifier_disagreement', 'scope_or_policy_conflict', 'security_review_blocked'],
    },
    budget: task.budgets,
    created_at: new Date().toISOString(),
  };
}
