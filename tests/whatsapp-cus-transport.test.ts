import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Listener = (value: any) => unknown;
  function createSocket() {
    const listeners = new Map<string, Listener[]>();
    return {
      listeners,
      ev: {
        on: vi.fn((event: string, listener: Listener) => {
          const entries = listeners.get(event) ?? [];
          entries.push(listener);
          listeners.set(event, entries);
        }),
      },
      ws: { on: vi.fn(), isConnecting: false },
      user: { id: '19990001111:7@s.whatsapp.net', name: 'Test bot' },
      sendMessage: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
      groupMetadata: vi.fn(async () => ({ subject: 'Test group' })),
      end: vi.fn(),
      logout: vi.fn(async () => undefined),
      async emit(event: string, value: unknown) {
        await Promise.all(
          (listeners.get(event) ?? []).map((listener) => listener(value)),
        );
      },
    };
  }
  return { sockets: [] as ReturnType<typeof createSocket>[], createSocket };
});

vi.mock('baileys', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    makeWASocket: vi.fn(() => {
      const socket = harness.createSocket();
      harness.sockets.push(socket);
      return socket;
    }),
    useMultiFileAuthState: vi.fn(async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(async () => undefined),
    })),
    fetchLatestBaileysVersion: vi.fn(async () => ({
      version: [2, 3000, 1],
      isLatest: true,
    })),
  };
});

const db = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
  getRegisteredGroup: vi.fn(),
  getDefaultChannelAccount: vi.fn(),
  getLegacyChannelAccount: vi.fn(),
  getChannelAccount: vi.fn(),
  getUserById: vi.fn(),
  isDatabaseInitialized: vi.fn(() => false),
}));
vi.mock('../src/db.js', () => db);
vi.mock('../src/web.js', () => ({ broadcastNewMessage: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,test') },
}));
vi.mock('proxy-agent', () => ({
  ProxyAgent: class {
    destroy() {}
  },
}));

const { createWhatsAppConnection } = await import('../src/whatsapp.js');
const {
  resolveWhatsAppConversationAlias,
  resolveWhatsAppConversationAliasFromGroups,
} = await import('../src/whatsapp-jid.js');
const { IMConnectionManager } = await import('../src/im-manager.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-cus-transport-'));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function message(remoteJid: string, id: string, text = 'hello') {
  return {
    key: { remoteJid, id, fromMe: false },
    message: { conversation: text },
    pushName: 'Legacy contact',
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

async function connect(accountId: string) {
  const onNewChat = vi.fn();
  const isChatAuthorized = vi.fn(() => true);
  const resolveEffectiveChatJid = vi.fn((jid: string) => ({
    effectiveJid: jid,
    agentId: null,
  }));
  const connection = createWhatsAppConnection({
    accountId,
    authDir: path.join(root, accountId),
  });
  await connection.connect({
    onNewChat,
    isChatAuthorized,
    resolveEffectiveChatJid,
    normalizeIncomingJid: (jid) => `${jid}#account:${accountId}`,
  });
  const socket = harness.sockets.at(-1)!;
  return {
    connection,
    socket,
    onNewChat,
    isChatAuthorized,
    resolveEffectiveChatJid,
  };
}

describe('WhatsApp legacy @c.us transport identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
  });

  test('raw c.us, device c.us, and canonical PN share registration, source, sender, and dedup identity', async () => {
    const connected = await connect('bot-a');
    const emit = async (remoteJid: string, id: string) =>
      connected.socket.emit('messages.upsert', {
        type: 'notify',
        messages: [message(remoteJid, id)],
      });

    await emit('15551234567@c.us', 'raw-1');
    await emit('15551234567:14@c.us', 'raw-2');
    await emit('15551234567@s.whatsapp.net', 'canonical-3');
    // The same provider message can cross a placeholder-resend boundary under
    // different aliases; it must still be delivered once.
    await emit('15551234567:14@c.us', 'dedup-4');
    await emit('15551234567@s.whatsapp.net', 'dedup-4');

    const canonical = 'whatsapp:15551234567@s.whatsapp.net#account:bot-a';
    expect(connected.isChatAuthorized).toHaveBeenCalledTimes(4);
    expect(connected.isChatAuthorized.mock.calls.map(([jid]) => jid)).toEqual(
      Array(4).fill(canonical),
    );
    expect(connected.onNewChat).toHaveBeenCalledTimes(4);
    expect(connected.onNewChat.mock.calls.map(([jid]) => jid)).toEqual(
      Array(4).fill(canonical),
    );
    expect(db.storeMessageDirect).toHaveBeenCalledTimes(4);
    for (const call of db.storeMessageDirect.mock.calls) {
      expect(call[1]).toBe(canonical);
      expect(call[2]).toBe('whatsapp:15551234567@s.whatsapp.net');
      expect(call[7]).toMatchObject({ sourceJid: canonical });
    }
  });

  test('keeps account scope distinct for the same legacy phone number', async () => {
    const first = await connect('bot-a');
    const second = await connect('bot-b');
    const inbound = message('15551234567:14@c.us', 'same-external-id');
    await first.socket.emit('messages.upsert', {
      type: 'notify',
      messages: [inbound],
    });
    await second.socket.emit('messages.upsert', {
      type: 'notify',
      messages: [inbound],
    });

    expect(first.onNewChat).toHaveBeenCalledWith(
      'whatsapp:15551234567@s.whatsapp.net#account:bot-a',
      'Legacy contact',
    );
    expect(second.onNewChat).toHaveBeenCalledWith(
      'whatsapp:15551234567@s.whatsapp.net#account:bot-b',
      'Legacy contact',
    );
  });

  test('unauthorized legacy inbound performs no persistence or routing writes', async () => {
    const onNewChat = vi.fn();
    const resolveEffectiveChatJid = vi.fn(() => ({
      effectiveJid: 'must-not-route',
      agentId: null,
    }));
    const isChatAuthorized = vi.fn(() => false);
    const connection = createWhatsAppConnection({
      accountId: 'bot-denied',
      authDir: path.join(root, 'bot-denied'),
    });
    await connection.connect({
      onNewChat,
      isChatAuthorized,
      resolveEffectiveChatJid,
      normalizeIncomingJid: (jid) => `${jid}#account:bot-denied`,
    });
    const socket = harness.sockets.at(-1)!;
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [message('15551234567:14@c.us', 'denied-1')],
    });

    expect(isChatAuthorized).toHaveBeenCalledWith(
      'whatsapp:15551234567@s.whatsapp.net#account:bot-denied',
    );
    expect(onNewChat).not.toHaveBeenCalled();
    expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(db.storeChatMetadata).not.toHaveBeenCalled();
    expect(db.updateChatName).not.toHaveBeenCalled();
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('a unique legacy pairing keeps its exact active route without re-pairing', async () => {
    const legacy = 'whatsapp:15551234567:14@c.us#account:bot-a';
    const onNewChat = vi.fn();
    const onPairAttempt = vi.fn(async () => false);
    const onAgentMessage = vi.fn();
    const isChatAuthorized = vi.fn((jid: string) => jid === legacy);
    const resolveEffectiveChatJid = vi.fn(() => ({
      effectiveJid: 'web:existing-workspace#agent:existing-session',
      agentId: 'existing-session',
    }));
    const connection = createWhatsAppConnection({
      accountId: 'bot-a',
      authDir: path.join(root, 'bot-a-legacy'),
    });
    await connection.connect({
      onNewChat,
      onPairAttempt,
      onAgentMessage,
      isChatAuthorized,
      resolveEffectiveChatJid,
      normalizeIncomingJid: (jid) => {
        const scoped = `${jid}#account:bot-a`;
        const resolved = resolveWhatsAppConversationAlias(scoped, [legacy]);
        if (resolved.status === 'conflict') throw new Error('unexpected');
        return resolved.jid;
      },
    });
    const socket = harness.sockets.at(-1)!;
    for (const [remoteJid, id] of [
      ['15551234567:14@c.us', 'legacy-route-1'],
      ['15551234567@s.whatsapp.net', 'legacy-route-2'],
    ]) {
      await socket.emit('messages.upsert', {
        type: 'notify',
        messages: [message(remoteJid, id)],
      });
    }

    expect(isChatAuthorized.mock.calls.map(([jid]) => jid)).toEqual([
      legacy,
      legacy,
    ]);
    expect(onPairAttempt).not.toHaveBeenCalled();
    expect(onNewChat.mock.calls.map(([jid]) => jid)).toEqual([legacy, legacy]);
    expect(resolveEffectiveChatJid.mock.calls.map(([jid]) => jid)).toEqual([
      legacy,
      legacy,
    ]);
    expect(onAgentMessage).toHaveBeenCalledTimes(2);
    for (const call of db.storeMessageDirect.mock.calls) {
      expect(call[1]).toBe('web:existing-workspace#agent:existing-session');
      expect(call[2]).toBe('whatsapp:15551234567@s.whatsapp.net');
      expect(call[7]).toMatchObject({ sourceJid: legacy });
    }
  });

  test('manager account scoping preserves alias-conflict denial before /pair or writes', async () => {
    const first = 'whatsapp:15551234567:14@c.us#account:bot-a';
    const second = 'whatsapp:15551234567@c.us#account:bot-a';
    const base = {
      folder: 'home-owner',
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      owner_im_id: '15551234567@s.whatsapp.net',
      owner_claim_source: 'trusted_direct',
    };
    const normalizeIncomingJid = vi.fn((jid: string) => {
      const resolved = resolveWhatsAppConversationAliasFromGroups(jid, {
        [first]: { ...base, target_agent_id: 'session-a' },
        [second]: { ...base, target_agent_id: 'session-b' },
      });
      return resolved.jid;
    });
    const isChatAuthorized = vi.fn(() => true);
    const onPairAttempt = vi.fn(async () => true);
    const onNewChat = vi.fn();
    const resolveEffectiveChatJid = vi.fn(() => ({
      effectiveJid: 'must-not-route',
      agentId: null,
    }));
    const connection = createWhatsAppConnection({
      accountId: 'bot-a',
      authDir: path.join(root, 'manager-conflict'),
    });
    const channel = {
      channelType: 'whatsapp',
      async connect(opts: Parameters<typeof connection.connect>[0]) {
        await connection.connect(opts);
        return true;
      },
      async disconnect() {
        await connection.disconnect();
      },
      async sendMessage() {},
      async setTyping() {},
      isConnected: () => true,
    };
    const manager = new IMConnectionManager();
    await manager.connectChannel(
      'owner-a',
      'whatsapp',
      channel,
      {
        onReady: vi.fn(),
        onNewChat,
        isChatAuthorized,
        onPairAttempt,
        resolveEffectiveChatJid,
        normalizeIncomingJid,
      },
      'bot-a',
    );
    const socket = harness.sockets.at(-1)!;
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [message('15551234567:14@c.us', 'conflict-pair', '/pair code')],
    });

    expect(normalizeIncomingJid).toHaveBeenCalledWith(
      'whatsapp:15551234567@s.whatsapp.net#account:bot-a',
    );
    expect(isChatAuthorized).not.toHaveBeenCalled();
    expect(onPairAttempt).not.toHaveBeenCalled();
    expect(onNewChat).not.toHaveBeenCalled();
    expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(db.storeChatMetadata).not.toHaveBeenCalled();
    expect(db.updateChatName).not.toHaveBeenCalled();
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    expect(socket.sendMessage).not.toHaveBeenCalled();
    await manager.disconnectAll();
  });

  test('uses canonical identity for pairing but replies through the raw SDK target', async () => {
    const onPairAttempt = vi.fn(async () => true);
    const connection = createWhatsAppConnection({
      accountId: 'bot-pair',
      authDir: path.join(root, 'bot-pair'),
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: vi.fn(() => false),
      onPairAttempt,
      normalizeIncomingJid: (jid) => `${jid}#account:bot-pair`,
    });
    const socket = harness.sockets.at(-1)!;
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [message('15551234567:14@c.us', 'pair-1', '/pair code')],
    });

    expect(onPairAttempt).toHaveBeenCalledWith(
      'whatsapp:15551234567@s.whatsapp.net#account:bot-pair',
      'Legacy contact',
      'code',
    );
    expect(socket.sendMessage).toHaveBeenCalledWith('15551234567:14@c.us', {
      text: '配对成功！此聊天已连接到你的工作区。',
    });
  });
});
