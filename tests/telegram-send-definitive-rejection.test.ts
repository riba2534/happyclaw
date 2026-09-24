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

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTelegramConnection } = await import('../src/telegram.js');
const { DefinitiveChannelDeliveryError } =
  await import('../src/channel-outbox-delivery.js');
const { PartialChannelDeliveryError } =
  await import('../src/im-delivery-progress.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-rejection-'));

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
