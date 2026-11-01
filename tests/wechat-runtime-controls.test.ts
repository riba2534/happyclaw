import type { Dispatcher } from 'undici';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const db = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
  isDatabaseInitialized: () => false,
}));

vi.mock('../src/db.js', () => db);
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createWeChatConnection } = await import('../src/wechat.js');
const { followUpHost } = await import('./helpers/follow-up-host.js');

const PEER = 'wxid_peer';
const JID = `wechat:${PEER}`;
let seq = 0;

function textMsg(text: string, extraItems: Record<string, unknown>[] = []) {
  seq += 1;
  return {
    message_id: `wx-${seq}`,
    from_user_id: PEER,
    create_time_ms: Date.now(),
    context_token: 'tok',
    item_list: [{ type: 1, text_item: { text } }, ...extraItems],
  };
}

/** Answer one getupdates poll with `msgs`, then hold the poll open. */
function wechatApi(msgs: unknown[]) {
  const sent: Array<Record<string, unknown>> = [];
  let polled = false;
  const fetchMock = vi.fn(
    async (url: string, init?: { body?: unknown; signal?: AbortSignal }) => {
      if (url.includes('getupdates')) {
        if (!polled) {
          polled = true;
          return Response.json({ get_updates_buf: 'c1', msgs });
        }
        return new Promise<Response>((_resolve, reject) => {
          const abort = () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init?.signal?.aborted) return abort();
          init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      if (url.includes('sendmessage')) {
        sent.push(JSON.parse(String(init?.body)));
      }
      return Response.json({});
    },
  );
  return { fetchMock, sent };
}

async function run(
  msgs: unknown[],
  host: ReturnType<typeof followUpHost>,
  until: () => void,
) {
  const api = wechatApi(msgs);
  const onCommand = vi.fn(async () => null);
  const onMessagePersisted = vi.fn();
  const connection = createWeChatConnection(
    { botToken: 'secret-token', ilinkBotId: 'bot@example' },
    {
      fetch: api.fetchMock as typeof fetch,
      createDispatcher: () =>
        ({ close: vi.fn(async () => undefined) }) as unknown as Dispatcher,
      contextTokenStore: null,
      random: () => 0.5,
      now: () => Date.now(),
    },
  );
  try {
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      onCommand,
      onMessagePersisted,
      ...host,
    });
    await vi.waitFor(until);
  } finally {
    await connection.disconnect();
  }
  return { ...api, onCommand, onMessagePersisted };
}

const sentText = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes('Current task stopped.');

describe('WeChat durable queue and runtime controls', () => {
  beforeEach(() => vi.clearAllMocks());

  test('an input arriving during a run waits in the durable queue', async () => {
    const host = followUpHost('queued');
    const { onMessagePersisted } = await run([textMsg('later')], host, () =>
      expect(host.onFollowUpsChanged).toHaveBeenCalled(),
    );
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      targetJid: JID,
      sourceJid: JID,
      senderImId: JID,
      requestedMode: undefined,
    });
    expect(onMessagePersisted.mock.calls[0][1]).toMatchObject({
      delivery_status: 'queued',
      delivery_mode: 'queue',
    });
  });

  test('with no active run the input starts a turn as before', async () => {
    const host = followUpHost('started');
    await run([textMsg('now')], host, () =>
      expect(host.onFollowUpMessage).toHaveBeenCalled(),
    );
    expect(host.onFollowUpsChanged).not.toHaveBeenCalled();
  });

  test('/steer stores its guidance as a steer', async () => {
    const host = followUpHost('queued');
    const { onCommand } = await run([textMsg('/steer be brief')], host, () =>
      expect(db.storeMessageDirect).toHaveBeenCalled(),
    );
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe('be brief');
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      requestedMode: 'steer',
    });
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('/break runs on the host and replies; nothing is stored', async () => {
    const host = followUpHost('queued');
    const { sent } = await run([textMsg('/break')], host, () =>
      expect(host.onSessionBreak).toHaveBeenCalled(),
    );
    expect(host.onSessionBreak).toHaveBeenCalledWith({
      sourceJid: JID,
      targetJid: JID,
      senderImId: PEER,
      chatType: 'p2p',
    });
    await vi.waitFor(() => expect(sent.some(sentText)).toBe(true));
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('/break with an image or arguments is ordinary input', async () => {
    const host = followUpHost('started');
    await run(
      [
        textMsg('/break', [{ type: 2, image_item: {} }]),
        textMsg('/break please'),
      ],
      host,
      () => expect(db.storeMessageDirect).toHaveBeenCalledTimes(2),
    );
    expect(host.onSessionBreak).not.toHaveBeenCalled();
  });
});
