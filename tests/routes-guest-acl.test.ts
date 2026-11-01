/**
 * Read-only guest accounts end to end, through the REAL auth middleware and
 * the global guest guard (no auth mock): guest management API, the default-
 * deny allowlist, granted vs ungranted reads, host-mode Home reads, file
 * hiding (worktree sessions included), automation visibility, member guests
 * and the per-owner cap, owner cut-off, deletion cascades, billing, and the
 * receive-only WebSocket.
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
const guestAccess = await import('../src/guest-access.js');
const { SESSION_COOKIE_NAME_PLAIN } = await import('../src/config.js');
const { invalidateUserSessions } = await import('../src/web-context.js');
const automationRoutes = await import('../src/routes/automations.js');
const { createAutomationCore } = await import('../src/automation-service.js');
const { insertSessionWorktree } =
  await import('../src/session-worktree-store.js');
const harness = await import('./automation-harness.js');
const { MAX_GUESTS_PER_OWNER } = await import('../src/guest-accounts.js');
const { getGroupAllowedUserIds } =
  await import('../src/group-broadcast-acl.js');

const OWNER = 'u1'; // admin whose Home runs in host mode
const OTHER = 'u2'; // unrelated member
const HOME = 'web:home-u1';
const GRANTED = 'web:flow-x';
const UNGRANTED = 'web:flow-y';
const FOREIGN = 'web:flow-z';
const GUEST_PASSWORD = 'guest-pass-123';
const WORKTREE_SESSION = 'wt-session';
/** Each workspace's session; a workspace has no history of its own. */
const sessionOf = (jid: string) => `${jid.slice(4)}-session`;
const messagesOf = (jid: string) =>
  `/api/groups/${jid}/messages?agentId=${sessionOf(jid)}`;
const automations = harness.createFakeRuntime();
const automationCore = createAutomationCore(automations.deps);
const automationIds: Record<string, string> = {};

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
  for (const [jid, owner] of [
    [HOME, OWNER],
    [GRANTED, OWNER],
    [UNGRANTED, OWNER],
    [FOREIGN, OTHER],
  ] as const) {
    db.createAgent({
      id: sessionOf(jid),
      group_folder: jid.slice(4),
      chat_jid: jid,
      name: 'Session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: owner,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    } as any);
  }
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
  // Case and symlink variants of hidden entries.
  fs.mkdirSync(path.join(dir, 'LOGS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'LOGS', 'run.log'), 'log');
  fs.mkdirSync(path.join(dir, '.Git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.Git', 'config'), '[remote]');
  fs.writeFileSync(path.join(dir, 'Server.PEM'), 'KEY');
  fs.writeFileSync(path.join(dir, 'id_ed25519'), 'KEY');
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{}');
  fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'innocent.txt'));
  fs.symlinkSync(path.join(dir, '.Git'), path.join(dir, 'repo-meta'));

  // A Runtime Session of the granted workspace that runs in its own
  // worktree: its file root is the worktree, not the workspace folder.
  const now = new Date().toISOString();
  db.createAgent({
    id: WORKTREE_SESSION,
    group_folder: 'flow-x',
    chat_jid: GRANTED,
    name: 'Worktree',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER,
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  } as any);
  const worktree = path.join(tmp, 'worktrees', 'flow-x', WORKTREE_SESSION);
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere');
  fs.writeFileSync(path.join(worktree, 'feature.ts'), 'export {}');
  fs.writeFileSync(path.join(worktree, 'deploy.key'), 'KEY');
  fs.symlinkSync(dir, path.join(worktree, 'main-checkout'));
  insertSessionWorktree({
    agent_id: WORKTREE_SESSION,
    group_folder: 'flow-x',
    chat_jid: GRANTED,
    repo_path: dir,
    cwd_subpath: '',
    worktree_path: worktree,
    branch: 'happyclaw/wt',
    base_commit: 'abc',
    created_at: now,
  });

  automationRoutes.setAutomationService(automationCore.service);
  const ownerActor = { kind: 'web' as const, userId: OWNER, isAdmin: true };
  for (const jid of [GRANTED, UNGRANTED]) {
    automationIds[jid] = automationCore.service.create(ownerActor, {
      workspaceJid: jid,
      ...harness.draft({ name: `auto ${jid}`, schedule: { kind: 'manual' } }),
    }).id;
  }
  // The host Home may carry a pre-run check; guests never see its command.
  automationIds[HOME] = automationCore.service.create(ownerActor, {
    workspaceJid: HOME,
    ...harness.draft({
      name: 'home check',
      schedule: { kind: 'manual' },
      preRunCheck: { command: 'echo $SECRET_TOKEN' },
    }),
  }).id;
});

afterAll(() => {
  automationRoutes.setAutomationService(null);
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
    ['POST', '/api/automations'],
    ['POST', '/api/automations/any/run'],
    ['POST', '/api/automations/any/pause'],
    ['POST', '/api/automations/any/runs/read'],
    ['PATCH', '/api/automations/any'],
    ['DELETE', '/api/automations/any'],
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
    `/api/groups/${GRANTED}/context-usage`,
    `/api/groups/${GRANTED}/git/status`,
    `/api/groups/${GRANTED}/git/diff?path=notes.txt`,
    `/api/groups/${GRANTED}/workdir/peers`,
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
    '/api/status/groups',
    '/api/tasks',
    '/api/automations/for-session?jid=web:flow-x',
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

  test("an unbound IM chat of the granted Home folder is not the Home's to show", () => {
    const imJid = 'feishu:oc_unbound_in_home';
    db.setRegisteredGroup(imJid, {
      name: 'Unbound chat',
      folder: HOME.slice(4),
      added_at: new Date().toISOString(),
      created_by: OWNER,
    } as any);
    try {
      const principal = { id: guestId, role: 'guest' as const };
      const chat = db.getRegisteredGroup(imJid)!;
      expect(guestAccess.resolveViewWorkspace(chat)).toBeNull();
      expect(guestAccess.canViewGroup(principal, chat)).toBe(false);
      // The Home itself stays visible.
      expect(
        guestAccess.canViewGroup(principal, db.getRegisteredGroup(HOME)!),
      ).toBe(true);
    } finally {
      db.deleteRegisteredGroup(imJid);
    }
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
      expect((await call(guestCookie, 'GET', messagesOf(jid))).status).toBe(
        200,
      );
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

  test('files hide dot entries, keys and runner state, in any case and via symlinks', async () => {
    const list = await call(guestCookie, 'GET', `/api/groups/${GRANTED}/files`);
    expect(list.status).toBe(200);
    const names = list.body.files.map((f: any) => f.name).sort();
    expect(names).toEqual(['notes.txt']);
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
      'LOGS/run.log',
      'alias/run.log',
      '.env',
      '.Git/config',
      'repo-meta/config',
      'innocent.txt',
      'Server.PEM',
      'id_ed25519',
      'credentials.json',
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
    for (const dirPath of ['logs', 'LOGS', '.Git', 'repo-meta', 'alias']) {
      const listHidden = await call(
        guestCookie,
        'GET',
        `/api/groups/${GRANTED}/files?path=${encodeURIComponent(dirPath)}`,
      );
      expect([dirPath, listHidden.status]).toEqual([dirPath, 404]);
    }

    // The owner is unaffected.
    const owner = await call(
      ownerCookie,
      'GET',
      `/api/groups/${GRANTED}/files/content/${b64('logs/run.log')}`,
    );
    expect(owner.status).toBe(200);
  });

  test('a worktree session lists and reads from its own worktree', async () => {
    const base = `/api/groups/${GRANTED}/files`;
    const query = `?agentId=${WORKTREE_SESSION}`;
    const list = await call(guestCookie, 'GET', `${base}${query}`);
    expect(list.status).toBe(200);
    expect(list.body.files.map((f: any) => f.name)).toEqual(['feature.ts']);
    const read = await call(
      guestCookie,
      'GET',
      `${base}/content/${b64('feature.ts')}${query}`,
    );
    expect(read.status).toBe(200);
    for (const hidden of ['.git', 'deploy.key']) {
      const res = await call(
        guestCookie,
        'GET',
        `${base}/content/${b64(hidden)}${query}`,
      );
      expect([hidden, res.status]).toEqual([hidden, 404]);
    }
    // A link out of the worktree is refused by path validation (for owners
    // too), before the guest check.
    const escape = await call(
      guestCookie,
      'GET',
      `${base}/content/${b64('main-checkout/notes.txt')}${query}`,
    );
    expect(escape.status).not.toBe(200);
    expect(JSON.stringify(escape.body)).not.toContain('hello');
    // The main session still reads the workspace folder.
    expect(
      (await call(guestCookie, 'GET', `${base}/content/${b64('notes.txt')}`))
        .status,
    ).toBe(200);
    expect(
      (await call(guestCookie, 'GET', `${base}/content/${b64('feature.ts')}`))
        .status,
    ).toBe(404);
  });

  test('the automation service treats a viewer as read-only', async () => {
    const viewer = { kind: 'viewer' as const, workspaceJids: [GRANTED, HOME] };
    const id = automationIds[GRANTED];
    expect(automationCore.service.get(viewer, id).id).toBe(id);
    expect(
      automationCore.service.get(viewer, automationIds[HOME]).preRunCheck,
    ).toBeNull();
    expect(() =>
      automationCore.service.get(viewer, automationIds[UNGRANTED]),
    ).toThrow(expect.objectContaining({ status: 404 }));
    for (const attempt of [
      () => automationCore.service.pause(viewer, id),
      () => automationCore.service.resume(viewer, id),
      () => automationCore.service.markRunsRead(viewer, id, []),
      () =>
        automationCore.service.create(viewer, {
          workspaceJid: GRANTED,
          ...harness.draft({ schedule: { kind: 'manual' } }),
        }),
    ]) {
      expect(attempt).toThrow(expect.objectContaining({ status: 403 }));
    }
    await expect(automationCore.service.runNow(viewer, id)).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  test('automations: granted workspaces only, host commands left out', async () => {
    const list = await call(guestCookie, 'GET', '/api/automations');
    expect(list.status).toBe(200);
    expect(list.body.automations.map((a: any) => a.id).sort()).toEqual(
      [automationIds[GRANTED], automationIds[HOME]].sort(),
    );
    const home = list.body.automations.find(
      (a: any) => a.id === automationIds[HOME],
    );
    expect(home.preRunCheck).toBeNull();
    expect(JSON.stringify(list.body)).not.toContain('SECRET_TOKEN');
    const owner = await call(ownerCookie, 'GET', '/api/automations');
    expect(JSON.stringify(owner.body)).toContain('SECRET_TOKEN');

    const filtered = await call(
      guestCookie,
      'GET',
      `/api/automations?workspace=${encodeURIComponent(UNGRANTED)}`,
    );
    expect(filtered.body.automations).toEqual([]);

    const detail = await call(
      guestCookie,
      'GET',
      `/api/automations/${automationIds[HOME]}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.automation.preRunCheck).toBeNull();
    expect(
      (
        await call(
          guestCookie,
          'GET',
          `/api/automations/${automationIds[GRANTED]}/runs`,
        )
      ).status,
    ).toBe(200);
    for (const url of [
      `/api/automations/${automationIds[UNGRANTED]}`,
      `/api/automations/${automationIds[UNGRANTED]}/runs`,
      '/api/automations/missing',
    ]) {
      const res = await call(guestCookie, 'GET', url);
      expect([url, res.status]).toEqual([url, 404]);
    }
    expect(
      (
        await call(
          guestCookie,
          'POST',
          `/api/automations/${automationIds[GRANTED]}/run`,
        )
      ).status,
    ).toBe(403);
  });

  test('grant changes apply on the next request', async () => {
    const patch = await call(ownerCookie, 'PATCH', `/api/guests/${guestId}`, {
      workspace_jids: [HOME, GRANTED, UNGRANTED],
    });
    expect(patch.status).toBe(200);
    expect((await call(guestCookie, 'GET', messagesOf(UNGRANTED))).status).toBe(
      200,
    );
    await call(ownerCookie, 'PATCH', `/api/guests/${guestId}`, {
      workspace_jids: [HOME, GRANTED],
    });
    expect((await call(guestCookie, 'GET', messagesOf(UNGRANTED))).status).toBe(
      404,
    );
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

  test("a member user manager cannot take over an admin's guest", async () => {
    const manager = 'flow-user-manager';
    user(manager, 'member');
    db.updateUserFields(manager, { permissions: ['manage_users'] });
    const cookie = mintCookie(manager);
    const before = db.getUserById(guestId)!;
    for (const [method, url, body] of [
      ['PATCH', `/api/admin/users/${guestId}`, { password: 'Takeover-123!' }],
      ['PATCH', `/api/admin/users/${guestId}`, { status: 'active' }],
      ['DELETE', `/api/admin/users/${guestId}/sessions`, undefined],
      ['DELETE', `/api/admin/users/${guestId}`, undefined],
    ] as const) {
      const res = await call(cookie, method, url, body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    const after = db.getUserById(guestId)!;
    expect(after.status).toBe(before.status);
    expect(db.getUserByUsername(after.username)!.password_hash).toBe(
      db.getUserByUsername(before.username)!.password_hash,
    );

    // Owning the guest does not let a user manager undo an admin's disable
    // here, nor relabel it as the owner's own.
    const now = new Date().toISOString();
    const ownGuest = 'flow-manager-guest';
    db.createUser({
      id: ownGuest,
      username: 'manager_guest',
      password_hash: 'x',
      display_name: ownGuest,
      role: 'guest',
      status: 'disabled',
      disable_reason: 'disabled_by_admin',
      guest_owner_id: manager,
      created_at: now,
      updated_at: now,
    } as any);
    for (const body of [
      { status: 'active' },
      { password: 'Takeover-123!' },
      { disable_reason: 'disabled_by_owner' },
    ]) {
      const res = await call(
        cookie,
        'PATCH',
        `/api/admin/users/${ownGuest}`,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    expect(db.getUserById(ownGuest)).toMatchObject({
      status: 'disabled',
      disable_reason: 'disabled_by_admin',
    });
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
    ws.send(
      JSON.stringify({
        type: 'terminal_resize',
        chatJid: HOME,
        cols: 100,
        rows: 30,
      }),
    );
    ws.send(JSON.stringify({ type: 'terminal_stop', chatJid: HOME }));
    // A type added after this test was written is refused the same way.
    ws.send(JSON.stringify({ type: 'some_future_type', chatJid: GRANTED }));
    await until(
      () => messages.filter((m) => m.type === 'ws_error').length >= 6,
    );
    const errors = messages.filter((m) => m.type === 'ws_error');
    expect(errors).toHaveLength(6);
    expect(
      errors.every((m) => m.error === 'Guest accounts are read-only'),
    ).toBe(true);
    expect(calls.ensureTerminal).toBe(0);
    expect(calls.processGroupMessages).toBe(0);
    expect(calls.stopGroup).toBe(0);
    ws.close();
  });

  test('a liveness ping still gets its pong', async () => {
    const { ws, messages } = await connect(guestCookie);
    ws.send(JSON.stringify({ type: 'ping' }));
    await until(() => messages.some((m) => m.type === 'pong'));
    expect(messages.map((m) => m.type)).toContain('pong');
    expect(messages.some((m) => m.type === 'ws_error')).toBe(false);
    ws.close();
  });

  test('automation events of granted workspaces reach the guest, redacted', async () => {
    const { ws, messages } = await connect(guestCookie);
    const run = {
      id: 'run-1',
      automationId: automationIds[HOME],
      trigger: 'manual',
      status: 'success',
      sessionJid: HOME,
      inputMessageId: null,
      scheduledFor: new Date().toISOString(),
      firedAt: null,
      finishedAt: null,
      resultText: null,
      error: null,
      preCheck: {
        decision: 'run',
        exitCode: 0,
        timedOut: false,
        stdout: 'SECRET_TOKEN=abc',
        stderr: 'warn',
      },
      silenced: false,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    web.broadcastAutomationEvent({
      type: 'automation_run_updated',
      automationId: automationIds[HOME],
      workspaceJid: HOME,
      ownerId: OWNER,
      run: run as any,
    });
    web.broadcastAutomationEvent({
      type: 'automation_changed',
      automationId: automationIds[UNGRANTED],
      workspaceJid: UNGRANTED,
      ownerId: OWNER,
    });
    await until(() =>
      messages.some((m) => m.type === 'automation_run_updated'),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const events = messages.filter((m) => m.type.startsWith('automation_'));
    expect(events).toHaveLength(1);
    expect(events[0].run.preCheck).toMatchObject({ stdout: '', stderr: '' });
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

  test('usage, context usage and worktree details stay with the owner', async () => {
    const owner = await connect(ownerCookie);
    const guest = await connect(guestCookie);
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      costUSD: 0.42,
      durationMs: 1,
      numTurns: 1,
    };
    web.broadcastStreamEvent(GRANTED, {
      eventType: 'usage',
      turnId: 'turn-usage',
      usage,
    } as any);
    web.broadcastStreamEvent(GRANTED, {
      eventType: 'text_delta',
      turnId: 'turn-usage',
      text: 'hello',
    } as any);
    await web.broadcastContextUsage('flow-x', null, {
      usedTokens: 1000,
      contextWindow: 200000,
    } as any);
    web.broadcastAgentStatus(GRANTED, WORKTREE_SESSION, 'idle', 'Worktree', '');
    web.broadcastNewMessage(GRANTED, {
      id: 'm-usage',
      chat_jid: GRANTED,
      sender: 'happyclaw-agent',
      sender_name: 'Agent',
      content: 'done',
      timestamp: new Date().toISOString(),
      token_usage: JSON.stringify({ costUSD: 0.42 }),
    } as any);
    const done = (list: any[]) =>
      list.some((m) => m.type === 'new_message') &&
      list.some((m) => m.type === 'agent_status');
    await until(() => done(owner.messages) && done(guest.messages));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const types = (list: any[]) =>
      list
        .filter((m) => m.type !== 'active_run_snapshot')
        .map((m) => (m.type === 'stream_event' ? m.event.eventType : m.type))
        .sort();
    expect(types(owner.messages)).toEqual([
      'agent_status',
      'context_usage',
      'new_message',
      'text_delta',
      'usage',
    ]);
    expect(types(guest.messages)).toEqual([
      'agent_status',
      'new_message',
      'text_delta',
    ]);
    const find = (list: any[], type: string) =>
      list.find((m) => m.type === type);
    expect(find(owner.messages, 'agent_status').worktree.branch).toBe(
      'happyclaw/wt',
    );
    expect(find(guest.messages, 'agent_status')).not.toHaveProperty('worktree');
    expect(find(owner.messages, 'new_message').message.token_usage).toBe(
      JSON.stringify({ costUSD: 0.42 }),
    );
    expect(find(guest.messages, 'new_message').message).not.toHaveProperty(
      'token_usage',
    );
    expect(JSON.stringify(guest.messages)).not.toContain('0.42');
    owner.ws.close();
    guest.ws.close();
  });
});

describe('withheld from guests over REST', () => {
  test('messages carry no token usage, sessions no worktree', async () => {
    const grantedSession = `${GRANTED}#agent:${sessionOf(GRANTED)}`;
    db.ensureChatExists(grantedSession);
    db.storeMessageDirect(
      'm-cost',
      grantedSession,
      'happyclaw-agent',
      'Agent',
      'answer',
      new Date().toISOString(),
      true,
      { tokenUsage: JSON.stringify({ costUSD: 0.42 }) },
    );
    const ownerView = await call(ownerCookie, 'GET', messagesOf(GRANTED));
    const guestView = await call(guestCookie, 'GET', messagesOf(GRANTED));
    const ownerMessage = ownerView.body.messages.find(
      (m: any) => m.id === 'm-cost',
    );
    const guestMessage = guestView.body.messages.find(
      (m: any) => m.id === 'm-cost',
    );
    expect(ownerMessage.token_usage).toContain('0.42');
    expect(guestMessage.content).toBe('answer');
    expect(guestMessage).not.toHaveProperty('token_usage');
    expect(guestMessage).not.toHaveProperty('cost_usd');

    for (const route of ['sessions', 'agents']) {
      const ownerList = await call(
        ownerCookie,
        'GET',
        `/api/groups/${GRANTED}/${route}`,
      );
      const guestList = await call(
        guestCookie,
        'GET',
        `/api/groups/${GRANTED}/${route}`,
      );
      const pick = (body: any) =>
        (body.sessions ?? body.agents).find(
          (item: any) => item.id === WORKTREE_SESSION,
        );
      expect([route, pick(ownerList.body).worktree?.branch]).toEqual([
        route,
        'happyclaw/wt',
      ]);
      expect([route, pick(guestList.body).worktree ?? null]).toEqual([
        route,
        null,
      ]);
    }
  });
});

describe('admin decisions and host grants', () => {
  test('a guest disabled by an administrator stays disabled for its owner', async () => {
    const created = await call(ownerCookie, 'POST', '/api/guests', {
      username: 'locked_guest',
      password: GUEST_PASSWORD,
      workspace_jids: [GRANTED],
    });
    expect(created.status).toBe(201);
    const lockedId = created.body.guest.id;

    // The owner's own disable can be undone by the owner.
    expect(
      (
        await call(ownerCookie, 'PATCH', `/api/guests/${lockedId}`, {
          status: 'disabled',
        })
      ).body.guest.disabled_by_admin,
    ).toBe(false);
    expect(
      (
        await call(ownerCookie, 'PATCH', `/api/guests/${lockedId}`, {
          status: 'active',
        })
      ).status,
    ).toBe(200);

    // User management disables it: the owner may look and delete only.
    const adminDisable = await call(
      ownerCookie,
      'PATCH',
      `/api/admin/users/${lockedId}`,
      { status: 'disabled' },
    );
    expect(adminDisable.status).toBe(200);
    for (const body of [
      { status: 'active' },
      { display_name: 'renamed' },
      { password: 'Another-pass-123' },
      { workspace_jids: [GRANTED, UNGRANTED] },
    ]) {
      const res = await call(
        ownerCookie,
        'PATCH',
        `/api/guests/${lockedId}`,
        body,
      );
      expect([JSON.stringify(body), res.status]).toEqual([
        JSON.stringify(body),
        403,
      ]);
    }
    const stored = db.getUserById(lockedId)!;
    expect(stored.status).toBe('disabled');
    expect(stored.display_name).not.toBe('renamed');
    const listed = (await call(ownerCookie, 'GET', '/api/guests')).body.guests;
    expect(listed.find((g: any) => g.id === lockedId).disabled_by_admin).toBe(
      true,
    );
    expect(
      (await call(ownerCookie, 'DELETE', `/api/guests/${lockedId}`)).status,
    ).toBe(200);
  });

  test('a Host grant lapses once its owner is no longer an admin', async () => {
    const on = await call(ownerCookie, 'PUT', '/api/config/system', {
      allowMemberGuests: true,
    });
    expect(on.status).toBe(200);
    db.updateUserFields(OWNER, { role: 'member' });
    try {
      const groups = await call(guestCookie, 'GET', '/api/groups');
      expect(groups.status).toBe(200);
      expect(Object.keys(groups.body.groups)).toEqual([GRANTED]);
      for (const url of [
        messagesOf(HOME),
        `/api/groups/${HOME}/files`,
        `/api/workspaces/${HOME}`,
      ]) {
        const res = await call(guestCookie, 'GET', url);
        expect([url, res.status]).toEqual([url, 404]);
      }
      expect(getGroupAllowedUserIds(HOME)?.has(guestId)).toBe(false);
      // A container workspace of the same owner is still shared.
      expect(getGroupAllowedUserIds(GRANTED)?.has(guestId)).toBe(true);
    } finally {
      db.updateUserFields(OWNER, { role: 'admin' });
      invalidateUserSessions(OWNER);
      await call(ownerCookie, 'PUT', '/api/config/system', {
        allowMemberGuests: false,
      });
    }
    expect(getGroupAllowedUserIds(HOME)?.has(guestId)).toBe(true);
  });

  test('a new or revoked grant reaches broadcasts at once', async () => {
    expect(getGroupAllowedUserIds(UNGRANTED)?.has(guestId)).toBe(false);
    await call(ownerCookie, 'PATCH', `/api/guests/${guestId}`, {
      workspace_jids: [HOME, GRANTED, UNGRANTED],
    });
    expect(getGroupAllowedUserIds(UNGRANTED)?.has(guestId)).toBe(true);
    await call(ownerCookie, 'PATCH', `/api/guests/${guestId}`, {
      workspace_jids: [HOME, GRANTED],
    });
    expect(getGroupAllowedUserIds(UNGRANTED)?.has(guestId)).toBe(false);
  });

  test('a guest file listing resolves only the symlinks', async () => {
    const dir = path.join(tmp, 'groups', 'flow-x', 'many');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
    }
    fs.symlinkSync(
      path.join(tmp, 'groups', 'flow-x', '.env'),
      path.join(dir, 'link'),
    );
    const realpath = vi.spyOn(fs, 'realpathSync');
    try {
      const list = await call(
        guestCookie,
        'GET',
        `/api/groups/${GRANTED}/files?path=many`,
      );
      expect(list.status).toBe(200);
      expect(list.body.files).toHaveLength(20);
      // A fixed few (root, listed directory, the one symlink), not one per
      // listed file.
      expect(realpath.mock.calls.length).toBeLessThan(10);
    } finally {
      realpath.mockRestore();
    }
  });
});

describe('member guests and the per-owner cap', () => {
  test('members cannot hold guests until allowMemberGuests is on', async () => {
    const list = await call(otherCookie, 'GET', '/api/guests');
    expect(list.status).toBe(200);
    expect(list.body.can_create).toBe(false);
    const denied = await call(otherCookie, 'POST', '/api/guests', {
      username: 'member_guest',
      password: GUEST_PASSWORD,
      workspace_jids: [FOREIGN],
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe(
      'Guest accounts are not enabled for members',
    );
    // The admin created guest_one with the setting at its default (off).
    expect(
      (await call(ownerCookie, 'GET', '/api/guests')).body.can_create,
    ).toBe(true);

    const on = await call(ownerCookie, 'PUT', '/api/config/system', {
      allowMemberGuests: true,
    });
    expect(on.status).toBe(200);
    expect(on.body.allowMemberGuests).toBe(true);
    const created = await call(otherCookie, 'POST', '/api/guests', {
      username: 'member_guest',
      password: GUEST_PASSWORD,
      workspace_jids: [FOREIGN],
    });
    expect(created.status).toBe(201);
    const memberGuestId = created.body.guest.id;
    const memberGuestCookie = mintCookie(memberGuestId);
    expect(
      (await call(memberGuestCookie, 'GET', messagesOf(FOREIGN))).status,
    ).toBe(200);
    expect(getGroupAllowedUserIds(FOREIGN)?.has(memberGuestId)).toBe(true);

    // Turning it off again cuts the member's guests off at once.
    const off = await call(ownerCookie, 'PUT', '/api/config/system', {
      allowMemberGuests: false,
    });
    expect(off.body.allowMemberGuests).toBe(false);
    const cut = await call(memberGuestCookie, 'GET', '/api/groups');
    expect(cut.status).toBe(403);
    expect(cut.body.error).toBe('Account disabled');
    expect(getGroupAllowedUserIds(FOREIGN)?.has(memberGuestId)).toBe(false);
    // The admin's guest is unaffected.
    expect((await call(guestCookie, 'GET', '/api/groups')).status).toBe(200);
    // The member can still clean up.
    expect(
      (await call(otherCookie, 'DELETE', `/api/guests/${memberGuestId}`))
        .status,
    ).toBe(200);
  });

  test(`an owner holds at most ${MAX_GUESTS_PER_OWNER} guests`, async () => {
    const filler: string[] = [];
    const now = new Date().toISOString();
    for (
      let i = db.listGuestsByOwner(OWNER).length;
      i < MAX_GUESTS_PER_OWNER;
      i++
    ) {
      const id = `filler-${i}`;
      db.createUser({
        id,
        username: `filler_${i}`,
        password_hash: 'x',
        display_name: id,
        role: 'guest',
        status: 'disabled',
        guest_owner_id: OWNER,
        created_at: now,
        updated_at: now,
      });
      filler.push(id);
    }
    const full = await call(ownerCookie, 'POST', '/api/guests', {
      username: 'one_too_many',
      password: GUEST_PASSWORD,
      workspace_jids: [],
    });
    expect(full.status).toBe(409);
    expect(full.body.error).toBe(
      `Guest limit reached: at most ${MAX_GUESTS_PER_OWNER} guests per account`,
    );
    expect(db.getUserByUsername('one_too_many')).toBeUndefined();

    for (const id of filler) db.deleteGuestUser(id);
    const room = await call(ownerCookie, 'POST', '/api/guests', {
      username: 'one_more',
      password: GUEST_PASSWORD,
      workspace_jids: [],
    });
    expect(room.status).toBe(201);
    db.deleteGuestUser(room.body.guest.id);
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
