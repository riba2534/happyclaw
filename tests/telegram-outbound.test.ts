import { afterEach, describe, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({
  transformers: [] as Array<
    (
      prev: (...args: any[]) => Promise<any>,
      method: string,
      payload: unknown,
      signal?: AbortSignal,
    ) => Promise<any>
  >,
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  editMessageText: vi.fn(async () => true),
  deleteMessage: vi.fn(async () => true),
  stop: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: {
        use: (fn: (typeof api.transformers)[number]) =>
          api.transformers.push(fn),
      },
      getMe: vi.fn(async () => ({ id: 1, username: 'happy_bot' })),
      sendMessage: api.sendMessage,
      editMessageText: api.editMessageText,
      deleteMessage: api.deleteMessage,
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
    }
  },
  InputFile: class {},
}));
vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DefinitiveChannelDeliveryError } from '../src/channel-outbox-delivery.js';
import { createTelegramConnection } from '../src/telegram.js';
import {
  chunkTelegramMarkdown,
  createTelegramRateLimitRetry,
  markdownToTelegramHtml,
  TELEGRAM_MESSAGE_LIMIT,
} from '../src/telegram-outbound.js';

describe('chunkTelegramMarkdown', () => {
  test('short text is one message rendered once', () => {
    expect(chunkTelegramMarkdown('**hi** & bye')).toEqual([
      { markdown: '**hi** & bye', html: '<b>hi</b> &amp; bye' },
    ]);
  });

  test('every rendered chunk fits even when escaping multiplies the source', () => {
    // 3 800 ampersands rendered to 19 000 characters in one message before.
    const text = `${'&'.repeat(3800)}\n${'<b>'.repeat(1500)}`;
    const chunks = chunkTelegramMarkdown(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      expect(chunk.markdown.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    expect(chunks.map((c) => c.markdown).join('')).toContain('&'.repeat(100));
  });

  test('a code block cut across messages is closed and reopened', () => {
    const code = Array.from({ length: 400 }, (_, i) => `line ${i} <tag>`).join(
      '\n',
    );
    const chunks = chunkTelegramMarkdown(
      `intro\n\`\`\`ts\n${code}\n\`\`\`\nouter`,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.html.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      // Balanced fences: the renderer turns each into <pre>, none leaks raw.
      expect((chunk.markdown.match(/^```/gm) ?? []).length % 2).toBe(0);
      expect(chunk.html).not.toContain('```');
      expect(chunk.html).toContain('<pre><code>');
    }
    expect(chunks[1].markdown.startsWith('```ts\n')).toBe(true);
  });

  test('a block cut more than once leaves the prose after it as prose', () => {
    const code = Array.from({ length: 700 }, (_, i) => `row ${i} <x>`).join(
      '\n',
    );
    const chunks = chunkTelegramMarkdown(
      `intro\n\`\`\`py\n${code}\n\`\`\`\nafter prose`,
    );
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.html).not.toContain('```');
      expect(chunk.html).toMatch(/^(intro\n)?<pre><code[^>]*>row /);
      expect(chunk.html).toContain('</code></pre>');
    }
    expect(chunks.at(-1)!.html).toMatch(/<\/code><\/pre>\n?after prose$/);
  });

  test('rendering stays the Markdown subset Telegram parses', () => {
    expect(markdownToTelegramHtml('`a<b>` [x](https://e.x) ~~s~~')).toBe(
      '<code>a&lt;b&gt;</code> <a href="https://e.x">x</a> <s>s</s>',
    );
  });
});

describe('createTelegramRateLimitRetry', () => {
  const tooMany = (retryAfter?: number) => ({
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after',
    ...(retryAfter === undefined
      ? {}
      : { parameters: { retry_after: retryAfter } }),
  });
  const ok = { ok: true, result: { message_id: 7 } };

  test('a refused send is retried after retry_after', async () => {
    const sleep = vi.fn(async () => undefined);
    const prev = vi
      .fn()
      .mockResolvedValueOnce(tooMany(3))
      .mockResolvedValueOnce(ok);
    const retry = createTelegramRateLimitRetry({ sleep });
    await expect(
      retry(prev, 'sendMessage' as never, {} as never),
    ).resolves.toBe(ok);
    expect(prev).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  test('at most two retries, then the 429 is returned', async () => {
    const sleep = vi.fn(async () => undefined);
    const prev = vi.fn().mockResolvedValue(tooMany(1));
    const retry = createTelegramRateLimitRetry({ sleep });
    await expect(
      retry(prev, 'sendPhoto' as never, {} as never),
    ).resolves.toMatchObject({
      error_code: 429,
    });
    expect(prev).toHaveBeenCalledTimes(3);
  });

  test('a wait beyond the total budget is not attempted', async () => {
    const sleep = vi.fn(async () => undefined);
    const prev = vi
      .fn()
      .mockResolvedValueOnce(tooMany(20))
      .mockResolvedValueOnce(tooMany(20));
    const retry = createTelegramRateLimitRetry({ sleep });
    await retry(prev, 'sendMessage' as never, {} as never);
    // 20 s fits the 30 s budget once; a second 20 s would exceed it.
    expect(prev).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('edits, other errors and transport failures are never resent', async () => {
    const sleep = vi.fn(async () => undefined);
    const retry = createTelegramRateLimitRetry({ sleep });
    const edit = vi.fn().mockResolvedValue(tooMany(1));
    await retry(edit, 'editMessageText' as never, {} as never);
    expect(edit).toHaveBeenCalledTimes(1);

    const rejected = vi
      .fn()
      .mockResolvedValue({ ok: false, error_code: 400, description: 'bad' });
    await retry(rejected, 'sendMessage' as never, {} as never);
    expect(rejected).toHaveBeenCalledTimes(1);

    // No answer: Telegram may already have the message.
    const lost = vi.fn().mockRejectedValue(new Error('socket hang up'));
    await expect(
      retry(lost, 'sendMessage' as never, {} as never),
    ).rejects.toThrow('socket hang up');
    expect(lost).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('a connection that stopped while waiting does not send late', async () => {
    let live = true;
    const sleep = vi.fn(async () => {
      live = false;
    });
    const prev = vi.fn().mockResolvedValue(tooMany(1));
    const retry = createTelegramRateLimitRetry({ sleep, isLive: () => live });
    await retry(prev, 'sendMessage' as never, {} as never);
    expect(prev).toHaveBeenCalledTimes(1);
  });
});

describe('Telegram connection outbound', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
    api.transformers.length = 0;
    api.sendMessage.mockClear();
  }, 8000);

  async function connect() {
    connection = createTelegramConnection({ botToken: 'test-token' });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    } as never);
    return connection;
  }

  test('the 429 retry is installed on the Bot API client', async () => {
    await connect();
    const prev = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 0.001 },
      })
      .mockResolvedValueOnce({ ok: true, result: {} });
    // Every installed transformer passes calls through; the retry resends.
    let calls = 0;
    for (const transformer of api.transformers) {
      prev.mockClear();
      prev
        .mockResolvedValueOnce({
          ok: false,
          error_code: 429,
          parameters: { retry_after: 0.001 },
        })
        .mockResolvedValueOnce({ ok: true, result: {} });
      await transformer(prev, 'sendMessage', {});
      calls = Math.max(calls, prev.mock.calls.length);
    }
    expect(calls).toBe(2);
  });

  test('sendMessage keeps every rendered message within the limit', async () => {
    const conn = await connect();
    await conn.sendMessage('-100777', `${'&'.repeat(3800)}`);
    expect(api.sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (const call of api.sendMessage.mock.calls as unknown as Array<
      [unknown, string]
    >) {
      expect(call[1].length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
  });
});

describe('Telegram streaming transport', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
    api.sendMessage.mockReset();
    api.sendMessage.mockResolvedValue({ message_id: 1 });
    api.editMessageText.mockReset();
    api.deleteMessage.mockReset();
  }, 8000);

  const grammyError = (code: number, description: string) =>
    Object.assign(new Error(description), { error_code: code, description });

  test('a topic answer streams with HTML into that topic and cleans up', async () => {
    connection = createTelegramConnection({ botToken: 'test-token' });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    } as never);
    const session = connection.createStreamingSession('-100777#thread:55')!;
    expect(session).toBeDefined();
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 11 })
      .mockResolvedValueOnce({ message_id: 12 });
    session.append('**working**');
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      -100777,
      '<b>working</b>',
      {
        parse_mode: 'HTML',
        message_thread_id: 55,
      },
    );
    // An unchanged edit is not a failure: the next update still edits.
    api.editMessageText.mockRejectedValueOnce(
      grammyError(400, 'Bad Request: message is not modified'),
    );
    session.append('**working.**');
    await vi.waitFor(
      () => expect(api.editMessageText).toHaveBeenCalledTimes(1),
      { timeout: 4000 },
    );
    session.append('**working..**');
    await vi.waitFor(
      () => expect(api.editMessageText).toHaveBeenCalledTimes(2),
      { timeout: 4000 },
    );
    await session.complete('done & dusted');
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      -100777,
      'done &amp; dusted',
      { parse_mode: 'HTML', message_thread_id: 55 },
    );
    expect(api.deleteMessage).toHaveBeenCalledWith(-100777, 11);
  });

  test('a final Telegram refuses is classified as a definitive rejection', async () => {
    connection = createTelegramConnection({ botToken: 'test-token' });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    } as never);
    const session = connection.createStreamingSession('42')!;
    api.sendMessage.mockRejectedValueOnce(
      grammyError(403, 'Forbidden: bot was blocked by the user'),
    );
    await expect(session.complete('answer')).rejects.toBeInstanceOf(
      DefinitiveChannelDeliveryError,
    );
  });

  test('an HTML edit Telegram cannot parse falls back to plain text', async () => {
    connection = createTelegramConnection({ botToken: 'test-token' });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    } as never);
    const session = connection.createStreamingSession('42')!;
    api.sendMessage.mockResolvedValueOnce({ message_id: 21 });
    session.append('first');
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    api.editMessageText.mockRejectedValueOnce(
      grammyError(400, "Bad Request: can't parse entities"),
    );
    session.append('**second**');
    await vi.waitFor(
      () => expect(api.editMessageText).toHaveBeenCalledTimes(2),
      { timeout: 4000 },
    );
    expect(api.editMessageText).toHaveBeenLastCalledWith(42, 21, '**second**');
    session.dispose();
  });
});
