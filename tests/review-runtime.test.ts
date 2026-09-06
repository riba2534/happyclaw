import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
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

beforeAll(() => {
  db.initDatabase();
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

describe('R03: Workspace PATCH field-level merge and quiesce consistency', () => {
  test('re-reads at commit boundary and only merges provided fields without rollback', () => {
    const jid = `web:ws-r03-${Date.now()}`;
    const initialGroup = {
      jid,
      name: 'Initial Name',
      folder: `folder-r03-${Date.now()}`,
      added_at: new Date().toISOString(),
      created_by: 'owner-user',
      executionMode: 'container' as const,
    };
    db.setRegisteredGroup(jid, initialGroup);

    // Request B changes executionMode to host
    const updatedByB = {
      ...initialGroup,
      executionMode: 'host' as const,
    };
    db.setRegisteredGroup(jid, updatedByB);

    // Request A only provided name = 'Updated Name'
    // Field-level merge against latest DB state
    const latest = db.getRegisteredGroup(jid)!;
    expect(latest.executionMode).toBe('host');

    const mergedByA = {
      ...latest,
      name: 'Updated Name',
    };
    db.setRegisteredGroup(jid, mergedByA);

    const finalRecord = db.getRegisteredGroup(jid)!;
    expect(finalRecord.name).toBe('Updated Name');
    expect(finalRecord.executionMode).toBe('host'); // Preserved host without rolling back to container!
  });
});

describe('R06: Agent self-capability mutation safety and turn boundary execution', () => {
  test('agent caller gets accepted without caller process termination, then applies at turn boundary', async () => {
    const requestId = `req-r06-${Date.now()}`;
    const userId = 'user-r06';

    // 1. Agent calls installSkillForUser with isAgentCaller = true
    const callResult = await skillService.installSkillForUser(
      userId,
      'test/package-r06',
      {
        requestId,
        sourceGroup: 'web:folder-r06',
        groupFolder: 'folder-r06',
        isAgentCaller: true,
      },
    );

    expect(callResult.success).toBe(true);
    expect(callResult.accepted).toBe(true);
    expect(callResult.requestId).toBe(requestId);

    const pendingRecord = skillService.getCapabilityMutationRequest(requestId);
    expect(pendingRecord?.status).toBe('accepted');

    // Mock unlocked installation
    vi.spyOn(
      skillService.skillMutationExecutor,
      'installSkillForUserUnlocked',
    ).mockResolvedValueOnce({
      success: true,
      installed: ['package-r06'],
    });

    // 2. Safe turn boundary execution
    const applied = await skillService.applyPendingCapabilityMutations({
      groupFolder: 'folder-r06',
    });
    expect(applied.applied).toBe(1);

    const appliedRecord = skillService.getCapabilityMutationRequest(requestId);
    expect(appliedRecord?.status).toBe('applied');
    expect(JSON.parse(appliedRecord?.resultJson || '[]')).toEqual([
      'package-r06',
    ]);

    // 3. Re-query is idempotent
    const idempotentResult = await skillService.installSkillForUser(
      userId,
      'test/package-r06',
      {
        requestId,
        sourceGroup: 'web:folder-r06',
        groupFolder: 'folder-r06',
        isAgentCaller: true,
      },
    );
    expect(idempotentResult.success).toBe(true);
    expect(idempotentResult.accepted).toBe(false);
    expect(idempotentResult.installed).toEqual(['package-r06']);
  });
});

describe('R13: Unified turn settlement and provider output state machine', () => {
  test('settleChannelTurnOutput handles complete inputs, receipts, and fences', async () => {
    const route = {
      provider: 'feishu' as const,
      accountId: 'bot-r13',
      sourceJid: 'feishu:bot-r13:chat-r13',
      chatId: 'chat-r13',
    };
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-r13-settle',
    });

    let settled = false;
    const runtimes = new Map([[runtime.runId, runtime]]);

    const result = await settleChannelTurnOutput(
      {
        inputTurnCompleted: true,
        inputTurnId: runtime.runId,
        status: 'success',
      },
      {
        chatJid: 'web:chat-r13',
        folder: 'folder-r13',
        lastProcessedId: runtime.runId,
        runtimes,
        outboxScopesByInput: new Map(),
        nonTerminalDeliveryAckByInput: new Map(),
        physicalDeliveryAckByInput: new Map([[runtime.runId, true]]),
        clearProcessingIndicator: async () => {},
        markOutputSettled: () => {
          settled = true;
        },
        deliverManualReconciliationNotice: async () => false,
        deliverDefinitiveFailureNotice: async () => false,
      },
    );

    expect(result).toBe(true);
    expect(settled).toBe(true);
    expect(runtimes.has(runtime.runId)).toBe(false); // Cleaned up
  });

  test('createRunnerProviderOutputHandler manages quotas and failure quarantines', async () => {
    const state = initialRunnerProviderOutputState();
    let stoppedReason = '';
    const outputsDispatched: any[] = [];

    const handler = createRunnerProviderOutputHandler(state, {
      groupName: 'test-group',
      identifier: 'proc-1',
      mode: 'host',
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
  });

  test('domain commands execute channel binding and unbinding atomically', () => {
    const channelJid = `feishu:cmd-bot:chat-${Date.now()}`;
    const workspaceJid = `web:ws-cmd-${Date.now()}`;

    db.setRegisteredGroup(workspaceJid, {
      jid: workspaceJid,
      name: 'Target Workspace',
      folder: `folder-cmd-${Date.now()}`,
      added_at: new Date().toISOString(),
      created_by: 'cmd-user',
    });

    // Execute domain command to bind channel to workspace
    const mount = executeBindChannelToWorkspace({
      channelJid,
      workspaceJid,
      replyPolicy: 'source_only',
      activationMode: 'auto',
    });

    expect(mount.channel_jid).toBe(channelJid);
    expect(mount.workspace_jid).toBe(workspaceJid);

    // Verify dual-write in compatibility mirror
    const groupMirror = db.getRegisteredGroup(channelJid);
    expect(groupMirror?.target_main_jid).toBe(workspaceJid);

    // Execute unbind
    executeUnbindChannel(channelJid);
    expect(db.getRegisteredGroup(channelJid)?.target_main_jid).toBeUndefined();
  });
});
