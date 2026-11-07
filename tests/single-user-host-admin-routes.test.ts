/**
 * Single-user host mode on the admin side: the host-integration settings
 * carry the workspace root and deployment mode, the switch is refused while
 * another active account exists and otherwise runs the admin host-only
 * migration, the routes that would add an account refuse, and the monitor
 * never touches Docker.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'single-user-host-admin-'));
// The install directory is the parent of DATA_DIR, so roots under `tmp`
// (outside `install/`) are valid and nothing resolves to the real home.
const installDir = path.join(tmp, 'install');
const dataDir = path.join(installDir, 'data');

const childCalls = vi.hoisted(() => [] as string[][]);
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const record = (command: string, args: unknown) => {
    childCalls.push([command, ...(Array.isArray(args) ? args : [])]);
  };
  return {
    ...real,
    // No real process ever runs: probes resolve with empty output.
    execFile: vi.fn((command: string, args: unknown, ...rest: unknown[]) => {
      record(command, args);
      const callback = rest.find((item) => typeof item === 'function') as
        | ((err: null, value: { stdout: string; stderr: string }) => void)
        | undefined;
      callback?.(null, { stdout: '', stderr: '' });
    }),
    spawn: vi.fn((command: string, args: unknown) => {
      record(command, args);
      throw new Error('spawn must not run in this test');
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
        permissions: [
          'manage_system_config',
          'manage_group_env',
          'manage_users',
          'manage_invites',
          'view_audit_log',
          'manage_billing',
        ],
        must_change_password: false,
      });
      return next();
    },
  };
});

const ADMIN = 'single-host-owner';

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { DEPLOYMENT_MODE_ENV } = await import('../src/deployment-mode.js');
const { WORKSPACE_ROOT_ENV } = await import('../src/workspace-root.js');

const stopGroup = vi.fn(async () => {});
const app = web.createAppForTest({
  queue: {
    stopGroup,
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 'test-pause' }),
    resumeGroupsAfterMutation: vi.fn(),
    blockGroupsForRuntimeSafety: vi.fn(),
    unblockGroupsForRuntimeSafety: vi.fn(),
    isGroupRuntimeSafetyBlocked: () => false,
    getStatus: () => ({
      groups: [],
      activeContainerCount: 0,
      activeHostProcessCount: 0,
      activeCount: 0,
      waitingCount: 0,
      waitingGroupJids: [],
    }),
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
  ensureTerminalContainerStarted: vi.fn(() => true),
  reconnectUserIMChannels: vi.fn(async () => {}),
} as any);

function request(
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
  );
}

const putHost = (body: unknown) =>
  request('/api/config/host-integration', 'PUT', body);

function createUser(
  id: string,
  role: 'admin' | 'member' | 'guest',
  status: 'active' | 'disabled' = 'active',
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
  });
}

function setStatus(id: string, status: 'active' | 'disabled'): void {
  db.updateUserFields(id, { status });
}

const SINGLE_USER_HOST_REFUSAL = {
  error: '单人宿主机模式只允许一个用户。',
  code: 'SINGLE_USER_HOST',
};

beforeAll(() => {
  delete process.env[DEPLOYMENT_MODE_ENV];
  delete process.env[WORKSPACE_ROOT_ENV];
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'groups'), { recursive: true });
  db.initDatabase();
  createUser(ADMIN, 'admin');
});

afterAll(() => {
  delete process.env[DEPLOYMENT_MODE_ENV];
  delete process.env[WORKSPACE_ROOT_ENV];
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('host-integration: workspace root and deployment mode', () => {
  test('defaults: nothing stored, nothing in the environment', async () => {
    const body = await (await request('/api/config/host-integration')).json();
    expect(body).toMatchObject({
      adminHostOnlyMode: false,
      workspaceRoot: '',
      workspaceRootEffective: path.join(os.homedir(), 'happyclaw'),
      workspaceRootSource: 'default',
      deploymentMode: 'multi_user',
      deploymentModeConfigured: '',
      deploymentModeSource: 'default',
    });
  });

  test('per key: the setting wins over the environment, which wins over the default', async () => {
    const envRoot = path.join(tmp, 'env-root');
    const settingRoot = path.join(tmp, 'setting-root');
    process.env[WORKSPACE_ROOT_ENV] = envRoot;
    process.env[DEPLOYMENT_MODE_ENV] = 'multi_user';
    let body = await (await request('/api/config/host-integration')).json();
    expect(body).toMatchObject({
      workspaceRoot: '',
      workspaceRootEffective: envRoot,
      workspaceRootSource: 'env',
      workspaceRootFallbackReason: null,
      deploymentMode: 'multi_user',
      deploymentModeSource: 'env',
    });

    const saved = await putHost({
      workspaceRoot: settingRoot,
      deploymentMode: 'multi_user',
    });
    expect(saved.status).toBe(200);
    body = await saved.json();
    expect(body).toMatchObject({
      workspaceRoot: settingRoot,
      workspaceRootEffective: settingRoot,
      workspaceRootSource: 'settings',
      deploymentMode: 'multi_user',
      deploymentModeConfigured: 'multi_user',
      deploymentModeSource: 'settings',
    });
    // Saving does not create the directory.
    expect(fs.existsSync(settingRoot)).toBe(false);

    // '' clears both stored values; the environment applies again.
    body = await (
      await putHost({ workspaceRoot: '', deploymentMode: '' })
    ).json();
    expect(body).toMatchObject({
      workspaceRoot: '',
      workspaceRootSource: 'env',
      deploymentModeConfigured: '',
      deploymentModeSource: 'env',
    });
    delete process.env[WORKSPACE_ROOT_ENV];
    delete process.env[DEPLOYMENT_MODE_ENV];
  });

  test.each([
    ['relative/dir', 'not_absolute'],
    ['/', 'filesystem_root'],
    [path.join(installDir, 'workspaces'), 'inside_install_dir'],
  ])('workspaceRoot %s is refused with %s', async (value, reason) => {
    const response = await putHost({ workspaceRoot: value });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'WORKSPACE_ROOT_INVALID',
      reason,
    });
    expect(runtimeConfig.getSystemSettings().workspaceRoot).toBe('');
  });

  test('with the fallback unusable too, no effective root is reported', async () => {
    // ~/CLAUDE.md rules out both ~/happyclaw and ~/happyclaw-workspaces, so
    // new workspaces stay in data/groups/<folder> (index.ts's resolver).
    const home = path.join(tmp, 'home-with-memory');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), '# mine\n');
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const body = await (await request('/api/config/host-integration')).json();
      expect(body).toMatchObject({
        workspaceRoot: '',
        workspaceRootEffective: null,
        workspaceRootSource: 'default',
        workspaceRootFallbackReason: 'claude_md_ancestor',
        workspaceRootFallbackWarning: 'claude_md_ancestor',
      });
    } finally {
      process.env.HOME = savedHome;
    }
  });

  test('a workspaceRoot that is a file is refused', async () => {
    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x');
    const response = await putHost({ workspaceRoot: file });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: 'not_directory' });
  });
});

describe('switching to single-user host mode', () => {
  test('is refused while an active member exists', async () => {
    createUser('other-member', 'member');
    const response = await putHost({ deploymentMode: 'single_user_host' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '单人宿主机模式只允许一个用户；请先停用其他账号。',
      code: 'SINGLE_USER_HOST_OTHER_USERS',
      users: [{ id: 'other-member', username: 'other-member', role: 'member' }],
    });
    expect(runtimeConfig.getSystemSettings().deploymentMode).toBe('');
  });

  test('is refused while an active guest exists', async () => {
    setStatus('other-member', 'disabled');
    createUser('other-guest', 'guest');
    const response = await putHost({ deploymentMode: 'single_user_host' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as any).users).toEqual([
      { id: 'other-guest', username: 'other-guest', role: 'guest' },
    ]);
  });

  test('a mode that only comes from the environment is guarded too', async () => {
    process.env[DEPLOYMENT_MODE_ENV] = 'single_user_host';
    // Clearing the stored value lets the environment decide: still a switch.
    runtimeConfig.saveSystemSettings({ deploymentMode: 'multi_user' });
    const response = await putHost({ deploymentMode: '' });
    expect(response.status).toBe(409);
    delete process.env[DEPLOYMENT_MODE_ENV];
    runtimeConfig.saveSystemSettings({ deploymentMode: '' });
  });

  test('with no other active user it runs the admin host-only migration', async () => {
    // The owner disables its own guest, so it may re-enable it later.
    expect(
      (
        await request('/api/guests/other-guest', 'PATCH', {
          status: 'disabled',
        })
      ).status,
    ).toBe(200);
    const now = new Date().toISOString();
    db.setRegisteredGroup('web:owner-container', {
      name: 'Owner container',
      folder: 'owner-container',
      added_at: now,
      executionMode: 'container',
      created_by: ADMIN,
    });
    db.setSession('owner-container', 'container-session');
    stopGroup.mockClear();

    const response = await putHost({ deploymentMode: 'single_user_host' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      // The stored switch is not rewritten.
      adminHostOnlyMode: false,
      deploymentMode: 'single_user_host',
      deploymentModeConfigured: 'single_user_host',
      deploymentModeSource: 'settings',
    });
    expect(db.getRegisteredGroup('web:owner-container')?.executionMode).toBe(
      'host',
    );
    expect(db.getSession('owner-container')).toBeUndefined();
    expect(stopGroup).toHaveBeenCalledWith(
      'web:owner-container',
      expect.objectContaining({ force: true, preserveQueuedWork: true }),
    );
    expect(runtimeConfig.getSystemSettings().adminHostOnlyMode).toBe(false);
  });
});

describe('in single-user host mode', () => {
  test('the monitor runs no Docker command and reports Docker as null', async () => {
    childCalls.length = 0;
    const response = await request('/api/status');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      deploymentMode: 'single_user_host',
      dockerImageExists: null,
      dockerRequired: null,
      dockerPullInProgress: null,
      dockerPullResult: null,
      adminHostOnlyMode: true,
    });
    expect((body.claudeCodeVersions as any).container).toBeNull();
    expect(childCalls.filter(([command]) => command === 'docker')).toEqual([]);
  });

  test('docker pull is refused without spawning', async () => {
    childCalls.length = 0;
    const response = await request('/api/docker/pull', 'POST');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '单人宿主机模式不使用 Docker。',
      code: 'SINGLE_USER_HOST',
    });
    expect(childCalls).toEqual([]);
  });

  test('creating a user is refused', async () => {
    const response = await request('/api/admin/users', 'POST', {
      username: 'second',
      password: 'second-password-1',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(SINGLE_USER_HOST_REFUSAL);
    expect(db.getUserByUsername('second')).toBeUndefined();
  });

  test('creating an invite code is refused', async () => {
    const response = await request('/api/admin/invites', 'POST', {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(SINGLE_USER_HOST_REFUSAL);
    expect(db.getAllInviteCodes()).toEqual([]);
  });

  test('reactivating a deactivated user is refused', async () => {
    const response = await request('/api/admin/users/other-member', 'PATCH', {
      status: 'active',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(SINGLE_USER_HOST_REFUSAL);
    expect(db.getUserById('other-member')?.status).toBe('disabled');
  });

  test('promoting to admin is refused', async () => {
    const response = await request('/api/admin/users/other-member', 'PATCH', {
      role: 'admin',
    });
    expect(response.status).toBe(409);
    expect(db.getUserById('other-member')?.role).toBe('member');
  });

  test('creating a guest is refused, and the guest list says so', async () => {
    const response = await request('/api/guests', 'POST', {
      username: 'new-guest',
      password: 'guest-password-1',
      workspace_jids: [],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(SINGLE_USER_HOST_REFUSAL);
    const list = await (await request('/api/guests')).json();
    expect(list.can_create).toBe(false);
  });

  test('re-enabling a guest is refused', async () => {
    const response = await request('/api/guests/other-guest', 'PATCH', {
      status: 'active',
    });
    expect(response.status).toBe(409);
    expect(db.getUserById('other-guest')?.status).toBe('disabled');
  });

  test('reading, editing, deactivating, restoring and deleting stay allowed', async () => {
    expect((await request('/api/admin/users')).status).toBe(200);
    expect(
      (
        await request('/api/admin/users/other-member', 'PATCH', {
          display_name: 'Renamed',
        })
      ).status,
    ).toBe(200);

    createUser('late-member', 'member');
    expect(
      (
        await request('/api/admin/users/late-member', 'PATCH', {
          status: 'disabled',
        })
      ).status,
    ).toBe(200);
    expect(
      (await request('/api/admin/users/late-member', 'DELETE')).status,
    ).toBe(200);
    // Restoring leaves the account disabled, so it adds no active user.
    const restored = await request(
      '/api/admin/users/late-member/restore',
      'POST',
    );
    expect(restored.status).toBe(200);
    expect(db.getUserById('late-member')?.status).toBe('disabled');
    expect((await request('/api/guests/other-guest', 'DELETE')).status).toBe(
      200,
    );
  });

  test('billing reads as off while the stored switch stays on', async () => {
    runtimeConfig.saveSystemSettings({ billingEnabled: true });
    const status = await (await request('/api/billing/status')).json();
    expect(status.enabled).toBe(false);
    const config = await (await request('/api/billing/admin/config')).json();
    expect(config.enabled).toBe(true);
    runtimeConfig.saveSystemSettings({ billingEnabled: false });
  });
});

describe('switching back to multi-user', () => {
  test('only saves the setting', async () => {
    stopGroup.mockClear();
    const response = await putHost({ deploymentMode: 'multi_user' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      adminHostOnlyMode: false,
      deploymentMode: 'multi_user',
      deploymentModeConfigured: 'multi_user',
    });
    expect(stopGroup).not.toHaveBeenCalled();
    expect(db.getRegisteredGroup('web:owner-container')?.executionMode).toBe(
      'host',
    );

    // Multi-user surfaces are back.
    const invite = await request('/api/admin/invites', 'POST', {});
    expect(invite.status).toBe(201);

    // The same spy sees the Docker probe once multi-user is back.
    childCalls.length = 0;
    expect((await request('/api/status')).status).toBe(200);
    expect(childCalls.some(([command]) => command === 'docker')).toBe(true);
  });
});

describe('switching to single-user host with admin host-only already on', () => {
  test('migrates nothing, so it stops no runner and keeps every session', async () => {
    runtimeConfig.saveSystemSettings({ adminHostOnlyMode: true });
    db.setRegisteredGroup('web:owner-host', {
      name: 'Owner host',
      folder: 'owner-host',
      added_at: new Date().toISOString(),
      executionMode: 'host',
      created_by: ADMIN,
    });
    db.setSession('owner-host', 'host-session');
    stopGroup.mockClear();

    const response = await putHost({ deploymentMode: 'single_user_host' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      adminHostOnlyMode: true,
      deploymentMode: 'single_user_host',
    });
    expect(stopGroup).not.toHaveBeenCalled();
    expect(db.getSession('owner-host')).toBe('host-session');
  });
});
