import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ChannelMount, RegisteredGroup } from '../src/types.js';

const state = vi.hoisted(() => ({
  groups: new Map<string, RegisteredGroup>(),
  agents: new Map<string, { chat_jid: string }>(),
  mounts: new Map<string, Pick<ChannelMount, 'workspace_jid' | 'session_id'>>(),
  // `${workspaceJid}|${ownerId}` → active guest ids (the SQL predicate's result)
  guests: new Map<string, string[]>(),
}));

vi.mock('../src/db.js', () => ({
  getRegisteredGroup: (jid: string) => state.groups.get(jid),
  getAgent: (id: string) => state.agents.get(id),
  getChannelMount: (jid: string) => state.mounts.get(jid),
  getJidsByFolder: (folder: string) =>
    [...state.groups.entries()]
      .filter(([, group]) => group.folder === folder)
      .map(([jid]) => jid),
  listActiveGuestIdsForWorkspace: (workspaceJid: string, ownerId: string) =>
    state.guests.get(`${workspaceJid}|${ownerId}`) ?? [],
}));

const { getGroupAllowedUserIds } =
  await import('../src/group-broadcast-acl.js');

function group(
  jid: string,
  folder: string,
  createdBy?: string,
  extra: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    jid,
    name: jid,
    folder,
    added_at: '2026-01-01T00:00:00.000Z',
    created_by: createdBy,
    ...extra,
  } as RegisteredGroup;
}

describe('group broadcast attribution ACL', () => {
  beforeEach(() => {
    state.groups.clear();
    state.agents.clear();
    state.mounts.clear();
    state.guests.clear();
  });

  test('observes a workspace rebind and owner transfer immediately', () => {
    const imJid = 'qq:c2c:rebind';
    state.groups.set(
      imJid,
      group(imJid, 'owner-home', 'channel-owner', {
        target_main_jid: 'web:workspace-a',
      }),
    );
    state.groups.set(
      'web:workspace-a',
      group('web:workspace-a', 'workspace-a', 'owner-a'),
    );
    state.groups.set(
      'web:workspace-b',
      group('web:workspace-b', 'workspace-b', 'owner-b'),
    );
    state.mounts.set(imJid, {
      workspace_jid: 'web:workspace-a',
      session_id: null,
    });

    expect([...getGroupAllowedUserIds(imJid)!]).toEqual(['owner-a']);

    state.mounts.set(imJid, {
      workspace_jid: 'web:workspace-b',
      session_id: null,
    });
    expect([...getGroupAllowedUserIds(imJid)!]).toEqual(['owner-b']);

    state.groups.set('web:workspace-b', {
      ...state.groups.get('web:workspace-b')!,
      created_by: 'owner-b-next',
    });
    expect([...getGroupAllowedUserIds(imJid)!]).toEqual(['owner-b-next']);
  });

  test('fails closed when a bound workspace has no owner', () => {
    const imJid = 'qq:c2c:ownerless-target';
    state.groups.set(
      'web:channel-home',
      group('web:channel-home', 'channel-home', 'channel-owner', {
        is_home: true,
      }),
    );
    state.groups.set(
      imJid,
      group(imJid, 'channel-home', 'channel-owner', {
        target_main_jid: 'web:legacy-target',
      }),
    );
    state.groups.set(
      'web:legacy-target',
      group('web:legacy-target', 'legacy-target'),
    );

    expect(getGroupAllowedUserIds(imJid)).toBeNull();
  });

  test('fails closed for a stale declared binding', () => {
    const imJid = 'qq:c2c:stale-target';
    state.groups.set(
      'web:channel-home',
      group('web:channel-home', 'channel-home', 'channel-owner', {
        is_home: true,
      }),
    );
    state.groups.set(
      imJid,
      group(imJid, 'channel-home', 'channel-owner', {
        target_main_jid: 'web:deleted-workspace',
      }),
    );

    expect(getGroupAllowedUserIds(imJid)).toBeNull();
  });

  test('keeps the folder fallback for genuinely unbound legacy IM rows', () => {
    const imJid = 'qq:c2c:legacy-unbound';
    state.groups.set(
      'web:legacy-home',
      group('web:legacy-home', 'legacy-home', 'legacy-owner', {
        is_home: true,
      }),
    );
    state.groups.set(imJid, group(imJid, 'legacy-home'));

    expect([...getGroupAllowedUserIds(imJid)!]).toEqual(['legacy-owner']);
  });

  test('adds guests with an active grant on the attributed workspace', () => {
    state.groups.set(
      'web:flow-x',
      group('web:flow-x', 'flow-x', 'u1', { executionMode: 'host' }),
    );
    state.guests.set('web:flow-x|u1', ['guest-1']);
    state.guests.set('web:other|u1', ['guest-2']);

    expect([...getGroupAllowedUserIds('web:flow-x')!].sort()).toEqual([
      'guest-1',
      'u1',
    ]);
    expect([
      ...getGroupAllowedUserIds('web:flow-x#agent:session-1')!,
    ]).toContain('guest-1');
  });

  test('a bound IM chat reaches guests of the bound workspace only', () => {
    const imJid = 'qq:c2c:bound-guest';
    state.groups.set('web:flow-x', group('web:flow-x', 'flow-x', 'u1'));
    state.groups.set(
      imJid,
      group(imJid, 'channel-home', 'channel-owner', {
        target_main_jid: 'web:flow-x',
      }),
    );
    state.guests.set('web:flow-x|u1', ['guest-1']);
    state.guests.set('web:channel-home|channel-owner', ['guest-9']);

    expect([...getGroupAllowedUserIds(imJid)!].sort()).toEqual([
      'guest-1',
      'u1',
    ]);
  });

  test('grants from a previous owner are not honoured', () => {
    state.groups.set('web:flow-x', group('web:flow-x', 'flow-x', 'u2'));
    state.guests.set('web:flow-x|u1', ['guest-1']);

    expect([...getGroupAllowedUserIds('web:flow-x')!]).toEqual(['u2']);
  });
});
