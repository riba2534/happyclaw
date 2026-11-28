/**
 * Ordinary (non-forum) Telegram supergroup replies carry message_thread_id as
 * the reply-chain root id with is_topic_message absent. Inbound must ignore
 * that id so the flat chat is not upgraded to a native-thread container.
 *
 * Real Forum topics (is_topic_message === true) still route per thread.
 * ensureNativeContextChannelMount is a verbatim extract of src/index.ts
 * (index.ts is not importable from tests).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'telegram-reply-thread-topic-'),
);
process.env.WEB_SESSION_SECRET ??= 'telegram-reply-thread-topic-secret';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: any) => Promise<void>>(),
  stop: null as (() => void) | null,
  groups: new Map<string, any>(),
  agents: new Map<string, any>(),
  stored: [] as Array<{ chatJid: string; text: string; sourceJid?: string }>,
  warn: [] as string[],
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: () => {} },
      getMe: async () => ({ id: 1, username: 'topic_bot' }),
      getChat: async () => ({ is_forum: false }),
      setMessageReaction: async () => {},
    };
    on(filter: string, fn: (ctx: any) => Promise<void>) {
      h.handlers.set(filter, fn);
      return this;
    }
    start(o: { onStart?: () => void }) {
      o.onStart?.();
      return new Promise<void>((r) => (h.stop = r));
    }
    stop() {
      h.stop?.();
      h.stop = null;
    }
  },
  InputFile: class {},
}));
vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  DATA_DIR: root,
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: (_o: unknown, msg: string) => h.warn.push(msg),
    error: (_o: unknown, msg: string) => h.warn.push(msg),
  },
}));
vi.mock('../src/message-notifier.js', () => ({ notifyNewImMessage: () => {} }));
vi.mock('../src/db.js', () => {
  const noop = () => {};
  return {
    storeChatMetadata: noop,
    updateChatName: noop,
    storeMessageDirect: (
      _id: string,
      chatJid: string,
      _sender: string,
      _senderName: string,
      text: string,
      ...rest: any[]
    ) => {
      h.stored.push({ chatJid, text, sourceJid: rest[2]?.sourceJid });
    },
    getRegisteredGroup: (jid: string) => h.groups.get(jid),
    setRegisteredGroup: (jid: string, g: any) => h.groups.set(jid, g),
    setRegisteredGroupAndClearMatchingMainOwner: (jid: string, g: any) =>
      h.groups.set(jid, g),
    getJidsByFolder: () => [],
    getAllRegisteredGroups: () => Object.fromEntries(h.groups),
    createAgent: noop,
    ensureChatExists: noop,
    getChannelAccount: () => undefined,
    getDefaultChannelAccount: () => undefined,
    getLegacyChannelAccount: () => undefined,
    getUserHomeGroup: () => undefined,
    listAgentsByJid: () => [],
    updateAgentLastImJid: noop,
  };
});

const { createTelegramConnection } = await import('../src/telegram.js');
const { createChannelInboundRouter } =
  await import('../src/channel-inbound-routing.js');
const { upgradeNativeContextChannelMount, isNativeContextContainer } =
  await import('../src/channel-mount-service.js');
const { getChannelType } = await import('../src/im-channel.js');

// ── verbatim extract of src/index.ts:19998-20044 (markThreadMapWorkspace stubbed) ──
const registeredGroups: Record<string, any> = {};
const setRegisteredGroup = (jid: string, g: any) => h.groups.set(jid, g);
const markThreadMapWorkspace = (_jid?: string) => {};
const logger = { error: (_o: unknown, m: string) => h.warn.push(m) };
function ensureNativeContextChannelMount(chatJid: string, group: any): any {
  if (
    getChannelType(chatJid) === 'feishu' &&
    !isNativeContextContainer(chatJid, group)
  ) {
    return null;
  }
  const persistNativeCapability = true;
  const detectedGroup = {
    ...group,
    native_context_type: 'thread',
  };
  const upgrade = upgradeNativeContextChannelMount(chatJid, detectedGroup);
  if (upgrade.status === 'conflict') {
    setRegisteredGroup(chatJid, detectedGroup);
    registeredGroups[chatJid] = detectedGroup;
    logger.error(
      { chatJid },
      'Native-context channel mount upgrade rejected; dropping message',
    );
    return null;
  }
  let updated = upgrade.updated;
  if (
    persistNativeCapability &&
    ((upgrade.status === 'unchanged' &&
      group.native_context_type !== 'thread') ||
      updated.native_context_type !== 'thread')
  ) {
    updated = { ...updated, native_context_type: 'thread' };
    setRegisteredGroup(chatJid, updated);
  }
  registeredGroups[chatJid] = updated;
  markThreadMapWorkspace(updated.target_main_jid);
  return updated;
}
// ── end extract ──

const CHAT = 'telegram:-100777';
const WS = 'web:ws-1';
const getGroup = (jid: string) => registeredGroups[jid] ?? h.groups.get(jid);
const router = createChannelInboundRouter({
  getRegisteredGroup: getGroup,
  getAgent: (id) => h.agents.get(id),
  getChannelMount: () => undefined,
  resolveWorkspaceJid: (jid) => (h.groups.has(jid) ? jid : null),
  ensureNativeContextChannelMount,
  resolveOrCreateNativeThreadAgent: (_c, wsJid, _w, _g, t) => ({
    effectiveJid: `${wsJid}#agent:thread-${t.contextId}`,
    agentId: `thread-${t.contextId}`,
    sourceJid: `${CHAT}#thread:${t.contextId}`,
  }),
});

let conn: ReturnType<typeof createTelegramConnection> | null = null;
async function connect() {
  conn = createTelegramConnection({ botToken: 't' });
  await conn.connect({
    onNewChat: () => {},
    isChatAuthorized: (jid: string) => h.groups.has(jid),
    resolveEffectiveChatJid: router,
    onNativeContextDetected: (jid: string) => {
      const g = getGroup(jid);
      if (!g) return false;
      return ensureNativeContextChannelMount(jid, g) !== null;
    },
    onAgentMessage: () => {},
  } as never);
}

let mid = 100;
function ctx(text: string, extra: Record<string, unknown> = {}) {
  return {
    message: {
      message_id: ++mid,
      date: Math.floor(Date.now() / 1000),
      text,
      ...extra,
    },
    // Telegram omits is_forum for ordinary supergroups.
    chat: { id: -100777, type: 'supergroup', title: 'Team' },
    from: { id: 9, first_name: 'Ada' },
    react: async () => {},
    reply: async () => {},
  };
}

function seed(bound: 'workspace' | 'session') {
  h.groups.clear();
  h.agents.clear();
  for (const k of Object.keys(registeredGroups)) delete registeredGroups[k];
  h.stored.length = 0;
  h.warn.length = 0;
  h.groups.set(WS, {
    name: 'WS',
    folder: 'ws-1',
    created_by: 'u1',
    added_at: 'x',
  });
  if (bound === 'workspace') {
    h.groups.set(CHAT, {
      name: 'Team',
      folder: 'ws-1',
      created_by: 'u1',
      added_at: 'x',
      target_main_jid: WS,
      binding_mode: 'single_context',
    });
  } else {
    h.agents.set('s1', { id: 's1', chat_jid: WS, kind: 'conversation' });
    h.groups.set(CHAT, {
      name: 'Team',
      folder: 'ws-1',
      created_by: 'u1',
      added_at: 'x',
      target_agent_id: 's1',
    });
  }
}

beforeEach(async () => {
  h.handlers.clear();
  await connect();
});
afterEach(async () => {
  await conn?.disconnect();
  conn = null;
});

// Upstream removed single_context workspace bindings (a7c4a463); test session-bound flat chat.
for (const bound of ['session'] as const) {
  describe(`ordinary supergroup bound to ${bound}`, () => {
    test('a reply (reply-chain message_thread_id, no is_topic_message) must not turn the chat into a topic container; next top-level message must still route', async () => {
      seed(bound);
      const onText = h.handlers.get('message:text')!;
      await onText(ctx('first question @topic_bot'));
      // user replies to the bot's answer: Telegram stamps the reply-chain root
      await onText(
        ctx('thanks, follow-up', {
          message_thread_id: 101,
          reply_to_message: { message_id: 101 },
        }),
      );
      await onText(ctx('new unrelated question @topic_bot'));

      const persisted = h.groups.get(CHAT);
      expect(persisted.native_context_type ?? 'none').not.toBe('thread');
      expect(h.stored.map((s) => s.text)).toContain(
        'new unrelated question @topic_bot',
      );
      // Flat route: no #thread: in the persisted source / chat jids from the reply
      const replyStored = h.stored.find((s) => s.text === 'thanks, follow-up');
      expect(replyStored?.chatJid).not.toMatch(/#thread:/);
      expect(replyStored?.sourceJid ?? '').not.toMatch(/#thread:/);
    });
  });
}

describe('control: real Forum topic still routes to its thread agent', () => {
  test('is_topic_message=true in a thread_map forum routes to thread agent', async () => {
    seed('workspace');
    h.groups.set(CHAT, {
      ...h.groups.get(CHAT),
      binding_mode: 'thread_map',
      native_context_type: 'thread',
    });
    const onText = h.handlers.get('message:text')!;
    await onText({
      ...ctx('topic question', {
        message_thread_id: 55,
        is_topic_message: true,
      }),
      chat: { id: -100777, type: 'supergroup', title: 'Team', is_forum: true },
    });
    expect(h.stored).toEqual([
      expect.objectContaining({
        chatJid: 'web:ws-1#agent:thread-55',
        text: 'topic question',
      }),
    ]);
  });
});
