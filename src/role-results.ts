import type { ReviewRecord, WorkResultEnvelope } from './models.js';
import type { RoleId } from './config.js';
import { assertRelativeProjectPath } from './lib/path.js';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function strict(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`);
}
function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function stringArray(value: unknown, label: string, paths = false, nonEmpty = false): string[] {
  if (!Array.isArray(value) || (nonEmpty && !value.length) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${label} must be a${nonEmpty ? ' non-empty' : ''} string array`);
  if (paths) for (const item of value) assertRelativeProjectPath(item as string);
  return value as string[];
}
function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function validateImplementationHandoffPayload(payload: unknown): void {
  const item = object(payload, 'implementation handoff');
  strict(item, ['schema_version', 'task_id', 'status', 'agent', 'files_read', 'files_changed', 'tests', 'manual_checks', 'budget', 'known_risks', 'unresolved_questions', 'recommended_next_action', 'session_id', 'assignment_id', 'task_revision', 'effective_contract_sha256'], 'implementation handoff');
  nonEmptyString(item.task_id, 'handoff.task_id');
  if (item.status !== 'worker_complete') throw new Error('handoff.status must be worker_complete');
  const agent = object(item.agent, 'handoff.agent'); strict(agent, ['role', 'model_class', 'provider_model', 'reasoning'], 'handoff.agent'); nonEmptyString(agent.role, 'handoff.agent.role'); nonEmptyString(agent.provider_model, 'handoff.agent.provider_model');
  stringArray(item.files_read, 'handoff.files_read', true); stringArray(item.files_changed, 'handoff.files_changed', true);
  const tests = requiredArray(item.tests, 'handoff.tests'); if (!tests.length) throw new Error('handoff.tests must not be empty');
  for (const entry of tests) { const test = object(entry, 'handoff test'); strict(test, ['command', 'exit_code', 'passed', 'failed'], 'handoff test'); nonEmptyString(test.command, 'handoff test.command'); if (typeof test.exit_code !== 'number' || !Number.isInteger(test.exit_code)) throw new Error('handoff test.exit_code must be an integer'); }
  for (const entry of requiredArray(item.manual_checks, 'handoff.manual_checks')) { const check = object(entry, 'handoff manual check'); strict(check, ['description', 'result'], 'handoff manual check'); nonEmptyString(check.description, 'handoff manual check.description'); if (!['passed', 'failed', 'blocked'].includes(String(check.result))) throw new Error('handoff manual check result is invalid'); }
  const budget = object(item.budget, 'handoff.budget'); strict(budget, ['files_read', 'context_bytes', 'tool_output_chars', 'repository_wide_scan_used', 'full_test_suite_used'], 'handoff.budget');
  stringArray(item.known_risks, 'handoff.known_risks'); stringArray(item.unresolved_questions, 'handoff.unresolved_questions'); nonEmptyString(item.recommended_next_action, 'handoff.recommended_next_action');
}

export function validateReviewPayload(payload: unknown, role: RoleId, taskId: string): ReviewRecord {
  const item = object(payload, 'review');
  strict(item, ['schema_version', 'task_id', 'reviewer', 'verdict', 'acceptance_criteria', 'tests_verified', 'manual_checks_verified', 'scope_verified', 'unrelated_changes_found', 'false_success_paths_found', 'required_followups', 'risks', 'findings', 'required_changes'], 'review');
  if (item.schema_version !== 1 || item.task_id !== taskId) throw new Error('Review identity is invalid');
  const reviewer = object(item.reviewer, 'review.reviewer'); strict(reviewer, ['type', 'role', 'model_class', 'provider_model', 'reasoning'], 'review.reviewer'); if (reviewer.role !== role) throw new Error('Review role does not match assigned role');
  const verdicts = ['accepted', 'rejected', 'accepted_with_followup', 'blocked', 'architect_review_required', 'critical_review_required']; if (!verdicts.includes(String(item.verdict))) throw new Error('Invalid review verdict');
  stringArray(item.required_followups, 'review.required_followups'); stringArray(item.risks, 'review.risks');
  if (item.acceptance_criteria !== undefined) for (const entry of requiredArray(item.acceptance_criteria, 'review.acceptance_criteria')) { const criterion = object(entry, 'review acceptance criterion'); nonEmptyString(criterion.criterion, 'review acceptance criterion.criterion'); if (!['passed', 'failed'].includes(String(criterion.result))) throw new Error('Review acceptance criterion result is invalid'); }
  return item as unknown as ReviewRecord;
}

export function validateRoleResultPayload(resultKind: WorkResultEnvelope['result_kind'], payload: unknown, role: RoleId, taskId: string): void {
  if (resultKind === 'implementation_handoff') return validateImplementationHandoffPayload(payload);
  if (resultKind === 'verification_review' || resultKind === 'security_review' || resultKind === 'critical_review') { validateReviewPayload(payload, role, taskId); return; }
  const item = object(payload, `${resultKind} payload`);
  const required: Record<string, string[]> = {
    architecture_decision: ['decision', 'constraints', 'rejected_alternatives', 'task_decomposition', 'acceptance_criteria', 'unresolved_questions'],
    scout_discovery: ['relevant_files', 'symbols', 'tests', 'dependencies', 'risks', 'recommended_bounded_scope'],
    repository_hygiene_report: ['findings'],
    security_research_result: ['authorization_scope', 'attack_surface', 'reachability', 'attacker_control', 'root_cause', 'impact', 'evidence', 'safe_verification_boundaries', 'unresolved_questions'],
  };
  for (const field of required[resultKind] ?? []) { if (!(field in item) || item[field] === null) throw new Error(`${resultKind} payload is missing ${field}`); }
  if (resultKind === 'architecture_decision') { strict(item, ['decision', 'constraints', 'rejected_alternatives', 'task_decomposition', 'acceptance_criteria', 'unresolved_questions'], 'architecture decision'); nonEmptyString(item.decision, 'architecture.decision'); stringArray(item.constraints, 'architecture.constraints'); stringArray(item.acceptance_criteria, 'architecture.acceptance_criteria'); stringArray(item.unresolved_questions, 'architecture.unresolved_questions'); requiredArray(item.rejected_alternatives, 'architecture.rejected_alternatives'); requiredArray(item.task_decomposition, 'architecture.task_decomposition'); }
  if (resultKind === 'scout_discovery') { strict(item, ['relevant_files', 'symbols', 'tests', 'dependencies', 'risks', 'recommended_bounded_scope'], 'scout discovery'); stringArray(item.relevant_files, 'scout.relevant_files', true); stringArray(item.symbols, 'scout.symbols'); stringArray(item.tests, 'scout.tests'); stringArray(item.dependencies, 'scout.dependencies'); stringArray(item.risks, 'scout.risks'); object(item.recommended_bounded_scope, 'scout.recommended_bounded_scope'); }
  if (resultKind === 'repository_hygiene_report') { strict(item, ['findings'], 'repository hygiene report'); for (const finding of requiredArray(item.findings, 'hygiene.findings')) { const entry = object(finding, 'hygiene finding'); strict(entry, ['path', 'category', 'risk', 'recommendation'], 'hygiene finding'); nonEmptyString(entry.path, 'hygiene finding.path'); nonEmptyString(entry.category, 'hygiene finding.category'); nonEmptyString(entry.risk, 'hygiene finding.risk'); nonEmptyString(entry.recommendation, 'hygiene finding.recommendation'); } }
  if (resultKind === 'security_research_result') { strict(item, ['authorization_scope', 'attack_surface', 'reachability', 'attacker_control', 'root_cause', 'impact', 'evidence', 'safe_verification_boundaries', 'unresolved_questions'], 'security research result'); object(item.authorization_scope, 'security authorization_scope'); stringArray(item.attack_surface, 'security.attack_surface'); nonEmptyString(item.reachability, 'security.reachability'); nonEmptyString(item.attacker_control, 'security.attacker_control'); nonEmptyString(item.root_cause, 'security.root_cause'); nonEmptyString(item.impact, 'security.impact'); requiredArray(item.evidence, 'security.evidence'); requiredArray(item.safe_verification_boundaries, 'security.safe_verification_boundaries'); stringArray(item.unresolved_questions, 'security.unresolved_questions'); }
}
