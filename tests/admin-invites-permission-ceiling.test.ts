import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-invites-ceiling-'));
fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });

const actorState = vi.hoisted(() => ({
  user: {
    id: 'u-admin',
    username: 'root',
    display_name: 'Root',
    role: 'admin' as 'admin' | 'member',
    status: 'active',
    permissions: [] as string[],
    must_change_password: false,
  },
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...real,
    DATA_DIR: tmpDir,
    STORE_DIR: path.join(tmpDir, 'db'),
    GROUPS_DIR: path.join(tmpDir, 'groups'),
  };
});

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

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', { ...actorState.user });
      return next();
    },
  };
});

const { ALL_PERMISSIONS, PERMISSION_TEMPLATES } =
  await import('../src/permissions.js');
const db = await import('../src/db.js');
const web = await import('../src/web.js');

const app = web.createAppForTest({
  queue: {
    stopGroup: vi.fn(async () => {}),
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 'test-pause' }),
    resumeGroupsAfterMutation: vi.fn(),
    blockGroupsForRuntimeSafety: vi.fn(),
    unblockGroupsForRuntimeSafety: vi.fn(),
    isGroupRuntimeSafetyBlocked: () => false,
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
  ensureTerminalContainerStarted: vi.fn(() => true),
  reconnectUserIMChannels: vi.fn(async () => {}),
} as any);

const USER_ADMIN_PERMS = [
  ...PERMISSION_TEMPLATES.user_admin.permissions,
] as string[];

function asAdmin() {
  actorState.user = {
    id: 'u-admin',
    username: 'root',
    display_name: 'Root',
    role: 'admin',
    status: 'active',
    permissions: [...ALL_PERMISSIONS],
    must_change_password: false,
  };
}

function asUserAdmin() {
  actorState.user = {
    id: 'u-ua',
    username: 'helpdesk',
    display_name: 'Helpdesk',
    role: 'member',
    status: 'active',
    permissions: [...USER_ADMIN_PERMS],
    must_change_password: false,
  };
}

async function postInvite(body: Record<string, unknown>) {
  return app.request('/api/admin/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getInvites() {
  return app.request('/api/admin/invites');
}

async function deleteInvite(code: string) {
  return app.request(`/api/admin/invites/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  });
}

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'u-admin',
    username: 'root',
    password_hash: 'x',
    display_name: 'Root',
    role: 'admin',
    status: 'active',
    permissions: [...ALL_PERMISSIONS],
    created_at: now,
    updated_at: now,
    must_change_password: false,
  } as any);
  db.createUser({
    id: 'u-ua',
    username: 'helpdesk',
    password_hash: 'x',
    display_name: 'Helpdesk',
    role: 'member',
    status: 'active',
    permissions: [...USER_ADMIN_PERMS],
    created_at: now,
    updated_at: now,
    must_change_password: false,
  } as any);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear invites between cases (keep users).
  for (const invite of db.getAllInviteCodes()) {
    db.deleteInviteCode(invite.code);
  }
  asAdmin();
});

describe('admin invite list/delete respect POST ceiling', () => {
  test('user_admin GET hides admin and ops_manager invites; admin GET lists all', async () => {
    asAdmin();
    const adminInvite = await postInvite({
      role: 'admin',
      permission_template: 'admin_full',
    });
    expect(adminInvite.status).toBe(201);
    const adminCode = (await adminInvite.json()).code as string;

    const opsInvite = await postInvite({ permission_template: 'ops_manager' });
    expect(opsInvite.status).toBe(201);
    const opsCode = (await opsInvite.json()).code as string;

    asUserAdmin();
    const ownInvite = await postInvite({ permission_template: 'member_basic' });
    expect(ownInvite.status).toBe(201);
    const ownCode = (await ownInvite.json()).code as string;

    // Still as user_admin: ceiling filter on GET
    const uaListRes = await getInvites();
    expect(uaListRes.status).toBe(200);
    const uaList = (await uaListRes.json()).invites as Array<{
      code: string;
      role: string;
      permissions: string[];
    }>;
    const uaCodes = uaList.map((i) => i.code);
    expect(uaCodes).toContain(ownCode);
    expect(uaCodes).not.toContain(adminCode);
    expect(uaCodes).not.toContain(opsCode);
    expect(uaList.every((i) => i.role !== 'admin')).toBe(true);
    expect(
      uaList.every((i) =>
        i.permissions.every((p) => USER_ADMIN_PERMS.includes(p)),
      ),
    ).toBe(true);

    asAdmin();
    const adminListRes = await getInvites();
    expect(adminListRes.status).toBe(200);
    const adminCodes = (
      (await adminListRes.json()).invites as Array<{ code: string }>
    ).map((i) => i.code);
    expect(adminCodes.sort()).toEqual([adminCode, opsCode, ownCode].sort());
  });

  test('user_admin DELETE of admin invite is 404 and leaves it intact; in-ceiling delete works', async () => {
    asAdmin();
    const adminInvite = await postInvite({
      role: 'admin',
      permission_template: 'admin_full',
    });
    const adminCode = (await adminInvite.json()).code as string;

    asUserAdmin();
    const ownInvite = await postInvite({ permission_template: 'member_basic' });
    const ownCode = (await ownInvite.json()).code as string;

    const denied = await deleteInvite(adminCode);
    expect(denied.status).toBe(404);
    expect((await denied.json()).error).toBe('Invite not found');
    expect(db.getInviteCode(adminCode)).toBeTruthy();

    const allowed = await deleteInvite(ownCode);
    expect(allowed.status).toBe(200);
    expect(db.getInviteCode(ownCode)).toBeUndefined();
  });
});
