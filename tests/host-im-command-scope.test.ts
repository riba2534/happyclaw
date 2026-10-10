/**
 * Host-side IM command boundaries (inbound P0-2 handler part, P1-3, P1-4),
 * Feishu recall handling (prod P2-4) and the quiet close of a vanished reply
 * target. Whole production functions from index.ts run against explicit
 * dependencies; only persistence and provider calls are faked.
 */
import { describe, expect, test, vi } from 'vitest';

import {
  channelConversationJid,
  parseChannelAddress,
} from '../src/channel-address.js';
import { resolveChannelConversationKind } from '../src/channel-conversation-kind.js';
import {
  channelOutboxFailureDetail,
  rememberChannelOutboxFailure,
} from '../src/channel-delivery-failure.js';
import { isNativeContextContainer } from '../src/channel-mount-service.js';
import { resolveNativeThreadContext } from '../src/channel-native-context.js';
import { DefinitiveChannelDeliveryError } from '../src/channel-outbox-delivery.js';
import { getChannelType } from '../src/im-channel.js';
import {
  OWNER_REQUIRED_IM_COMMANDS,
  checkImOwnerCommand,
  formatContextMessages,
  isDirectMessageJid,
  resolveBoundChatTarget,
} from '../src/im-command-utils.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const OWNER = 'ou_owner';
const MEMBER = 'ou_member';

/** The real direct-chat learner against an in-memory registered_groups. */
function directChatLearning(groups: Record<string, any>) {
  const learnFeishuDirectChatMode = vi.fn((jid: string) => {
    if (!groups[jid] || groups[jid].feishu_chat_mode) return false;
    groups[jid] = { ...groups[jid], feishu_chat_mode: 'p2p' };
    return true;
  });
  return { getChannelType, learnFeishuDirectChatMode };
}

function commandLane(groups: Record<string, any>) {
  const handlers = {
    handleListCommand: vi.fn(() => 'LIST'),
    handleStatusCommand: vi.fn(() => 'STATUS'),
    handleWhereCommand: vi.fn(() => 'WHERE'),
    handleRecallCommand: vi.fn(async () => 'RECALL'),
  };
  const globals: Record<string, any> = {
    logger,
    registeredGroups: groups,
    getRegisteredGroup: (jid: string) => groups[jid],
    OWNER_REQUIRED_IM_COMMANDS,
    checkImOwnerCommand,
    isDirectMessageJid,
    resolveChannelConversationKind,
    channelConversationJid,
    claimOwner: (group: any, sender: string) => ({
      ...group,
      owner_im_id: sender,
    }),
    persistGroupUpdate: vi.fn((jid: string, group: any, cache: any) => {
      cache[jid] = group;
    }),
    ...directChatLearning(groups),
    ...handlers,
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'GROUP_OWNER_ONLY_READ_IM_COMMANDS',
    'learnFeishuDirectChat',
    'isDirectImConversation',
    'checkGroupOwnerOnlyRead',
    'handleCommand',
  ]) {
    harness.install(name);
  }
  return {
    globals,
    handlers,
    run: (jid: string, command: string, sender?: string, meta?: unknown) =>
      globals.handleCommand(jid, command, sender, undefined, meta) as Promise<
        string | null
      >,
  };
}

describe('group read commands do not expose the owner beyond this chat (P0-2)', () => {
  const groupJid = 'feishu:oc_group';
  const p2pJid = 'feishu:oc_p2p';
  const unknownJid = 'feishu:oc_unknown';
  const lane = () =>
    commandLane({
      [groupJid]: {
        name: 'g',
        folder: 'ws',
        feishu_chat_mode: 'group',
        owner_im_id: OWNER,
      },
      [p2pJid]: {
        name: 'p',
        folder: 'ws',
        feishu_chat_mode: 'p2p',
        owner_im_id: OWNER,
      },
      [unknownJid]: { name: 'u', folder: 'ws', owner_im_id: OWNER },
    });

  test.each(['list', 'ls', 'recall', 'rc'])(
    'a group member cannot run /%s; the owner can',
    async (cmd) => {
      const l = lane();
      const rejected = await l.run(groupJid, cmd, MEMBER);
      expect(rejected).toContain('owner');
      expect(l.handlers.handleListCommand).not.toHaveBeenCalled();
      expect(l.handlers.handleRecallCommand).not.toHaveBeenCalled();
      expect(await l.run(groupJid, cmd, OWNER)).toMatch(/LIST|RECALL/);
    },
  );

  test('/status and /where only describe this chat and stay available', async () => {
    const l = lane();
    expect(await l.run(groupJid, 'status', MEMBER)).toBe('STATUS');
    expect(await l.run(groupJid, 'where', MEMBER)).toBe('WHERE');
  });

  test('a 1:1 chat is not gated; an unknown Feishu chat fails closed', async () => {
    const l = lane();
    expect(await l.run(p2pJid, 'list', MEMBER)).toBe('LIST');
    expect(await l.run(unknownJid, 'list', MEMBER)).toContain('owner');
  });

  test('the connector-reported chat type wins and a private chat is learned (should-fix 15)', async () => {
    const l = lane();
    expect(await l.run(unknownJid, 'list', MEMBER, { chatType: 'p2p' })).toBe(
      'LIST',
    );
    expect(l.globals.learnFeishuDirectChatMode).toHaveBeenCalledWith(
      unknownJid,
    );
    // Persisted: a later message without chat type is still a private chat.
    expect(await l.run(unknownJid, 'list', MEMBER)).toBe('LIST');
    // A reported group stays gated and is never learned as p2p.
    expect(
      await l.run(groupJid, 'list', MEMBER, { chatType: 'group' }),
    ).toContain('owner');
  });

  test('/recall receives the routed message metadata', async () => {
    const l = lane();
    const meta = { nativeContextType: 'thread', contextId: 'omt_1' };
    await l.run(groupJid, 'recall', OWNER, meta);
    expect(l.handlers.handleRecallCommand).toHaveBeenCalledWith(groupJid, meta);
  });
});

function recallLane() {
  const groups: Record<string, any> = {
    'web:ws': { name: 'Workspace', folder: 'ws', created_by: 'u1' },
    'feishu:oc_topic': {
      name: 'topic group',
      folder: 'ws',
      created_by: 'u1',
      feishu_chat_mode: 'topic',
      target_main_jid: 'web:ws',
      binding_mode: 'thread_map',
    },
    'feishu:oc_normal': {
      name: 'normal group',
      folder: 'ws',
      created_by: 'u1',
      feishu_chat_mode: 'group',
      target_agent_id: 'session-normal',
    },
  };
  const agents: Record<string, any> = {
    'session-topic': {
      id: 'session-topic',
      chat_jid: 'web:ws',
      group_folder: 'ws',
      name: 'Topic session',
    },
    'session-normal': {
      id: 'session-normal',
      chat_jid: 'web:ws',
      group_folder: 'ws',
      name: 'Normal session',
    },
  };
  const bindings: Record<string, any> = {
    'feishu:oc_topic|omt_1': { agent_id: 'session-topic' },
  };
  const router = vi.fn((jid: string) =>
    jid === 'feishu:oc_normal'
      ? {
          effectiveJid: 'web:ws#agent:session-normal',
          agentId: 'session-normal',
        }
      : null,
  );
  const getMessagesPage = vi.fn((jid: string) => [
    {
      id: 'm1',
      chat_jid: jid,
      sender: 'u',
      sender_name: 'User',
      content: `history of ${jid}`,
      is_from_me: false,
    },
  ]);
  const globals: Record<string, any> = {
    logger,
    registeredGroups: groups,
    getRegisteredGroup: (jid: string) => groups[jid],
    getAgent: (id: string) => agents[id],
    isNativeContextContainer,
    resolveNativeThreadContext,
    getImContextBinding: (jid: string, _type: string, contextId: string) =>
      bindings[`${jid}|${contextId}`],
    buildResolveEffectiveChatJid: () => router,
    findGroupNameByFolder: () => 'Workspace',
    getMessagesPage,
    summarizeWithClaude: vi.fn(async () => null),
    formatContextMessages,
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'recallCooldowns',
    'resolveRecallTarget',
    'handleRecallCommand',
  ]) {
    harness.install(name);
  }
  return {
    globals,
    getMessagesPage,
    recall: (jid: string, meta?: unknown) =>
      globals.handleRecallCommand(jid, meta) as Promise<string>,
  };
}

describe('/recall reads the Session this message routes to (P0-2)', () => {
  test('a topic message recalls its own topic Session, never the Workspace main Session', async () => {
    const l = recallLane();
    const reply = await l.recall('feishu:oc_topic', {
      nativeContextType: 'thread',
      contextId: 'omt_1',
      threadId: 'omt_1',
    });
    expect(l.getMessagesPage).toHaveBeenCalledWith(
      'web:ws#agent:session-topic',
      undefined,
      10,
    );
    expect(l.getMessagesPage).not.toHaveBeenCalledWith(
      'web:ws',
      expect.anything(),
      expect.anything(),
    );
    expect(reply).toContain('Topic session');
  });

  test('without topic metadata a topic group refuses instead of falling back to main', async () => {
    const l = recallLane();
    const reply = await l.recall('feishu:oc_topic');
    expect(reply).toContain('话题');
    expect(l.getMessagesPage).not.toHaveBeenCalled();
  });

  test('a topic without a Session yet is reported empty, not created', async () => {
    const l = recallLane();
    const reply = await l.recall('feishu:oc_topic', {
      nativeContextType: 'thread',
      contextId: 'omt_new',
    });
    expect(reply).toContain('暂无会话记录');
    expect(l.getMessagesPage).not.toHaveBeenCalled();
  });

  test('a normal group recalls its bound Session through the inbound router', async () => {
    const l = recallLane();
    await l.recall('feishu:oc_normal');
    expect(l.getMessagesPage).toHaveBeenCalledWith(
      'web:ws#agent:session-normal',
      undefined,
      10,
    );
  });
});

function runtimeControlLane(groups: Record<string, any>) {
  const executeSessionReset = vi.fn(async () => {});
  const executeFreshWindowReset = vi.fn(async () => {});
  const persistGroupUpdate = vi.fn((jid: string, group: any, cache: any) => {
    cache[jid] = group;
  });
  const globals: Record<string, any> = {
    logger,
    path: { join: (...parts: string[]) => parts.join('/') },
    GROUPS_DIR: '/groups',
    registeredGroups: groups,
    getRegisteredGroup: (jid: string) => groups[jid],
    getAgent: (id: string) =>
      id === 'session-dm'
        ? { id, chat_jid: 'web:ws', name: 'DM session', group_folder: 'ws' }
        : undefined,
    findGroupNameByFolder: () => 'Workspace',
    resolveWorkspaceJid: (jid: string) => jid,
    resolveBoundChatTarget,
    resolveFollowUpRuntime: (jid: string) => ({
      baseChatJid: jid.split('#agent:')[0],
      agentId: jid.includes('#agent:') ? jid.split('#agent:')[1] : null,
      effectiveGroup: { folder: 'ws' },
    }),
    OWNER_REQUIRED_IM_COMMANDS,
    checkImOwnerCommand,
    isDirectMessageJid,
    resolveChannelConversationKind,
    channelConversationJid,
    claimOwner: (group: any, sender: string) => ({
      ...group,
      owner_im_id: sender,
    }),
    persistGroupUpdate,
    executeSessionReset,
    executeFreshWindowReset,
    captureWorkspaceSnapshot: async () => ({}),
    formatFreshWindowHandoff: () => 'handoff',
    FRESH_WINDOW_SUCCESS_REPLY: 'FRESH_OK',
    FRESH_WINDOW_FAILURE_REPLY: 'FRESH_FAILED',
    queue: {
      getActiveQueryId: vi.fn(() => 'run-active'),
      interruptQuery: vi.fn(() => true),
    },
    sessions: {},
    broadcastNewMessage: vi.fn(),
    setCursors: vi.fn(),
    isNativeContextContainer,
    parseChannelAddress,
    cancelQueuedFollowUpsAtCutoff: vi.fn(() => []),
    broadcastFollowUpUpdate: vi.fn(),
    clearStandaloneProcessingIndicator: vi.fn(async () => {}),
    clearTrackedProcessingIndicators: vi.fn(async () => {}),
    getStreamingSession: () => undefined,
    cancelRetryWaitChannelTurnsForInputs: vi.fn(() => 0),
    ...directChatLearning(groups),
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'learnFeishuDirectChat',
    'isDirectImConversation',
    'resolveRuntimeControlTarget',
    'checkRuntimeControlOwner',
    'channelTurnScopeForInput',
    'closeRetryWaitTurnsForWithdrawnInputs',
    'interruptActiveSessionRun',
    'handleSessionBreak',
    'handleFeishuSessionClear',
    'handleFeishuSessionFresh',
  ]) {
    harness.install(name);
  }
  return {
    globals,
    executeSessionReset,
    executeFreshWindowReset,
    persistGroupUpdate,
    clear: (input: any) => globals.handleFeishuSessionClear(input),
    fresh: (input: any) =>
      globals.handleFeishuSessionFresh({ notes: '', ...input }),
    breakRun: (input: any) => globals.handleSessionBreak(input),
  };
}

describe('Feishu runtime /clear and /fresh (P1-3, P1-4)', () => {
  const dm = 'feishu:oc_dm';
  const group = 'feishu:oc_group';
  const topic = 'feishu:oc_topic';
  const unknownDm = 'feishu:oc_dm_unknown';
  const groups = () => ({
    [dm]: {
      name: 'dm',
      folder: 'ws',
      feishu_chat_mode: 'p2p',
      owner_im_id: OWNER,
      target_agent_id: 'session-dm',
    },
    [group]: {
      name: 'group',
      folder: 'ws',
      feishu_chat_mode: 'group',
      owner_im_id: OWNER,
      target_main_jid: 'web:ws',
    },
    [topic]: {
      name: 'topic group',
      folder: 'ws',
      feishu_chat_mode: 'topic',
      binding_mode: 'thread_map',
      owner_im_id: OWNER,
      target_main_jid: 'web:ws',
    },
    [unknownDm]: {
      name: 'dm without stored mode',
      folder: 'ws',
      owner_im_id: OWNER,
      target_agent_id: 'session-dm',
    },
    'web:ws': { name: 'Workspace', folder: 'ws' },
  });

  test.each(['topic', 'group'] as const)(
    'a %s whose route failed never falls back to the Workspace main Session (M1)',
    async (kind) => {
      const l = runtimeControlLane(groups());
      const sourceJid = kind === 'topic' ? topic : group;
      await expect(
        l.clear({ sourceJid, senderImId: OWNER }),
      ).resolves.toContain('当前绑定目标不存在');
      await expect(
        l.fresh({ sourceJid, senderImId: OWNER }),
      ).resolves.toContain('当前绑定目标不存在');
      await expect(
        l.breakRun({ sourceJid, senderImId: OWNER }),
      ).resolves.toContain('当前绑定目标不存在');
      expect(l.executeSessionReset).not.toHaveBeenCalled();
      expect(l.executeFreshWindowReset).not.toHaveBeenCalled();
      expect(l.globals.queue.interruptQuery).not.toHaveBeenCalled();
    },
  );

  test('a private chat named by the connector resolves its binding and is learned', async () => {
    const l = runtimeControlLane(groups());
    await expect(
      l.clear({ sourceJid: unknownDm, senderImId: OWNER, chatType: 'p2p' }),
    ).resolves.toBe('Session context cleared.');
    expect(l.executeSessionReset).toHaveBeenCalledWith(
      'web:ws',
      'ws',
      expect.anything(),
      'session-dm',
    );
    expect(l.globals.registeredGroups[unknownDm].feishu_chat_mode).toBe('p2p');
    // /break of the same private chat stops its bound Session.
    await expect(
      l.breakRun({ sourceJid: unknownDm, senderImId: OWNER }),
    ).resolves.toBe('Current task stopped.');
    expect(l.globals.queue.interruptQuery).toHaveBeenCalledWith(
      'web:ws#agent:session-dm',
      'run-active',
    );
  });

  test('a private chat resolves its bound Session like /break does', async () => {
    const l = runtimeControlLane(groups());
    await expect(l.clear({ sourceJid: dm, senderImId: OWNER })).resolves.toBe(
      'Session context cleared.',
    );
    expect(l.executeSessionReset).toHaveBeenCalledWith(
      'web:ws',
      'ws',
      expect.anything(),
      'session-dm',
    );
    await expect(l.fresh({ sourceJid: dm, senderImId: OWNER })).resolves.toBe(
      'FRESH_OK',
    );
    expect(l.executeFreshWindowReset).toHaveBeenCalledTimes(1);
  });

  test('an unowned private chat claims its sender on first use', async () => {
    const g = groups();
    delete (g[dm] as any).owner_im_id;
    const l = runtimeControlLane(g);
    await expect(
      l.clear({ sourceJid: dm, senderImId: 'ou_dm_user' }),
    ).resolves.toBe('Session context cleared.');
    expect(l.persistGroupUpdate).toHaveBeenCalledTimes(1);
    expect(l.globals.registeredGroups[dm].owner_im_id).toBe('ou_dm_user');
  });

  test('@Bot /clear and /fresh in a group require the owner', async () => {
    const l = runtimeControlLane(groups());
    const targetJid = 'web:ws';
    const clearReply = await l.clear({
      sourceJid: group,
      targetJid,
      senderImId: MEMBER,
    });
    const freshReply = await l.fresh({
      sourceJid: group,
      targetJid,
      senderImId: MEMBER,
    });
    expect(clearReply).toContain('owner');
    expect(freshReply).toContain('owner');
    expect(l.executeSessionReset).not.toHaveBeenCalled();
    expect(l.executeFreshWindowReset).not.toHaveBeenCalled();
    await expect(
      l.clear({ sourceJid: group, targetJid, senderImId: OWNER }),
    ).resolves.toBe('Session context cleared.');
  });

  test('an unowned group never auto-claims the first runtime controller', async () => {
    const g = groups();
    delete (g[group] as any).owner_im_id;
    const l = runtimeControlLane(g);
    const reply = await l.clear({
      sourceJid: group,
      targetJid: 'web:ws',
      senderImId: MEMBER,
    });
    expect(reply).toContain('owner');
    expect(l.persistGroupUpdate).not.toHaveBeenCalled();
    expect(l.executeSessionReset).not.toHaveBeenCalled();
  });
});

function recalledLane(
  rows: any[],
  options: { pending: any[]; active?: string },
) {
  const queue = {
    getActiveQueryId: vi.fn(() => options.active ?? null),
    interruptQuery: vi.fn(() => true),
  };
  const session = { isActive: () => true, abort: vi.fn(async () => {}) };
  const globals: Record<string, any> = {
    logger,
    listInboundMessagesById: vi.fn(() => rows),
    channelConversationJid,
    getChannelType,
    cancelFollowUp: vi.fn(() => ({ ok: true })),
    getMessagesSince: vi.fn(() => options.pending),
    lastAgentTimestamp: {},
    EMPTY_CURSOR: { timestamp: '', id: '' },
    queue,
    cancelPendingInboundMessage: vi.fn(() => true),
    broadcastFollowUpUpdate: vi.fn(),
    clearStandaloneProcessingIndicator: vi.fn(async () => {}),
    clearTrackedProcessingIndicators: vi.fn(async () => {}),
    getStreamingSession: () => session,
    cancelRetryWaitChannelTurnsForInputs: vi.fn(() => 0),
    parseChannelAddress,
    registeredGroups: {},
    getRegisteredGroup: () => undefined,
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'interruptActiveSessionRun',
    'channelTurnScopeForInput',
    'closeRetryWaitTurnsForWithdrawnInputs',
    'handleChannelMessageRecalled',
  ]) {
    harness.install(name);
  }
  return {
    globals,
    queue,
    session,
    recalled: (jid: string, id: string) =>
      globals.handleChannelMessageRecalled(jid, id),
  };
}

describe('a recalled Feishu message is withdrawn (prod P2-4)', () => {
  const chat = 'feishu:oc_chat#account:bot';
  const row = (status: string | null) => ({
    id: 'om_recalled',
    chat_jid: 'web:ws#agent:s1',
    source_jid: 'feishu:oc_chat#account:bot#thread:omt_1',
    delivery_status: status,
  });

  test('a still-queued input is cancelled and leaves the visible queue', () => {
    const l = recalledLane([row('queued')], { pending: [] });
    l.recalled(chat, 'om_recalled');
    expect(l.globals.cancelFollowUp).toHaveBeenCalledWith(
      'web:ws#agent:s1',
      'om_recalled',
    );
    expect(l.queue.interruptQuery).not.toHaveBeenCalled();
  });

  test('the sole executing input is stopped like /break, without a framework reply', () => {
    const l = recalledLane([row(null)], {
      pending: [{ id: 'om_recalled' }],
      active: 'run-1',
    });
    expect(l.recalled(chat, 'om_recalled')).toBeUndefined();
    expect(l.queue.interruptQuery).toHaveBeenCalledWith(
      'web:ws#agent:s1',
      'run-1',
    );
    expect(l.session.abort).toHaveBeenCalled();
  });

  test('one input of a larger executing batch is left running', () => {
    const l = recalledLane([row(null)], {
      pending: [{ id: 'om_other' }, { id: 'om_recalled' }],
      active: 'run-1',
    });
    l.recalled(chat, 'om_recalled');
    expect(l.queue.interruptQuery).not.toHaveBeenCalled();
  });

  test('an input not picked up yet is cancelled before it runs', () => {
    const l = recalledLane([row(null)], { pending: [{ id: 'om_recalled' }] });
    l.recalled(chat, 'om_recalled');
    expect(l.globals.cancelPendingInboundMessage).toHaveBeenCalledWith(
      'web:ws#agent:s1',
      'om_recalled',
    );
    expect(l.globals.broadcastFollowUpUpdate).toHaveBeenCalled();
    // Scoped to this Bot account and session (M2), not the bare message id.
    expect(l.globals.cancelRetryWaitChannelTurnsForInputs).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'feishu',
        accountId: 'bot',
        agentId: 's1',
        correlationIds: ['om_recalled'],
      }),
    );
  });

  test('a merged-forward root held for its companion is cancelled (should-fix 10)', () => {
    const l = recalledLane([row('awaiting_companion')], { pending: [] });
    l.recalled(chat, 'om_recalled');
    expect(l.globals.cancelPendingInboundMessage).toHaveBeenCalledWith(
      'web:ws#agent:s1',
      'om_recalled',
    );
    expect(l.globals.getMessagesSince).not.toHaveBeenCalled();
    expect(l.queue.interruptQuery).not.toHaveBeenCalled();
  });

  test('a copy routed from another chat is never touched', () => {
    const l = recalledLane(
      [{ ...row('queued'), source_jid: 'feishu:oc_other#account:bot' }],
      { pending: [] },
    );
    l.recalled(chat, 'om_recalled');
    expect(l.globals.cancelFollowUp).not.toHaveBeenCalled();
  });
});

function settlementLane() {
  const deliverChannelDefinitiveFailureNotice = vi.fn(async () => true);
  const globals: Record<string, any> = {
    logger,
    channelOutboxFailureDetail,
    getDeliveredChannelOutboxForTurn: () => undefined,
    deliverChannelDefinitiveFailureNotice,
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('settleChannelTurnDefinitiveFailure');
  const runtime = {
    runId: 'turn-1',
    cancel: vi.fn(() => true),
    fail: vi.fn(() => true),
  };
  return {
    runtime,
    deliverChannelDefinitiveFailureNotice,
    settle: (failedId: string) =>
      globals.settleChannelTurnDefinitiveFailure({
        runtime,
        failedDelivery: { id: failedId },
        notice: { logicalChatJid: 'web:ws', route: {} },
      }),
  };
}

const axios = (code: number) => ({
  response: { status: 400, data: { code }, headers: {} },
});

describe('definitive delivery failures (prod P2-4, P2-6)', () => {
  test('a recalled anchor closes the Turn quietly as cancelled, with no notice to it', async () => {
    rememberChannelOutboxFailure(
      'outbox-recalled',
      new DefinitiveChannelDeliveryError('gone', { cause: axios(230011) }),
    );
    const l = settlementLane();
    await expect(l.settle('outbox-recalled')).resolves.toEqual({
      settled: true,
      notified: true,
    });
    expect(l.runtime.cancel).toHaveBeenCalled();
    expect(l.runtime.fail).not.toHaveBeenCalled();
    expect(l.deliverChannelDefinitiveFailureNotice).not.toHaveBeenCalled();
  });

  test('a DLP refusal fails the Turn and tells the user why', async () => {
    rememberChannelOutboxFailure(
      'outbox-dlp',
      new DefinitiveChannelDeliveryError('audit', { cause: axios(230028) }),
    );
    const l = settlementLane();
    await l.settle('outbox-dlp');
    expect(l.runtime.fail).toHaveBeenCalled();
    expect(l.deliverChannelDefinitiveFailureNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: '内容含邮箱等敏感信息，被飞书安全策略拦截',
      }),
    );
  });
});
