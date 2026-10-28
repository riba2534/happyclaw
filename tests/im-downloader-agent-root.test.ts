/**
 * Inbound P1-6: a Host workspace with customCwd runs its Agent there, so an
 * IM attachment announced as `downloads/<channel>/<date>/<file>` must exist
 * relative to that directory, not to data/groups/{folder}.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const paths = vi.hoisted(() => ({ groups: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  paths.groups = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'im-dl-groups-'),
  );
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    GROUPS_DIR: paths.groups,
  };
});

const discord = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const onceListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const client = {
    user: { id: 'bot-1', tag: 'test#0001' },
    application: { commands: { set: async () => [] } },
    guilds: { cache: { values: () => [] } },
    once(event: string, fn: (...args: any[]) => unknown) {
      onceListeners.set(event, [...(onceListeners.get(event) ?? []), fn]);
    },
    on(event: string, fn: (...args: any[]) => unknown) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    async login() {
      for (const fn of onceListeners.get('ready') ?? []) await fn(client);
    },
    async destroy() {},
  };
  return { client, listeners };
});
vi.mock('discord.js', () => ({
  Client: class {
    constructor() {
      return discord.client;
    }
  },
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    DirectMessages: 4,
    MessageContent: 8,
    GuildMessageReactions: 16,
  },
  Events: {
    ClientReady: 'ready',
    InteractionCreate: 'interactionCreate',
    MessageCreate: 'messageCreate',
    GuildCreate: 'guildCreate',
    GuildDelete: 'guildDelete',
  },
  Partials: { Channel: 1, Message: 2 },
  AttachmentBuilder: class {},
  ChannelType: { DM: 1, GuildText: 0, GroupDM: 3 },
}));
vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));
vi.mock('../src/message-notifier.js', () => ({ notifyNewImMessage: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GROUPS_DIR } = await import('../src/config.js');
const { resolveImDownloadRoot, saveDownloadedFile, setImDownloadRootResolver } =
  await import('../src/im-downloader.js');
const { storeMessageDirect } = await import('../src/db.js');
const { createDiscordConnection } = await import('../src/discord.js');

afterAll(() => {
  fs.rmSync(paths.groups, { recursive: true, force: true });
});

const created: string[] = [];

afterEach(() => {
  setImDownloadRootResolver(null);
  for (const target of created.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('IM attachments land in the Agent working directory', () => {
  test('Host customCwd: the relative path resolves from the Agent cwd', async () => {
    const customCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'im-dl-cwd-'));
    const folder = `im-dl-host-${process.pid}-${Date.now()}`;
    created.push(customCwd, path.join(GROUPS_DIR, folder));
    setImDownloadRootResolver((groupFolder) =>
      groupFolder === folder ? customCwd : undefined,
    );

    const rel = await saveDownloadedFile(
      folder,
      'feishu',
      'report.pdf',
      Buffer.from('pdf-bytes'),
    );

    expect(rel).toMatch(/^downloads\/feishu\/\d{4}-\d{2}-\d{2}\/report\.pdf$/);
    expect(fs.readFileSync(path.join(customCwd, rel), 'utf8')).toBe(
      'pdf-bytes',
    );
    expect(fs.existsSync(path.join(GROUPS_DIR, folder, rel))).toBe(false);
  });

  test('every channel shares the same root resolution', async () => {
    const customCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'im-dl-cwd-'));
    const folder = `im-dl-any-${process.pid}-${Date.now()}`;
    created.push(customCwd, path.join(GROUPS_DIR, folder));
    setImDownloadRootResolver(() => customCwd);
    for (const channel of ['telegram', 'qq', 'wecom'] as const) {
      const rel = await saveDownloadedFile(
        folder,
        channel,
        `${channel}.txt`,
        Buffer.from(channel),
      );
      expect(fs.readFileSync(path.join(customCwd, rel), 'utf8')).toBe(channel);
    }
  });

  test('without an override (container, or Host without customCwd) keeps data/groups/{folder}', async () => {
    const folder = `im-dl-default-${process.pid}-${Date.now()}`;
    created.push(path.join(GROUPS_DIR, folder));
    setImDownloadRootResolver(() => undefined);
    expect(resolveImDownloadRoot(folder)).toBe(path.join(GROUPS_DIR, folder));
    const rel = await saveDownloadedFile(
      folder,
      'telegram',
      'a.txt',
      Buffer.from('a'),
    );
    expect(fs.existsSync(path.join(GROUPS_DIR, folder, rel))).toBe(true);
  });

  test('a relative or throwing resolver never redirects writes', () => {
    setImDownloadRootResolver(() => 'relative/dir');
    expect(resolveImDownloadRoot('f')).toBe(path.join(GROUPS_DIR, 'f'));
    setImDownloadRootResolver(() => {
      throw new Error('db unavailable');
    });
    expect(resolveImDownloadRoot('f')).toBe(path.join(GROUPS_DIR, 'f'));
  });
});

const CJK90 = '季度经营分析报告'.repeat(12).slice(0, 90) + '.pdf'; // 274 UTF-8 bytes
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('saveDownloadedFile byte-length names', () => {
  test.each([
    ['90 CJK chars + .pdf', CJK90],
    ['250 CJK chars + .docx', '文'.repeat(250) + '.docx'],
    ['70 emoji + .png', '😀'.repeat(70) + '.png'],
  ])(
    '%s is saved with a <=255-byte name and stays readable',
    async (_l, name) => {
      const folder = `qa1692-${Math.random().toString(16).slice(2)}`;
      created.push(path.join(GROUPS_DIR, folder));
      const rel = await saveDownloadedFile(
        folder,
        'telegram',
        name,
        Buffer.from('payload'),
      );
      expect(bytes(path.basename(rel))).toBeLessThanOrEqual(255);
      expect(fs.readFileSync(path.join(GROUPS_DIR, folder, rel), 'utf8')).toBe(
        'payload',
      );
    },
  );

  test('a second same-named long CJK file (collision suffix) is also saved', async () => {
    const folder = `qa1692-col-${process.pid}`;
    created.push(path.join(GROUPS_DIR, folder));
    const a = await saveDownloadedFile(
      folder,
      'feishu',
      CJK90,
      Buffer.from('one'),
    );
    const b = await saveDownloadedFile(
      folder,
      'feishu',
      CJK90,
      Buffer.from('two'),
    );
    expect(a).not.toBe(b);
    expect(fs.readFileSync(path.join(GROUPS_DIR, folder, b), 'utf8')).toBe(
      'two',
    );
  });
});

describe('Discord inbound attachment with a long CJK name (real caller)', () => {
  let connection: ReturnType<typeof createDiscordConnection> | null = null;
  beforeEach(() => {
    vi.clearAllMocks();
    discord.listeners.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () =>
          new TextEncoder().encode('%PDF-1.7 body').buffer,
      })),
    );
  });
  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
    vi.unstubAllGlobals();
  });

  test.each([
    ['attachment only', ''],
    ['attachment beside text', '请看附件'],
  ])(
    '%s: the file lands on disk and the Agent gets its path',
    async (_l, content) => {
      connection = createDiscordConnection({ botToken: 'test-token' });
      expect(
        await connection.connect({
          onNewChat: vi.fn(),
          isChatAuthorized: () => true,
          resolveEffectiveChatJid: (jid: string) => ({
            effectiveJid: jid,
            agentId: null,
          }),
          resolveGroupFolder: () => 'qa1692-discord',
        } as any),
      ).toBe(true);
      const handler = discord.listeners.get('messageCreate')![0];
      await handler({
        id: `m-${Math.random().toString(16).slice(2)}`,
        author: {
          bot: false,
          id: 'user-1',
          username: 'Ada',
          displayName: 'Ada',
        },
        member: { displayName: 'Ada' },
        channel: { type: 1 },
        channelId: 'chan-1',
        content,
        createdTimestamp: Date.now(),
        attachments: {
          values: () => [
            {
              url: 'https://cdn.discord.test/r.pdf',
              name: CJK90,
              contentType: 'application/pdf',
            },
          ],
        },
        mentions: { has: () => false },
        react: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
      });
      const stored = String(vi.mocked(storeMessageDirect).mock.calls[0]?.[4]);
      const dir = path.join(
        GROUPS_DIR,
        'qa1692-discord',
        'downloads',
        'discord',
      );
      const onDisk = fs.existsSync(dir)
        ? fs
            .readdirSync(dir, { recursive: true })
            .filter((p) => String(p).endsWith('.pdf'))
        : [];
      expect(stored).toMatch(/\[文件: downloads\/discord\/\d{4}-\d{2}-\d{2}\//);
      expect(onDisk.length).toBeGreaterThan(0);
    },
  );
});
