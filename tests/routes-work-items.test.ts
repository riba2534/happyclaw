import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-item-routes-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [storeDir, groupsDir]) fs.mkdirSync(dir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
        username: 'u',
        role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
        status: 'active',
        permissions: [],
      });
      return next();
    },
  };
});

const service = vi.hoisted(() => ({
  listTeamMountViews: vi.fn(),
  saveTeamMountSettings: vi.fn(),
  listWorkItemViews: vi.fn(),
  getWorkItemDetail: vi.fn(),
  stopWorkItem: vi.fn(),
  approveWorkItem: vi.fn(),
  listWorkDecisionsForWorkspace: vi.fn(),
}));
vi.mock('../src/work-item-service.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/work-item-service.js')>()),
  ...service,
}));

const db = await import('../src/db.js');
const routes = (await import('../src/routes/work-items.js')).default;
const { WorkItemError } = await import('../src/work-item-service.js');
const { isGuestRouteAllowed } =
  await import('../src/middleware/guest-guard.js');
const harness = await import('./automation-harness.js');

const ALICE = 'web:alice-ws';
const ALICE_HOST = 'web:alice-host';
const BOB = 'web:bob-ws';
const GROUP = 'feishu:oc_team';

const app = new Hono();
app.route('/api', routes);

function as(user: string, role = 'member') {
  process.env.HAPPYCLAW_TEST_USER_ID = user;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

async function call(method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wi-1',
    seq: 1,
    workspaceJid: ALICE,
    stage: 'working',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

const settings = {
  enabled: true,
  admission: {
    listedUnaddressed: 'ignore',
    unlistedAddressed: 'inferred',
    unlistedUnaddressed: 'ignore',
  },
  acceptMode: 'observe',
  rules: [
    {
      id: 'r1',
      name: '线上报错',
      instruction: '有人贴报错时排查',
      enabled: true,
    },
  ],
};

const enc = encodeURIComponent;

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  harness.seedWorkspace(db, { jid: ALICE, owner: 'alice' });
  harness.seedWorkspace(db, { jid: ALICE_HOST, owner: 'alice', host: true });
  harness.seedWorkspace(db, { jid: BOB, owner: 'bob' });
  harness.seedWorkspace(db, { jid: 'web:root-ws', owner: 'root' });
  // An IM chat alice owns is never a workspace for these routes.
  db.setRegisteredGroup(GROUP, {
    name: '研发群',
    folder: 'alice-ws',
    added_at: new Date().toISOString(),
    created_by: 'alice',
  } as never);
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  service.listWorkItemViews.mockReturnValue([]);
  service.getWorkItemDetail.mockImplementation((id: string) =>
    id === 'wi-1'
      ? { item: item(), events: [], subscriptions: [] }
      : id === 'wi-bob'
        ? {
            item: item({ id, workspaceJid: BOB }),
            events: [],
            subscriptions: [],
          }
        : undefined,
  );
  as('alice');
});

describe('team mounts', () => {
  test('owner lists and saves; the saved view comes back', async () => {
    const view = { channelJid: GROUP, settings: { ...settings, version: 2 } };
    service.listTeamMountViews.mockReturnValue([view]);
    service.saveTeamMountSettings.mockResolvedValue({});

    const list = await call('GET', `/api/workspaces/${enc(ALICE)}/team-mounts`);
    expect(list).toEqual({ status: 200, body: { mounts: [view] } });

    const saved = await call(
      'PUT',
      `/api/workspaces/${enc(ALICE)}/team-mounts/${enc(GROUP)}`,
      { settings },
    );
    expect(saved).toEqual({ status: 200, body: { mount: view } });
    expect(service.saveTeamMountSettings).toHaveBeenCalledWith(
      ALICE,
      GROUP,
      settings,
      { userId: 'alice', isAdmin: false },
    );
  });

  test('invalid settings are 400 and never reach the service', async () => {
    const url = `/api/workspaces/${enc(ALICE)}/team-mounts/${enc(GROUP)}`;
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      ...settings.rules[0],
      id: `r${i}`,
    }));
    const long = [{ ...settings.rules[0], instruction: 'x'.repeat(2001) }];
    const dup = [settings.rules[0], settings.rules[0]];
    const explicitUnaddressed = {
      ...settings.admission,
      listedUnaddressed: 'explicit',
    };
    for (const body of [
      { settings: { ...settings, rules: tooMany } },
      { settings: { ...settings, rules: long } },
      { settings: { ...settings, rules: dup } },
      { settings: { ...settings, admission: explicitUnaddressed } },
      { settings: { ...settings, acceptMode: 'always' } },
      {},
    ]) {
      expect((await call('PUT', url, body)).status).toBe(400);
    }
    expect(service.saveTeamMountSettings).not.toHaveBeenCalled();
  });

  test('WorkItemError maps to its status', async () => {
    service.saveTeamMountSettings.mockRejectedValue(
      new WorkItemError('只能在飞书普通群开启', 409),
    );
    const res = await call(
      'PUT',
      `/api/workspaces/${enc(ALICE)}/team-mounts/${enc(GROUP)}`,
      { settings },
    );
    expect(res).toEqual({
      status: 409,
      body: { error: '只能在飞书普通群开启' },
    });
  });
});

describe('permissions', () => {
  const workspaceReads = (jid: string) => [
    ['GET', `/api/workspaces/${enc(jid)}/team-mounts`],
    ['PUT', `/api/workspaces/${enc(jid)}/team-mounts/${enc(GROUP)}`],
    ['GET', `/api/workspaces/${enc(jid)}/work-items`],
    ['GET', `/api/workspaces/${enc(jid)}/work-decisions`],
  ];
  const itemCalls = (id: string) => [
    ['GET', `/api/work-items/${id}`],
    ['POST', `/api/work-items/${id}/stop`],
    ['POST', `/api/work-items/${id}/approve`],
  ];

  test("another user's workspace and items are 404", async () => {
    for (const [method, url] of [
      ...workspaceReads(BOB),
      ...itemCalls('wi-bob'),
      ...itemCalls('wi-missing'),
    ]) {
      const res = await call(
        method,
        url,
        method === 'PUT' ? { settings } : undefined,
      );
      expect([method, url, res.status]).toEqual([method, url, 404]);
    }
    expect(service.listTeamMountViews).not.toHaveBeenCalled();
    expect(service.saveTeamMountSettings).not.toHaveBeenCalled();
    expect(service.stopWorkItem).not.toHaveBeenCalled();
    expect(service.approveWorkItem).not.toHaveBeenCalled();
  });

  test('an admin has no bypass into other workspaces', async () => {
    as('root', 'admin');
    for (const [method, url] of [
      ...workspaceReads(ALICE),
      ...itemCalls('wi-1'),
    ]) {
      const res = await call(
        method,
        url,
        method === 'PUT' ? { settings } : undefined,
      );
      expect([method, url, res.status]).toEqual([method, url, 404]);
    }
    expect(service.stopWorkItem).not.toHaveBeenCalled();
  });

  test('a Host workspace needs an admin even for its creator', async () => {
    expect(
      (await call('GET', `/api/workspaces/${enc(ALICE_HOST)}/team-mounts`))
        .status,
    ).toBe(404);
  });

  test('guests are refused by the guard and by the routes', async () => {
    as('alice', 'guest');
    for (const [method, url] of [
      ...workspaceReads(ALICE),
      ...itemCalls('wi-1'),
      ['GET', '/api/work-items?needs=me'],
    ]) {
      expect(isGuestRouteAllowed(method, url.split('?')[0])).toBe(false);
      const res = await call(
        method,
        url,
        method === 'PUT' ? { settings } : undefined,
      );
      expect([method, url, res.status]).toEqual([method, url, 403]);
    }
    expect(service.getWorkItemDetail).not.toHaveBeenCalled();
  });

  test('a non-web jid is never a workspace', async () => {
    expect(
      (await call('GET', `/api/workspaces/${enc(GROUP)}/team-mounts`)).status,
    ).toBe(404);
  });
});

describe('work items', () => {
  test('owner reads, stops and approves', async () => {
    const detail = await call('GET', '/api/work-items/wi-1');
    expect(detail.status).toBe(200);
    expect(detail.body.item.id).toBe('wi-1');

    service.stopWorkItem.mockResolvedValue(item({ status: 'ended' }));
    const stopped = await call('POST', '/api/work-items/wi-1/stop');
    expect(stopped.body.item.status).toBe('ended');
    expect(service.stopWorkItem).toHaveBeenCalledWith('wi-1', {
      userId: 'alice',
      isAdmin: false,
    });

    service.approveWorkItem.mockRejectedValue(
      new WorkItemError('这个工作项不需要批准', 409),
    );
    expect((await call('POST', '/api/work-items/wi-1/approve')).status).toBe(
      409,
    );
  });

  test('a delegated item reads and stops like any item, with its origin', async () => {
    const delegated = item({
      id: 'wi-d',
      origin: 'delegated',
      originAgentId: 'main-1',
      originInputId: 'in-1',
      originSessionName: '主会话',
      channelName: null,
    });
    service.getWorkItemDetail.mockReturnValue({
      item: delegated,
      events: [],
      subscriptions: [],
    });
    const detail = await call('GET', '/api/work-items/wi-d');
    expect(detail.status).toBe(200);
    expect(detail.body.item).toMatchObject({
      origin: 'delegated',
      originAgentId: 'main-1',
      originInputId: 'in-1',
      originSessionName: '主会话',
    });
    service.stopWorkItem.mockResolvedValue({
      ...delegated,
      status: 'ended',
      outcome: 'stopped',
    });
    const stopped = await call('POST', '/api/work-items/wi-d/stop');
    expect(stopped.body.item).toMatchObject({
      origin: 'delegated',
      outcome: 'stopped',
    });
    expect(service.stopWorkItem).toHaveBeenCalledWith('wi-d', {
      userId: 'alice',
      isAdmin: false,
    });
    // A guest still has no way to stop it.
    as('guest-1', 'guest');
    service.stopWorkItem.mockClear();
    expect((await call('POST', '/api/work-items/wi-d/stop')).status).toBe(403);
    expect(service.stopWorkItem).not.toHaveBeenCalled();
    as('alice');
  });

  test('list filters are validated', async () => {
    const base = `/api/workspaces/${enc(ALICE)}`;
    expect((await call('GET', `${base}/work-items?status=open`)).status).toBe(
      200,
    );
    expect(service.listWorkItemViews).toHaveBeenCalledWith(ALICE, {
      status: 'open',
      limit: undefined,
    });
    expect((await call('GET', `${base}/work-items?status=x`)).status).toBe(400);

    service.listWorkDecisionsForWorkspace.mockReturnValue([]);
    expect(
      (await call('GET', `${base}/work-decisions?kind=would_accept`)).status,
    ).toBe(200);
    expect((await call('GET', `${base}/work-decisions?kind=x`)).status).toBe(
      400,
    );
  });

  test('needs=me spans only the caller’s workspaces and person stages', async () => {
    service.listWorkItemViews.mockImplementation((jid: string) => [
      item({ id: `${jid}-a`, workspaceJid: jid, stage: 'answer' }),
      item({ id: `${jid}-w`, workspaceJid: jid, stage: 'working' }),
    ]);
    const res = await call('GET', '/api/work-items?needs=me');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
      `${ALICE}-a`,
    ]);
    expect(service.listWorkItemViews).toHaveBeenCalledTimes(1);
    expect((await call('GET', '/api/work-items')).status).toBe(400);
  });
});
