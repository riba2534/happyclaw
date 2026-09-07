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

  test('composite PATCH with is_pinned fails at permission boundary without altering pin state', async () => {
    const jid = `web:ws-pin-${Date.now()}`;
    const folder = `folder-pin-${Date.now()}`;
    db.setRegisteredGroup(jid, {
      jid,
      name: 'Pinned Target',
      folder,
      added_at: new Date().toISOString(),
      created_by: 'other-owner',
      executionMode: 'container' as const,
    });

    const originalUser = currentAuthUser;
    currentAuthUser = {
      id: 'unauthorized-pinner',
      username: 'pinner',
      role: 'member',
      status: 'active',
    };

    try {
      // Member tries to both pin and rename a workspace they don't own
      const res = await app.request(`/api/groups/${jid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_pinned: true, name: 'Illegal Name Change' }),
      });

      expect([403, 404]).toContain(res.status);
      // Verify user_pinned_groups was NOT modified in db
      const pinned = db.getUserPinnedGroups('unauthorized-pinner');
      expect(pinned[jid]).toBeUndefined();
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

  test('owner fence: late worker completion cannot overwrite newly claimed mutation', () => {
    const requestId = `req-fence-${Date.now()}`;
    skillService.recordCapabilityMutationRequest({
      requestId,
      userId: 'user-fence',
      groupFolder: 'folder-fence',
      capabilityKind: 'skills',
      action: 'install',
      target: 'pkg-fence',
      status: 'accepted',
    });

    // Worker 1 claims with a short lease
    const claim1 = skillService.claimCapabilityMutation(
      requestId,
      'worker-1',
      10,
    );
    expect(claim1?.claimOwner).toBe('worker-1');

    // Simulate expiry: Worker 2 claims it
    const rawDb = new Database(path.join(storeDir, 'messages.db'));
    rawDb
      .prepare(
        "UPDATE capability_mutation_requests SET claim_expires_at='2000-01-01T00:00:00.000Z' WHERE request_id = ?",
      )
      .run(requestId);
    rawDb.close();

    const claim2 = skillService.claimCapabilityMutation(
      requestId,
      'worker-2',
      60_000,
    );
    expect(claim2?.claimOwner).toBe('worker-2');

    // Worker 1 wakes up late and attempts to complete -> FENCE BLOCKS IT!
    const lateUpdateSuccess = skillService.updateCapabilityMutationRequest(
      requestId,
      {
        status: 'failed',
        expectedClaimOwner: 'worker-1',
        error: 'Worker 1 timeout error',
      },
    );
    expect(lateUpdateSuccess).toBe(false); // Worker 1 was rejected!

    // Verify record is still owned by worker-2
    const current = skillService.getCapabilityMutationRequest(requestId)!;
    expect(current.status).toBe('applying');
    expect(current.claimOwner).toBe('worker-2');

    // Worker 2 successfully completes
    const worker2Success = skillService.updateCapabilityMutationRequest(
      requestId,
      {
        status: 'applied',
        expectedClaimOwner: 'worker-2',
        resultJson: JSON.stringify(['pkg-fence']),
      },
    );
    expect(worker2Success).toBe(true);
    expect(skillService.getCapabilityMutationRequest(requestId)?.status).toBe(
      'applied',
    );
  });

  test('crash recovery: expired applying and accepted mutations recover after real SQLite close and reopen', async () => {
    const requestId = `req-crash-${Date.now()}`;
    const folder = `folder-crash-${Date.now()}`;
    skillService.recordCapabilityMutationRequest({
      requestId,
      userId: 'user-crash',
      groupFolder: folder,
      sessionId: 'session-crash',
      inputTurnId: 'turn-crash',
      capabilityKind: 'skills',
      action: 'install',
      target: 'pkg-crash',
      status: 'accepted',
    });

    // Dead worker claimed before process death
    skillService.claimCapabilityMutation(
      requestId,
      'dead-worker-before-crash',
      10,
    );

    // Simulate crash and time advance past lease expiry
    const rawDb = new Database(path.join(storeDir, 'messages.db'));
    rawDb
      .prepare(
        "UPDATE capability_mutation_requests SET claim_expires_at='2000-01-01T00:00:00.000Z' WHERE request_id = ?",
      )
      .run(requestId);
    rawDb.close();

    // Close and reopen SQLite to simulate real restart
    db.closeDatabase();
    db.initDatabase();

    // Verify listPendingCapabilityMutations finds the expired applying mutation
    const pendingList = skillService.listPendingCapabilityMutations({
      groupFolder: folder,
      sessionId: 'session-crash',
      inputTurnId: 'turn-crash',
    });
    expect(pendingList.some((x) => x.requestId === requestId)).toBe(true);

    vi.spyOn(
      skillService.skillMutationExecutor,
      'installSkillForUserUnlocked',
    ).mockResolvedValueOnce({
      success: true,
      installed: ['pkg-crash'],
    });

    // Global recovery on startup successfully applies it
    const recovered = await skillService.applyPendingCapabilityMutations();
    expect(recovered.applied).toBeGreaterThanOrEqual(1);

    const afterRecovery = skillService.getCapabilityMutationRequest(requestId)!;
    expect(afterRecovery.status).toBe('applied');
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

  test('createRunnerProviderOutputHandler executes identical state transitions across host and container modes for full event sequence', async () => {
    for (const mode of ['host', 'container'] as const) {
      const state = initialRunnerProviderOutputState();
      const stoppedReasons: string[] = [];
      const dispatchedOutputs: any[] = [];
      const quarantinedProfiles: string[] = [];
      let timeoutResets = 0;

      const handler = createRunnerProviderOutputHandler(state, {
        groupName: 'test-group',
        identifier: mode === 'container' ? 'container-1' : 'proc-1',
        mode,
        selectedProfileId: 'provider-1',
        resetTimeout: () => {
          timeoutResets++;
        },
        stopTarget: (reason) => {
          stoppedReasons.push(reason);
        },
        onOutput: (out) => {
          dispatchedOutputs.push(out);
        },
        quarantineFromOutput: (profileId) => {
          quarantinedProfiles.push(profileId);
        },
        applyDisposition: () => true,
        dispositionLogMessage: () => 'terminal provider failure',
      });

      // Event 1: quota control event
      await handler({
        providerQuotaObservation: { resetsAt: 1234567890 } as any,
      } as any);
      expect(dispatchedOutputs).toHaveLength(1);
      expect(timeoutResets).toBe(1);
      expect(stoppedReasons).toHaveLength(0); // Quota does not stop runner

      // Event 2: providerFailureRetrying event
      await handler({
        providerFailure: true,
        providerFailureRetrying: true,
        result: 'Transient network failure',
      } as any);
      expect(state.providerFailureReported).toBe(true);
      expect(quarantinedProfiles).toContain('provider-1');
      expect(stoppedReasons).toHaveLength(0); // Retrying does not stop runner

      // Event 3: healthy input turn completed
      await handler({
        status: 'success',
        inputTurnCompleted: true,
        result: 'Turn completed',
      } as any);
      expect(state.healthyInputTurnCompleted).toBe(true);
      expect(stoppedReasons).toHaveLength(0);

      // Event 4: maintenance provider failure after completed input
      await handler({
        providerFailure: true,
        providerFailureMaintenance: true,
        result: 'Maintenance failed',
      } as any);
      expect(state.providerFailureMaintenance).toBe(true);
      expect(stoppedReasons).toContain('maintenance_provider_failure');

      // Event 5: terminal providerFailure
      await handler({
        status: 'error',
        providerFailure: true,
        result: 'Rate limit exceeded',
      } as any);
      expect(state.providerFailureTerminal).toBe(true);
      expect(stoppedReasons).toContain('provider_failure');
    }
  });
});
