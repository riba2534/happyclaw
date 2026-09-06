import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  deletedFolders: [] as string[],
  blocked: [] as string[][],
  unblocked: [] as string[][],
  safetyBlocked: false,
  profiles: new Map<string, any[]>(),
  workspaces: new Map<string, any[]>(),
  sessions: { 'u1-inherit-folder': 'old-session' } as Record<string, string>,
}));

vi.mock('../src/db.js', () => ({
  deleteWorkspaceSessions: (folder: string) =>
    state.deletedFolders.push(folder),
  getAllUsers: () => [
    { id: 'u1', status: 'active' },
    { id: 'u2', status: 'active' },
    { id: 'disabled-user', status: 'disabled' },
  ],
  listAgentProfilesForUser: (userId: string) =>
    state.profiles.get(userId) ?? [],
}));

vi.mock('../src/web-context.js', () => ({
  getWebDeps: () => ({
    sessions: state.sessions,
    queue: {
      blockGroupsForRuntimeSafety: (jids: string[]) => state.blocked.push(jids),
      unblockGroupsForRuntimeSafety: (jids: string[]) =>
        state.unblocked.push(jids),
      isGroupRuntimeSafetyBlocked: () => state.safetyBlocked,
    },
  }),
}));

vi.mock('../src/agent-profile-runtime.js', () => ({
  listWorkspaceGroupsForAgentProfile: (_ownerId: string, profileId: string) =>
    state.workspaces.get(profileId) ?? [],
  getWorkspaceRuntimeJids: (_deps: unknown, folder: string) => [
    `web:${folder}`,
  ],
  quiesceWorkspaceRunnersAroundCommit: async (
    _deps: unknown,
    targets: Array<{ folder: string }>,
    _options: unknown,
    commit: () => Promise<unknown> | unknown,
  ) => ({
    value: await commit(),
    runtimeJids: targets.map((target) => `web:${target.folder}`),
  }),
}));

const runtime = await import('../src/capability-runtime-mutation.js');
const skillService = await import('../src/skill-install-service.js');
const Database = (await import('better-sqlite3')).default;

function profile(id: string, mcp: { mode: string; ids: string[] }) {
  return {
    id,
    runtime_policy: {
      mcp,
      skills: { mode: 'disabled', ids: [] },
    },
  };
}

function workspace(folder: string) {
  return [{ jid: `web:${folder}`, group: { folder } }];
}

beforeEach(() => {
  state.deletedFolders.length = 0;
  state.blocked.length = 0;
  state.unblocked.length = 0;
  state.safetyBlocked = false;
  state.profiles.clear();
  state.workspaces.clear();
  state.sessions = { 'u1-inherit-folder': 'old-session' };
});

describe('capability runtime mutation invalidation', () => {
  test('system MCP mutation targets every inherit or source-qualified custom Agent', async () => {
    state.profiles.set('u1', [
      profile('u1-inherit', { mode: 'inherit', ids: [] }),
      profile('u1-disabled', { mode: 'disabled', ids: [] }),
    ]);
    state.profiles.set('u2', [
      profile('u2-custom', { mode: 'custom', ids: ['system:platform'] }),
      profile('u2-other', { mode: 'custom', ids: ['system:other'] }),
    ]);
    state.workspaces.set('u1-inherit', workspace('u1-inherit-folder'));
    state.workspaces.set('u1-disabled', workspace('u1-disabled-folder'));
    state.workspaces.set('u2-custom', workspace('u2-custom-folder'));
    state.workspaces.set('u2-other', workspace('u2-other-folder'));

    let committed = false;
    const result = await runtime.mutateCapabilityAroundRuntimeQuiesce(
      {
        kind: 'mcp',
        ownerUserId: 'admin',
        scope: 'system',
        ids: ['platform'],
      },
      'system MCP updated',
      () => {
        committed = true;
      },
    );

    expect(committed).toBe(true);
    expect(state.deletedFolders.sort()).toEqual([
      'u1-inherit-folder',
      'u2-custom-folder',
    ]);
    expect(state.sessions).not.toHaveProperty('u1-inherit-folder');
    expect(state.unblocked).toEqual([
      ['web:u1-inherit-folder', 'web:u2-custom-folder'],
    ]);
    expect(result.invalidatedRuntimeJids).toBe(2);
  });

  test('repairs a prior safety block before a retry can resume work', async () => {
    state.profiles.set('u1', [
      profile('u1-inherit', { mode: 'inherit', ids: [] }),
    ]);
    state.workspaces.set('u1-inherit', workspace('u1-inherit-folder'));
    state.safetyBlocked = true;

    const repaired = await runtime.repairCapabilityRuntimeSafetyBlock(
      {
        kind: 'mcp',
        ownerUserId: 'u1',
        scope: 'user',
        ids: ['private'],
      },
      'retry cleanup',
    );

    expect(repaired).toBe(1);
    expect(state.deletedFolders).toEqual(['u1-inherit-folder']);
    expect(state.unblocked).toEqual([['web:u1-inherit-folder']]);
  });

  test('R06: agent caller mutation persists accepted requestId without killing caller immediately, and executes at turn boundary', async () => {
    const memDb = new Database(':memory:');
    skillService.createCapabilityMutationSchema(memDb);
    skillService.bindCapabilityMutationDatabase(memDb);

    state.profiles.set('u1', [
      {
        id: 'u1-inherit',
        runtime_policy: {
          mcp: { mode: 'inherit', ids: [] },
          skills: { mode: 'inherit', ids: [] },
        },
      },
    ]);
    state.workspaces.set('u1-inherit', workspace('u1-inherit-folder'));

    const requestId = 'req-test-r06-1';
    // 1. Agent calls installSkillForUser in its own turn
    const agentCallResult = await skillService.installSkillForUser(
      'u1',
      'owner/skill-test',
      {
        requestId,
        sourceGroup: 'web:u1-inherit-folder',
        groupFolder: 'u1-inherit-folder',
        isAgentCaller: true,
      },
    );

    // Verify it is accepted immediately
    expect(agentCallResult).toMatchObject({
      success: true,
      accepted: true,
      requestId,
    });
    // Caller is NOT killed immediately!
    expect(state.deletedFolders).toEqual([]);

    // Check DB persistence
    const saved = skillService.getCapabilityMutationRequest(requestId);
    expect(saved).toMatchObject({
      requestId,
      userId: 'u1',
      status: 'accepted',
      target: 'owner/skill-test',
    });

    // 2. Turn completion boundary: apply pending mutations
    // Mock installer commit
    vi.spyOn(
      skillService.skillMutationExecutor,
      'installSkillForUserUnlocked',
    ).mockResolvedValueOnce({
      success: true,
      installed: ['skill-test'],
    });

    const applied = await skillService.applyPendingCapabilityMutations({
      groupFolder: 'u1-inherit-folder',
    });
    expect(applied).toEqual({ applied: 1, failed: 0 });

    // After turn boundary execution, caller workspace is quiesced
    expect(state.deletedFolders).toEqual(['u1-inherit-folder']);

    // Check final status in DB
    const finalReq = skillService.getCapabilityMutationRequest(requestId);
    expect(finalReq?.status).toBe('applied');
    expect(JSON.parse(finalReq?.resultJson || '[]')).toEqual(['skill-test']);

    // 3. Idempotent check: calling with same requestId returns existing applied result
    const idempotentCall = await skillService.installSkillForUser(
      'u1',
      'owner/skill-test',
      {
        requestId,
        sourceGroup: 'web:u1-inherit-folder',
        groupFolder: 'u1-inherit-folder',
        isAgentCaller: true,
      },
    );
    expect(idempotentCall).toMatchObject({
      success: true,
      accepted: false,
      installed: ['skill-test'],
    });

    skillService.bindCapabilityMutationDatabase(null);
    memDb.close();
  });
});
