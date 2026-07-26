import { describe, expect, test } from 'vitest';
import {
  canIpcActorAccessGroup,
  canIpcActorManageTask,
  type TaskAclActor,
  type TaskAclDeps,
} from '../src/task-acl.js';
import type { RegisteredGroup } from '../src/types.js';

function group(
  folder: string,
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    name: folder,
    folder,
    added_at: new Date(0).toISOString(),
    ...overrides,
  };
}

const ADMIN: TaskAclActor = { id: 'u-admin', role: 'admin', status: 'active' };
const MEMBER: TaskAclActor = {
  id: 'u-member',
  role: 'member',
  status: 'active',
};

/**
 * Ownership-only `canAccessGroup`, matching src/web-context.ts: no admin
 * bypass. The point of these tests is that the IPC surface must not reintroduce
 * one on top of it.
 */
function ownershipOnlyCanAccessGroup(
  user: { id: string },
  g: RegisteredGroup & { jid: string },
): boolean {
  return g.created_by === user.id;
}

function deps(
  groups: Record<string, RegisteredGroup>,
  actor: TaskAclActor | undefined,
): TaskAclDeps {
  return {
    lookupGroup: (jid) => groups[jid],
    resolveActor: () => actor,
    canAccessGroup: ownershipOnlyCanAccessGroup,
  };
}

describe('canIpcActorAccessGroup', () => {
  test('allows the agent own workspace folder without needing an actor', () => {
    const groups = { 'web:mine': group('mine') };
    expect(
      canIpcActorAccessGroup('mine', 'web:mine', deps(groups, undefined)),
    ).toBe(true);
  });

  test('allows another workspace owned by the same user', () => {
    const groups = {
      'web:other': group('other', { created_by: 'u-member' }),
    };
    expect(
      canIpcActorAccessGroup('mine', 'web:other', deps(groups, MEMBER)),
    ).toBe(true);
  });

  test('denies a workspace owned by a different user even for an admin actor', () => {
    // Regression guard: admin home used to bypass this check entirely, which
    // let an LLM-driven admin workspace plant schedules in other tenants.
    const groups = {
      'web:victim': group('victim', { created_by: 'u-victim' }),
    };
    expect(
      canIpcActorAccessGroup('adminhome', 'web:victim', deps(groups, ADMIN)),
    ).toBe(false);
  });

  test('denies an unregistered target', () => {
    expect(canIpcActorAccessGroup('mine', 'web:ghost', deps({}, ADMIN))).toBe(
      false,
    );
  });

  test('denies when the workspace owner cannot be resolved', () => {
    const groups = { 'web:other': group('other', { created_by: 'u-member' }) };
    expect(
      canIpcActorAccessGroup('mine', 'web:other', deps(groups, undefined)),
    ).toBe(false);
  });

  test('denies a disabled owner', () => {
    const groups = { 'web:other': group('other', { created_by: 'u-member' }) };
    const disabled: TaskAclActor = { ...MEMBER, status: 'disabled' };
    expect(
      canIpcActorAccessGroup('mine', 'web:other', deps(groups, disabled)),
    ).toBe(false);
  });
});

describe('canIpcActorManageTask', () => {
  const task = (group_folder: string, chat_jid: string) => ({
    group_folder,
    chat_jid,
  });

  test('allows a task belonging to the agent own workspace', () => {
    expect(
      canIpcActorManageTask(
        'mine',
        task('mine', 'feishu:oc_x'),
        deps({}, undefined),
      ),
    ).toBe(true);
  });

  test('resolves cross-workspace tasks through their bound chat', () => {
    const groups = {
      'feishu:oc_other': group('other', { created_by: 'u-member' }),
    };
    expect(
      canIpcActorManageTask(
        'mine',
        task('other', 'feishu:oc_other'),
        deps(groups, MEMBER),
      ),
    ).toBe(true);
  });

  test('denies another tenant task even for an admin actor', () => {
    const groups = {
      'feishu:oc_victim': group('victim', { created_by: 'u-victim' }),
    };
    expect(
      canIpcActorManageTask(
        'adminhome',
        task('victim', 'feishu:oc_victim'),
        deps(groups, ADMIN),
      ),
    ).toBe(false);
  });
});
