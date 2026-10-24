/**
 * Read-only guest accounts end to end, through the REAL auth middleware and
 * the global guest guard (no auth mock): guest management API, the default-
 * deny allowlist, granted vs ungranted reads, host-mode Home reads, file
 * hiding, task visibility, owner cut-off, deletion cascades, billing, and
 * the receive-only WebSocket.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'guest-acl-route-test-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-guest-acl-'));

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
const acl = await import('../src/group-acl.js');
const { SESSION_COOKIE_NAME_PLAIN } = await import('../src/config.js');
const { invalidateUserSessions } = await import('../src/web-context.js');

const OWNER = 'u1'; // admin whose Home runs in host mode
const OTHER = 'u2'; // unrelated member
const HOME = 'web:home-u1';
const GRANTED = 'web:flow-x';
const UNGRANTED = 'web:flow-y';
const FOREIGN = 'web:flow-z';
const GUEST_PASSWORD = 'guest-pass-123';

const calls = {
  processGroupMessages: 0,
  ensureTerminal: 0,
  stopGroup: 0,
};

const app = web.createAppForTest({
  queue: {
    stopGroup: async () => {
      calls.stopGroup++;
    },
    getActiveQueryId: () => null,
    getStatus: () => ({ groups: [] }),
  },
  getSessions: () => ({}),
  sessions: {},
  setLastAgentTimestamp: () => {},
  getRegisteredGroups: () => ({}),
  advanceGlobalCursor: () => {},
  processGroupMessages: async () => {
    calls.processGroupMessages++;
    return true;
  },
  ensureTerminalContainerStarted: () => {
    calls.ensureTerminal++;
    return true;
  },
} as unknown as Parameters<typeof web.createAppForTest>[0]);

function mintCookie(userId: string): string {
  const token = auth.generateSessionToken();
  const now = new Date().toISOString();
  db.createUserSession({
    id: token,
    user_id: userId,
    ip_address: null,
    user_agent: null,
    created_at: now,
    expires_at: auth.sessionExpiresAt(),
    last_active_at: now,
  });
  return `${SESSION_COOKIE_NAME_PLAIN}=${auth.signSessionToken(token)}`;
}

async function call(
  cookie: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(`http://happyclaw.test${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function workspace(
  jid: string,
  owner: string,
  extra: Record<string, unknown> = {},
): void {
  const folder = jid.slice(4);
  db.setRegisteredGroup(jid, {
    name: `Workspace ${folder}`,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: owner,
    is_home: false,
    ...extra,
  } as any);
  fs.mkdirSync(path.join(tmp, 'groups', folder), { recursive: true });
}

function user(id: string, role: 'admin' | 'member'): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: `user_${id}`,
    password_hash: 'x',
    display_name: id,
    role,
    status: 'active',
    created_at: now,
    updated_at: now,
  });
}

const b64 = (value: string) => Buffer.from(value).toString('base64url');

let ownerCookie = '';
let otherCookie = '';
let guestCookie = '';
let guestId = '';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  user(OWNER, 'admin');
  user(OTHER, 'member');
  workspace(HOME, OWNER, { is_home: true, executionMode: 'host' });
  workspace(GRANTED, OWNER);
  workspace(UNGRANTED, OWNER);
  workspace(FOREIGN, OTHER);
  ownerCookie = mintCookie(OWNER);
  otherCookie = mintCookie(OTHER);

  const dir = path.join(tmp, 'groups', 'flow-x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=fake');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'run.log'), 'log');
  fs.symlinkSync(path.join(dir, 'logs'), path.join(dir, 'alias'));

  for (const [id, jid] of [
    ['task-granted', GRANTED],
    ['task-ungranted', UNGRANTED],
  ] as const) {
    db.createTask({
      id,
      group_folder: jid.slice(4),
      chat_jid: jid,
      prompt: 'check',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'group',
      execution_type: 'agent',
      script_command: null,
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
      created_by: OWNER,
    } as any);
  }
});

afterAll(() => {
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('guest management API', () => {
  test('rejects workspaces the caller does not own, without leaking', async () => {
    for (const jid of [FOREIGN, 'web:missing']) {
      const res = await call(ownerCookie, 'POST', '/api/guests', {
        username: 'guest_bad',
        password: GUEST_PASSWORD,
        workspace_jids: [jid],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Workspace not found');
    }
    expect(db.getUserByUsername('guest_bad')).toBeUndefined();
  });

  test('creates a guest with own Home + workspace grants', async () => {
    const res = await call(ownerCookie, 'POST', '/api/guests', {
      username: 'guest_one',
      display_name: 'Guest One',
      password: GUEST_PASSWORD,
      workspace_jids: [HOME, GRANTED, GRANTED],
    });
    expect(res.status).toBe(201);
    guestId = res.body.guest.id;
    expect(res.body.guest.workspaces.map((w: any) => w.jid).sort()).toEqual(
      [GRANTED, HOME].sort(),
    );
    const stored = db.getUserById(guestId)!;
    expect(stored.role).toBe('guest');
    expect(stored.guest_owner_id).toBe(OWNER);
    expect(stored.permissions).toEqual([]);

    const dup = await call(ownerCookie, 'POST', '/api/guests', {
      username: 'guest_one',
      password: GUEST_PASSWORD,
      workspace_jids: [],
    });
    expect(dup.status).toBe(409);
  });

  test('lists only my guests and my grantable workspaces', async () => {
    const mine = await call(ownerCookie, 'GET', '/api/guests');
    expect(mine.body.guests.map((g: any) => g.id)).toEqual([guestId]);
    expect(
      mine.body.grantable_workspaces.map((w: any) => w.jid).sort(),
    ).toEqual([GRANTED, HOME, UNGRANTED].sort());
    const theirs = await call(otherCookie, 'GET', '/api/guests');
    expect(theirs.body.guests).toEqual([]);
    const patch = await call(otherCookie, 'PATCH', `/api/guests/${guestId}`, {
      display_name: 'x',
    });
    expect(patch.status).toBe(404);
    const del = await call(otherCookie, 'DELETE', `/api/guests/${guestId}`);
    expect(del.status).toBe(404);
  });

  test('guest login creates no Home, no Agent, no subscription', async () => {
    const res = await app.request('http://happyclaw.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'guest_one', password: GUEST_PASSWORD }),
    });
    expect(res.status).toBe(200);
    expect(db.getUserHomeGroup(guestId)).toBeUndefined();
    expect(
      db.getAllUserBillingOverview().some((row) => row.user_id === guestId),
    ).toBe(false);
    guestCookie = mintCookie(guestId);
  });
});

describe('guest guard: default deny', () => {
  const writes: Array<[string, string]> = [
    ['POST', '/api/messages'],
    ['POST', '/api/groups'],
    ['PATCH', `/api/groups/${GRANTED}`],
    ['DELETE', `/api/groups/${GRANTED}`],
    ['POST', `/api/groups/${GRANTED}/stop`],
    ['POST', `/api/groups/${GRANTED}/reset-session`],
    ['POST', `/api/groups/${GRANTED}/clear-history`],
    ['DELETE', `/api/groups/${GRANTED}/messages/m1`],
    ['PUT', `/api/groups/${GRANTED}/mcp`],
    ['PUT', `/api/groups/${GRANTED}/model-selection`],
    ['POST', `/api/groups/${GRANTED}/files`],
    ['PUT', `/api/groups/${GRANTED}/files/content/${b64('notes.txt')}`],
    ['DELETE', `/api/groups/${GRANTED}/files/${b64('notes.txt')}`],
    ['POST', `/api/groups/${GRANTED}/directories`],
    ['POST', `/api/groups/${GRANTED}/sessions`],
    ['POST', `/api/groups/${GRANTED}/agents`],
    ['POST', `/api/groups/${GRANTED}/im-groups/sync`],
    ['POST', '/api/follow-ups/m1/action'],
    ['POST', '/api/tasks'],
    ['POST', '/api/tasks/task-granted/run'],
    ['PATCH', '/api/tasks/task-granted'],
    ['DELETE', '/api/tasks/task-granted'],
    ['POST', `/api/memory/workspaces/${GRANTED}/items`],
    ['POST', '/api/skills/install'],
    ['POST', '/api/mcp-servers'],
    ['POST', '/api/agent-profiles'],
    ['POST', '/api/channel-accounts'],
    ['POST', '/api/billing/my/redeem'],
    ['POST', '/api/bug-report/submit'],
    ['PUT', '/api/auth/profile'],
    ['POST', '/api/auth/avatar'],
    ['PUT', '/api/config/system'],
    ['POST', '/api/guests'],
    ['POST', '/api/admin/users'],
  ];
  test.each(writes)('%s %s → 403', async (method, url) => {
    const res = await call(guestCookie, method, url, {});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Guest accounts are read-only');
  });

  const reads = [
    `/api/groups/${GRANTED}/env`,
    `/api/groups/${GRANTED}/mcp`,
    `/api/groups/${GRANTED}/model-selection`,
    `/api/groups/${GRANTED}/im-groups`,
    `/api/groups/${GRANTED}/delete-impact`,
    `/api/workspaces/${GRANTED}/channel-mounts`,
    `/api/groups/${GRANTED}/workspace-config/skills`,
    '/api/skills',
    '/api/mcp-servers',
    '/api/plugins',
    '/api/agent-profiles',
    '/api/billing/my/balance',
    '/api/usage/stats',
    '/api/status',
    '/api/config/system',
    '/api/channel-accounts',
    '/api/browse/directories',
    '/api/guests',
    '/api/admin/users',
  ];
  test.each(reads)('GET %s → 403', async (url) => {
    const res = await call(guestCookie, 'GET', url);
    expect(res.status).toBe(403);
  });

  test('owner-only predicates stay false for the guest', () => {
    const principal = { id: guestId, role: 'guest' as const };
    const group = db.getRegisteredGroup(GRANTED)!;
    expect(acl.canAccessGroup(principal, group)).toBe(false);
    expect(acl.canModifyGroup(principal, group)).toBe(false);
    expect(acl.canDeleteGroup(principal, group)).toBe(false);
  });
});

describe('guest reads: granted only', () => {
  test('workspace list shows exactly the grants, read-only', async () => {
    const res = await call(guestCookie, 'GET', '/api/groups');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.groups).sort()).toEqual([GRANTED, HOME].sort());
    const home = res.body.groups[HOME];
    expect(home.read_only).toBe(true);
    expect(home.can_modify).toBe(false);
    expect(home.is_my_home).toBeUndefined();
    expect(home.editable).toBe(false);

    const ws = await call(guestCookie, 'GET', '/api/workspaces');
    expect(ws.body.workspaces.map((w: any) => w.jid).sort()).toEqual(
      [GRANTED, HOME].sort(),
    );
    expect(ws.body.workspaces[0].owner_user_id).toBeUndefined();
  });

  test('history, sessions and queue of granted (incl. host Home)', async () => {
    for (const jid of [GRANTED, HOME]) {
      expect(
        (await call(guestCookie, 'GET', `/api/groups/${jid}/messages`)).status,
      ).toBe(200);
      expect(
        (await call(guestCookie, 'GET', `/api/groups/${jid}/sessions`)).status,
      ).toBe(200);
      expect(
        (await call(guestCookie, 'GET', `/api/groups/${jid}/agents`)).status,
      ).toBe(200);
      expect(
        (
          await call(
            guestCookie,
            'GET',
            `/api/follow-ups?chatJid=${encodeURIComponent(jid)}`,
          )
        ).status,
      ).toBe(200);
    }
  });

  test('ungranted and foreign workspaces answer 404', async () => {
    for (const jid of [UNGRANTED, FOREIGN]) {
      for (const url of [
        `/api/groups/${jid}/messages`,
        `/api/groups/${jid}/sessions`,
        `/api/groups/${jid}/agents`,
        `/api/groups/${jid}/turn-traces/turn-1`,
        `/api/groups/${jid}/files`,
        `/api/memory/workspaces/${jid}/items`,
        `/api/workspaces/${jid}`,
        `/api/follow-ups?chatJid=${encodeURIComponent(jid)}`,
      ]) {
        const res = await call(guestCookie, 'GET', url);
        expect([url, res.status]).toEqual([url, 404]);
      }
    }
  });

  test('memory of a granted workspace is readable', async () => {
    const res = await call(
      guestCookie,
      'GET',
      `/api/memory/workspaces/${GRANTED}/items`,
    );
    expect(res.status).toBe(200);
  });

  test('files hide .claude, logs and dotenv, including via symlink', async () => {
    const list = await call(guestCookie, 'GET', `/api/groups/${GRANTED}/files`);
    expect(list.status).toBe(200);
    const names = list.body.files.map((f: any) => f.name);
    expect(names).toContain('notes.txt');
    expect(names).not.toContain('.claude');
    expect(names).not.toContain('logs');
    expect(names).not.toContain('.env');
    expect(names).not.toContain('alias');
    expect(list.body.files[0].absolutePath).toBeUndefined();

    const ok = await call(
      guestCookie,
      'GET',
      `/api/groups/${GRANTED}/files/content/${b64('notes.txt')}`,
    );
    expect(ok.status).toBe(200);
    for (const hidden of [
      '.claude/settings.json',
      'logs/run.log',
      'alias/run.log',
      '.env',
    ]) {
      for (const kind of ['download', 'preview', 'content']) {
        const res = await call(
          guestCookie,
          'GET',
          `/api/groups/${GRANTED}/files/${kind}/${b64(hidden)}`,
        );
        expect([hidden, kind, res.status]).toEqual([hidden, kind, 404]);
      }
    }
    const listHidden = await call(
      guestCookie,
      'GET',
      `/api/groups/${GRANTED}/files?path=logs`,
    );
    expect(listHidden.status).toBe(404);

    // The owner is unaffected.
    const owner = await call(
      ownerCookie,
      'GET',
      `/api/groups/${GRANTED}/files/content/${b64('logs/run.log')}`,
    );
    expect(owner.status).toBe(200);
  });

  test('tasks: only granted ones, every permission false', async () => {
    const res = await call(guestCookie, 'GET', '/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t: any) => t.id)).toEqual(['task-granted']);
    const perms = res.body.tasks[0].permissions;
    for (const key of [
      'can_edit',
      'can_run',
      'can_pause',
      'can_stop',
      'can_delete',
      'can_restore',
      'can_purge',
    ]) {
      expect([key, perms[key]]).toEqual([key, false]);
    }
    expect(Object.keys(res.body.groupNames).sort()).toEqual(
      [GRANTED, HOME].sort(),
    );
    expect(
      (await call(guestCookie, 'GET', '/api/tasks/task-granted/runs')).status,
    ).toBe(200);
    expect(
      (await call(guestCookie, 'GET', '/api/tasks/task-granted/logs')).status,
    ).toBe(200);
    expect(
      (await call(guestCookie, 'GET', '/api/tasks/task-ungranted/runs')).status,
    ).toBe(404);
    expect(
      (await call(guestCookie, 'GET', '/api/tasks/task-ungranted/logs')).status,
    ).toBe(404);
  });

  test('grant changes apply on the next request', async () => {
    const patch = await call(ownerCookie, 'PATCH', `/api/guests/${guestId}`, {
      workspace_jids: [HOME, GRANTED, UNGRANTED],
    });
    expect(patch.status).toBe(200);
    expect(
      (await call(guestCookie, 'GET', `/api/groups/${UNGRANTED}/messages`))
        .status,
    ).toBe(200);
    await call(ownerCookie, 'PATCH', `/api/guests/${guestId}`, {
      workspace_jids: [HOME, GRANTED],
    });
    expect(
      (await call(guestCookie, 'GET', `/api/groups/${UNGRANTED}/messages`))
        .status,
    ).toBe(404);
  });
});

describe('admin user management cannot mint or convert guests', () => {
  test('create/patch/invite reject the guest role', async () => {
    const create = await call(ownerCookie, 'POST', '/api/admin/users', {
      username: 'sneaky_guest',
      password: GUEST_PASSWORD,
      role: 'guest',
    });
    expect(create.status).toBe(400);
    const promote = await call(
      ownerCookie,
      'PATCH',
      `/api/admin/users/${guestId}`,
      { role: 'member' },
    );
    expect(promote.status).toBe(400);
    expect(db.getUserById(guestId)!.role).toBe('guest');
    const demote = await call(
      ownerCookie,
      'PATCH',
      `/api/admin/users/${OTHER}`,
      { role: 'guest' },
    );
    expect(demote.status).toBe(400);
    const invite = await call(ownerCookie, 'POST', '/api/admin/invites', {
      role: 'guest',
    });
    expect(invite.status).toBe(400);

    const list = await call(ownerCookie, 'GET', '/api/admin/users?role=guest');
    expect(list.status).toBe(200);
    expect(list.body.users.map((u: any) => u.id)).toEqual([guestId]);
    expect(list.body.users[0].guest_owner_username).toBe(`user_${OWNER}`);
  });

  test('billing admin tools refuse guests', async () => {
    const billing = await import('../src/billing.js');
    expect(() => billing.assignPlan(guestId, 'any-plan', OWNER)).toThrow(
      /Guest accounts cannot be billed/,
    );
  });
});

describe('receive-only WebSocket', () => {
  let server: http.Server;
  let wss: ReturnType<typeof web.attachWebSocketForTest>;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer();
    wss = web.attachWebSocketForTest(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(cookie: string): Promise<{
    ws: WebSocket;
    messages: any[];
  }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { cookie },
      });
      const messages: any[] = [];
      ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
      ws.once('open', () => resolve({ ws, messages }));
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`upgrade rejected ${res.statusCode}`)),
      );
      ws.once('error', reject);
    });
  }

  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  test('every inbound guest message is refused', async () => {
    const { ws, messages } = await connect(guestCookie);
    ws.send(
      JSON.stringify({
        type: 'terminal_start',
        chatJid: HOME,
        cols: 80,
        rows: 24,
      }),
    );
    ws.send(
      JSON.stringify({ type: 'send_message', chatJid: GRANTED, content: 'hi' }),
    );
    ws.send(
      JSON.stringify({ type: 'terminal_input', chatJid: HOME, data: 'ls\n' }),
    );
    await until(
      () => messages.filter((m) => m.type === 'ws_error').length >= 3,
    );
    const errors = messages.filter((m) => m.type === 'ws_error');
    expect(errors).toHaveLength(3);
    expect(
      errors.every((m) => m.error === 'Guest accounts are read-only'),
    ).toBe(true);
    expect(calls.ensureTerminal).toBe(0);
    expect(calls.processGroupMessages).toBe(0);
    ws.close();
  });

  test('broadcasts reach the guest for granted (host) workspaces only', async () => {
    const { ws, messages } = await connect(guestCookie);
    const message = (id: string, jid: string) => ({
      id,
      chat_jid: jid,
      sender: OWNER,
      sender_name: 'Owner',
      content: 'streamed',
      timestamp: new Date().toISOString(),
    });
    web.broadcastNewMessage(HOME, message('m-home', HOME) as any);
    web.broadcastNewMessage(
      UNGRANTED,
      message('m-ungranted', UNGRANTED) as any,
    );
    web.broadcastNewMessage(GRANTED, message('m-granted', GRANTED) as any);
    await until(
      () => messages.filter((m) => m.type === 'new_message').length >= 2,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const ids = messages
      .filter((m) => m.type === 'new_message')
      .map((m) => m.message.id)
      .sort();
    expect(ids).toEqual(['m-granted', 'm-home']);
    ws.close();
  });
});

describe('owner state and deletion cascades', () => {
  test('a disabled owner cuts the guest off immediately', async () => {
    db.updateUserFields(OWNER, { status: 'disabled' });
    invalidateUserSessions(OWNER);
    const res = await call(guestCookie, 'GET', '/api/groups');
    expect(res.status).toBe(403);
    const login = await app.request('http://happyclaw.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'guest_one', password: GUEST_PASSWORD }),
    });
    expect(login.status).toBe(401);
    db.updateUserFields(OWNER, { status: 'active' });
    expect((await call(guestCookie, 'GET', '/api/groups')).status).toBe(200);
  });

  test('deleting a workspace removes its grants', () => {
    expect(
      db.listGuestWorkspaceGrants(guestId).map((g) => g.workspace_jid),
    ).toContain(GRANTED);
    db.deleteRegisteredGroup(GRANTED);
    expect(
      db.listGuestWorkspaceGrants(guestId).map((g) => g.workspace_jid),
    ).toEqual([HOME]);
  });

  test('deleting the guest removes grants, pins and sessions', async () => {
    db.pinGroup(guestId, HOME);
    const res = await call(ownerCookie, 'DELETE', `/api/guests/${guestId}`);
    expect(res.status).toBe(200);
    expect(db.listGuestWorkspaceGrants(guestId)).toEqual([]);
    expect(db.getUserPinnedGroups(guestId)).toEqual({});
    expect(db.getUserById(guestId)!.status).toBe('deleted');
    expect((await call(guestCookie, 'GET', '/api/groups')).status).toBe(401);
  });
});
