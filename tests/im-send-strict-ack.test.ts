import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { retryUnscopedImSend } from '../src/im-send-retry-policy.js';
import { settleTaskNotificationDeliveries } from '../src/task-notification.js';

const controls = vi.hoisted(() => ({
  feishuMessageCreate: vi.fn(),
  feishuMessageReply: vi.fn(),
  feishuImageCreate: vi.fn(),
  feishuFileCreate: vi.fn(),
  feishuChatList: vi.fn(),
  updateChatName: vi.fn(),
  updateRegisteredGroupAvatar: vi.fn(),
  telegramSendMessage: vi.fn(),
  telegramSendPhoto: vi.fn(),
  telegramSendAnimation: vi.fn(),
  telegramSendDocument: vi.fn(),
  telegramStopPolling: null as (() => void) | null,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { info: 'info' },
  defaultHttpInstance: { defaults: { timeout: 0 } },
  Client: class {
    request = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } });
    im = {
      v1: {
        message: { create: controls.feishuMessageCreate },
        image: { create: controls.feishuImageCreate },
        file: { create: controls.feishuFileCreate },
        chat: { list: controls.feishuChatList },
      },
      message: { reply: controls.feishuMessageReply },
      messageReaction: {
        create: vi.fn().mockResolvedValue({ code: 0 }),
        delete: vi.fn().mockResolvedValue({ code: 0 }),
      },
    };
  },
  EventDispatcher: class {
    register() {
      return this;
    }
  },
  WSClient: class {
    async start() {}
    async close() {}
  },
}));

vi.mock('../src/db.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    updateChatName: controls.updateChatName,
    updateRegisteredGroupAvatar: controls.updateRegisteredGroupAvatar,
  };
});

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn().mockResolvedValue({ id: 1, username: 'strict_ack_bot' }),
      sendMessage: controls.telegramSendMessage,
      sendPhoto: controls.telegramSendPhoto,
      sendAnimation: controls.telegramSendAnimation,
      sendDocument: controls.telegramSendDocument,
    };
    on() {
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        controls.telegramStopPolling = resolve;
      });
    }
    stop() {
      controls.telegramStopPolling?.();
      controls.telegramStopPolling = null;
    }
  },
  InputFile: class {
    constructor(
      readonly source: unknown,
      readonly filename?: string,
    ) {}
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  createFeishuConnection,
  parseFeishuRouteTarget,
  resolveFeishuMessageAnchor,
} = await import('../src/feishu.js');
const { createTelegramConnection } = await import('../src/telegram.js');

let cleanup: Array<() => Promise<void>> = [];

beforeEach(() => {
  cleanup = [];
  controls.telegramStopPolling = null;
  vi.clearAllMocks();
  controls.feishuMessageCreate.mockResolvedValue({
    code: 0,
    data: { message_id: 'om_1' },
  });
  controls.feishuMessageReply.mockResolvedValue({
    code: 0,
    data: { message_id: 'om_1' },
  });
  controls.feishuImageCreate.mockResolvedValue({
    image_key: 'img_1',
  });
  controls.feishuFileCreate.mockResolvedValue({
    file_key: 'file_1',
  });
  controls.feishuChatList.mockResolvedValue({
    data: {
      items: [
        {
          chat_id: 'oc_visible',
          name: '已加入的群',
          avatar: 'https://example.com/visible.png',
        },
        { chat_id: 'oc_unnamed' },
      ],
      has_more: false,
    },
  });
  controls.telegramSendMessage.mockResolvedValue({ message_id: 1 });
  controls.telegramSendPhoto.mockResolvedValue({ message_id: 2 });
  controls.telegramSendAnimation.mockResolvedValue({ message_id: 3 });
  controls.telegramSendDocument.mockResolvedValue({ message_id: 4 });
});

afterEach(async () => {
  await Promise.allSettled(cleanup.map((fn) => fn()));
});

async function connectedTransports() {
  const feishu = createFeishuConnection({ appId: 'app', appSecret: 'secret' });
  expect(await feishu.connect({ onReady: vi.fn() })).toBe(true);
  const telegram = createTelegramConnection({ botToken: 'token' });
  expect(
    await telegram.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
    }),
  ).toBe(true);
  cleanup.push(
    () => feishu.stop(),
    () => telegram.disconnect(),
  );
  return { feishu, telegram };
}

function feishuHttp400(message = 'provider rejected image') {
  return Object.assign(new Error(message), {
    response: {
      status: 400,
      data: { code: 230001, msg: message },
    },
  });
}

describe('IM strict send acknowledgement', () => {
  test('Feishu native presentation uses post while default keeps interactive cards', async () => {
    const { feishu } = await connectedTransports();

    await expect(
      feishu.sendMessage('oc_1', '像真人一样发言', undefined, {
        presentation: 'native',
      }),
    ).resolves.toBeUndefined();

    expect(controls.feishuMessageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuMessageCreate.mock.calls[0][0].data).toMatchObject({
      receive_id: 'oc_1',
      msg_type: 'post',
    });
    expect(
      JSON.parse(
        controls.feishuMessageCreate.mock.calls[0][0].data.content as string,
      ),
    ).toMatchObject({
      zh_cn: {
        content: [[{ tag: 'md', text: '像真人一样发言' }]],
      },
    });

    controls.feishuMessageCreate.mockClear();
    await expect(
      feishu.sendMessage('oc_1', '传统机器人回复'),
    ).resolves.toBeUndefined();

    expect(controls.feishuMessageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuMessageCreate.mock.calls[0][0].data).toMatchObject({
      receive_id: 'oc_1',
      msg_type: 'interactive',
    });
  });

  test.each([
    ['generated card', 'normal markdown'],
    [
      'prebuilt card',
      JSON.stringify({ type: 'interactive', card: { body: { elements: [] } } }),
    ],
  ])(
    'Feishu %s accepted-timeout never falls back to a second post',
    async (_label, text) => {
      const { feishu } = await connectedTransports();
      const acceptedTimeout = Object.assign(
        new Error('interactive create ACK timed out after acceptance'),
        { code: 'ETIMEDOUT' },
      );
      controls.feishuMessageCreate.mockRejectedValueOnce(acceptedTimeout);

      const result = await retryUnscopedImSend(
        () => feishu.sendMessage('oc_1', text),
        { sleep: async () => {} },
      );

      expect(result).toMatchObject({ ok: false, outcome: 'uncertain' });
      expect(controls.feishuMessageCreate).toHaveBeenCalledOnce();
      expect(controls.feishuMessageCreate.mock.calls[0][0].data).toMatchObject({
        msg_type: 'interactive',
      });
    },
  );

  test('Feishu explicit interactive rejection may safely fall back to one post', async () => {
    const { feishu } = await connectedTransports();
    controls.feishuMessageCreate.mockResolvedValueOnce({
      code: 230001,
      msg: 'card format rejected',
    });

    await expect(feishu.sendMessage('oc_1', 'fallback body')).resolves.toBe(
      undefined,
    );

    expect(controls.feishuMessageCreate).toHaveBeenCalledTimes(2);
    expect(
      controls.feishuMessageCreate.mock.calls.map(
        (call) => call[0].data.msg_type,
      ),
    ).toEqual(['interactive', 'post']);
  });

  test('Feishu missing interactive acknowledgement is uncertain and never format-falls back', async () => {
    const { feishu } = await connectedTransports();
    controls.feishuMessageCreate.mockResolvedValueOnce({});

    const result = await retryUnscopedImSend(
      () => feishu.sendMessage('oc_1', 'missing ACK'),
      { sleep: async () => {} },
    );

    expect(result).toMatchObject({ ok: false, outcome: 'uncertain' });
    expect(controls.feishuMessageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuMessageCreate.mock.calls[0][0].data.msg_type).toBe(
      'interactive',
    );
  });

  test('Feishu text ACK plus image HTTP 400 is partial and creates no task retry payload', async () => {
    const { feishu } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-partial-'));
    const imagePath = path.join(tempDir, 'image.png');
    await fs.writeFile(imagePath, 'image');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));
    controls.feishuImageCreate.mockRejectedValueOnce(feishuHttp400());

    const transport = await retryUnscopedImSend(
      () => feishu.sendMessage('oc_1', 'scheduled result', [imagePath]),
      { sleep: async () => {} },
    );
    const payload = {
      kind: 'im_message' as const,
      targetJid: 'feishu:oc_1',
      text: 'scheduled result',
      localImagePaths: [imagePath],
    };
    const settled = await settleTaskNotificationDeliveries([
      {
        channel: 'feishu',
        payload,
        failure: {
          error: transport.error,
          outcome:
            transport.outcome === 'delivered' ? undefined : transport.outcome,
        },
        deliver: async () => transport.ok,
      },
    ]);

    expect(transport).toMatchObject({
      ok: false,
      outcome: 'uncertain',
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
      },
    });
    expect(settled.receipt.status).toBe('uncertain');
    expect(settled.retryPayload).toBeUndefined();
    expect(controls.feishuMessageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuMessageCreate.mock.calls[0][0].data.msg_type).toBe(
      'interactive',
    );
  });

  test('Feishu tracks body plus each acknowledged image before a later attachment failure', async () => {
    const { feishu } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-partial-'));
    const imagePaths = [
      path.join(tempDir, 'first.png'),
      path.join(tempDir, 'second.png'),
    ];
    await Promise.all(imagePaths.map((item) => fs.writeFile(item, 'image')));
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));
    controls.feishuImageCreate
      .mockResolvedValueOnce({ image_key: 'img_first' })
      .mockRejectedValueOnce(feishuHttp400('second image rejected'));

    await expect(
      feishu.sendMessage('oc_1', 'body', imagePaths),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      deliveredOutputs: 2,
      totalOutputs: 3,
    });
    expect(
      controls.feishuMessageCreate.mock.calls.map(
        (call) => call[0].data.msg_type,
      ),
    ).toEqual(['interactive', 'image']);
  });

  test('Feishu missing local image after body ACK is partial before upload starts', async () => {
    const { feishu } = await connectedTransports();
    const missingPath = path.join(
      os.tmpdir(),
      `missing-feishu-image-${Date.now()}.png`,
    );

    await expect(
      feishu.sendMessage('oc_1', 'body', [missingPath]),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      deliveredOutputs: 1,
      totalOutputs: 2,
    });
    expect(controls.feishuMessageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuImageCreate).not.toHaveBeenCalled();
  });

  test('Feishu image-message timeout after body ACK is partial without connector replay', async () => {
    const { feishu } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-partial-'));
    const imagePath = path.join(tempDir, 'image.png');
    await fs.writeFile(imagePath, 'image');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));
    controls.feishuMessageCreate
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_body' } })
      .mockRejectedValueOnce(
        Object.assign(new Error('image create ACK timed out'), {
          code: 'ETIMEDOUT',
        }),
      );

    const result = await retryUnscopedImSend(
      () => feishu.sendMessage('oc_1', 'body', [imagePath]),
      { sleep: async () => {} },
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: 'uncertain',
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
      },
    });
    expect(controls.feishuImageCreate).toHaveBeenCalledOnce();
    expect(
      controls.feishuMessageCreate.mock.calls.map(
        (call) => call[0].data.msg_type,
      ),
    ).toEqual(['interactive', 'image']);
  });

  test('Feishu prebuilt interactive card still delivers requested local images', async () => {
    const { feishu } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-partial-'));
    const imagePath = path.join(tempDir, 'image.png');
    await fs.writeFile(imagePath, 'image');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));
    const card = JSON.stringify({
      type: 'interactive',
      card: { body: { elements: [] } },
    });

    await expect(
      feishu.sendMessage('oc_1', card, [imagePath]),
    ).resolves.toBeUndefined();
    expect(
      controls.feishuMessageCreate.mock.calls.map(
        (call) => call[0].data.msg_type,
      ),
    ).toEqual(['interactive', 'image']);
  });

  test('Feishu image ACK plus rejected caption is partial and never resends the image', async () => {
    const { feishu } = await connectedTransports();
    controls.feishuMessageCreate
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_image' } })
      .mockResolvedValueOnce({ code: 230001, msg: 'caption rejected' });

    const transport = await retryUnscopedImSend(
      () =>
        feishu.sendImage('oc_1', Buffer.from('image'), 'image/png', 'caption'),
      { sleep: async () => {} },
    );

    expect(transport).toMatchObject({
      ok: false,
      outcome: 'uncertain',
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
      },
    });
    expect(controls.feishuImageCreate).toHaveBeenCalledOnce();
    expect(
      controls.feishuMessageCreate.mock.calls.map(
        (call) => call[0].data.msg_type,
      ),
    ).toEqual(['image', 'text']);
  });

  test('Feishu failures before any visible message retain safe retry phases', async () => {
    const { feishu } = await connectedTransports();
    controls.feishuImageCreate.mockRejectedValueOnce(
      feishuHttp400('upload rejected'),
    );

    const rejected = await retryUnscopedImSend(
      () => feishu.sendImage('oc_1', Buffer.from('image'), 'image/png'),
      { sleep: async () => {} },
    );
    expect(rejected).toMatchObject({ ok: false, outcome: 'rejected' });
    expect(controls.feishuImageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuMessageCreate).not.toHaveBeenCalled();

    const missingFile = await retryUnscopedImSend(
      () =>
        feishu.sendFile(
          'oc_1',
          path.join(os.tmpdir(), `missing-feishu-file-${Date.now()}`),
          'missing.txt',
        ),
      { sleep: async () => {} },
    );
    expect(missingFile).toMatchObject({ ok: false, outcome: 'pre_accept' });
    expect(controls.feishuFileCreate).not.toHaveBeenCalled();
    expect(controls.feishuMessageCreate).not.toHaveBeenCalled();
  });

  test('Feishu chat inventory reports every visible chat to registration', async () => {
    const feishu = createFeishuConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    const onNewChat = vi.fn();
    expect(
      await feishu.connect({
        onReady: vi.fn(),
        onNewChat,
        normalizeIncomingJid: (jid) => `${jid}#account:secondary`,
      }),
    ).toBe(true);
    cleanup.push(() => feishu.stop());

    await feishu.syncGroups();

    expect(onNewChat).toHaveBeenNthCalledWith(
      1,
      'feishu:oc_visible',
      '已加入的群',
    );
    expect(onNewChat).toHaveBeenNthCalledWith(
      2,
      'feishu:oc_unnamed',
      '飞书聊天',
    );
    expect(controls.updateChatName).toHaveBeenCalledWith(
      'feishu:oc_visible#account:secondary',
      '已加入的群',
    );
    expect(controls.updateRegisteredGroupAvatar).toHaveBeenCalledWith(
      'feishu:oc_visible#account:secondary',
      'https://example.com/visible.png',
    );
  });

  test('all send methods reject while their transport is uninitialized', async () => {
    const feishu = createFeishuConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    const telegram = createTelegramConnection({ botToken: 'token' });

    await expect(feishu.sendMessage('oc_1', 'hello')).rejects.toThrow(
      'not initialized',
    );
    await expect(
      feishu.sendImage('oc_1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('not initialized');
    await expect(feishu.sendFile('oc_1', '/missing', 'a.txt')).rejects.toThrow(
      'not initialized',
    );
    await expect(telegram.sendMessage('1', 'hello')).rejects.toThrow(
      'not initialized',
    );
    await expect(
      telegram.sendImage('1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('not initialized');
    await expect(telegram.sendFile('1', '/missing', 'a.txt')).rejects.toThrow(
      'not initialized',
    );
  });

  test('all send methods reject malformed provider targets', async () => {
    const { feishu, telegram } = await connectedTransports();

    await expect(feishu.sendMessage('', 'hello')).rejects.toThrow(
      'Invalid Feishu route target',
    );
    await expect(
      feishu.sendImage('oc_1#root:', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('Invalid Feishu route target');
    await expect(
      feishu.sendFile('oc_1#unknown:x', '/missing', 'a.txt'),
    ).rejects.toThrow('Invalid Feishu route target');
    await expect(
      feishu.sendImage(
        'oc_1#thread:omt_without_root',
        Buffer.from('image'),
        'image/png',
      ),
    ).rejects.toThrow('Invalid Feishu route target');
    await expect(telegram.sendMessage('not-a-chat', 'hello')).rejects.toThrow(
      'Invalid Telegram chat ID',
    );
    await expect(telegram.sendMessage('', 'hello')).rejects.toThrow(
      'Invalid Telegram chat ID',
    );
    await expect(
      telegram.sendImage('1#thread:0', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('Invalid Telegram chat ID');
    await expect(
      telegram.sendFile('1#thread:nope', '/missing', 'a.txt'),
    ).rejects.toThrow('Invalid Telegram chat ID');
  });

  test('never resolves a bare group route to the latest message from another topic', () => {
    const bareGroup = parseFeishuRouteTarget('oc_group');
    expect(
      resolveFeishuMessageAnchor({
        target: bareGroup,
        chatType: 'group',
        lastMessageId: 'om_latest_message_in_topic_b',
      }),
    ).toBeUndefined();
    expect(
      resolveFeishuMessageAnchor({
        target: bareGroup,
        chatType: 'p2p',
        lastMessageId: 'om_latest_private_message',
      }),
    ).toBe('om_latest_private_message');
    expect(
      resolveFeishuMessageAnchor({
        target: parseFeishuRouteTarget('oc_group#root:om_explicit_root'),
        chatType: 'group',
        lastMessageId: 'om_wrong_topic',
      }),
    ).toBe('om_explicit_root');
  });

  test.each([230071, 230072])(
    'falls back one threaded physical send for Feishu error %s without re-uploading',
    async (code) => {
      const { feishu } = await connectedTransports();
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'thread-fallback-'),
      );
      const filePath = path.join(tempDir, 'payload.pdf');
      await fs.writeFile(filePath, 'payload');
      cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

      controls.feishuMessageReply
        .mockRejectedValueOnce({ code, message: 'reply_in_thread unsupported' })
        .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_image' } });
      await expect(
        feishu.sendImage(
          'oc_group#thread:omt_1#root:om_root',
          Buffer.from('image'),
          'image/png',
        ),
      ).resolves.toBeUndefined();
      expect(controls.feishuImageCreate).toHaveBeenCalledTimes(1);
      expect(controls.feishuMessageReply).toHaveBeenCalledTimes(2);
      expect(controls.feishuMessageReply.mock.calls[0][0].data).toMatchObject({
        msg_type: 'image',
        reply_in_thread: true,
      });
      expect(
        controls.feishuMessageReply.mock.calls[1][0].data,
      ).not.toHaveProperty('reply_in_thread');

      controls.feishuMessageReply.mockReset();
      controls.feishuMessageReply
        .mockResolvedValueOnce({ code, msg: 'reply_in_thread unsupported' })
        .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_file' } });
      await expect(
        feishu.sendFile(
          'oc_group#thread:omt_1#root:om_root',
          filePath,
          'payload.pdf',
        ),
      ).resolves.toBeUndefined();
      expect(controls.feishuFileCreate).toHaveBeenCalledTimes(1);
      expect(controls.feishuMessageReply).toHaveBeenCalledTimes(2);
      expect(controls.feishuMessageReply.mock.calls[0][0].data).toMatchObject({
        msg_type: 'file',
        reply_in_thread: true,
      });
      expect(
        controls.feishuMessageReply.mock.calls[1][0].data,
      ).not.toHaveProperty('reply_in_thread');
    },
  );

  test('final provider API failures reject text, image, and file sends', async () => {
    const { feishu, telegram } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strict-im-ack-'));
    const filePath = path.join(tempDir, 'payload.txt');
    await fs.writeFile(filePath, 'payload');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

    controls.feishuMessageCreate.mockResolvedValue({
      code: 230001,
      msg: 'permission denied',
    });
    await expect(feishu.sendMessage('oc_1', 'hello')).rejects.toThrow(
      'code=230001',
    );
    await expect(
      feishu.sendImage('oc_1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('code=230001');
    await expect(
      feishu.sendFile('oc_1', filePath, 'payload.txt'),
    ).rejects.toThrow('code=230001');

    controls.telegramSendMessage.mockRejectedValue(new Error('send denied'));
    controls.telegramSendPhoto.mockRejectedValue(new Error('photo denied'));
    controls.telegramSendDocument.mockRejectedValue(
      new Error('document denied'),
    );
    await expect(telegram.sendMessage('1', 'hello')).rejects.toThrow(
      'send denied',
    );
    await expect(
      telegram.sendImage('1', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('photo denied');
    await expect(
      telegram.sendFile('1', filePath, 'payload.txt'),
    ).rejects.toThrow('document denied');
  });

  test('message create and reply require an explicit code=0 acknowledgement', async () => {
    const { feishu } = await connectedTransports();

    controls.feishuMessageCreate.mockResolvedValueOnce({});
    await expect(
      feishu.sendMessage('oc_1', 'create', undefined, {
        presentation: 'native',
      }),
    ).rejects.toThrow('code=undefined');

    controls.feishuMessageReply.mockResolvedValueOnce({
      data: { message_id: 'om_unwrapped_reply' },
    });
    await expect(
      feishu.sendMessage('oc_1#root:om_root', 'reply', undefined, {
        presentation: 'native',
      }),
    ).rejects.toThrow('code=undefined');
  });

  test('accepts SDK-unwrapped upload acknowledgements without code=0', async () => {
    const { feishu } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strict-im-ack-'));
    const filePath = path.join(tempDir, 'payload.pdf');
    await fs.writeFile(filePath, 'payload');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

    await expect(
      feishu.sendImage('oc_1', Buffer.from('image'), 'image/png'),
    ).resolves.toBeUndefined();
    await expect(
      feishu.sendFile('oc_1', filePath, 'payload.pdf'),
    ).resolves.toBeUndefined();

    expect(controls.feishuImageCreate).toHaveBeenCalledOnce();
    expect(controls.feishuFileCreate).toHaveBeenCalledOnce();
  });

  test('sendMessage rejects when a requested image attachment fails', async () => {
    const { feishu, telegram } = await connectedTransports();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strict-im-ack-'));
    const imagePath = path.join(tempDir, 'image.png');
    await fs.writeFile(imagePath, 'image');
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));

    controls.feishuImageCreate.mockRejectedValue(new Error('upload denied'));
    await expect(
      feishu.sendMessage('oc_1', 'hello', [imagePath]),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      deliveredOutputs: 1,
      totalOutputs: 2,
    });

    controls.telegramSendPhoto.mockRejectedValue(new Error('photo denied'));
    await expect(
      telegram.sendMessage('1', 'hello', [imagePath]),
    ).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      deliveredOutputs: 1,
      cause: expect.objectContaining({ message: 'photo denied' }),
    });
  });
});
