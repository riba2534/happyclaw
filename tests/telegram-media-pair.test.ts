import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: any) => Promise<void>>(),
  stored: vi.fn(),
  stop: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn(async () => ({ id: 1, username: 'pair_bot' })),
      getChat: vi.fn(async () => ({ is_forum: false })),
      setMessageReaction: vi.fn(async () => {}),
    };
    on(filter: string, fn: (ctx: any) => Promise<void>) {
      harness.handlers.set(filter, fn);
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        harness.stop = resolve;
      });
    }
    stop() {
      harness.stop?.();
      harness.stop = null;
    }
  },
  InputFile: class {},
}));
vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: harness.stored,
  updateChatName: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTelegramConnection, matchTelegramPairCode } =
  await import('../src/telegram.js');

describe('matchTelegramPairCode', () => {
  test('reads only a leading /pair command from text or caption', () => {
    expect(matchTelegramPairCode('/pair ABC123')).toBe('ABC123');
    expect(matchTelegramPairCode('/PAIR xyz')).toBe('xyz');
    expect(matchTelegramPairCode('  /pair code-1  ')).toBe('code-1');
    expect(matchTelegramPairCode('/pair@pair_bot CODE', 'pair_bot')).toBe(
      'CODE',
    );
    expect(matchTelegramPairCode('/pair@PAIR_BOT CODE', '@pair_bot')).toBe(
      'CODE',
    );
    expect(
      matchTelegramPairCode('/pair@other_bot CODE', 'pair_bot'),
    ).toBeNull();
    expect(matchTelegramPairCode('/pair@pair_bot CODE')).toBeNull();
    expect(matchTelegramPairCode('not /pair CODE')).toBeNull();
    expect(matchTelegramPairCode(undefined)).toBeNull();
  });
});

describe('Telegram unified media caption admission', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  beforeEach(() => {
    harness.handlers.clear();
    harness.stored.mockReset();
    harness.stop = null;
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  async function connect(onPairAttempt: ReturnType<typeof vi.fn>) {
    connection = createTelegramConnection({ botToken: 'token' });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => false,
      onPairAttempt,
    });
  }

  function context(
    kind: string,
    id: number,
    reply = vi.fn(async () => {}),
    caption = '/pair@pair_bot PAIR-CODE',
  ) {
    const media =
      kind === 'photo'
        ? { photo: [{ file_id: `f-${id}` }] }
        : kind === 'document'
          ? { document: { file_id: `f-${id}`, file_name: 'file.pdf' } }
          : { [kind]: { file_id: `f-${id}` } };
    return {
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        caption,
        ...media,
      },
      chat: { id: 99, type: 'private', title: 'Ada' },
      from: { id: 7, first_name: 'Ada' },
      reply,
      react: vi.fn(async () => {}),
    };
  }

  test('photo, document, video, audio, voice and animation all use one pairing path', async () => {
    const onPairAttempt = vi.fn(async () => true);
    await connect(onPairAttempt);
    const kinds = ['photo', 'document', 'video', 'audio', 'voice', 'animation'];
    for (let index = 0; index < kinds.length; index++) {
      const kind = kinds[index]!;
      const ctx = context(kind, index + 1);
      await harness.handlers.get(`message:${kind}`)!(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        'Pairing successful! This chat is now connected.',
      );
    }
    expect(onPairAttempt).toHaveBeenCalledTimes(kinds.length);
    expect(harness.stored).not.toHaveBeenCalled();
  });

  test('a rejected pair Promise is caught and returns user-visible feedback', async () => {
    const onPairAttempt = vi.fn(async () => {
      throw new Error('pair backend unavailable');
    });
    await connect(onPairAttempt);
    const ctx = context('video', 40);
    await harness.handlers.get('message:video')!(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Pairing failed due to an internal error. Please try again.',
    );
    expect(harness.stored).not.toHaveBeenCalled();
  });

  test('text /pair@BotUsername uses the same verified username parser', async () => {
    const onPairAttempt = vi.fn(async () => true);
    await connect(onPairAttempt);
    const reply = vi.fn(async () => {});
    await harness.handlers.get('message:text')!({
      message: {
        message_id: 50,
        date: Math.floor(Date.now() / 1000),
        text: '/pair@PAIR_BOT TEXT-CODE',
      },
      chat: { id: 99, type: 'private', title: 'Ada' },
      from: { id: 7, first_name: 'Ada' },
      reply,
    });
    expect(onPairAttempt).toHaveBeenCalledWith(
      'telegram:99',
      'Ada',
      'TEXT-CODE',
    );
    expect(harness.stored).not.toHaveBeenCalled();
  });

  test('caption addressed to a different bot is denied without consuming the code', async () => {
    const onPairAttempt = vi.fn(async () => true);
    await connect(onPairAttempt);
    const reply = vi.fn(async () => {});
    await harness.handlers.get('message:video')!(
      context('video', 60, reply, '/pair@other_bot WRONG-CODE'),
    );
    expect(onPairAttempt).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.stringMatching(/not yet paired/i),
    );
    expect(harness.stored).not.toHaveBeenCalled();
  });
});
