import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const postPushMessage = vi.fn();
vi.mock('../src/web-push-transport.js', () => ({
  postPushMessage: (...args: unknown[]) => postPushMessage(...args),
}));

const push = await import('../src/web-push.js');
type Subscription = import('../src/web-push-store.js').WebPushSubscription;

const NOW = 1_800_000_000_000;
const CONVERSATION = {
  chatJid: 'web:ws-1',
  folder: 'ws-1',
  agentId: 'agent-1',
};

function subscription(endpoint: string, userId = 'owner'): Subscription {
  return {
    endpoint,
    user_id: userId,
    p256dh: 'k',
    auth: 'a',
    user_agent: null,
    created_at: '2026-11-05T00:00:00.000Z',
    updated_at: '2026-11-05T00:00:00.000Z',
    last_success_at: null,
  };
}

describe('plainTextPreview', () => {
  test('strips Markdown to plain text', () => {
    const markdown = [
      '# 标题',
      '',
      '**粗体** 和 _斜体_ 以及 `code`，[链接](https://example.com/x) ![图](a.png)',
      '',
      '> 引用',
      '- [x] 列表项',
      '1. 有序项',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const text = push.plainTextPreview(markdown, 500);
    expect(text).toBe(
      '标题 粗体 和 斜体 以及 code，链接 图 引用 列表项 有序项 const a = 1; a b 1 2',
    );
    expect(text).not.toMatch(/[*`#>|]|https?:/);
  });

  test.each([
    ['20 000 newlines', 'a\n' + '\n'.repeat(20_000) + 'b'],
    [
      '500 lines of 20 spaces',
      'a\n' + (' '.repeat(20) + '\n').repeat(500) + 'b',
    ],
    ['3 000 blank lines in a table', '| a |\n' + '\n'.repeat(3000) + '| --- |'],
    ['one 1 MB line of spaces', ' '.repeat(1_000_000) + '|'],
    ['a long run of list markers', '- '.repeat(200_000)],
  ])('stays fast on %s', (_name, input) => {
    const started = performance.now();
    push.plainTextPreview(input);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test('previews only the head of a long reply', () => {
    const text = push.plainTextPreview(
      'x'.repeat(push.PREVIEW_SOURCE_MAX_CHARS - 1) + '😀' + 'tail',
      push.PREVIEW_SOURCE_MAX_CHARS + 10,
    );
    // The cut half of the emoji is not left behind.
    expect(text).toBe('x'.repeat(push.PREVIEW_SOURCE_MAX_CHARS - 1));
  });

  test('cuts at 80 characters, counting characters and not UTF-16 units', () => {
    const long = '你好😀'.repeat(60);
    const text = push.plainTextPreview(long);
    expect(Array.from(text)).toHaveLength(push.PUSH_BODY_MAX_CHARS + 1);
    expect(text.endsWith('…')).toBe(true);
    expect(push.plainTextPreview('short')).toBe('short');
    expect(push.plainTextPreview('  \n\n ')).toBe('');
  });
});

describe('payload', () => {
  test('title is 「workspace · session」 and collapses duplicates', () => {
    expect(push.conversationTitle('项目', '会话一')).toBe('项目 · 会话一');
    expect(push.conversationTitle('同名', '同名')).toBe('同名');
    expect(push.conversationTitle('项目', '')).toBe('项目');
    expect(push.conversationTitle(null, '会话')).toBe('会话');
    expect(push.conversationTitle(undefined, undefined)).toBe('HappyClaw');
  });

  test('a reply carries the route, one tag per conversation and a preview', () => {
    const payload = push.buildPushPayload({
      kind: 'reply',
      workspaceName: 'My WS',
      sessionName: 'Chat 1',
      text: '**完成** 了',
      conversation: { chatJid: 'web:ws 1', folder: 'ws 1', agentId: 'a/1' },
    });
    expect(payload).toEqual({
      title: 'My WS · Chat 1',
      body: '完成 了',
      tag: 'conv:web:ws 1#a/1',
      path: '/chat/ws%201?agent=a%2F1',
      kind: 'reply',
    });
  });

  test('errors are marked, and an empty text still says something', () => {
    const error = push.buildPushPayload({
      kind: 'error',
      text: 'agent exited',
      conversation: CONVERSATION,
    });
    expect(error.body).toBe('⚠️ agent exited');
    expect(
      push.buildPushPayload({
        kind: 'reply',
        text: '',
        conversation: CONVERSATION,
      }).body,
    ).toBe('收到新回复');
    expect(
      push.buildPushPayload({
        kind: 'error',
        text: '',
        conversation: CONVERSATION,
      }).body,
    ).toBe('⚠️ 运行出错');
  });
});

describe('isAllowedPushEndpoint', () => {
  test.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts %s', (endpoint) => {
    expect(push.isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  test.each([
    'http://fcm.googleapis.com/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'https://169.254.169.254/x',
    'https://evil.example.com/x',
    'https://fcm.googleapis.com.evil.example.com/x',
    'https://evilgoogleapis.com/x',
    // Only FCM's own host, not every Google API.
    'https://android.googleapis.com/gcm/send/abc',
    'https://storage.googleapis.com/x',
    'https://push.apple.com/x',
    'https://evil.push.apple.com/x',
    'https://push.services.mozilla.com/x',
    'https://.notify.windows.com/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    // WHATWG URL and url.parse (used by web-push) read different hosts.
    'https://127.0.0.1;.fcm.googleapis.com/x',
    'https://10.0.0.5;.fcm.googleapis.com/admin',
    'https://attacker.example{.web.push.apple.com/y',
    'https://localhost`.notify.windows.com/z',
    'https://127.0.0.1;.updates.push.services.mozilla.com/x',
    `https://fcm.googleapis.com/${'x'.repeat(2048)}`,
    'not a url',
    '',
  ])('rejects %s', (endpoint) => {
    expect(push.isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  test('normalizes to the one form that is stored and posted to', () => {
    expect(
      push.normalizePushEndpoint('https://FCM.googleapis.com:443/fcm/send/a'),
    ).toBe('https://fcm.googleapis.com/fcm/send/a');
    // Both parsers read the backslash as a path separator: still FCM's host.
    expect(
      push.normalizePushEndpoint('https://fcm.googleapis.com\\@127.0.0.1/x'),
    ).toBe('https://fcm.googleapis.com/@127.0.0.1/x');
    expect(push.normalizePushEndpoint(42)).toBeNull();
  });
});

describe('isConversationBeingViewed', () => {
  const presence = (
    over: Partial<{
      visible: boolean;
      chatJid: string | null;
      agentId: string | null;
      at: number;
    }> = {},
  ) => ({
    visible: true,
    chatJid: 'web:ws-1',
    agentId: 'agent-1',
    at: NOW,
    ...over,
  });
  const view = (
    clients: Array<{ userId: string; presence?: ReturnType<typeof presence> }>,
  ) =>
    push.isConversationBeingViewed(clients, 'owner', CONVERSATION, NOW + 1_000);

  test('a visible page on that conversation is looking', () => {
    expect(view([{ userId: 'owner', presence: presence() }])).toBe(true);
  });

  test('any one of several pages is enough', () => {
    expect(
      view([
        { userId: 'owner', presence: presence({ visible: false }) },
        { userId: 'owner', presence: presence() },
      ]),
    ).toBe(true);
  });

  test.each([
    ['a hidden page', presence({ visible: false })],
    ['another session', presence({ agentId: 'agent-2' })],
    ['another workspace', presence({ chatJid: 'web:ws-2' })],
    ['a page off the chat route', presence({ chatJid: null, agentId: null })],
    ['a workspace without an open session', presence({ agentId: null })],
    ['a report that went stale', presence({ at: NOW - push.PRESENCE_TTL_MS })],
  ])('%s is not looking', (_name, report) => {
    expect(view([{ userId: 'owner', presence: report }])).toBe(false);
  });

  test("another user's page, a page that never reported, and no pages", () => {
    expect(view([{ userId: 'someone-else', presence: presence() }])).toBe(
      false,
    );
    expect(view([{ userId: 'owner' }])).toBe(false);
    expect(view([])).toBe(false);
  });
});

describe('isWebOriginTurn', () => {
  const web = {
    imSourceJid: null,
    automationRunId: null,
    teamLane: false,
    sessionKind: 'conversation',
    sessionSourceKind: 'manual' as string | null,
  };

  test('an input typed on the Web is pushed', () => {
    expect(push.isWebOriginTurn(web)).toBe(true);
    expect(push.isWebOriginTurn({ ...web, sessionSourceKind: null })).toBe(
      true,
    );
  });

  test('an IM input, an automation run, a team lane or a spawn is not', () => {
    expect(push.isWebOriginTurn({ ...web, imSourceJid: 'feishu:oc_1' })).toBe(
      false,
    );
    expect(push.isWebOriginTurn({ ...web, automationRunId: 'run-1' })).toBe(
      false,
    );
    expect(push.isWebOriginTurn({ ...web, teamLane: true })).toBe(false);
    expect(push.isWebOriginTurn({ ...web, sessionKind: 'spawn' })).toBe(false);
    for (const kind of ['automation', 'team_router', 'work_item']) {
      expect(push.isWebOriginTurn({ ...web, sessionSourceKind: kind })).toBe(
        false,
      );
    }
  });
});

describe('delivery and notifyWebTurn', () => {
  let rows: Subscription[];
  let sent: Array<{ endpoint: string; payload: unknown }>;
  let results: Record<string, Awaited<ReturnType<typeof push.sendWebPush>>>;
  let removed: string[];
  let succeeded: string[];
  let clients: Array<{
    userId: string;
    presence?: {
      visible: boolean;
      chatJid: string | null;
      agentId: string | null;
      at: number;
    };
  }>;

  const deps = () => ({
    send: async (sub: Subscription, payload: unknown) => {
      sent.push({ endpoint: sub.endpoint, payload });
      return results[sub.endpoint] ?? { ok: true as const };
    },
    listSubscriptions: (userId: string) =>
      rows.filter((r) => r.user_id === userId),
    deleteSubscription: (endpoint: string) => {
      removed.push(endpoint);
      rows = rows.filter((r) => r.endpoint !== endpoint);
    },
    markSuccess: (endpoint: string) => void succeeded.push(endpoint),
    clients: () => clients,
    now: () => NOW,
  });
  const notice = {
    ownerUserId: 'owner',
    kind: 'reply' as const,
    workspaceName: 'WS',
    sessionName: 'S',
    text: '好了',
    conversation: CONVERSATION,
  };

  beforeEach(() => {
    rows = [
      subscription('https://fcm.googleapis.com/a'),
      subscription('https://web.push.apple.com/b'),
    ];
    sent = [];
    results = {};
    removed = [];
    succeeded = [];
    clients = [];
  });

  test('pushes to every device of the owner', async () => {
    const summary = await push.notifyWebTurn(notice, deps());
    expect(summary).toEqual({ attempted: 2, delivered: 2, removed: 0 });
    expect(sent.map((s) => s.endpoint).sort()).toEqual([
      'https://fcm.googleapis.com/a',
      'https://web.push.apple.com/b',
    ]);
    expect(sent[0].payload).toMatchObject({
      title: 'WS · S',
      body: '好了',
      kind: 'reply',
    });
    expect(succeeded).toHaveLength(2);
  });

  test('stays quiet while the owner is looking at the conversation', async () => {
    clients = [
      {
        userId: 'owner',
        presence: {
          visible: true,
          chatJid: 'web:ws-1',
          agentId: 'agent-1',
          at: NOW,
        },
      },
    ];
    expect(await push.notifyWebTurn(notice, deps())).toBeNull();
    expect(sent).toEqual([]);
  });

  test('a visible page on another conversation does not silence it', async () => {
    clients = [
      {
        userId: 'owner',
        presence: {
          visible: true,
          chatJid: 'web:ws-1',
          agentId: 'agent-2',
          at: NOW,
        },
      },
    ];
    expect((await push.notifyWebTurn(notice, deps()))?.delivered).toBe(2);
  });

  test('without a subscription or an owner nothing is sent', async () => {
    rows = [];
    expect(await push.notifyWebTurn(notice, deps())).toBeNull();
    rows = [subscription('https://fcm.googleapis.com/a')];
    expect(
      await push.notifyWebTurn({ ...notice, ownerUserId: null }, deps()),
    ).toBeNull();
    expect(
      await push.notifyWebTurn({ ...notice, ownerUserId: 'nobody' }, deps()),
    ).toBeNull();
    expect(sent).toEqual([]);
  });

  test('a subscription the push service reports gone is deleted', async () => {
    results['https://fcm.googleapis.com/a'] = {
      ok: false,
      gone: true,
      statusCode: 410,
      error: 'gone',
    };
    const summary = await push.notifyWebTurn(notice, deps());
    expect(summary).toEqual({ attempted: 2, delivered: 1, removed: 1 });
    expect(removed).toEqual(['https://fcm.googleapis.com/a']);
    expect(rows.map((r) => r.endpoint)).toEqual([
      'https://web.push.apple.com/b',
    ]);
  });

  test('other failures keep the subscription', async () => {
    results['https://web.push.apple.com/b'] = {
      ok: false,
      gone: false,
      statusCode: 500,
      error: 'boom',
    };
    const summary = await push.notifyWebTurn(notice, deps());
    expect(summary).toEqual({ attempted: 2, delivered: 1, removed: 0 });
    expect(removed).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  test('never throws into the turn', async () => {
    const broken = {
      ...deps(),
      listSubscriptions: () => {
        throw new Error('db closed');
      },
    };
    await expect(push.notifyWebTurn(notice, broken)).resolves.toBeNull();
  });
});

describe('VAPID keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-push-vapid-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('are generated on first use into a 0600 file and then reused', () => {
    const file = path.join(dir, 'config', 'web-push-vapid.json');
    const first = push.getVapidKeys(file);
    expect(first?.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(first?.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(push.getVapidKeys(file)).toEqual(first);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject(first!);
  });

  test('an unreadable file disables push and is left alone', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{not json', { mode: 0o600 });
    expect(push.getVapidKeys(file)).toBeNull();
    expect(fs.readFileSync(file, 'utf-8')).toBe('{not json');
  });
});
