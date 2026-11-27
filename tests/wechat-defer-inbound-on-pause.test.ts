/**
 * Graceful shutdown pauses IM inbound via imManager.pauseInbound() but keeps
 * the WeChat iLink poller running until disconnectAll(). Without
 * shouldDeferInbound, a message in that window is treated as an unauthorized
 * terminal ignore and processWeChatUpdateBatch commits get_updates_buf past it.
 * After restart the iLink server resumes after the committed cursor, so the
 * message is never stored.
 *
 * Real stack: IMConnectionManager -> createWeChatChannel -> createWeChatConnection
 * against a local fake iLink HTTP server with buf replay semantics + real SQLite.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-defer-pause-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

const db = await import('../src/db.js');
const { IMConnectionManager } = await import('../src/im-manager.js');

const USER_ID = 'defer-user';
const TARGET_JID = 'web:defer-wechat';
const FROM = 'wxid_alice@im.wechat';
const PAUSE_TEXT = 'please also check the Q3 report (sent during restart)';
const CONTROL_TEXT = 'control message (no shutdown)';
const UNPAIRED_TEXT = 'hello from unpaired peer';
const NOT_PAIRED_REPLY = '此微信会话尚未配对';

let released = false;
let scenario = { prefix: 'buf', msgId: 9001, text: PAUSE_TEXT };
const sends: Array<{ to: string; text: string }> = [];
const getUpdatesCalls: string[] = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    const reply = (obj: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url?.includes('ilink/bot/getupdates')) {
      const buf = json.get_updates_buf as string;
      getUpdatesCalls.push(buf);
      const respond = () => {
        if (buf === `${scenario.prefix}-0` && released) {
          reply({
            ret: 0,
            longpolling_timeout_ms: 300,
            get_updates_buf: `${scenario.prefix}-1`,
            msgs: [
              {
                message_id: scenario.msgId,
                seq: scenario.msgId,
                from_user_id: FROM,
                to_user_id: 'bot@im.bot',
                message_type: 1,
                create_time_ms: Date.now(),
                context_token: 'ctx-alice-1',
                item_list: [{ type: 1, text_item: { text: scenario.text } }],
              },
            ],
          });
        } else {
          reply({
            ret: 0,
            longpolling_timeout_ms: 300,
            get_updates_buf: buf,
            msgs: [],
          });
        }
      };
      setTimeout(respond, 80);
      return;
    }
    if (req.url?.includes('ilink/bot/sendmessage')) {
      sends.push({
        to: json.msg?.to_user_id,
        text: json.msg?.item_list?.[0]?.text_item?.text,
      });
      reply({ ret: 0 });
      return;
    }
    reply({ ret: 0 });
  });
});

let baseUrl = '';
beforeAll(async () => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: USER_ID,
    username: 'defer',
    password_hash: 'x',
    display_name: 'Defer',
    role: 'member' as any,
    status: 'active' as any,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup(TARGET_JID, {
    name: 'Defer WeChat',
    folder: 'defer-wechat',
    added_at: now,
  } as any);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
  server.close();
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  released = false;
  sends.length = 0;
  getUpdatesCalls.length = 0;
});

function storedMessages(): string[] {
  return db
    .getMessagesSince(TARGET_JID, { timestamp: '', id: '', sequence: 0 })
    .map((m) => m.content);
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

async function connect(
  manager: InstanceType<typeof IMConnectionManager>,
  buf: string,
  persisted: string[],
  authorized: boolean,
) {
  const ok = await manager.connectUserWeChat(
    USER_ID,
    {
      botToken: 'tok',
      ilinkBotId: 'bot_defer_12345678',
      baseUrl,
      getUpdatesBuf: buf,
      bypassProxy: true,
    } as any,
    () => undefined,
    {
      isChatAuthorized: () => authorized,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: TARGET_JID,
        agentId: null,
        sourceJid: jid,
      }),
      onUpdatesBuf: (c: string) => {
        persisted.push(c);
      },
    },
  );
  expect(ok).toBe(true);
}

describe('WeChat shouldDeferInbound across pauseInbound window', () => {
  test('unpaused: stores the message and acknowledges the cursor', async () => {
    scenario = { prefix: 'ctl', msgId: 7001, text: CONTROL_TEXT };
    const persisted: string[] = [];
    const m = new IMConnectionManager();
    await connect(m, 'ctl-0', persisted, true);
    released = true;
    const ok = await waitFor(
      () => storedMessages().some((c) => c.includes('control message')),
      4000,
    );
    await m.disconnectAll();
    expect(ok).toBe(true);
    expect(persisted.at(-1)).toBe('ctl-1');
    expect(sends.some((s) => String(s.text).includes(NOT_PAIRED_REPLY))).toBe(
      false,
    );
  }, 20_000);

  test('pauseInbound then inbound: no not-paired reply, cursor held, survives restart', async () => {
    scenario = { prefix: 'buf', msgId: 9001, text: PAUSE_TEXT };
    const persisted: string[] = [];
    const before = storedMessages().length;

    const m1 = new IMConnectionManager();
    await connect(m1, 'buf-0', persisted, true);
    await waitFor(() => getUpdatesCalls.length >= 1);

    // shutdown Phase 0 — index.ts imManager.pauseInbound()
    m1.pauseInbound();
    released = true;
    // Give the still-running poller time to observe the paused window.
    await waitFor(
      () =>
        getUpdatesCalls.includes('buf-1') ||
        sends.length > 0 ||
        persisted.includes('buf-1'),
      2500,
    );
    await new Promise((r) => setTimeout(r, 400));

    // shutdown Phase 3 — disconnectAll()
    await m1.disconnectAll();

    const durableCursor = persisted.at(-1) ?? 'buf-0';
    const replies = sends.filter((s) =>
      String(s.text).includes(NOT_PAIRED_REPLY),
    );
    expect(replies).toEqual([]);
    expect(durableCursor).toBe('buf-0');
    expect(storedMessages().length).toBe(before);

    // Restart from the durable cursor with inbound resumed.
    const m2 = new IMConnectionManager();
    await connect(m2, durableCursor, persisted, true);
    const stored = await waitFor(
      () => storedMessages().some((c) => c.includes('Q3 report')),
      4000,
    );
    await m2.disconnectAll();

    expect(stored).toBe(true);
    expect(storedMessages().some((c) => c.includes('Q3 report'))).toBe(true);
  }, 25_000);

  test('genuinely unpaired chat still receives the not-paired reply', async () => {
    scenario = { prefix: 'unp', msgId: 8001, text: UNPAIRED_TEXT };
    const persisted: string[] = [];
    const m = new IMConnectionManager();
    await connect(m, 'unp-0', persisted, false);
    released = true;
    const gotReply = await waitFor(
      () => sends.some((s) => String(s.text).includes(NOT_PAIRED_REPLY)),
      4000,
    );
    await m.disconnectAll();
    expect(gotReply).toBe(true);
    expect(storedMessages().some((c) => c.includes('unpaired peer'))).toBe(
      false,
    );
    // Unauthorized terminal ignore still advances the durable cursor.
    expect(persisted.at(-1)).toBe('unp-1');
  }, 20_000);
});
