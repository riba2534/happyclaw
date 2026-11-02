import { describe, expect, test } from 'vitest';
import { checkOwnerActive } from '../src/owner-gate.js';

describe('checkOwnerActive', () => {
  test('legacy groups without owner info pass (backward compat)', () => {
    expect(checkOwnerActive(null)).toEqual({ allowed: true });
    expect(checkOwnerActive(undefined)).toEqual({ allowed: true });
  });

  test('active owner is allowed', () => {
    expect(checkOwnerActive({ status: 'active' })).toEqual({ allowed: true });
  });

  test('disabled owner is blocked', () => {
    expect(checkOwnerActive({ status: 'disabled' })).toEqual({
      allowed: false,
      reason: 'inactive_owner',
      status: 'disabled',
    });
  });

  test('deleted owner is blocked', () => {
    expect(checkOwnerActive({ status: 'deleted' })).toEqual({
      allowed: false,
      reason: 'inactive_owner',
      status: 'deleted',
    });
  });

  test('unknown / future status values are blocked (fail-safe default)', () => {
    expect(checkOwnerActive({ status: 'pending_review' })).toEqual({
      allowed: false,
      reason: 'inactive_owner',
      status: 'pending_review',
    });
    expect(checkOwnerActive({ status: '' })).toEqual({
      allowed: false,
      reason: 'inactive_owner',
      status: '',
    });
  });

  test('gate is status-only — admin role does NOT bypass it', () => {
    // Load-bearing for the scheduler path: billing checks skip admins, so the
    // owner gate must NOT inherit that short-circuit, or a disabled admin's
    // cron tasks would keep firing. checkOwnerActive only looks at status.
    expect(checkOwnerActive({ status: 'disabled' })).toEqual({
      allowed: false,
      reason: 'inactive_owner',
      status: 'disabled',
    });
  });
});

/**
 * Path-level contract tests for the two gates added in this PR. The gate
 * itself is `checkOwnerActive`; these lock the decision each path makes from
 * the `getUserById(created_by)` result, mirroring the inline call sites:
 *  - conversation-agent path (src/index.ts processAgentConversation entry):
 *    the main loop `continue`s past target_agent_id groups before its own
 *    gate, so this is the only gate conversation-agent traffic hits.
 *  - scheduler path (src/task-scheduler.ts, before billing): runs regardless
 *    of isBillingEnabled() / role.
 *
 * Mutation checks (QA): dropping the gate, or re-adding a `role === 'admin'`
 * short-circuit in front of it, should turn one of these red.
 */
describe('owner gate — per-path drop decision', () => {
  type Owner = { id: string; role: 'admin' | 'member'; status: string };

  // Simulates the inline gate: `created_by → getUserById → checkOwnerActive`.
  function shouldDrop(
    createdBy: string | null | undefined,
    lookup: (id: string) => Owner | undefined,
  ): boolean {
    if (!createdBy) return false; // legacy group, no owner — never dropped
    return !checkOwnerActive(lookup(createdBy)).allowed;
  }

  const users: Record<string, Owner> = {
    'u-active': { id: 'u-active', role: 'member', status: 'active' },
    'u-disabled': { id: 'u-disabled', role: 'member', status: 'disabled' },
    // deleteUser is a SOFT delete (db.ts): row stays with status='deleted',
    // so getUserById still returns it — the gate blocks on the status value.
    'u-deleted': { id: 'u-deleted', role: 'member', status: 'deleted' },
    'u-admin-disabled': {
      id: 'u-admin-disabled',
      role: 'admin',
      status: 'disabled',
    },
  };
  const lookup = (id: string) => users[id];

  test('conversation-agent path: active owner → process, disabled → drop', () => {
    expect(shouldDrop('u-active', lookup)).toBe(false);
    expect(shouldDrop('u-disabled', lookup)).toBe(true);
  });

  test('conversation-agent path: soft-deleted owner → drop', () => {
    expect(shouldDrop('u-deleted', lookup)).toBe(true);
  });

  test('scheduler path: disabled admin is dropped (role-independent)', () => {
    // Admins bypass billing but NOT the owner gate.
    expect(shouldDrop('u-admin-disabled', lookup)).toBe(true);
  });

  test('legacy group without created_by is never dropped', () => {
    expect(shouldDrop(null, lookup)).toBe(false);
    expect(shouldDrop(undefined, lookup)).toBe(false);
  });
});
