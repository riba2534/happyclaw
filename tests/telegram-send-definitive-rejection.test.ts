import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-rejection-'));
// Keep the real config module from persisting a session secret in the repo.
process.env.WEB_SESSION_SECRET ??= 'telegram-rejection-test-secret';

const api = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({})),
  sendPhoto: vi.fn(async () => ({})),
  sendAnimation: vi.fn(async () => ({})),
  sendDocument: vi.fn(async () => ({})),
  sendVideo: vi.fn(async () => ({})),
  sendAudio: vi.fn(async () => ({})),
  sendVoice: vi.fn(async () => ({})),
  getMe: vi.fn(async () => ({ id: 1, username: 'rejection_bot' })),
  config: { use: vi.fn() },
  stop: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: api.config,
      getMe: api.getMe,
      sendMessage: api.sendMessage,
      sendPhoto: api.sendPhoto,
      sendAnimation: api.sendAnimation,
      sendDocument: api.sendDocument,
      sendVideo: api.sendVideo,
      sendAudio: api.sendAudio,
      sendVoice: api.sendVoice,
    };
    on() {
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        api.stop = resolve;
      });
    }
    stop() {
      api.stop?.();
      api.stop = null;
    }
  },
  InputFile: class {
    constructor(
      public source: unknown,
      public fileName?: string,
    ) {}
  },
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTelegramConnection } = await import('../src/telegram.js');
const delivery = await import('../src/channel-outbox-delivery.js');
const { DefinitiveChannelDeliveryError } = delivery;
const { PartialChannelDeliveryError } =
  await import('../src/im-delivery-progress.js');
const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const { createTelegramChannel } = await import('../src/im-channel.js');

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Bot API `ok=false` response as grammY surfaces it (numeric error_code). */
function botApiRejection(description: string, code = 400): Error {
  return Object.assign(new Error(`${code}: ${description}`), {
    error_code: code,
    description,
  });
}

/** Transport failure: no error_code, the provider may have accepted it. */
function transportError(): Error {
  return Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });
}

describe('Telegram definitive send rejections (live connection)', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    api.stop = null;
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  });

  async function connect() {
    connection = createTelegramConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    });
    expect(ok).toBe(true);
    return connection;
  }

  test('oversized sendFile is a definitive local rejection, never sent', async () => {
    const conn = await connect();
    const filePath = path.join(root, 'huge.zip');
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, 31 * 1024 * 1024);

    await expect(
      conn.sendFile('424242', filePath, 'huge.zip'),
    ).rejects.toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  test('Bot API ok=false on sendFile becomes a definitive rejection', async () => {
    const conn = await connect();
    const filePath = path.join(root, 'small.pdf');
    fs.writeFileSync(filePath, 'x');
    const cause = botApiRejection('Bad Request: file must be non-empty');
    api.sendDocument.mockRejectedValueOnce(cause);

    const failure = await conn
      .sendFile('424242', filePath, 'small.pdf')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect((failure as Error).cause).toBe(cause);
  });

  test('transport errors on sendFile stay untyped (potentially accepted)', async () => {
    const conn = await connect();
    const filePath = path.join(root, 'small2.pdf');
    fs.writeFileSync(filePath, 'x');
    const cause = transportError();
    api.sendDocument.mockRejectedValueOnce(cause);

    const failure = await conn
      .sendFile('424242', filePath, 'small2.pdf')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toBe(cause);
    expect(failure).not.toBeInstanceOf(DefinitiveChannelDeliveryError);
  });

  test('Bot API ok=false on the first message chunk is definitive', async () => {
    const conn = await connect();
    api.sendMessage.mockRejectedValueOnce(
      botApiRejection('Bad Request: chat not found'),
    );

    await expect(conn.sendMessage('424242', 'hello')).rejects.toBeInstanceOf(
      DefinitiveChannelDeliveryError,
    );
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  test('rejection after an acknowledged chunk stays a partial (uncertain) error', async () => {
    const conn = await connect();
    // Force two physical chunks; the first is acknowledged before the
    // second is explicitly rejected, so replay is no longer safe.
    const twoChunks = 'x'.repeat(3900);
    api.sendMessage
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(botApiRejection('Bad Request: chat not found'));

    const failure = await conn
      .sendMessage('424242', twoChunks)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PartialChannelDeliveryError);
    expect(failure).not.toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  test('Bot API 5xx stays untyped: Telegram may have queued the message', async () => {
    const conn = await connect();
    const cause = botApiRejection('Internal Server Error', 500);
    api.sendMessage.mockRejectedValueOnce(cause);

    const failure = await conn
      .sendMessage('424242', 'hello')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toBe(cause);
    expect(failure).not.toBeInstanceOf(DefinitiveChannelDeliveryError);
  });

  test('Bot API 408 stays untyped: an intermediary may have timed out after acceptance', async () => {
    const conn = await connect();
    const cause = botApiRejection('Request Timeout', 408);
    api.sendMessage.mockRejectedValueOnce(cause);

    const failure = await conn
      .sendMessage('424242', 'hello')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toBe(cause);
  });

  test('Bot API 429 is a terminal definitive rejection without retryAt', async () => {
    const conn = await connect();
    api.sendMessage.mockRejectedValueOnce(
      botApiRejection('Too Many Requests: retry after 7', 429),
    );

    const failure = await conn
      .sendMessage('424242', 'hello')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect(
      (failure as InstanceType<typeof DefinitiveChannelDeliveryError>).retryAt,
    ).toBeUndefined();
    expect((failure as Error).message).toContain('retry after 7');
  });

  test('unreadable sendFile path is a definitive local rejection, never sent', async () => {
    const conn = await connect();

    const failure = await conn
      .sendFile('424242', path.join(root, 'missing.pdf'), 'missing.pdf')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect((failure as Error).cause).toMatchObject({ code: 'ENOENT' });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  test('sends without an initialized bot are definitive local rejections', async () => {
    const conn = createTelegramConnection({ botToken: 'test-token' });
    const filePath = path.join(root, 'never-sent.pdf');
    fs.writeFileSync(filePath, 'x');

    await expect(conn.sendMessage('424242', 'hello')).rejects.toBeInstanceOf(
      DefinitiveChannelDeliveryError,
    );
    await expect(
      conn.sendImage('424242', Buffer.from('png'), 'image/png'),
    ).rejects.toBeInstanceOf(DefinitiveChannelDeliveryError);
    await expect(
      conn.sendFile('424242', filePath, 'never-sent.pdf'),
    ).rejects.toBeInstanceOf(DefinitiveChannelDeliveryError);
  });

  test('Bot API ok=false on sendImage becomes a definitive rejection', async () => {
    const conn = await connect();
    api.sendPhoto.mockRejectedValueOnce(
      botApiRejection('Bad Request: IMAGE_PROCESS_FAILED'),
    );

    await expect(
      conn.sendImage('424242', Buffer.from('not-a-real-png'), 'image/png'),
    ).rejects.toBeInstanceOf(DefinitiveChannelDeliveryError);
  });
});

describe('Telegram send failures through the durable Outbox', () => {
  const owner = 'telegram-outbox-owner';
  const accountId = 'telegram-outbox-bot';
  const jid = `telegram:424242#account:${accountId}`;
  const route = {
    provider: 'telegram',
    accountId,
    sourceJid: jid,
    chatId: '424242',
    rootId: null,
    threadId: null,
  };
  let manager: InstanceType<typeof IMConnectionManager>;

  beforeAll(async () => {
    fs.mkdirSync(path.join(root, 'db'), { recursive: true });
    fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
    db.initDatabase();
    const now = new Date().toISOString();
    db.createUser({
      id: owner,
      username: owner,
      password_hash: 'test',
      display_name: 'Telegram outbox owner',
      role: 'member',
      status: 'active',
      permissions: [],
      created_at: now,
      updated_at: now,
    });
    db.createChannelAccount({
      id: accountId,
      owner_user_id: owner,
      provider: 'telegram',
      name: accountId,
      secret_ref: `channel-account:${accountId}`,
      enabled: true,
      auth_status: 'authorized',
    });
    db.setRegisteredGroup(jid, {
      name: 'Telegram outbox chat',
      folder: 'telegram-outbox',
      added_at: now,
      created_by: owner,
      channel_account_id: accountId,
    });
    manager = new IMConnectionManager();
    const connected = await manager.connectChannel(
      owner,
      'telegram',
      createTelegramChannel({ botToken: 'test-token' }),
      { onReady: vi.fn(), onNewChat: vi.fn(), isChatAuthorized: () => true },
      accountId,
    );
    expect(connected).toBe(true);
  });

  afterAll(async () => {
    await manager.disconnectAll();
    db.closeDatabase();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Same shape as the host's scoped delivery: one Outbox row per physical
   * output, `sending` persisted before the connector call, and the IM manager
   * routing to the account-bound Telegram channel.
   */
  function deliver(
    turnRunId: string,
    ordinal: number,
    kind: 'text' | 'file',
    send: (deliveryId: string) => Promise<void>,
  ) {
    return delivery.deliverChannelOutboxItem({
      ...route,
      turnRunId,
      ordinal,
      kind,
      payload: { ordinal },
      idempotencyKey: `${turnRunId}:${ordinal}`,
      owner: `telegram-outbox-test:${turnRunId}`,
      delivery: {
        mode: 'single',
        send: async ({ item }) => {
          await send(item.id);
          return { providerMessageId: `ack:${item.id}` };
        },
      },
    });
  }

  function startTurn(name: string) {
    return store.createChannelTurnRun({
      ...route,
      idempotencyKey: `telegram-outbox:${name}`,
    }).run;
  }

  function sendText(turnRunId: string, ordinal: number, text: string) {
    return deliver(turnRunId, ordinal, 'text', (deliveryId) =>
      manager.sendMessage(jid, text, [], {
        deliveryId,
        chunkIndex: 0,
        physicalOutput: false,
      }),
    );
  }

  test.each([
    {
      name: 'oversized',
      prepare: (filePath: string) => {
        fs.writeFileSync(filePath, '');
        fs.truncateSync(filePath, 31 * 1024 * 1024);
      },
      error: '文件大小超过 30MB 限制',
    },
    {
      name: 'missing',
      prepare: () => {},
      error: '文件无法读取',
    },
  ])(
    '$name file fails without fencing the turn; later text still sends',
    async ({ name, prepare, error }) => {
      const run = startTurn(`file-${name}`);
      const fileName = `${name}.zip`;
      const filePath = path.join(root, fileName);
      prepare(filePath);

      const file = await deliver(run.id, 0, 'file', (deliveryId) =>
        manager.sendFile(jid, filePath, fileName, {
          deliveryId,
          chunkIndex: 0,
          physicalOutput: false,
        }),
      );
      expect(file.status).toBe('failed');
      expect(file.error).toContain(error);
      expect(api.sendDocument).not.toHaveBeenCalled();
      expect(store.getUncertainChannelOutboxForTurn(run.id)).toBeFalsy();

      const text = await sendText(run.id, 1, 'follow-up after the file');
      expect(text.status).toBe('delivered');
      expect(api.sendMessage).toHaveBeenCalledOnce();
    },
  );

  test('Bot API 429 is failed, not a retry_wait row nothing reclaims', async () => {
    const run = startTurn('flood-wait');
    api.sendMessage.mockRejectedValueOnce(
      botApiRejection('Too Many Requests: retry after 7', 429),
    );

    const first = await sendText(run.id, 0, 'flood limited');
    expect(first.status).toBe('failed');
    expect(store.getChannelOutboxItem(first.itemId)?.status).toBe('failed');
    expect(store.getUncertainChannelOutboxForTurn(run.id)).toBeFalsy();

    const next = await sendText(run.id, 1, 'next reply');
    expect(next.status).toBe('delivered');
  });

  test('Bot API 408 stays uncertain and fences the rest of the turn', async () => {
    const run = startTurn('request-timeout');
    api.sendMessage.mockRejectedValueOnce(
      botApiRejection('Request Timeout', 408),
    );

    const first = await sendText(run.id, 0, 'maybe accepted');
    expect(first.status).toBe('uncertain');

    const next = await sendText(run.id, 1, 'must stay blocked');
    expect(next).toMatchObject({ status: 'uncertain', itemId: first.itemId });
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
});
