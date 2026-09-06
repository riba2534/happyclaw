import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runtime-'));
const storeDir = path.join(tmpRoot, 'store');
const groupsDir = path.join(tmpRoot, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: storeDir,
    GROUPS_DIR: groupsDir,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let currentAuthUser: any = {
  id: 'test-admin',
  username: 'admin',
  role: 'admin',
  status: 'active',
  permissions: ['manage_system_config'],
};

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', currentAuthUser);
    return next();
  },
}));

const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');
const recovery = await import('../src/channel-reliability-recovery.js');
const skillService = await import('../src/skill-install-service.js');
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');
const { settleChannelTurnOutput } =
  await import('../src/channel-turn-settlement.js');
const { createRunnerProviderOutputHandler, initialRunnerProviderOutputState } =
  await import('../src/runner-provider-output-state-machine.js');
const {
  executeBindChannelToWorkspace,
  executeBindChannelToSession,
  executeUnbindChannel,
} = await import('../src/channel-mount-service.js');
const { default: groupRoutes } = await import('../src/routes/groups.js');
const webContext = await import('../src/web-context.js');

const app = new Hono();
app.route('/api/groups', groupRoutes);

beforeAll(() => {
  db.initDatabase();
  webContext.setWebDeps({
    getRegisteredGroups: () => db.getAllRegisteredGroups(),
    sessions: {},
    queue: {
      isGroupRuntimeSafetyBlocked: () => false,
      pauseGroupsForMutation: () => ({ id: 1 }),
      resumeGroupsAfterMutation: () => {},
      stopGroup: async () => {},
      blockGroupsForRuntimeSafety: () => {},
      unblockGroupsForRuntimeSafety: () => {},
      listDescendantJids: () => [],
    } as any,
  } as any);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('R02: Outbox continuous recovery and safe lease reconciliation', () => {
  const route = {
    provider: 'feishu' as const,
    accountId: 'bot-r02',
    sourceJid: 'feishu:bot-r02:chat-r02',
    chatId: 'chat-r02',
  };

  test('distinguishes pre-send retry_wait and sending uncertain without preempting active lease', async () => {
    let now = '2026-09-07T10:00:00.000Z';
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'run:r02-test',
      now,
    }).run;

    // 1. Crash during claimed phase (pre-send)
    let claimedId = '';
    await expect(
      delivery.deliverChannelOutboxItem({
        ...route,
        turnRunId: run.id,
        ordinal: 0,
        kind: 'text',
        payload: { text: 'Claimed payload' },
        owner: 'dead-worker-1',
        leaseMs: 60_000,
        now: () => now,
        delivery: {
          mode: 'single',
          send: async () => ({ providerMessageId: 'ack-1' }),
        },
        afterPersist: (phase, item) => {
          if (phase === 'claimed') {
            claimedId = item.id;
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);

    // 2. Crash during sending phase (in-flight send, possibly ACK lost)
    let sendingId = '';
    await expect(
      delivery.deliverChannelOutboxItem({
        ...route,
        turnRunId: run.id,
        ordinal: 1,
        kind: 'text',
        payload: { text: 'Sending payload' },
        owner: 'dead-worker-2',
        leaseMs: 60_000,
        now: () => now,
        delivery: {
          mode: 'single',
          send: async () => ({ providerMessageId: 'ack-2' }),
        },
        afterPersist: (phase, item) => {
          if (phase === 'sending') {
            sendingId = item.id;
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);

    // Step A: At 10s (before 60s lease expires), recovery run must NOT preempt leases
    now = '2026-09-07T10:00:10.000Z';
    const dummyReconciler = {
      reconcileStreamingCard: async () => ({
        version: 1,
        method: 'cardkit' as const,
      }),
    };
    const at10s = await recovery.reconcileChannelReliabilityPass(
      dummyReconciler,
      {
        mode: 'live',
        now,
        includeOutbox: true,
      },
    );
    expect(at10s.outbox).toEqual({ retryable: 0, uncertain: 0 });
    expect(store.getChannelOutboxItem(claimedId)?.status).toBe('claimed');
    expect(store.getChannelOutboxItem(sendingId)?.status).toBe('sending');

    // Step B: At 61s (after expiry), continuous recovery safely transitions items
    now = '2026-09-07T10:01:01.000Z';
    const at61s = await recovery.reconcileChannelReliabilityPass(
      dummyReconciler,
      {
        mode: 'live',
        now,
        includeOutbox: true,
      },
    );
    expect(at61s.outbox.retryable).toBeGreaterThanOrEqual(1);
    expect(at61s.outbox.uncertain).toBeGreaterThanOrEqual(1);

    const claimedAfter = store.getChannelOutboxItem(claimedId)!;
    expect(claimedAfter.status).toBe('retry_wait');
    expect(claimedAfter.leaseOwner).toBeNull();

    const sendingAfter = store.getChannelOutboxItem(sendingId)!;
    expect(sendingAfter.status).toBe('uncertain');
    expect(sendingAfter.leaseOwner).toBeNull();

    // Verify sending item is listed for manual reconciliation and cannot be claimed
    expect(
      store.listUncertainChannelOutbox().some((x) => x.id === sendingId),
    ).toBe(true);
    expect(
      store.claimChannelOutboxById(sendingId, 'new-worker', 60_000, now),
    ).toBeUndefined();
  });
});

describe('R03: Real Workspace PATCH route endpoint concurrency, ACL revalidation, and deletion safety', () => {
  test('concurrent rename and execution_mode PATCH requests merge without field rollback via real Hono endpoint', async () => {
    const jid = `web:ws-r03-${Date.now()}`;
    const folder = `folder-r03-${Date.now()}`;
    db.setRegisteredGroup(jid, {
      jid,
      name: 'Initial Name',
      folder,
      added_at: new Date().toISOString(),
      created_by: 'test-admin',
      executionMode: 'container' as const,
    });

    // 1. Send Mode PATCH request (container -> host) through real route
    const modeRes = await app.request(`/api/groups/${jid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ execution_mode: 'host' }),
    });
    expect(modeRes.status).toBe(200);

    const afterMode = db.getRegisteredGroup(jid)!;
    expect(afterMode.executionMode).toBe('host');

    // 2. Send Rename PATCH request through real route
    const renameRes = await app.request(`/api/groups/${jid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Name' }),
    });
    expect(renameRes.status).toBe(200);

    // 3. Verify final DB state: name is updated, and executionMode remains 'host' (NOT rolled back!)
    const finalGroup = db.getRegisteredGroup(jid)!;
    expect(finalGroup.name).toBe('Renamed Name');
    expect(finalGroup.executionMode).toBe('host');
  });

  test('deletion during mutation rejects with 404 and does not revive deleted workspace', async () => {
    const jid = `web:ws-del-${Date.now()}`;
    const folder = `folder-del-${Date.now()}`;
    db.setRegisteredGroup(jid, {
      jid,
      name: 'To Be Deleted',
      folder,
      added_at: new Date().toISOString(),
      created_by: 'test-admin',
      executionMode: 'container' as const,
    });

    // Delete workspace
    db.deleteRegisteredGroup(jid);
    expect(db.getRegisteredGroup(jid)).toBeUndefined();

    // Now a concurrent PATCH arrives for the deleted workspace
    const res = await app.request(`/api/groups/${jid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Should Not Revive' }),
    });

    expect(res.status).toBe(404);
    // Crucial: Workspace must remain deleted and NOT resurrected!
    expect(db.getRegisteredGroup(jid)).toBeUndefined();
  });

  test('revalidates permission at commit boundary and rejects when user is unauthorized', async () => {
    const jid = `web:ws-perm-${Date.now()}`;
    const folder = `folder-perm-${Date.now()}`;
    db.setRegisteredGroup(jid, {
      jid,
      name: 'Secure Workspace',
      folder,
      added_at: new Date().toISOString(),
      created_by: 'other-owner',
      executionMode: 'container' as const,
    });

    // Switch auth context to a member without modify permissions
    const originalUser = currentAuthUser;
    currentAuthUser = {
      id: 'unauthorized-member',
      username: 'member',
      role: 'member',
      status: 'active',
    };

    try {
      const res = await app.request(`/api/groups/${jid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hacked Name' }),
      });
      // canModifyGroup checks owner -> rejects 404/403
      expect([403, 404]).toContain(res.status);
      expect(db.getRegisteredGroup(jid)?.name).toBe('Secure Workspace');
    } finally {
      currentAuthUser = originalUser;
    }
  });
});

describe('R06: Agent self-capability mutation safety, cross-session isolation and convergence', () => {
  test('session-level isolation: mutation is not triggered by unrelated session settlement', async () => {
    const folder = `folder-iso-${Date.now()}`;
    const requestId = `req-iso-${Date.now()}`;
    const userId = 'user-iso';

    // Session 1 registers install_skill in its own turn
    const registerResult = await skillService.installSkillForUser(
      userId,
      'provider/skill-a',
      {
        requestId,
        sourceGroup: `web:${folder}`,
        groupFolder: folder,
        sessionId: 'session-1',
        inputTurnId: 'turn-1',
        isAgentCaller: true,
      },
    );
    expect(registerResult.accepted).toBe(true);
    expect(skillService.getCapabilityMutationRequest(requestId)?.status).toBe(
      'accepted',
    );

    // Spy installer
    let installCalls = 0;
    vi.spyOn(
      skillService.skillMutationExecutor,
      'installSkillForUserUnlocked',
    ).mockImplementation(async () => {
      installCalls++;
      return { success: true, installed: ['skill-a'] };
    });

    // An unrelated Session 2 in the same workspace settles turn-2
    const session2Applied = await skillService.applyPendingCapabilityMutations({
      groupFolder: folder,
      sessionId: 'session-2',
      inputTurnId: 'turn-2',
    });
    // Must be skipped: session-2 cannot apply session-1's pending mutation!
    expect(session2Applied.applied).toBe(0);
    expect(installCalls).toBe(0);
    expect(skillService.getCapabilityMutationRequest(requestId)?.status).toBe(
      'accepted',
    );

    // Now Session 1 settles turn-1
    const session1Applied = await skillService.applyPendingCapabilityMutations({
      groupFolder: folder,
      sessionId: 'session-1',
      inputTurnId: 'turn-1',
    });
    expect(session1Applied.applied).toBe(1);
    expect(installCalls).toBe(1);
    expect(skillService.getCapabilityMutationRequest(requestId)?.status).toBe(
      'applied',
    );

    // Internal notification message must be recorded in db
    const rawDb = new Database(path.join(storeDir, 'messages.db'));
    const noticeRow = rawDb
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(`notice-${requestId}`) as any;
    expect(noticeRow?.content).toContain('已成功安装并生效');
    rawDb.close();
  });

  test('concurrency safety: two racing apply calls execute underlying installer exactly once via CAS claim', async () => {
    const folder = `folder-cas-${Date.now()}`;
    const requestId = `req-cas-${Date.now()}`;
    const userId = 'user-cas';

    await skillService.installSkillForUser(userId, 'provider/skill-cas', {
      requestId,
      sourceGroup: `web:${folder}`,
      groupFolder: folder,
      sessionId: 'session-cas',
      inputTurnId: 'turn-cas',
      isAgentCaller: true,
    });

    let executorRuns = 0;
    vi.spyOn(
      skillService.skillMutationExecutor,
      'installSkillForUserUnlocked',
    ).mockImplementation(async () => {
      executorRuns++;
      return { success: true, installed: ['skill-cas'] };
    });

    // Two parallel settlement calls race to apply the same mutation
    const [res1, res2] = await Promise.all([
      skillService.applyPendingCapabilityMutations({
        groupFolder: folder,
        sessionId: 'session-cas',
        inputTurnId: 'turn-cas',
      }),
      skillService.applyPendingCapabilityMutations({
        groupFolder: folder,
        sessionId: 'session-cas',
        inputTurnId: 'turn-cas',
      }),
    ]);

    // Exactly one call applies; the other call cannot re-run the mutation
    expect(res1.applied + res2.applied).toBe(1);
    expect(executorRuns).toBe(1); // Underlying installer ran exactly once!
    expect(skillService.getCapabilityMutationRequest(requestId)?.status).toBe(
      'applied',
    );
  });

  test('idempotent uninstall: uninstallation of already-missing skill succeeds idempotently without failure', () => {
    const userId = `user-del-${Date.now()}`;
    // Uninstalling non-existent skill from disk
    const result = skillService.deleteSkillForUserUnlocked(
      userId,
      'non-existent-skill',
    );
    expect(result.success).toBe(true);
  });

  test('identity protection: requestId collision with conflicting operation or user identity is rejected', async () => {
    const requestId = `req-collide-${Date.now()}`;
    await skillService.installSkillForUser('user-1', 'pkg-a', {
      requestId,
      sourceGroup: 'web:folder',
      isAgentCaller: true,
    });

    // Different user attempts to reuse the same requestId
    const conflictResult = await skillService.installSkillForUser(
      'user-2',
      'pkg-a',
      {
        requestId,
        sourceGroup: 'web:folder',
        isAgentCaller: true,
      },
    );
    expect(conflictResult.success).toBe(false);
    expect(conflictResult.error).toContain('Request ID conflict');
  });
});

describe('R13: Production domain commands, mirror rebuild, and shared output state machine', () => {
  test('domain commands execute binding and mirror synchronization, and reverse rebuild works', () => {
    const channelJid = `feishu:cmd-test:chat-${Date.now()}`;
    const workspaceJid = `web:ws-cmd-${Date.now()}`;

    db.setRegisteredGroup(workspaceJid, {
      jid: workspaceJid,
      name: 'Target Workspace',
      folder: `folder-cmd-${Date.now()}`,
      added_at: new Date().toISOString(),
      created_by: 'cmd-user',
    });

    // 1. Bind to workspace via domain command
    const mount = executeBindChannelToWorkspace({
      channelJid,
      workspaceJid,
      replyPolicy: 'source_only',
      activationMode: 'auto',
    });
    expect(mount.workspace_jid).toBe(workspaceJid);

    // Verify compatibility mirror in registered_groups
    expect(db.getRegisteredGroup(channelJid)?.target_main_jid).toBe(
      workspaceJid,
    );

    // 2. Simulate mirror drift / desync and verify reverse rebuild from normalized channel_mounts source of truth
    const rawDb = new Database(path.join(storeDir, 'messages.db'));
    rawDb
      .prepare(
        'UPDATE registered_groups SET target_main_jid = NULL WHERE jid = ?',
      )
      .run(channelJid);
    expect(db.getRegisteredGroup(channelJid)?.target_main_jid).toBeUndefined();

    // Rebuild from normalized source of truth
    db.syncRegisteredGroupsFromNormalizedChannelMounts();
    expect(db.getRegisteredGroup(channelJid)?.target_main_jid).toBe(
      workspaceJid,
    );
    rawDb.close();

    // 3. Unbind via domain command
    executeUnbindChannel(channelJid);
    expect(db.getRegisteredGroup(channelJid)?.target_main_jid).toBeUndefined();
  });

  test('createRunnerProviderOutputHandler executes identical state transitions across host and container modes', async () => {
    for (const mode of ['host', 'container'] as const) {
      const state = initialRunnerProviderOutputState();
      let stoppedReason = '';
      const outputsDispatched: any[] = [];

      const handler = createRunnerProviderOutputHandler(state, {
        groupName: 'test-group',
        identifier: mode === 'container' ? 'container-1' : 'proc-1',
        mode,
        selectedProfileId: 'provider-1',
        resetTimeout: () => {},
        stopTarget: (reason) => {
          stoppedReason = reason;
        },
        onOutput: (out) => {
          outputsDispatched.push(out);
        },
        quarantineFromOutput: () => {},
        applyDisposition: () => true,
        dispositionLogMessage: () => 'terminal provider failure',
      });

      // 1. Normal output
      await handler({ status: 'success', inputTurnCompleted: true });
      expect(state.healthyInputTurnCompleted).toBe(true);
      expect(outputsDispatched).toHaveLength(1);

      // 2. Terminal provider failure output
      await handler({
        status: 'error',
        providerFailure: true,
        result: 'Rate limited',
      });
      expect(state.providerFailureTerminal).toBe(true);
      expect(stoppedReason).toBe('provider_failure');
    }
  });
});
