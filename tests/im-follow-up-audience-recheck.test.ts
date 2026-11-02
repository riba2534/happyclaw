import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-up-recheck-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { getChannelType } = await import('../src/im-channel.js');
const { channelConversationJid, parseChannelAddress } =
  await import('../src/channel-address.js');
const { stripVirtualJidSuffix } = await import('../src/utils.js');
const { ownerImIdFromPersistedSender } =
  await import('../src/agent-builder-turn-auth.js');
const { isDirectMessageJid } = await import('../src/im-command-utils.js');
const { resolveChannelConversationKind } =
  await import('../src/channel-conversation-kind.js');
const { isSenderAdmittedByGroupPolicy } =
  await import('../src/im-group-audience.js');
const { isUnknownFeishuSenderAllowed } =
  await import('../src/im-audience-policy.js');
const { resolveFollowUpMode } = await import('../src/follow-up-policy.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

import type {
  ChannelTurnContext,
  QueuedFollowUp,
  RegisteredGroup,
} from '../src/types.js';

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});
// Startup recovery scans every queue in the database; start each test with
// none left over from the previous one.
beforeEach(() => {
  for (const chatJid of db.getQueuedFollowUpChatJids()) {
    db.cancelQueuedFollowUpsAtCutoff(chatJid);
  }
});

type Group = Partial<RegisteredGroup>;

/**
 * Runs index.ts's real queue drain (`dispatchNextQueuedFollowUp`), startup
 * recovery (`recoverDurableFollowUps`) and steer intake
 * (`handleIncomingFollowUp`) against a real database, with the host's real
 * audience policy (`isSenderAllowedInGroup`) reading the in-memory group
 * cache. Only the runner, the IPC hand-off and provider side effects are
 * stand-ins, recorded so the tests can see which inputs reached a turn.
 */
function hostHarness(registeredGroups: Record<string, Group>) {
  const injected: string[][] = [];
  const recovered: QueuedFollowUp[] = [];
  const queue = {
    activeRunId: null as string | null,
    getActiveQueryId: vi.fn(() => queue.activeRunId),
    hasBackgroundHold: vi.fn(() => false),
    interruptQuery: vi.fn(() => true),
    activeQueryExclusivelyCoversMessage: vi.fn(() => false),
    reserveNextQuery: vi.fn(() => 'run-next'),
    releaseQueryReservation: vi.fn(),
    setCurrentQueryCoverage: vi.fn(),
    announceReservedQuery: vi.fn(),
  };
  const globals: Record<string, unknown> = {
    queue,
    registeredGroups,
    listQueuedFollowUps: vi.fn(db.listQueuedFollowUps),
    listQueuedChannelFollowUps: vi.fn(db.listQueuedChannelFollowUps),
    listQueuedAutomationFollowUps: db.listQueuedAutomationFollowUps,
    getQueuedFollowUp: db.getQueuedFollowUp,
    getQueuedFollowUpChatJids: db.getQueuedFollowUpChatJids,
    setMessageFollowUp: db.setMessageFollowUp,
    claimNextQueuedFollowUpBatch: db.claimNextQueuedFollowUpBatch,
    releaseQueuedFollowUpBatch: db.releaseQueuedFollowUpBatch,
    restorePromotingFollowUpBatch: db.restorePromotingFollowUpBatch,
    withdrawQueuedFollowUp: db.withdrawQueuedFollowUp,
    getRegisteredGroup: db.getRegisteredGroup,
    getChannelAccount: db.getChannelAccount,
    getUserFeishuConfig: () => undefined,
    getChannelType,
    channelConversationJid,
    parseChannelAddress,
    stripVirtualJidSuffix,
    ownerImIdFromPersistedSender,
    isDirectMessageJid,
    resolveChannelConversationKind,
    isSenderAdmittedByGroupPolicy,
    isUnknownFeishuSenderAllowed,
    resolveFollowUpMode,
    broadcastFollowUpUpdate: vi.fn(),
    closeRetryWaitTurnsForWithdrawnInputs: vi.fn(),
    channelTurnScopeForInput: vi.fn(() => null),
    clearStandaloneProcessingIndicator: vi.fn(async () => undefined),
    markSteeringInterrupt: vi.fn(),
    clearSteeringInterrupt: vi.fn(),
    clearTrackedProcessingIndicators: vi.fn(async () => undefined),
    dispatchQueuedFollowUpFamily: vi.fn(),
    createIpcDeliveryTarget: vi.fn(() => null),
    prepareFollowUp: vi.fn(async (items: QueuedFollowUp[]) => ({
      replies: [],
      messages: items.map((item) => ({ id: item.id })),
    })),
    completeFollowUpReply: vi.fn(),
    selectBatchProcessingIndicatorOwners: vi.fn(() => []),
    beginBatchAckReactions: vi.fn(async () => undefined),
    clearUntrackedBatchAckReactions: vi.fn(async () => undefined),
    injectPreparedFollowUp: vi.fn((items: QueuedFollowUp[]) => {
      injected.push(items.map((item) => item.id));
      return 'sent';
    }),
    enqueueReleasedFollowUp: vi.fn((item: QueuedFollowUp) => {
      recovered.push(item);
    }),
    crypto: globalThis.crypto,
    setTimeout,
    endUsageLimitWait: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'isDirectImConversation',
    'isSenderAllowedInGroup',
    'queuedInputImSender',
    'settleCancelledFollowUp',
    'withdrawQueuedInputsOutsideAudience',
    'dispatchNextQueuedFollowUp',
    'broadcastFollowUpBatchUpdate',
    'releaseQueuedFollowUpsToColdReader',
    'recoverDurableFollowUps',
    'deliverWithoutInterruptingBackgroundWork',
    'steerQueuedFollowUpBatch',
    'handleIncomingFollowUp',
  ]) {
    harness.install(name);
  }
  return {
    globals,
    queue,
    injected,
    recovered,
    dispatch: globals.dispatchNextQueuedFollowUp as (
      chatJid: string,
    ) => Promise<void>,
    recover: globals.recoverDurableFollowUps as () => void,
    offer: globals.handleIncomingFollowUp as (input: {
      targetJid: string;
      sourceJid: string;
      messageId: string;
      senderImId: string;
      requestedMode?: 'queue' | 'steer';
    }) => { disposition: string },
  };
}

let clock = Date.parse('2026-10-27T09:00:00.000Z');
function stored(
  chatJid: string,
  id: string,
  sourceJid: string,
  sender: string,
  options: {
    channelContext?: ChannelTurnContext;
    deliveryStatus?: 'queued' | 'subsumed' | null;
    deliveryRunId?: string;
  } = {},
) {
  clock += 1000;
  const status =
    options.deliveryStatus === undefined ? 'queued' : options.deliveryStatus;
  db.storeMessageDirect(
    id,
    chatJid,
    sender,
    'Member',
    id,
    new Date(clock).toISOString(),
    false,
    {
      sourceJid,
      channelContext: options.channelContext,
      meta: status
        ? {
            deliveryMode: status === 'queued' ? 'queue' : undefined,
            deliveryStatus: status,
            deliveryRunId: options.deliveryRunId ?? 'run-active',
          }
        : undefined,
    },
  );
}

function feishuContext(
  sourceJid: string,
  messageId: string,
  openId: string,
): ChannelTurnContext {
  return {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: null,
    sourceJid,
    chat: { id: sourceJid.slice('feishu:'.length), type: 'group' },
    message: { id: messageId },
    sender: { openId },
  };
}

function statuses(chatJid: string): Map<string, string | null | undefined> {
  return new Map(
    db
      .getMessagesPage(chatJid)
      .map((message) => [message.id, message.delivery_status]),
  );
}

describe('the queue drain re-admits waiting inputs', () => {
  test('a member outside a new owner_only audience is withdrawn, the owner runs', async () => {
    const chatJid = 'web:recheck-drain';
    db.ensureChatExists(chatJid);
    stored(chatJid, 'tg-owner', 'telegram:-1001', 'tg:42');
    stored(chatJid, 'tg-member', 'telegram:-1001', 'tg:43');
    stored(chatJid, 'tg-owner-again', 'telegram:-1001', 'tg:42');
    const h = hostHarness({
      'telegram:-1001': { audience_mode: 'owner_only', owner_im_id: '42' },
    });

    await h.dispatch(chatJid);

    expect(h.injected).toEqual([['tg-owner', 'tg-owner-again']]);
    expect(statuses(chatJid).get('tg-member')).toBe('cancelled');
    expect(h.globals.broadcastFollowUpUpdate).toHaveBeenCalledWith(
      chatJid,
      expect.objectContaining({
        id: 'tg-member',
        delivery_status: 'cancelled',
      }),
    );
    expect(
      h.globals.closeRetryWaitTurnsForWithdrawnInputs,
    ).toHaveBeenCalledWith(null, ['tg-member'], 'Queued input cancelled');
    expect(h.globals.clearStandaloneProcessingIndicator).toHaveBeenCalledWith(
      chatJid,
      'telegram:-1001',
      'tg-member',
    );
  });

  test('a Feishu forward note leaves the queue with the root it covers', async () => {
    const chatJid = 'web:recheck-forward';
    const sourceJid = 'feishu:oc_forward';
    db.ensureChatExists(chatJid);
    stored(chatJid, 'om_owner', sourceJid, 'ou_owner', {
      channelContext: feishuContext(sourceJid, 'om_owner', 'ou_owner'),
    });
    stored(chatJid, 'om_note', sourceJid, 'ou_member', {
      channelContext: feishuContext(sourceJid, 'om_note', 'ou_member'),
    });
    // The late physical root, durably covered by the note.
    stored(chatJid, 'om_root', sourceJid, 'ou_member', {
      channelContext: feishuContext(sourceJid, 'om_root', 'ou_member'),
      deliveryStatus: 'subsumed',
      deliveryRunId: 'om_note',
    });
    const h = hostHarness({
      [sourceJid]: {
        audience_mode: 'owner_only',
        owner_im_id: 'ou_owner',
        feishu_chat_mode: 'group',
      },
    });

    await h.dispatch(chatJid);

    expect(h.injected).toEqual([['om_owner']]);
    const after = statuses(chatJid);
    expect(after.get('om_note')).toBe('cancelled');
    expect(after.get('om_root')).toBe('cancelled');
    // The root is settled like the note: announced, Turn closed, unmarked.
    for (const id of ['om_note', 'om_root']) {
      expect(h.globals.broadcastFollowUpUpdate).toHaveBeenCalledWith(
        chatJid,
        expect.objectContaining({ id, delivery_status: 'cancelled' }),
      );
      expect(
        h.globals.closeRetryWaitTurnsForWithdrawnInputs,
      ).toHaveBeenCalledWith(null, [id], 'Queued input cancelled');
      expect(h.globals.clearStandaloneProcessingIndicator).toHaveBeenCalledWith(
        chatJid,
        sourceJid,
        id,
      );
    }
  });

  test('Web, system and other non-channel inputs are never audience-checked', async () => {
    const chatJid = 'web:recheck-sources';
    db.ensureChatExists(chatJid);
    // A Web user's input; one addressed through each bound chat without a
    // channel turn context; and a host-synthesized input.
    stored(chatJid, 'web-input', chatJid, 'user-1');
    stored(chatJid, 'web-to-feishu', 'feishu:oc_sources', 'user-1');
    stored(chatJid, 'web-to-telegram', 'telegram:-1002', 'user-1');
    stored(chatJid, 'system-input', 'feishu:oc_sources', '__system__');
    const h = hostHarness({
      'feishu:oc_sources': {
        audience_mode: 'owner_only',
        owner_im_id: 'ou_owner',
        feishu_chat_mode: 'group',
      },
      'telegram:-1002': { audience_mode: 'owner_only', owner_im_id: '42' },
    });

    await h.dispatch(chatJid);

    expect(h.injected).toHaveLength(1);
    expect(
      [...statuses(chatJid).values()].filter((s) => s === 'cancelled'),
    ).toEqual([]);
    // Only channel-sourced rows are read for the recheck, never the queue.
    expect(h.globals.listQueuedFollowUps).not.toHaveBeenCalled();
    expect(
      (
        h.globals.listQueuedChannelFollowUps as ReturnType<typeof vi.fn>
      ).mock.results[0].value.map((item: QueuedFollowUp) => item.id),
    ).toEqual(['web-to-feishu', 'web-to-telegram', 'system-input']);
    expect(
      h.globals.closeRetryWaitTurnsForWithdrawnInputs,
    ).not.toHaveBeenCalled();
  });

  test('a /steer from a sender who left the audience does not run', async () => {
    const chatJid = 'web:recheck-steer';
    const sourceJid = 'telegram:-1003';
    db.ensureChatExists(chatJid);
    const group: Group = { audience_mode: 'everyone' };
    const h = hostHarness({ [sourceJid]: group });
    h.queue.activeRunId = 'run-active';
    stored(chatJid, 'tg-owner', sourceJid, 'tg:42');
    stored(chatJid, 'tg-steer', sourceJid, 'tg:43', { deliveryStatus: null });
    expect(
      h.offer({
        targetJid: chatJid,
        sourceJid,
        messageId: 'tg-steer',
        senderImId: '43',
        requestedMode: 'steer',
      }).disposition,
    ).toBe('steered');
    expect(db.getQueuedFollowUp(chatJid, 'tg-steer')?.delivery_mode).toBe(
      'steer',
    );

    // The group became owner_only while the interrupted run wound down.
    Object.assign(group, { audience_mode: 'owner_only', owner_im_id: '42' });
    h.queue.activeRunId = null;
    await h.dispatch(chatJid);

    expect(h.injected).toEqual([['tg-owner']]);
    expect(statuses(chatJid).get('tg-steer')).toBe('cancelled');
  });
});

describe('startup recovery re-admits waiting inputs', () => {
  test('a sender removed from the allowlist is withdrawn before release', () => {
    const chatJid = 'web:recheck-recovery';
    db.ensureChatExists(chatJid);
    stored(chatJid, 'qq-owner', 'qq:group:G1', 'qq:OWNER');
    stored(chatJid, 'qq-gone', 'qq:group:G1', 'qq:FORMER');
    stored(chatJid, 'qq-owner-again', 'qq:group:G1', 'qq:OWNER');
    const h = hostHarness({
      'qq:group:G1': {
        audience_mode: 'everyone',
        sender_allowlist: ['group:OWNER'],
      },
    });

    h.recover();

    expect(h.recovered.map((item) => item.id)).toEqual(['qq-owner-again']);
    const after = statuses(chatJid);
    expect(after.get('qq-gone')).toBe('cancelled');
    expect(after.get('qq-owner')).toBe('released');
    expect(after.get('qq-owner-again')).toBe('released');
  });

  test('private chats are never audience-gated', () => {
    const chatJid = 'web:recheck-private';
    db.ensureChatExists(chatJid);
    stored(chatJid, 'dm', 'telegram:4242', 'tg:4242');
    const h = hostHarness({
      'telegram:4242': { audience_mode: 'owner_only', owner_im_id: '1' },
    });

    h.recover();

    expect(h.recovered.map((item) => item.id)).toEqual(['dm']);
    expect(statuses(chatJid).get('dm')).toBe('released');
  });
});
