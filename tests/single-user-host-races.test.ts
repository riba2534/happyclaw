/**
 * Adding an account and switching to single-user host mode both await
 * between their first check and their write (password hashing, runner
 * quiesce). Each interleaving below holds one side on a deferred promise,
 * lets the other side finish, then releases it: single-user host mode must
 * still end with one active account.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'single-user-host-races-'));
const dataDir = path.join(tmp, 'install', 'data');

const hashGate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  entered: null as (() => void) | null,
}));
vi.mock('../src/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/auth.js')>();
  return {
    ...real,
    hashPassword: vi.fn(async () => {
      if (hashGate.hold) {
        const hold = hashGate.hold;
        hashGate.hold = null;
        hashGate.entered?.();
        await hold;
      }
      return 'hash';
    }),
  };
});
vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...real,
    DATA_DIR: dataDir,
    STORE_DIR: path.join(dataDir, 'db'),
    GROUPS_DIR: path.join(dataDir, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: ADMIN,
        username: ADMIN,
        display_name: 'Owner',
        role: 'admin',
        status: 'active',
        permissions: ['manage_system_config', 'manage_users'],
        must_change_password: false,
      });
      return next();
    },
  };
});

const ADMIN = 'race-owner';

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { DEPLOYMENT_MODE_ENV } = await import('../src/deployment-mode.js');
const { WORKSPACE_ROOT_ENV } = await import('../src/workspace-root.js');

const stopGroup = vi.fn(async (_jid: string) => {});
const app = web.createAppForTest({
  queue: {
    stopGroup,
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

function request(url: string, method: string, body?: unknown) {
  return Promise.resolve(
    app.request(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.0.9' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const switchToSingleUserHost = () =>
  request('/api/config/host-integration', 'PUT', {
    deploymentMode: 'single_user_host',
  });

/** Hold the next password hash until `release()`; `entered` resolves on entry. */
function holdNextHash() {
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    hashGate.entered = resolve;
  });
  hashGate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, release };
}

/** Hold the first stopGroup call until `release()`. */
function holdFirstStop() {
  let release!: () => void;
  let reportEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    reportEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  stopGroup.mockImplementation(async () => {
    if (held) return;
    held = true;
    reportEntered();
    await gate;
  });
  return { entered, release };
}

function createUser(
  id: string,
  role: 'admin' | 'member' | 'guest',
  status: 'active' | 'disabled' = 'active',
  extra: Record<string, unknown> = {},
): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role,
    status,
    created_at: now,
    updated_at: now,
    must_change_password: false,
    ...(role === 'guest' ? { guest_owner_id: ADMIN } : {}),
    ...extra,
  });
}

function activeUserIds(): string[] {
  return db
    .listUsers({ status: 'active', pageSize: 200 })
    .users.map((user) => user.id);
}

beforeAll(() => {
  delete process.env[DEPLOYMENT_MODE_ENV];
  process.env[WORKSPACE_ROOT_ENV] = path.join(tmp, 'roots');
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'groups'), { recursive: true });
  db.initDatabase();
  createUser(ADMIN, 'admin');
  runtimeConfig.saveRegistrationConfig({
    allowRegistration: true,
    requireInviteCode: false,
  });
});

afterEach(() => {
  // Back to multi-user, one active account.
  runtimeConfig.saveSystemSettings({
    deploymentMode: '',
    adminHostOnlyMode: false,
  });
  for (const id of activeUserIds()) {
    if (id !== ADMIN) db.updateUserFields(id, { status: 'disabled' });
  }
  stopGroup.mockImplementation(async () => {});
});

afterAll(() => {
  delete process.env[WORKSPACE_ROOT_ENV];
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('register: the switch lands while the password hashes', async () => {
  const hash = holdNextHash();
  const register = request('/api/auth/register', 'POST', {
    username: 'racer_register',
    password: 'racer-password-1',
  });
  await hash.entered;
  expect((await switchToSingleUserHost()).status).toBe(200);
  hash.release();
  expect((await register).status).toBe(403);
  expect(db.getUserByUsername('racer_register')).toBeUndefined();
  expect(activeUserIds()).toEqual([ADMIN]);
});

test('admin create: the switch lands while the password hashes', async () => {
  const hash = holdNextHash();
  const create = request('/api/admin/users', 'POST', {
    username: 'racer_admin_create',
    password: 'racer-password-1',
  });
  await hash.entered;
  expect((await switchToSingleUserHost()).status).toBe(200);
  hash.release();
  expect((await create).status).toBe(409);
  expect(db.getUserByUsername('racer_admin_create')).toBeUndefined();
  expect(activeUserIds()).toEqual([ADMIN]);
});

test('guest create: the switch lands while the password hashes', async () => {
  const hash = holdNextHash();
  const create = request('/api/guests', 'POST', {
    username: 'racer_guest',
    password: 'racer-password-1',
    workspace_jids: [],
  });
  await hash.entered;
  expect((await switchToSingleUserHost()).status).toBe(200);
  hash.release();
  expect((await create).status).toBe(409);
  expect(db.getUserByUsername('racer_guest')).toBeUndefined();
  expect(activeUserIds()).toEqual([ADMIN]);
});

test('guest re-enable with a new password: the switch lands while it hashes', async () => {
  createUser('racer-old-guest', 'guest', 'disabled', {
    disable_reason: 'disabled_by_owner',
  });
  const hash = holdNextHash();
  const patch = request('/api/guests/racer-old-guest', 'PATCH', {
    status: 'active',
    password: 'racer-password-2',
  });
  await hash.entered;
  expect((await switchToSingleUserHost()).status).toBe(200);
  hash.release();
  expect((await patch).status).toBe(409);
  expect(activeUserIds()).toEqual([ADMIN]);
});

// The admin PATCH holds the system capability lock, so a host-integration
// PUT waits for it; these change the mode directly to exercise the re-check.
test('admin reactivate with a new password: the mode changes while it hashes', async () => {
  createUser('racer-old-member', 'member', 'disabled');
  const hash = holdNextHash();
  const patch = request('/api/admin/users/racer-old-member', 'PATCH', {
    status: 'active',
    password: 'racer-password-2',
  });
  await hash.entered;
  runtimeConfig.saveSystemSettings({ deploymentMode: 'single_user_host' });
  hash.release();
  expect((await patch).status).toBe(409);
  expect(activeUserIds()).toEqual([ADMIN]);
});

test('admin reactivate under host-only: the mode changes during the quiesce', async () => {
  createUser('racer-old-admin', 'admin', 'disabled');
  db.setRegisteredGroup('web:racer-old-admin', {
    name: 'Old admin workspace',
    folder: 'racer-old-admin',
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: 'racer-old-admin',
  });
  runtimeConfig.saveSystemSettings({ adminHostOnlyMode: true });
  const stop = holdFirstStop();
  const patch = request('/api/admin/users/racer-old-admin', 'PATCH', {
    status: 'active',
  });
  await stop.entered;
  runtimeConfig.saveSystemSettings({ deploymentMode: 'single_user_host' });
  stop.release();
  expect((await patch).status).toBe(409);
  expect(db.getUserById('racer-old-admin')?.status).toBe('disabled');
  expect(db.getRegisteredGroup('web:racer-old-admin')?.executionMode).toBe(
    'container',
  );
  expect(activeUserIds()).toEqual([ADMIN]);
});

test('switch: an account is created while runners quiesce', async () => {
  db.setRegisteredGroup('web:racer-owner-container', {
    name: 'Owner container',
    folder: 'racer-owner-container',
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: ADMIN,
  });
  db.setSession('racer-owner-container', 'owner-session');
  const stop = holdFirstStop();
  const put = switchToSingleUserHost();
  await stop.entered;
  const created = await request('/api/admin/users', 'POST', {
    username: 'racer_late',
    password: 'racer-password-1',
  });
  expect(created.status).toBe(201);
  stop.release();

  const response = await put;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: 'SINGLE_USER_HOST_OTHER_USERS',
    users: [expect.objectContaining({ username: 'racer_late' })],
  });
  // Refused before the first write: mode, migration and sessions untouched.
  expect(runtimeConfig.getSystemSettings().deploymentMode).toBe('');
  expect(
    db.getRegisteredGroup('web:racer-owner-container')?.executionMode,
  ).toBe('container');
  expect(db.getSession('racer-owner-container')).toBe('owner-session');
});
