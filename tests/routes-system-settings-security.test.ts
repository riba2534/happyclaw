import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-system-settings-security-'),
);

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
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'settings-security-user',
        username: 'settings-security-user',
        display_name: 'Settings Security User',
        role: process.env.HAPPYCLAW_TEST_ROLE ?? 'member',
        status: 'active',
        permissions: JSON.parse(process.env.HAPPYCLAW_TEST_PERMISSIONS ?? '[]'),
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const stopGroup = vi.fn(async () => {});
const reconnectUserIMChannels = vi.fn(async () => {});
const runtimeSafetyBlocks = new Map<string, Set<string>>();
const liveGroups: Record<string, any> = {};
const blockGroupsForRuntimeSafety = vi.fn(
  (jids: string[], _reason: string, source = 'default') => {
    for (const jid of jids) {
      const sources = runtimeSafetyBlocks.get(jid) ?? new Set<string>();
      sources.add(source);
      runtimeSafetyBlocks.set(jid, sources);
    }
  },
);
const unblockGroupsForRuntimeSafety = vi.fn(
  (jids: string[], source = 'default') => {
    for (const jid of jids) {
      const sources = runtimeSafetyBlocks.get(jid);
      sources?.delete(source);
      if (sources?.size === 0) runtimeSafetyBlocks.delete(jid);
    }
  },
);
const app = web.createAppForTest({
  queue: {
    stopGroup,
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 'test-pause' }),
    resumeGroupsAfterMutation: vi.fn(),
    blockGroupsForRuntimeSafety,
    unblockGroupsForRuntimeSafety,
    isGroupRuntimeSafetyBlocked: (jid: string) => runtimeSafetyBlocks.has(jid),
  },
  getRegisteredGroups: () => liveGroups,
  sessions: {},
  ensureTerminalContainerStarted: vi.fn(() => true),
  reconnectUserIMChannels,
} as any);

function asUser(role: 'admin' | 'member', permissions: string[] = []): void {
  process.env.HAPPYCLAW_TEST_ROLE = role;
  process.env.HAPPYCLAW_TEST_PERMISSIONS = JSON.stringify(permissions);
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'settings-security-user',
    username: 'settings-security-user',
    password_hash: 'hash',
    display_name: 'Settings Security User',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
});

afterAll(() => {
  delete process.env.HAPPYCLAW_TEST_ROLE;
  delete process.env.HAPPYCLAW_TEST_PERMISSIONS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('system settings capability boundaries', () => {
  test('system config response excludes host and billing fields', async () => {
    asUser('member', ['manage_system_config']);
    const response = await app.request('/api/config/system');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('externalClaudeDir');
    expect(body).not.toHaveProperty('pluginAutoScan');
    expect(body).not.toHaveProperty('adminHostOnlyMode');
    expect(body).not.toHaveProperty('mainAgentContextSource');
    expect(body).not.toHaveProperty('mainAgentAutoCompactWindow');
    expect(body).not.toHaveProperty('mainAgentAutoCompactPercentage');
    expect(body).not.toHaveProperty('billingEnabled');
    expect(body).not.toHaveProperty('billingCurrencyRate');
  });

  test('system config rejects billing fields instead of silently accepting them', async () => {
    asUser('member', ['manage_system_config']);
    const response = await app.request('/api/config/system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ billingEnabled: true }),
    });
    expect(response.status).toBe(400);
  });

  test('stale clients may submit retired automation fields, which are ignored', async () => {
    asUser('member', ['manage_system_config']);
    const response = await app.request('/api/config/system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxConcurrentScripts: 100,
        scriptTimeout: -1,
        taskBackfillGraceMs: 'legacy',
        maxRepliesPerTurn: null,
        maxTasksPerUser: 999_999,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('maxConcurrentScripts');
    expect(body).not.toHaveProperty('scriptTimeout');
    expect(body).not.toHaveProperty('taskBackfillGraceMs');
    expect(body).not.toHaveProperty('maxRepliesPerTurn');
    expect(body).not.toHaveProperty('maxTasksPerUser');
  });

  test('member with system permission cannot read or write host integration', async () => {
    asUser('member', ['manage_system_config']);
    expect((await app.request('/api/config/host-integration')).status).toBe(
      403,
    );
    expect(
      (
        await app.request('/api/config/host-integration', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ externalClaudeDir: tmpDir }),
        })
      ).status,
    ).toBe(403);
  });

  test('storage sources are admin only', async () => {
    asUser('member', ['manage_system_config']);
    expect((await app.request('/api/config/storage-sources')).status).toBe(403);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect(
        (
          await app.request('/api/config/storage-sources/nas', {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'nfs',
              server: 'nas.lan',
              exportPath: '/export',
              allowReadWrite: true,
            }),
          })
        ).status,
      ).toBe(403);
    }
    asUser('admin');
    expect(
      (
        await app.request('/api/config/storage-sources/Bad%20Id', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(400);
  });

  test('admin host update logs names but never the sensitive path', async () => {
    asUser('admin');
    const response = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'settings-security-test',
      },
      body: JSON.stringify({
        externalClaudeDir: tmpDir,
        mainAgentContextSource: 'managed',
      }),
    });
    expect(response.status).toBe(200);
    const logs = db.queryAuthAuditLogs({
      event_type: 'host_integration_updated',
    }).logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({
      changed_fields: ['externalClaudeDir', 'mainAgentContextSource'],
      external_claude_dir_configured: true,
    });
    expect(JSON.stringify(logs[0].details)).not.toContain(tmpDir);
  });

  test('combined host and compact update quiesces admin custom and member default workspaces without discarding work', async () => {
    const now = new Date().toISOString();
    for (const [id, role] of [
      ['settings-admin-owner', 'admin'],
      ['settings-member-owner', 'member'],
    ] as const) {
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
      });
    }
    const adminCustom = db.createAgentProfile({
      ownerUserId: 'settings-admin-owner',
      name: 'Admin Custom Host',
      runtimePolicy: { context: { source: 'host_claude' } },
    });
    db.getOrCreateDefaultAgentProfile('settings-member-owner');
    db.setRegisteredGroup('web:settings-admin-custom', {
      name: 'Admin custom',
      folder: 'settings-admin-custom',
      added_at: now,
      executionMode: 'host',
      created_by: 'settings-admin-owner',
    });
    db.assignWorkspaceAgentProfile('settings-admin-custom', adminCustom.id);
    db.setSession('settings-admin-custom', 'sdk-session-dir-a', null, {
      agentProfileId: adminCustom.id,
      agentProfileVersion: adminCustom.version,
      identityHash: adminCustom.identity_hash,
    });
    expect(db.getSession('settings-admin-custom')).toBe('sdk-session-dir-a');
    expect(
      db.listWorkspaceRuntimeSessionsByWorkspace('web:settings-admin-custom'),
    ).toHaveLength(1);
    db.setRegisteredGroup('web:settings-member-default', {
      name: 'Member default',
      folder: 'settings-member-default',
      added_at: now,
      executionMode: 'container',
      created_by: 'settings-member-owner',
    });

    const nextClaudeDir = path.join(tmpDir, 'next-claude');
    fs.mkdirSync(nextClaudeDir);
    stopGroup.mockClear();
    asUser('admin');
    const response = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        externalClaudeDir: nextClaudeDir,
        mainAgentAutoCompactWindow: 360_000,
      }),
    });
    expect(response.status).toBe(200);
    expect(stopGroup).toHaveBeenCalledWith(
      'web:settings-admin-custom',
      expect.objectContaining({ force: true, preserveQueuedWork: true }),
    );
    expect(stopGroup).toHaveBeenCalledWith(
      'web:settings-member-default',
      expect.objectContaining({ force: true, preserveQueuedWork: true }),
    );
    expect(db.getSession('settings-admin-custom')).toBeUndefined();
    expect(
      db.listWorkspaceRuntimeSessionsByWorkspace('web:settings-admin-custom'),
    ).toEqual([]);

    db.setSession('settings-admin-custom', 'sdk-session-dir-b', null, {
      agentProfileId: adminCustom.id,
      agentProfileVersion: adminCustom.version,
      identityHash: adminCustom.identity_hash,
    });
    const finalClaudeDir = path.join(tmpDir, 'final-claude');
    fs.mkdirSync(finalClaudeDir);
    const secondResponse = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalClaudeDir: finalClaudeDir }),
    });
    expect(secondResponse.status).toBe(200);
    expect(db.getSession('settings-admin-custom')).toBeUndefined();
    expect(
      db.listWorkspaceRuntimeSessionsByWorkspace('web:settings-admin-custom'),
    ).toEqual([]);
  });

  test('admin host-only mode migrates only active-admin runtimes and preserves member isolation', async () => {
    const now = new Date().toISOString();
    db.setRegisteredGroup('web:settings-admin-container', {
      name: 'Admin container before policy',
      folder: 'settings-admin-container',
      added_at: now,
      executionMode: 'container',
      created_by: 'settings-admin-owner',
    });
    db.setRegisteredGroup('web:settings-member-container', {
      name: 'Member container before policy',
      folder: 'settings-member-container',
      added_at: now,
      executionMode: 'container',
      created_by: 'settings-member-owner',
    });

    stopGroup.mockClear();
    asUser('admin');
    const response = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminHostOnlyMode: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ adminHostOnlyMode: true });
    expect(
      db.getRegisteredGroup('web:settings-admin-container')?.executionMode,
    ).toBe('host');
    expect(
      db.getRegisteredGroup('web:settings-member-container')?.executionMode,
    ).toBe('container');
    expect(stopGroup).toHaveBeenCalledWith(
      'web:settings-admin-container',
      expect.objectContaining({ force: true, preserveQueuedWork: true }),
    );

    const disableResponse = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminHostOnlyMode: false }),
    });
    expect(disableResponse.status).toBe(200);
    expect(
      db.getRegisteredGroup('web:settings-admin-container')?.executionMode,
    ).toBe('host');
  });

  test('an exact retry repairs a persisted host-integration cleanup failure', async () => {
    asUser('admin');
    await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminHostOnlyMode: false }),
    });
    db.setRegisteredGroup('web:settings-admin-retry', {
      name: 'Admin cleanup retry',
      folder: 'settings-admin-retry',
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'settings-admin-owner',
    });
    db.setSession('settings-admin-retry', 'initial-container-session');

    const callsByJid = new Map<string, number>();
    stopGroup.mockImplementation(async (jid: string) => {
      const calls = (callsByJid.get(jid) ?? 0) + 1;
      callsByJid.set(jid, calls);
      if (jid === 'web:settings-admin-retry' && calls === 2) {
        db.setSession('settings-admin-retry', 'late-container-session');
        throw new Error('simulated post-commit teardown failure');
      }
    });
    runtimeSafetyBlocks.clear();
    blockGroupsForRuntimeSafety.mockClear();
    unblockGroupsForRuntimeSafety.mockClear();

    const failed = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminHostOnlyMode: true }),
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      persisted: true,
      retryable: true,
    });
    expect(
      db.getRegisteredGroup('web:settings-admin-retry')?.executionMode,
    ).toBe('host');
    expect(db.getSession('settings-admin-retry')).toBe(
      'late-container-session',
    );
    expect(runtimeSafetyBlocks.has('web:settings-admin-retry')).toBe(true);
    expect(
      db.getRouterState('admin_host_only_runtime_cleanup_pending'),
    ).toContain('settings-admin-retry');

    stopGroup.mockImplementation(async () => {});
    const repaired = await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminHostOnlyMode: true }),
    });
    expect(repaired.status).toBe(200);
    expect(db.getSession('settings-admin-retry')).toBeUndefined();
    expect(runtimeSafetyBlocks.has('web:settings-admin-retry')).toBe(false);
    expect(
      db.getRouterState('admin_host_only_runtime_cleanup_pending'),
    ).toBeUndefined();
    expect(unblockGroupsForRuntimeSafety).toHaveBeenCalled();
  });

  test('host-only enable serializes with workspace publication and prewarm', async () => {
    asUser('admin');
    await app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminHostOnlyMode: false }),
    });
    db.getOrCreateDefaultAgentProfile('settings-security-user');

    let releaseStop!: () => void;
    let reportStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      reportStopEntered = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let heldFirstStop = false;
    stopGroup.mockImplementation(async () => {
      if (heldFirstStop) return;
      heldFirstStop = true;
      reportStopEntered();
      await stopGate;
    });

    const enableRequest = app.request('/api/config/host-integration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminHostOnlyMode: true }),
    });
    await stopEntered;
    const createRequest = app.request('/api/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Must not publish as Docker',
        execution_mode: 'container',
      }),
    });
    const completedWhilePolicyPaused = await Promise.race([
      createRequest.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(completedWhilePolicyPaused).toBe(false);

    releaseStop();
    expect((await enableRequest).status).toBe(200);
    const createResponse = await createRequest;
    expect(createResponse.status).toBe(409);
    expect(await createResponse.json()).toMatchObject({
      code: 'ADMIN_HOST_ONLY_MODE_ENABLED',
    });
    expect(
      Object.values(db.getAllRegisteredGroups()).some(
        (group) => group.name === 'Must not publish as Docker',
      ),
    ).toBe(false);
    stopGroup.mockImplementation(async () => {});
  });

  test('promoting a member under host-only mode migrates runtimes and retries cleanup safely', async () => {
    const now = new Date().toISOString();
    db.createUser({
      id: 'settings-promoted-admin',
      username: 'settings-promoted-admin',
      password_hash: 'hash',
      display_name: 'Promoted Admin',
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    db.setRegisteredGroup('web:settings-promoted-admin', {
      name: 'Promoted admin workspace',
      folder: 'settings-promoted-admin',
      added_at: now,
      executionMode: 'container',
      created_by: 'settings-promoted-admin',
    });
    db.setSession('settings-promoted-admin', 'promotion-initial-session');

    let targetStops = 0;
    stopGroup.mockImplementation(async (jid: string) => {
      if (jid !== 'web:settings-promoted-admin') return;
      targetStops += 1;
      if (targetStops === 2) {
        db.setSession('settings-promoted-admin', 'promotion-late-session');
        throw new Error('simulated promotion post-commit failure');
      }
    });
    runtimeSafetyBlocks.clear();
    asUser('admin');
    const failed = await app.request(
      '/api/admin/users/settings-promoted-admin',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      persisted: true,
      retryable: true,
    });
    expect(db.getUserById('settings-promoted-admin')?.role).toBe('admin');
    expect(
      db.getRegisteredGroup('web:settings-promoted-admin')?.executionMode,
    ).toBe('host');
    expect(db.getSession('settings-promoted-admin')).toBe(
      'promotion-late-session',
    );
    expect(runtimeSafetyBlocks.has('web:settings-promoted-admin')).toBe(true);

    stopGroup.mockImplementation(async () => {});
    const repaired = await app.request(
      '/api/admin/users/settings-promoted-admin',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
    );
    expect(repaired.status).toBe(200);
    expect(db.getSession('settings-promoted-admin')).toBeUndefined();
    expect(runtimeSafetyBlocks.has('web:settings-promoted-admin')).toBe(false);
    stopGroup.mockImplementation(async () => {});
  });

  test('reactivating an administrator applies host-only mode before reconnecting channels', async () => {
    const now = new Date().toISOString();
    db.createUser({
      id: 'settings-reactivated-admin',
      username: 'settings-reactivated-admin',
      password_hash: 'hash',
      display_name: 'Reactivated Admin',
      role: 'admin',
      status: 'disabled',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    db.setRegisteredGroup('web:settings-reactivated-admin', {
      name: 'Reactivated admin workspace',
      folder: 'settings-reactivated-admin',
      added_at: now,
      executionMode: 'container',
      created_by: 'settings-reactivated-admin',
    });
    reconnectUserIMChannels.mockClear();
    stopGroup.mockImplementation(async () => {});

    const response = await app.request(
      '/api/admin/users/settings-reactivated-admin',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(response.status).toBe(200);
    expect(db.getUserById('settings-reactivated-admin')?.status).toBe('active');
    expect(
      db.getRegisteredGroup('web:settings-reactivated-admin')?.executionMode,
    ).toBe('host');
    expect(reconnectUserIMChannels).toHaveBeenCalledWith(
      'settings-reactivated-admin',
    );
  });
});

describe('billing config capability boundary', () => {
  test('manage_system_config alone cannot access billing admin config', async () => {
    asUser('member', ['manage_system_config']);
    expect((await app.request('/api/billing/admin/config')).status).toBe(403);
  });

  test('manage_billing can update config and produces billing audit', async () => {
    asUser('member', ['manage_billing']);
    const response = await app.request('/api/billing/admin/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        minStartBalanceUsd: 1.5,
        currency: 'CNY',
        currencyRate: 7.2,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      minStartBalanceUsd: 1.5,
      currency: 'CNY',
      currencyRate: 7.2,
    });
    const logs = db.getBillingAuditLog(
      20,
      0,
      'settings-security-user',
      'billing_settings_updated',
    ).logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toEqual({
      changed_fields: [
        'currency',
        'currencyRate',
        'enabled',
        'minStartBalanceUsd',
      ],
    });
  });
});
