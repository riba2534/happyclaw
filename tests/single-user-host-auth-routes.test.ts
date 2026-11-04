/**
 * Auth routes under the deployment mode: status and /me report the effective
 * mode, /setup can store it before the admin's home workspace exists, and
 * single-user host mode closes registration without rewriting the stored
 * registration switch.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'single-user-host-auth-test-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'single-user-host-auth-'));
// The install directory is the parent of DATA_DIR; keep the workspace root
// outside it so nothing resolves to the real home directory.
const dataDir = path.join(tmp, 'install', 'data');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
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
vi.mock('../src/middleware/auth.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      const id = process.env.HAPPYCLAW_TEST_USER_ID!;
      const user = db.getUserById(id)!;
      c.set('user', {
        id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        status: user.status,
        permissions: user.permissions,
        must_change_password: false,
      });
      return next();
    },
  };
});

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { DEPLOYMENT_MODE_ENV } = await import('../src/deployment-mode.js');
const { WORKSPACE_ROOT_ENV } = await import('../src/workspace-root.js');
const authRoutes = (await import('../src/routes/auth.js')).default;

const app = new Hono().route('/api/auth', authRoutes);

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function createUser(id: string, role: 'admin' | 'member' | 'guest'): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role,
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
    ...(role === 'guest' ? { guest_owner_id: 'me-admin' } : {}),
  });
}

beforeAll(() => {
  delete process.env[DEPLOYMENT_MODE_ENV];
  process.env[WORKSPACE_ROOT_ENV] = path.join(tmp, 'roots');
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'groups'), { recursive: true });
  db.initDatabase();
  runtimeConfig.saveRegistrationConfig({
    allowRegistration: true,
    requireInviteCode: false,
  });
});

afterAll(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env[WORKSPACE_ROOT_ENV];
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('setup with a deployment mode', () => {
  test('an invalid deployment_mode is rejected before any account exists', async () => {
    const response = await app.request(
      '/api/auth/setup',
      json({
        username: 'owner',
        password: 'owner-password-1',
        deployment_mode: 'docker_please',
      }),
    );
    expect(response.status).toBe(400);
    expect(db.getUserCount(true)).toBe(0);
    expect(runtimeConfig.getSystemSettings().deploymentMode).toBe('');
  });

  test('status reports the default mode before setup', async () => {
    const response = await app.request('/api/auth/status');
    expect(await response.json()).toEqual({
      initialized: false,
      deploymentMode: 'multi_user',
    });
  });

  test('single_user_host is stored and the home workspace is a Host one', async () => {
    const response = await app.request(
      '/api/auth/setup',
      json({
        username: 'owner',
        password: 'owner-password-1',
        deployment_mode: 'single_user_host',
      }),
    );
    expect(response.status).toBe(201);
    const { user } = (await response.json()) as { user: { id: string } };
    expect(runtimeConfig.getSystemSettings().deploymentMode).toBe(
      'single_user_host',
    );
    const home = db.getUserHomeGroup(user.id);
    expect(home).toBeDefined();
    expect(home!.executionMode).toBe('host');
    expect(db.getRegisteredGroup(home!.jid)?.created_by).toBe(user.id);

    const status = await app.request('/api/auth/status');
    expect(await status.json()).toEqual({
      initialized: true,
      deploymentMode: 'single_user_host',
    });
    process.env.HAPPYCLAW_TEST_USER_ID = user.id;
  });
});

describe('/me reports the effective mode for every role', () => {
  test.each(['admin', 'member', 'guest'] as const)('%s', async (role) => {
    const id = `me-${role}`;
    createUser(id, role);
    process.env.HAPPYCLAW_TEST_USER_ID = id;
    const response = await app.request('/api/auth/me');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.deploymentMode).toBe('single_user_host');
    expect('setupStatus' in body).toBe(role === 'admin');
  });
});

describe('registration in single-user host mode', () => {
  test('register/status reports registration closed', async () => {
    const response = await app.request('/api/auth/register/status');
    expect(await response.json()).toEqual({
      allowRegistration: false,
      requireInviteCode: true,
    });
  });

  test('register is refused and creates nothing', async () => {
    const before = db.getUserCount(true);
    const response = await app.request(
      '/api/auth/register',
      json({ username: 'newcomer', password: 'newcomer-password-1' }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: '单人宿主机模式不开放注册。',
    });
    expect(db.getUserCount(true)).toBe(before);
  });

  test('switching back to multi_user restores the stored registration switch', async () => {
    runtimeConfig.saveSystemSettings({ deploymentMode: 'multi_user' });
    const response = await app.request('/api/auth/register/status');
    expect(await response.json()).toEqual({
      allowRegistration: true,
      requireInviteCode: false,
    });
    const me = await app.request('/api/auth/me');
    expect(((await me.json()) as any).deploymentMode).toBe('multi_user');
  });
});
