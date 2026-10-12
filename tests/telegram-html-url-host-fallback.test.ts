import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const telegramControls = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stopPolling: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn().mockResolvedValue({ id: 1, username: 'url_host_bot' }),
      sendMessage: telegramControls.sendMessage,
    };
    on() {
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        telegramControls.stopPolling = resolve;
      });
    }
    stop() {
      telegramControls.stopPolling?.();
      telegramControls.stopPolling = null;
    }
  },
  InputFile: class {},
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTelegramConnection } = await import('../src/telegram.js');

function grammyUrlHostEmpty(): Error {
  const err = new Error(
    "Call to 'sendMessage' failed! (400: URL host is empty)",
  );
  err.name = 'GrammyError';
  Object.assign(err, {
    error_code: 400,
    description: 'Bad Request: URL host is empty',
    method: 'sendMessage',
    ok: false,
  });
  return err;
}

function grammyWrongHttpUrl(): Error {
  const err = new Error("Call to 'sendMessage' failed! (400: Wrong HTTP URL)");
  err.name = 'GrammyError';
  Object.assign(err, {
    error_code: 400,
    description: 'Bad Request: Wrong HTTP URL',
    method: 'sendMessage',
    ok: false,
  });
  return err;
}

function grammyEntityUrl(): Error {
  const err = new Error("Call to 'sendMessage' failed! (400: ENTITY_URL)");
  err.name = 'GrammyError';
  Object.assign(err, {
    error_code: 400,
    description: 'Bad Request: ENTITY_URL_EMPTY: entity url host missing',
    method: 'sendMessage',
    ok: false,
  });
  return err;
}

function grammyParseEntitiesError(): Error {
  const err = new Error(
    "Call to 'sendMessage' failed! (400: can't parse entities)",
  );
  err.name = 'GrammyError';
  Object.assign(err, {
    error_code: 400,
    description: "can't parse entities: unclosed start tag at byte offset 12",
    method: 'sendMessage',
    ok: false,
  });
  return err;
}

function grammyChatNotFound(): Error {
  const err = new Error("Call to 'sendMessage' failed! (400: chat not found)");
  err.name = 'GrammyError';
  Object.assign(err, {
    error_code: 400,
    description: 'Bad Request: chat not found',
    method: 'sendMessage',
    ok: false,
  });
  return err;
}

function grammyHttpTimeout(): Error {
  const inner = new Error(
    "Request to 'sendMessage' timed out after 30 seconds",
  );
  const err = new Error("Network request for 'sendMessage' failed!");
  err.name = 'HttpError';
  Object.assign(err, { error: inner });
  return err;
}

function grammyTooManyRequests(): Error {
  const err = new Error(
    "Call to 'sendMessage' failed! (429: Too Many Requests)",
  );
  err.name = 'GrammyError';
  Object.assign(err, {
    error_code: 429,
    description: 'Too Many Requests: retry after 3',
    method: 'sendMessage',
    ok: false,
  });
  return err;
}

describe('Telegram HTML URL-host / Wrong-HTTP falls back to plain mdChunk', () => {
  let cleanup: Array<() => Promise<void>> = [];

  beforeEach(() => {
    cleanup = [];
    telegramControls.stopPolling = null;
    telegramControls.sendMessage.mockReset();
  });

  afterEach(async () => {
    await Promise.allSettled(cleanup.map((fn) => fn()));
  });

  async function connectTelegram() {
    const telegram = createTelegramConnection({ botToken: 'token' });
    expect(
      await telegram.connect({
        onNewChat: vi.fn(),
        isChatAuthorized: () => true,
      }),
    ).toBe(true);
    cleanup.push(() => telegram.disconnect());
    return telegram;
  }

  test('falls back to plain text when HTML send hits 400 URL host is empty', async () => {
    const telegram = await connectTelegram();
    const physicalSends: Array<{ text: string; parseMode?: string }> = [];
    telegramControls.sendMessage.mockImplementation(
      async (
        _chatId: number,
        text: string,
        extra?: { parse_mode?: string },
      ) => {
        physicalSends.push({ text, parseMode: extra?.parse_mode });
        if (extra?.parse_mode === 'HTML') {
          throw grammyUrlHostEmpty();
        }
        return { message_id: physicalSends.length };
      },
    );

    await telegram.sendMessage('12345', 'see [docs](/relative/path)');
    expect(physicalSends).toHaveLength(2);
    expect(physicalSends[0]?.parseMode).toBe('HTML');
    expect(physicalSends[1]?.parseMode).toBeUndefined();
    expect(physicalSends[1]?.text).toBe('see [docs](/relative/path)');
  });

  test('falls back to plain text when HTML send hits 400 Wrong HTTP URL', async () => {
    const telegram = await connectTelegram();
    const physicalSends: Array<{ text: string; parseMode?: string }> = [];
    telegramControls.sendMessage.mockImplementation(
      async (
        _chatId: number,
        text: string,
        extra?: { parse_mode?: string },
      ) => {
        physicalSends.push({ text, parseMode: extra?.parse_mode });
        if (extra?.parse_mode === 'HTML') {
          throw grammyWrongHttpUrl();
        }
        return { message_id: physicalSends.length };
      },
    );

    await telegram.sendMessage('12345', 'see [local](http://localhost:3000)');
    expect(physicalSends).toHaveLength(2);
    expect(physicalSends[0]?.parseMode).toBe('HTML');
    expect(physicalSends[1]?.parseMode).toBeUndefined();
    expect(physicalSends[1]?.text).toBe('see [local](http://localhost:3000)');
  });

  test('falls back to plain text when HTML send hits 400 entity url', async () => {
    const telegram = await connectTelegram();
    const physicalSends: Array<{ text: string; parseMode?: string }> = [];
    telegramControls.sendMessage.mockImplementation(
      async (
        _chatId: number,
        text: string,
        extra?: { parse_mode?: string },
      ) => {
        physicalSends.push({ text, parseMode: extra?.parse_mode });
        if (extra?.parse_mode === 'HTML') {
          throw grammyEntityUrl();
        }
        return { message_id: physicalSends.length };
      },
    );

    await telegram.sendMessage('12345', 'see [x](file:///tmp/x)');
    expect(physicalSends).toHaveLength(2);
    expect(physicalSends[0]?.parseMode).toBe('HTML');
    expect(physicalSends[1]?.parseMode).toBeUndefined();
    expect(physicalSends[1]?.text).toBe('see [x](file:///tmp/x)');
  });

  test('still falls back to plain text on GrammyError 400 parse entities', async () => {
    const telegram = await connectTelegram();
    const physicalSends: Array<{ text: string; parseMode?: string }> = [];
    telegramControls.sendMessage.mockImplementation(
      async (
        _chatId: number,
        text: string,
        extra?: { parse_mode?: string },
      ) => {
        physicalSends.push({ text, parseMode: extra?.parse_mode });
        if (extra?.parse_mode === 'HTML') {
          throw grammyParseEntitiesError();
        }
        return { message_id: physicalSends.length };
      },
    );

    await telegram.sendMessage('12345', 'hello **world**');
    expect(physicalSends).toHaveLength(2);
    expect(physicalSends[0]?.parseMode).toBe('HTML');
    expect(physicalSends[1]?.parseMode).toBeUndefined();
  });

  test('does not plain-resend on GrammyError 400 chat not found', async () => {
    const telegram = await connectTelegram();
    telegramControls.sendMessage.mockImplementation(async () => {
      throw grammyChatNotFound();
    });

    const failure = await telegram
      .sendMessage('12345', 'hello **world**')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toMatchObject({
      name: 'DefinitiveChannelDeliveryError',
      cause: { error_code: 400, description: 'Bad Request: chat not found' },
    });
    expect(telegramControls.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('does not plain-resend on HttpError timeout', async () => {
    const telegram = await connectTelegram();
    telegramControls.sendMessage.mockImplementation(async () => {
      throw grammyHttpTimeout();
    });

    await expect(
      telegram.sendMessage('12345', 'hello **world**'),
    ).rejects.toMatchObject({ name: 'HttpError' });
    expect(telegramControls.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('does not plain-resend on GrammyError 429', async () => {
    const telegram = await connectTelegram();
    telegramControls.sendMessage.mockImplementation(async () => {
      throw grammyTooManyRequests();
    });

    const failure = await telegram
      .sendMessage('12345', 'hello **world**')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(failure).toMatchObject({
      name: 'DefinitiveChannelDeliveryError',
      cause: { error_code: 429 },
    });
    expect(telegramControls.sendMessage).toHaveBeenCalledTimes(1);
  });
});
