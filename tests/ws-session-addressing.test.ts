/**
 * Over the real WebSocket handler, every input and every terminal names one
 * session: a workspace JID alone is refused and nothing is stored or started.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'ws-session-addressing-test-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ws-session-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { SESSION_COOKIE_NAME_PLAIN } = await import('../src/config.js');

const OWNER = 'ws-owner';
const WORKSPACE = 'web:ws-addressing';
const OTHER_WORKSPACE = 'web:ws-addressing-other';
const SESSION = '44444444-2222-4333-8444-555555555555';
const OTHER_SESSION = '55555555-2222-4333-8444-555555555555';
const SESSION_JID = `${WORKSPACE}#agent:${SESSION}`;

const started: string[] = [];
const tasks: string[] = [];

web.createAppForTest({
  queue: {
    stopGroup: async () => {},
    getActiveQueryId: () => null,
    getStatus: () => ({ groups: [] }),
    hasActiveRunnerForMessage: () => false,
    requiresFeishuCliContainerRestart: () => false,
    enqueueTask: (jid: string) => tasks.push(jid),
  },
  setLastAgentTimestamp: () => {},
  getRegisteredGroups: () => ({}),
  getLastAgentTimestamp: () => ({}),
  processAgentConversation: async () => {},
  ensureTerminalContainerStarted: (jid: string) => {
    started.push(jid);
    return true;
  },
} as unknown as Parameters<typeof web.createAppForTest>[0]);

function workspace(jid: string, sessionId: string): void {
  const folder = jid.slice(4);
  db.setRegisteredGroup(jid, {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER,
    is_home: false,
  } as any);
  fs.mkdirSync(path.join(tmp, 'groups', folder), { recursive: true });
  db.createAgent({
    id: sessionId,
    group_folder: folder,
    chat_jid: jid,
    name: 'Session',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
}

let server: http.Server;
let wss: ReturnType<typeof web.attachWebSocketForTest>;
let port = 0;
let cookie = '';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: OWNER,
    username: 'ws_owner',
    password_hash: 'x',
    display_name: 'Owner',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  workspace(WORKSPACE, SESSION);
  workspace(OTHER_WORKSPACE, OTHER_SESSION);
  const token = auth.generateSessionToken();
  db.createUserSession({
    id: token,
    user_id: OWNER,
    ip_address: null,
    user_agent: null,
    created_at: now,
    expires_at: auth.sessionExpiresAt(),
    last_active_at: now,
  });
  cookie = `${SESSION_COOKIE_NAME_PLAIN}=${auth.signSessionToken(token)}`;
  server = http.createServer();
  wss = web.attachWebSocketForTest(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connect(): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie },
    });
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

async function reply(messages: any[], type: string, count = 1): Promise<any[]> {
  for (let i = 0; i < 200; i++) {
    const found = messages.filter((m) => m.type === type);
    if (found.length >= count) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${type} after ${JSON.stringify(messages)}`);
}

describe('WebSocket send_message', () => {
  test('a workspace JID without a session is refused and stores nothing', async () => {
    const { ws, messages } = await connect();
    ws.send(
      JSON.stringify({
        type: 'send_message',
        chatJid: WORKSPACE,
        content: 'to nobody',
      }),
    );
    const [error] = await reply(messages, 'ws_error');
    expect(error).toMatchObject({
      chatJid: WORKSPACE,
      code: 'session_required',
    });
    ws.close();
    expect(
      db
        .getMessagesPage(WORKSPACE, undefined, 50)
        .filter((m) => m.content === 'to nobody'),
    ).toEqual([]);
    expect(tasks).toEqual([]);
  });
});

describe('WebSocket terminal_start', () => {
  test('a workspace JID, or a session of another workspace, is refused', async () => {
    const { ws, messages } = await connect();
    for (const chatJid of [
      WORKSPACE,
      `${WORKSPACE}#agent:${OTHER_SESSION}`,
      `${WORKSPACE}#agent:missing`,
    ]) {
      ws.send(JSON.stringify({ type: 'terminal_start', chatJid }));
    }
    const errors = await reply(messages, 'terminal_error', 3);
    ws.close();
    expect(errors.map((e) => [e.chatJid, e.error])).toEqual([
      [WORKSPACE, '请选择会话'],
      [`${WORKSPACE}#agent:${OTHER_SESSION}`, '请选择会话'],
      [`${WORKSPACE}#agent:missing`, '请选择会话'],
    ]);
    expect(started).toEqual([]);
  });

  test("a session JID starts that session's container and answers for it", async () => {
    const { ws, messages } = await connect();
    ws.send(JSON.stringify({ type: 'terminal_start', chatJid: SESSION_JID }));
    const [error] = await reply(messages, 'terminal_error');
    ws.close();
    expect(error).toEqual({
      type: 'terminal_error',
      chatJid: SESSION_JID,
      error: '工作区启动中，请稍后重试',
    });
    expect(started).toEqual([SESSION_JID]);
  });
});
