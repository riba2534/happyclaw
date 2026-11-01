import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const inbound = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (ctx: any, next?: () => Promise<unknown>) => Promise<void>
  >(),
  storeMessageDirect: vi.fn(),
  stop: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn(async () => ({ id: 1, username: 'happy_bot' })),
      getFile: vi.fn(async () => ({})),
      getChat: vi.fn(async () => ({ is_forum: false })),
      setMessageReaction: vi.fn(async () => {}),
    };
    on(
      filter: string,
      fn: (ctx: any, next?: () => Promise<unknown>) => Promise<void>,
    ) {
      inbound.handlers.set(filter, fn);
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        inbound.stop = resolve;
      });
    }
    stop() {
      inbound.stop?.();
      inbound.stop = null;
    }
  },
  InputFile: class {},
}));

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: inbound.storeMessageDirect,
  updateChatName: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createTelegramConnection,
  telegramAddressedText,
  telegramCommandMentions,
} from '../src/telegram.js';
import { STEER_TARGET_MISSING_REPLY } from '../src/im-connector-follow-up.js';
import { followUpHost } from './helpers/follow-up-host.js';
import {
  groupAudienceHost,
  type AudienceGroup,
} from './helpers/group-audience.js';

const GROUP_JID = 'telegram:-100777';
const OWNER = 42;
const MEMBER = 43;
const OUTSIDER = 44;
let seq = 1000;

function textCtx(input: {
  text: string;
  from: number;
  chat?: { id: number; type: string; title?: string };
  entities?: unknown[];
  reply_to_message?: unknown;
  sender_chat?: unknown;
  message_thread_id?: number;
}) {
  seq += 1;
  return {
    message: {
      message_id: seq,
      date: Math.floor(Date.now() / 1000),
      text: input.text,
      entities: input.entities,
      reply_to_message: input.reply_to_message,
      sender_chat: input.sender_chat,
      message_thread_id: input.message_thread_id,
    },
    chat: input.chat ?? { id: -100777, type: 'supergroup', title: 'Team' },
    from: { id: input.from, first_name: `user${input.from}` },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

describe('Telegram group response audience', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;
  let groups: Record<string, AudienceGroup>;
  let onCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    inbound.handlers.clear();
    inbound.storeMessageDirect.mockReset();
    groups = {};
    onCommand = vi.fn(async (_jid: string, command: string) =>
      command.startsWith('status') || command.startsWith('owner_mention')
        ? 'ok'
        : null,
    );
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  }, 8000);

  async function connect(group?: AudienceGroup) {
    if (group) groups[GROUP_JID] = group;
    connection = createTelegramConnection({ botToken: 'test-token' });
    const host = groupAudienceHost('telegram', groups);
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      onCommand,
      ...host,
    } as never);
    return host;
  }

  async function sendText(input: Parameters<typeof textCtx>[0]) {
    const ctx = textCtx(input);
    await inbound.handlers.get('message:text')!(ctx);
    return ctx;
  }

  test('owner_only: the owner reaches the Agent, another member does not', async () => {
    await connect({ audience_mode: 'owner_only', owner_im_id: String(OWNER) });

    await sendText({ text: 'from owner', from: OWNER });
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();

    await sendText({ text: 'from member', from: MEMBER });
    await sendText({ text: '/status', from: MEMBER });
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('allowlist: listed members pass, others are dropped', async () => {
    await connect({
      audience_mode: 'everyone',
      owner_im_id: String(OWNER),
      sender_allowlist: [String(OWNER), String(MEMBER)],
    });
    await sendText({ text: 'member', from: MEMBER });
    await sendText({ text: 'outsider', from: OUTSIDER });
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe('member');
  });

  test('everyone without an allowlist admits every member', async () => {
    await connect({ audience_mode: 'everyone' });
    await sendText({ text: 'a', from: MEMBER });
    await sendText({ text: 'b', from: OUTSIDER });
    expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(2);
  });

  test('private chats never consult the group gate', async () => {
    const host = await connect();
    host.isSenderAllowedInGroup.mockReturnValue(false);
    await sendText({
      text: 'dm',
      from: OUTSIDER,
      chat: { id: OUTSIDER, type: 'private' },
    });
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();
    expect(host.isSenderAllowedInGroup).not.toHaveBeenCalled();
  });

  test('an unowned owner_only group can only be claimed with /owner_mention', async () => {
    await connect({ audience_mode: 'owner_only' });
    await sendText({ text: 'hello', from: MEMBER });
    await sendText({ text: '/status', from: MEMBER });
    expect(onCommand).not.toHaveBeenCalled();

    await sendText({ text: '/owner_mention@happy_bot', from: MEMBER });
    expect(onCommand).toHaveBeenCalledWith(
      GROUP_JID,
      'owner_mention',
      String(MEMBER),
      [],
    );
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('a transfer-quarantined group cannot be bootstrapped from IM', async () => {
    await connect({
      audience_mode: 'owner_only',
      owner_claim_source: 'transfer_reset',
    });
    await sendText({ text: '/owner_mention', from: MEMBER });
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('media from a rejected sender is dropped before any download', async () => {
    await connect({ audience_mode: 'owner_only', owner_im_id: String(OWNER) });
    seq += 1;
    await inbound.handlers.get('message:video')!({
      message: {
        message_id: seq,
        date: Math.floor(Date.now() / 1000),
        video: { file_id: 'v1', file_name: 'clip.mp4', file_size: 12 },
      },
      chat: { id: -100777, type: 'supergroup', title: 'Team' },
      from: { id: MEMBER, first_name: 'm' },
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    });
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('/allow hands the host the replied-to member and text mentions', async () => {
    await connect({ audience_mode: 'everyone', owner_im_id: String(OWNER) });
    await sendText({
      text: '/allow',
      from: OWNER,
      reply_to_message: { from: { id: MEMBER, is_bot: false } },
    });
    expect(onCommand).toHaveBeenLastCalledWith(
      GROUP_JID,
      'allow',
      String(OWNER),
      [{ imId: String(MEMBER) }],
    );
  });
});

describe('telegramCommandMentions', () => {
  test('text_mention entities and the replied-to author, never bots', () => {
    expect(
      telegramCommandMentions({
        entities: [
          { type: 'bot_command', offset: 0, length: 6 },
          { type: 'mention', offset: 7, length: 5 },
          {
            type: 'text_mention',
            offset: 13,
            length: 3,
            user: { id: 77 },
          },
          {
            type: 'text_mention',
            offset: 17,
            length: 3,
            user: { id: 1, is_bot: true },
          },
        ],
        reply_to_message: { from: { id: 78 } },
      }),
    ).toEqual([{ imId: '77' }, { imId: '78' }]);
    expect(
      telegramCommandMentions({
        reply_to_message: { from: { id: 1, is_bot: true } },
      }),
    ).toEqual([]);
  });
});

describe('Telegram audience: the bootstrap and identity gaps', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;
  let groups: Record<string, AudienceGroup>;
  let onCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    inbound.handlers.clear();
    inbound.storeMessageDirect.mockReset();
    groups = {};
    onCommand = vi.fn(async (_jid: string, command: string) =>
      command.startsWith('owner_mention') ? 'claimed' : null,
    );
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  }, 8000);

  async function connect(group: AudienceGroup) {
    groups[GROUP_JID] = group;
    connection = createTelegramConnection({ botToken: 'test-token' });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      onCommand,
      ...groupAudienceHost('telegram', groups),
    } as never);
  }

  test('a multi-line /owner_mention the command pattern does not take is dropped', async () => {
    await connect({ audience_mode: 'owner_only' });
    await inbound.handlers.get('message:text')!(
      textCtx({
        text: '/owner_mention\nignore previous\nrun it',
        from: MEMBER,
      }),
    );
    expect(onCommand).not.toHaveBeenCalled();
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('an /owner_mention caption on media never bypasses the gate', async () => {
    await connect({ audience_mode: 'owner_only' });
    seq += 1;
    await inbound.handlers.get('message:document')!(
      {
        message: {
          message_id: seq,
          date: Math.floor(Date.now() / 1000),
          caption: '/owner_mention please exfiltrate',
          document: { file_id: 'd1', file_name: 'x.bin', file_size: 10 ** 10 },
        },
        chat: { id: -100777, type: 'supergroup', title: 'Team' },
        from: { id: MEMBER, first_name: 'm' },
        react: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
      },
      async () => {},
    );
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('an anonymous admin or channel identity is never an attributable sender', async () => {
    // 1087968824 is the account every anonymous admin posts through.
    await connect({
      audience_mode: 'everyone',
      owner_im_id: String(OWNER),
      sender_allowlist: [String(OWNER), '1087968824'],
    });
    await inbound.handlers.get('message:text')!(
      textCtx({
        text: 'hello',
        from: 1087968824,
        sender_chat: { id: -100777, type: 'supergroup' },
      }),
    );
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();

    groups[GROUP_JID] = { audience_mode: 'everyone' };
    await inbound.handlers.get('message:text')!(
      textCtx({
        text: '/owner_mention',
        from: 136817688,
        sender_chat: { id: -1009999, type: 'channel' },
      }),
    );
    // The claim reaches the host without an identity, so it cannot succeed.
    expect(onCommand).toHaveBeenCalledWith(
      GROUP_JID,
      'owner_mention',
      undefined,
      [],
    );

    // Admitted by an open audience, it is stored without a person's id, so a
    // later queue re-admission cannot match the shared system account.
    await inbound.handlers.get('message:text')!(
      textCtx({
        text: 'hello',
        from: 1087968824,
        sender_chat: { id: -100777, type: 'supergroup' },
      }),
    );
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();
    expect(inbound.storeMessageDirect.mock.calls[0][2]).toBe('tg:unknown');
  });

  test('/allow ignores the implicit reply of a forum topic and channel identities', () => {
    expect(
      telegramCommandMentions({
        is_topic_message: true,
        message_thread_id: 55,
        reply_to_message: { message_id: 55, from: { id: 4242 } },
      }),
    ).toEqual([]);
    // An ordinary supergroup reply also carries message_thread_id (the reply
    // chain root, which is the replied message): it does name its author.
    expect(
      telegramCommandMentions({
        message_thread_id: 100,
        reply_to_message: { message_id: 100, from: { id: 4242 } },
      }),
    ).toEqual([{ imId: '4242' }]);
    expect(
      telegramCommandMentions({
        reply_to_message: {
          message_id: 9,
          from: { id: 4242 },
          forum_topic_created: { name: 'topic' },
        },
      }),
    ).toEqual([]);
    expect(
      telegramCommandMentions({
        reply_to_message: {
          message_id: 9,
          from: { id: 1087968824 },
          sender_chat: { id: -100 },
        },
      }),
    ).toEqual([]);
    expect(
      telegramCommandMentions({
        message_thread_id: 55,
        reply_to_message: { message_id: 60, from: { id: 4242 } },
      }),
    ).toEqual([{ imId: '4242' }]);
  });
});

describe('Telegram durable queue and runtime controls', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  beforeEach(() => {
    inbound.handlers.clear();
    inbound.storeMessageDirect.mockReset();
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  }, 8000);

  async function connect(
    host: ReturnType<typeof followUpHost>,
    extra: Record<string, unknown> = {},
  ) {
    connection = createTelegramConnection({ botToken: 'test-token' });
    const opts = {
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      onCommand: vi.fn(async () => null),
      onMessagePersisted: vi.fn(),
      onAgentMessage: vi.fn(),
      ...host,
      ...extra,
    };
    await connection.connect(opts as never);
    return opts;
  }

  const DM = { id: OUTSIDER, type: 'private' };
  const send = (input: Parameters<typeof textCtx>[0]) =>
    inbound.handlers.get('message:text')!(textCtx(input));

  test('an input arriving during a run waits in the durable queue', async () => {
    const host = followUpHost('queued');
    const opts = await connect(host, {
      resolveEffectiveChatJid: () => ({
        effectiveJid: 'web:home#agent:a1',
        agentId: 'a1',
      }),
    });
    await send({ text: 'later please', from: OUTSIDER, chat: DM });

    const stored = inbound.storeMessageDirect.mock.calls[0];
    expect(stored[1]).toBe('web:home#agent:a1');
    expect(stored[7]).toMatchObject({ sourceJid: `telegram:${OUTSIDER}` });
    expect(host.onFollowUpMessage).toHaveBeenCalledWith({
      targetJid: 'web:home#agent:a1',
      sourceJid: `telegram:${OUTSIDER}`,
      messageId: stored[0],
      senderImId: `tg:${OUTSIDER}`,
      requestedMode: undefined,
    });
    expect(opts.onMessagePersisted.mock.calls[0][1]).toMatchObject({
      delivery_mode: 'queue',
      delivery_status: 'queued',
      delivery_run_id: 'run-1',
    });
    expect(host.onFollowUpsChanged).toHaveBeenCalledWith('web:home#agent:a1');
    // Released by the host when the run ends: no wake-up, no agent start.
    expect(opts.onAgentMessage).not.toHaveBeenCalled();
  });

  test('with no active run the input starts a turn as before', async () => {
    const host = followUpHost('started');
    const opts = await connect(host);
    await send({ text: 'hello', from: OUTSIDER, chat: DM });
    expect(host.onFollowUpMessage).toHaveBeenCalledOnce();
    expect(host.onFollowUpsChanged).not.toHaveBeenCalled();
    expect(opts.onMessagePersisted.mock.calls[0][1]).not.toHaveProperty(
      'delivery_status',
    );
  });

  test('/steer in a private chat stores its guidance as a steer', async () => {
    const host = followUpHost('queued');
    const opts = await connect(host);
    await send({ text: '/steer focus on tests', from: OUTSIDER, chat: DM });
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe('focus on tests');
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      requestedMode: 'steer',
    });
    expect(opts.onMessagePersisted.mock.calls[0][1]).toMatchObject({
      delivery_mode: 'steer',
      delivery_status: 'queued',
    });
    expect(opts.onCommand).not.toHaveBeenCalled();
  });

  test('/break in a private chat runs on the host and replies', async () => {
    const host = followUpHost('queued');
    await connect(host);
    const ctx = textCtx({ text: '/break', from: OUTSIDER, chat: DM });
    await inbound.handlers.get('message:text')!(ctx);
    expect(host.onSessionBreak).toHaveBeenCalledWith({
      sourceJid: `telegram:${OUTSIDER}`,
      targetJid: `telegram:${OUTSIDER}`,
      senderImId: String(OUTSIDER),
      chatType: 'p2p',
    });
    expect(ctx.reply).toHaveBeenCalledWith('Current task stopped.');
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('a group needs a structural @Bot; a bare command is ordinary input', async () => {
    const host = followUpHost('started');
    await connect(host);
    await send({ text: '/break', from: MEMBER });
    expect(host.onSessionBreak).not.toHaveBeenCalled();
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe('/break');

    const mention = textCtx({
      text: '@happy_bot /break',
      from: MEMBER,
      entities: [{ type: 'mention', offset: 0, length: 10 }],
    });
    await inbound.handlers.get('message:text')!(mention);
    const command = textCtx({
      text: '/steer@happy_bot try again',
      from: MEMBER,
      entities: [{ type: 'bot_command', offset: 0, length: 16 }],
    });
    await inbound.handlers.get('message:text')!(command);

    expect(host.onSessionBreak).toHaveBeenCalledWith({
      sourceJid: GROUP_JID,
      targetJid: GROUP_JID,
      senderImId: String(MEMBER),
      chatType: 'group',
    });
    expect(inbound.storeMessageDirect.mock.calls[1][4]).toBe('try again');
    expect(host.onFollowUpMessage.mock.calls[1][0]).toMatchObject({
      requestedMode: 'steer',
    });
  });

  test('/break with arguments or another case is ordinary input', async () => {
    const host = followUpHost('started');
    await connect(host);
    await send({ text: '/break now', from: OUTSIDER, chat: DM });
    await send({ text: '/Break', from: OUTSIDER, chat: DM });
    expect(host.onSessionBreak).not.toHaveBeenCalled();
    expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(2);
  });

  test('a group /break whose route is rejected reports no target to the host', async () => {
    const host = followUpHost('started');
    await connect(host, {
      resolveEffectiveChatJid: () => null,
    });
    await send({
      text: '@happy_bot /break',
      from: MEMBER,
      entities: [{ type: 'mention', offset: 0, length: 10 }],
    });
    expect(host.onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({ targetJid: undefined, chatType: 'group' }),
    );
  });

  test('a runtime control in a topic only looks its Session up', async () => {
    const host = followUpHost('queued');
    const resolveEffectiveChatJid = vi.fn(() => ({
      effectiveJid: 'web:home#agent:created',
      agentId: 'created',
    }));
    const lookupEffectiveChatJid = vi.fn(() => null);
    await connect(host, { resolveEffectiveChatJid, lookupEffectiveChatJid });
    const inTopic = { message_thread_id: 77, from: MEMBER };

    await send({
      ...inTopic,
      text: '@happy_bot /break',
      entities: [{ type: 'mention', offset: 0, length: 10 }],
    });
    expect(lookupEffectiveChatJid).toHaveBeenCalledWith(
      GROUP_JID,
      expect.objectContaining({ threadId: '77' }),
    );
    expect(host.onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({ targetJid: undefined, chatType: 'group' }),
    );

    const steer = textCtx({
      ...inTopic,
      text: '/steer@happy_bot go',
      entities: [{ type: 'bot_command', offset: 0, length: 16 }],
    });
    await inbound.handlers.get('message:text')!(steer);
    expect(steer.reply).toHaveBeenCalledWith(STEER_TARGET_MISSING_REPLY);

    seq += 1;
    const caption = {
      message: {
        message_id: seq,
        date: Math.floor(Date.now() / 1000),
        message_thread_id: 77,
        caption: '/steer@happy_bot look',
        caption_entities: [{ type: 'bot_command', offset: 0, length: 16 }],
        video: { file_id: 'v2', file_name: 'clip.mp4', file_size: 12 },
      },
      chat: { id: -100777, type: 'supergroup', title: 'Team' },
      from: { id: MEMBER, first_name: 'm' },
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    };
    await inbound.handlers.get('message:video')!(caption);
    expect(caption.reply).toHaveBeenCalledWith(STEER_TARGET_MISSING_REPLY);

    // Nothing was routed, so no topic Session was created and nothing stored.
    expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
    expect(host.onFollowUpMessage).not.toHaveBeenCalled();

    // A topic that has its Session is the target of both controls.
    lookupEffectiveChatJid.mockReturnValue({
      effectiveJid: 'web:home#agent:t77',
      agentId: 't77',
    } as never);
    await send({
      ...inTopic,
      text: '@happy_bot /break',
      entities: [{ type: 'mention', offset: 0, length: 10 }],
    });
    expect(host.onSessionBreak).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetJid: 'web:home#agent:t77' }),
    );
    await send({
      ...inTopic,
      text: '/steer@happy_bot go',
      entities: [{ type: 'bot_command', offset: 0, length: 16 }],
    });
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      requestedMode: 'steer',
    });
  });

  test('a /steer caption carries its image as guidance', async () => {
    const host = followUpHost('queued');
    await connect(host);
    seq += 1;
    await inbound.handlers.get('message:video')!({
      message: {
        message_id: seq,
        date: Math.floor(Date.now() / 1000),
        caption: '/steer use this clip',
        video: { file_id: 'v1', file_name: 'clip.mp4', file_size: 12 },
      },
      chat: DM,
      from: { id: OUTSIDER, first_name: 'o' },
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    });
    const content = inbound.storeMessageDirect.mock.calls[0][4] as string;
    expect(content).toContain('use this clip');
    expect(content).not.toContain('/steer');
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      requestedMode: 'steer',
    });
  });
});

describe('telegramAddressedText', () => {
  const bot = { username: 'happy_bot', id: 1 };
  test('only Telegram-marked addressing of this bot counts', () => {
    expect(
      telegramAddressedText(
        {
          text: '@happy_bot /break',
          entities: [{ type: 'mention', offset: 0, length: 10 }],
        },
        bot,
      ),
    ).toBe('/break');
    expect(
      telegramAddressedText(
        {
          text: '/break@Happy_Bot',
          entities: [{ type: 'bot_command', offset: 0, length: 16 }],
        },
        bot,
      ),
    ).toBe('/break');
    expect(
      telegramAddressedText(
        {
          text: 'Happy /break',
          entities: [
            { type: 'text_mention', offset: 0, length: 5, user: { id: 1 } },
          ],
        },
        bot,
      ),
    ).toBe('/break');
    expect(
      telegramAddressedText(
        {
          text: '@other_bot /break',
          entities: [{ type: 'mention', offset: 0, length: 10 }],
        },
        bot,
      ),
    ).toBeNull();
    expect(
      telegramAddressedText(
        {
          text: '/break',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
        bot,
      ),
    ).toBeNull();
    // Typed text without an entity is not proof.
    expect(
      telegramAddressedText({ text: '@happy_bot /break' }, bot),
    ).toBeNull();
  });
});
