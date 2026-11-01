import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

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
      updateMediaMessage: vi.fn(),
      async emit(event: string, value: unknown) {
        await Promise.all(
          (listeners.get(event) ?? []).map((listener) => listener(value)),
        );
      },
    };
  }
  return { sockets: [] as ReturnType<typeof createSocket>[], createSocket };
});

const downloadMediaMessage = vi.hoisted(() =>
  vi.fn(async () => Buffer.from('sticker-bytes')),
);

vi.mock('baileys', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    downloadMediaMessage,
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

const { createWhatsAppConnection, whatsAppCommandMentions } =
  await import('../src/whatsapp.js');
const { groupAudienceHost } = await import('./helpers/group-audience.js');
const { followUpHost } = await import('./helpers/follow-up-host.js');
const { STEER_TARGET_MISSING_REPLY } =
  await import('../src/im-connector-follow-up.js');
type AudienceGroup = import('./helpers/group-audience.js').AudienceGroup;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-group-'));
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const GROUP = '120363000000@g.us';
const GROUP_JID = `whatsapp:${GROUP}`;
const BOT_JID = '19990001111@s.whatsapp.net';
const OWNER = '15550000001@s.whatsapp.net';
const MEMBER = '15550000002@s.whatsapp.net';
const OUTSIDER = '15550000003@s.whatsapp.net';
let seq = 0;

function groupMessage(
  participant: string,
  text: string,
  mentionedJid?: string[],
  remoteJid = GROUP,
) {
  seq += 1;
  return {
    key: {
      remoteJid,
      id: `wa-${seq}`,
      fromMe: false,
      participant: remoteJid.endsWith('@g.us') ? participant : undefined,
    },
    message: mentionedJid
      ? { extendedTextMessage: { text, contextInfo: { mentionedJid } } }
      : { conversation: text },
    pushName: 'Member',
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

describe('WhatsApp group response audience', () => {
  let groups: Record<string, AudienceGroup>;
  let onCommand: ReturnType<typeof vi.fn>;
  let connection: ReturnType<typeof createWhatsAppConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
    groups = {};
    onCommand = vi.fn(async (_jid: string, command: string) =>
      command.startsWith('status') || command.startsWith('owner_mention')
        ? 'ok'
        : null,
    );
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  async function connect(group?: AudienceGroup) {
    if (group) groups[GROUP_JID] = group;
    const host = groupAudienceHost('whatsapp', groups);
    connection = createWhatsAppConnection({
      accountId: `wa-${seq}`,
      authDir: path.join(root, `auth-${seq}`),
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      onCommand,
      ...host,
    });
    const socket = harness.sockets.at(-1)!;
    return {
      host,
      deliver: (...messages: ReturnType<typeof groupMessage>[]) =>
        socket.emit('messages.upsert', { type: 'notify', messages }),
    };
  }

  test('owner_only: the owner reaches the Agent, another member does not', async () => {
    const { deliver } = await connect({
      audience_mode: 'owner_only',
      owner_im_id: OWNER,
    });
    await deliver(groupMessage(OWNER, 'hi'));
    await deliver(groupMessage(MEMBER, 'hi'));
    await deliver(groupMessage(MEMBER, '@19990001111 /status', [BOT_JID]));
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(db.storeMessageDirect.mock.calls[0][2]).toBe(`whatsapp:${OWNER}`);
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('allowlist: listed members pass, others are dropped', async () => {
    const { deliver } = await connect({
      audience_mode: 'everyone',
      owner_im_id: OWNER,
      sender_allowlist: [OWNER, MEMBER],
    });
    await deliver(groupMessage(MEMBER, 'listed'));
    await deliver(groupMessage(OUTSIDER, 'not listed'));
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe('listed');
  });

  test('everyone without an allowlist admits every member', async () => {
    const { deliver } = await connect({ audience_mode: 'everyone' });
    await deliver(groupMessage(MEMBER, 'a'), groupMessage(OUTSIDER, 'b'));
    expect(db.storeMessageDirect).toHaveBeenCalledTimes(2);
  });

  test('private chats never consult the group gate', async () => {
    const { host, deliver } = await connect();
    host.isSenderAllowedInGroup.mockReturnValue(false);
    await deliver(groupMessage(OUTSIDER, 'dm', undefined, OUTSIDER));
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(host.isSenderAllowedInGroup).not.toHaveBeenCalled();
  });

  test('an unowned owner_only group can only be claimed with /owner_mention', async () => {
    const { deliver } = await connect({ audience_mode: 'owner_only' });
    await deliver(groupMessage(MEMBER, '/status'));
    expect(onCommand).not.toHaveBeenCalled();
    await deliver(
      groupMessage(MEMBER, '@19990001111 /owner_mention', [BOT_JID]),
    );
    expect(onCommand).toHaveBeenCalledWith(
      GROUP_JID,
      'owner_mention',
      MEMBER,
      [],
    );
  });

  test('/allow hands the host the @mentioned members', async () => {
    const { deliver } = await connect({
      audience_mode: 'everyone',
      owner_im_id: OWNER,
    });
    await deliver(
      groupMessage(OWNER, '@19990001111 /allow @15550000002', [
        BOT_JID,
        MEMBER,
      ]),
    );
    expect(onCommand).toHaveBeenCalledWith(
      GROUP_JID,
      'allow @15550000002',
      OWNER,
      [{ imId: MEMBER }],
    );
  });
});

describe('WhatsApp audience: /owner_mention is only an exception when consumed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
  });

  test('an /owner_mention the host does not consume is dropped', async () => {
    seq += 1;
    const groups: Record<string, AudienceGroup> = {
      [GROUP_JID]: { audience_mode: 'owner_only' },
    };
    const connection = createWhatsAppConnection({
      accountId: `wa-boot-${seq}`,
      authDir: path.join(root, `auth-boot-${seq}`),
    });
    const onCommand = vi.fn(async () => null);
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      onCommand,
      ...groupAudienceHost('whatsapp', groups),
    });
    const socket = harness.sockets.at(-1)!;
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [groupMessage(MEMBER, '/owner_mention run this')],
    });
    expect(onCommand).toHaveBeenCalledOnce();
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    await connection.disconnect();
  });
});

describe('whatsAppCommandMentions', () => {
  test('normalized member JIDs, never the bot itself', () => {
    expect(
      whatsAppCommandMentions(
        {
          extendedTextMessage: {
            text: 'x',
            contextInfo: {
              mentionedJid: [
                '19990001111:7@s.whatsapp.net',
                '15550000002:3@s.whatsapp.net',
              ],
            },
          },
        },
        { id: '19990001111:7@s.whatsapp.net' },
      ),
    ).toEqual([{ imId: '15550000002@s.whatsapp.net' }]);
  });
});

describe('WhatsApp durable queue and runtime controls', () => {
  let connection: ReturnType<typeof createWhatsAppConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  async function connect(
    host: ReturnType<typeof followUpHost>,
    extra: Record<string, unknown> = {},
  ) {
    seq += 1;
    connection = createWhatsAppConnection({
      accountId: `wa-rc-${seq}`,
      authDir: path.join(root, `auth-rc-${seq}`),
    });
    const opts = {
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      onCommand: vi.fn(async () => null),
      onMessagePersisted: vi.fn(),
      ...host,
      ...extra,
    };
    await connection.connect(opts);
    const socket = harness.sockets.at(-1)!;
    return {
      opts,
      socket,
      deliver: (...messages: ReturnType<typeof groupMessage>[]) =>
        socket.emit('messages.upsert', { type: 'notify', messages }),
    };
  }

  const dm = (text: string) =>
    groupMessage(OUTSIDER, text, undefined, OUTSIDER);

  test('an input arriving during a run waits in the durable queue', async () => {
    const host = followUpHost('queued');
    const { opts, deliver } = await connect(host);
    await deliver(dm('later'));
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      targetJid: `whatsapp:${OUTSIDER}`,
      sourceJid: `whatsapp:${OUTSIDER}`,
      senderImId: `whatsapp:${OUTSIDER}`,
    });
    expect(opts.onMessagePersisted.mock.calls[0][1]).toMatchObject({
      delivery_status: 'queued',
    });
    expect(host.onFollowUpsChanged).toHaveBeenCalledWith(
      `whatsapp:${OUTSIDER}`,
    );
  });

  test('with no active run the input starts a turn as before', async () => {
    const host = followUpHost('started');
    const { deliver } = await connect(host);
    await deliver(dm('now'));
    expect(host.onFollowUpMessage).toHaveBeenCalledOnce();
  });

  test('/steer and /break in a private chat', async () => {
    const host = followUpHost('queued');
    const { opts, socket, deliver } = await connect(host);
    await deliver(dm('/steer shorter answers'));
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe('shorter answers');
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      requestedMode: 'steer',
    });
    expect(opts.onCommand).not.toHaveBeenCalled();

    await deliver(dm('/break'));
    expect(host.onSessionBreak).toHaveBeenCalledWith({
      sourceJid: `whatsapp:${OUTSIDER}`,
      targetJid: `whatsapp:${OUTSIDER}`,
      senderImId: OUTSIDER,
      chatType: 'p2p',
    });
    expect(socket.sendMessage).toHaveBeenCalledWith(OUTSIDER, {
      text: 'Current task stopped.',
    });
    expect(db.storeMessageDirect).toHaveBeenCalledTimes(1);
  });

  test('a control for a chat without a Session only looks it up', async () => {
    const host = followUpHost('queued');
    const resolveEffectiveChatJid = vi.fn((jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    }));
    const lookupEffectiveChatJid = vi.fn(() => null);
    const { socket, deliver } = await connect(host, {
      resolveEffectiveChatJid,
      lookupEffectiveChatJid,
    });
    await deliver(dm('/break'));
    expect(host.onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({ targetJid: undefined }),
    );
    await deliver(dm('/steer go'));
    expect(socket.sendMessage).toHaveBeenLastCalledWith(OUTSIDER, {
      text: STEER_TARGET_MISSING_REPLY,
    });
    expect(lookupEffectiveChatJid).toHaveBeenCalledWith(`whatsapp:${OUTSIDER}`);
    expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(db.storeMessageDirect).not.toHaveBeenCalled();

    lookupEffectiveChatJid.mockReturnValue({
      effectiveJid: 'web:home',
      agentId: null,
    } as never);
    await deliver(dm('/break'));
    expect(host.onSessionBreak).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetJid: 'web:home' }),
    );
  });

  test('a group control needs the bot in mentionedJid', async () => {
    const host = followUpHost('started');
    const { deliver } = await connect(host, {
      shouldProcessGroupMessage: () => true,
    });
    await deliver(groupMessage(MEMBER, '/break'));
    expect(host.onSessionBreak).not.toHaveBeenCalled();
    await deliver(groupMessage(MEMBER, '@19990001111 /break', [BOT_JID]));
    expect(host.onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({ sourceJid: GROUP_JID, chatType: 'group' }),
    );
  });
});
