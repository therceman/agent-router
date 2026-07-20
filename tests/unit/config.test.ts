import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoleList, PROFILE_DEFINITIONS, PROFILE_IDS, ROLE_IDS } from '../../src/config.js';

test('all four workflow profiles are explicit', () => {
  assert.deepEqual(PROFILE_IDS, [
    'development',
    'secure-development-external-brain',
    'secure-development-local-brain',
    'security-research',
  ]);
  assert.deepEqual(PROFILE_DEFINITIONS.development.roles, ['main', 'implementation_worker', 'implementation_escalation_worker']);
  assert.deepEqual(PROFILE_DEFINITIONS['secure-development-external-brain'].required_review_roles, ['verifier', 'security_reviewer']);
  assert.ok(PROFILE_DEFINITIONS['secure-development-local-brain'].roles.includes('architect'));
  assert.ok(PROFILE_DEFINITIONS['security-research'].roles.includes('security_researcher'));
});

test('role defaults come from the selected profile and all remains explicit', () => {
  assert.deepEqual(parseRoleList(undefined, 'development'), ['main', 'implementation_worker', 'implementation_escalation_worker']);
  assert.deepEqual(parseRoleList(undefined, 'secure-development-external-brain'), ['main', 'implementation_worker', 'implementation_escalation_worker', 'verifier', 'security_reviewer']);
  assert.deepEqual(parseRoleList('implementation-worker'), ['main', 'implementation_worker']);
  assert.deepEqual(parseRoleList('all'), [...ROLE_IDS]);
});
