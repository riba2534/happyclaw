import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-deactivate-audit-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const dataDir = path.join(tmpRoot, 'data');
  return {
    ...actual,
    DATA_DIR: dataDir,
    STORE_DIR: path.join(dataDir, 'db'),
    GROUPS_DIR: path.join(dataDir, 'groups'),
  };
});

process.env.WEB_SESSION_SECRET = 'test-session-secret-for-deactivate-audit';
process.env.DISABLE_MIGRATION_BACKUPS = 'true';

const {
  initDatabase,
  createUser,
  createUserSession,
  setRegisteredGroup,
  getAllRegisteredGroups,
  queryAuthAuditLogs,
} = await import('../src/db.js');
const { signSessionToken } = await import('../src/auth.js');
const { setWebDeps } = await import('../src/web-context.js');
const { GroupQueue } = await import('../src/group-queue.js');
const { scanHostMarketplaces } = await import('../src/plugin-importer.js');
const { readUserPluginsV2 } = await import('../src/plugin-utils.js');
const pluginsRoutes = (await import('../src/routes/plugins.js')).default;
const mcpRoutes = (await import('../src/routes/mcp-servers.js')).default;
const skillsRoutes = (await import('../src/routes/skills.js')).default;

const adminId = 'admin-user-' + Date.now();
const memberAId = 'member-a-' + Date.now();
const memberBId = 'member-b-' + Date.now();

let adminCookie: string;
let memberACookie: string;
let memberBCookie: string;

let realQueue: any;
const executedTasks: string[] = [];
const mockSessions: Record<string, string> = {};

const fixtureSource = path.join(tmpRoot, 'fixture-marketplaces');
const marketplaceDir = path.join(fixtureSource, 'auditmarket');
const pluginDir = path.join(marketplaceDir, 'plugins', 'auditplug');

beforeAll(async () => {
  initDatabase();
  const now = new Date().toISOString();

  // 1. 创建 Admin
  createUser({
    id: adminId,
    username: adminId,
    password_hash: 'unused',
    display_name: 'Admin User',
    role: 'admin',
    status: 'active',
    permissions: ['manage_system_config', 'view_audit_log'],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  const adminToken = 'admin'.repeat(12);
  createUserSession({
    id: adminToken,
    user_id: adminId,
    ip_address: '127.0.0.1',
    user_agent: 'Vitest-Test-Agent',
    created_at: now,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    last_active_at: now,
  });
  adminCookie = 'happyclaw_session=' + signSessionToken(adminToken);

  // 2. 创建 Member A
  createUser({
    id: memberAId,
    username: memberAId,
    password_hash: 'unused',
    display_name: 'Member A',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  const tokenA = 'memA'.repeat(16);
  createUserSession({
    id: tokenA,
    user_id: memberAId,
    ip_address: '192.168.1.10',
    user_agent: 'Vitest-Test-Agent',
    created_at: now,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    last_active_at: now,
  });
  memberACookie = 'happyclaw_session=' + signSessionToken(tokenA);

  // 3. 创建 Member B
  createUser({
    id: memberBId,
    username: memberBId,
    password_hash: 'unused',
    display_name: 'Member B',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  const tokenB = 'memB'.repeat(16);
  createUserSession({
    id: tokenB,
    user_id: memberBId,
    ip_address: '192.168.1.20',
    user_agent: 'Vitest-Test-Agent',
    created_at: now,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    last_active_at: now,
  });
  memberBCookie = 'happyclaw_session=' + signSessionToken(tokenB);

  // 创建 Member A 的专属工作区
  setRegisteredGroup('web:workspace-a', {
    name: 'Workspace A',
    folder: 'workspace-a',
    added_at: now,
    created_by: memberAId,
    executionMode: 'container',
  });

  // 创建 Member B 的专属工作区
  setRegisteredGroup('web:workspace-b', {
    name: 'Workspace B',
    folder: 'workspace-b',
    added_at: now,
    created_by: memberBId,
    executionMode: 'container',
  });

  // 构造插件
  fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'auditmarket',
      plugins: [{ name: 'auditplug', source: './plugins/auditplug' }],
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'auditplug',
      version: '1.0.0',
      description: 'Audit test plugin',
    }),
  );

  // 导入插件
  await scanHostMarketplaces({
    source: { type: 'directory', path: fixtureSource },
  });

  mockSessions['workspace-a'] = 'active-session-a';
  mockSessions['workspace-b'] = 'active-session-b';

  realQueue = new GroupQueue();
  realQueue.setHostModeChecker(() => true);
  realQueue.setProcessMessagesFn(async (jid: string) => {
    executedTasks.push(jid);
    return true;
  });

  setWebDeps({
    queue: realQueue,
    sessions: mockSessions,
    getSessions: () => mockSessions,
    getRegisteredGroups: () => getAllRegisteredGroups(),
  } as any);
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe('R15: 插件立即停用与能力/凭据变更审计测试', () => {
  const fullId = 'auditplug@auditmarket';

  test('插件启用与即时停用：仅停用当前用户会话并记录审计，不影响其他用户', async () => {
    // 1. 用户 A 启用插件
    const resEnableA = await pluginsRoutes.request(
      `/enabled/${encodeURIComponent(fullId)}`,
      {
        method: 'PATCH',
        headers: { cookie: memberACookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(resEnableA.status).toBe(200);

    // 2. 用户 B 也启用插件
    const resEnableB = await pluginsRoutes.request(
      `/enabled/${encodeURIComponent(fullId)}`,
      {
        method: 'PATCH',
        headers: { cookie: memberBCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(resEnableB.status).toBe(200);

    // 验证 A 和 B 均已启用
    expect(readUserPluginsV2(memberAId)?.enabled[fullId]?.enabled).toBe(true);
    expect(readUserPluginsV2(memberBId)?.enabled[fullId]?.enabled).toBe(true);

    // 3. 用户 A 调用立即停用端到端 API
    mockSessions['workspace-a'] = 'active-session-a';
    const resDeactivateA = await pluginsRoutes.request(
      `/deactivate-immediately/${encodeURIComponent(fullId)}`,
      {
        method: 'POST',
        headers: { cookie: memberACookie },
      },
    );
    expect(resDeactivateA.status).toBe(200);
    const bodyDeactivateA = (await resDeactivateA.json()) as {
      success: boolean;
      fullId: string;
      stoppedSessionsCount: number;
    };
    expect(bodyDeactivateA.success).toBe(true);
    expect(bodyDeactivateA.fullId).toBe(fullId);
    // 真实验证：受影响的当前用户活跃运行会话被实际失效，而用户 B 的会话不受影响！
    expect(bodyDeactivateA.stoppedSessionsCount).toBeGreaterThanOrEqual(1);
    expect(mockSessions['workspace-a']).toBeUndefined();
    expect(mockSessions['workspace-b']).toBe('active-session-b');

    // 验证用户 A 已经彻底停用该插件
    expect(readUserPluginsV2(memberAId)?.enabled[fullId]).toBeUndefined();

    // 验证隔离性：用户 B 依然保持启用状态，不受任何影响！
    expect(readUserPluginsV2(memberBId)?.enabled[fullId]?.enabled).toBe(true);

    // 4. 验证立即停用重试路径：再次调用立即停用（此时 v2 已移除），必须作为幂等重试成功，绝不报 400 not enabled！
    const resRetry = await pluginsRoutes.request(
      `/deactivate-immediately/${encodeURIComponent(fullId)}`,
      {
        method: 'POST',
        headers: { cookie: memberACookie },
      },
    );
    expect(resRetry.status).toBe(200);
    expect(((await resRetry.json()) as any).success).toBe(true);

    // 5. 验证审计记录
    const auditLogs = queryAuthAuditLogs({ limit: 50 });
    const deactivateLog = auditLogs.logs.find(
      (l) =>
        l.event_type === 'plugin_deactivated_immediately' &&
        l.username === memberAId,
    );
    expect(deactivateLog).toBeDefined();
    expect(deactivateLog?.actor_username).toBe(memberAId);
    const details = deactivateLog?.details as Record<string, unknown>;
    expect(details?.targetId).toBe(fullId);
    expect(details?.action).toBe('deactivate_immediately');
    expect(details?.scope).toBe(`user:${memberAId}`);
    expect((details?.runtimeResult as Record<string, unknown>)?.success).toBe(
      true,
    );
  });

  test('用户私有插件 Secret 管理 API：脱敏只返回键名，支持配置、物化更新与安全撤回，并触发运行时会话失效', async () => {
    mockSessions['workspace-a'] = 'active-session-a-secrets';

    // 1. 配置 Secret 并触发运行时失效
    const resPut = await pluginsRoutes.request('/secrets/API_CUSTOM_KEY', {
      method: 'PUT',
      headers: { cookie: memberACookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'real-user-a-secret-plain-999' }),
    });
    expect(resPut.status).toBe(200);
    const bodyPut = (await resPut.json()) as any;
    expect(bodyPut.key).toBe('API_CUSTOM_KEY');
    expect(bodyPut.invalidated_runtime_jids).toBeGreaterThanOrEqual(1);
    expect(mockSessions['workspace-a']).toBeUndefined();

    // 2. 脱敏查询已配置的键名
    const resGet = await pluginsRoutes.request('/secrets', {
      headers: { cookie: memberACookie },
    });
    expect(resGet.status).toBe(200);
    const bodyGet = (await resGet.json()) as { keys: string[] };
    expect(bodyGet.keys).toContain('API_CUSTOM_KEY');
    // 严格不泄露凭据明文
    expect(JSON.stringify(bodyGet)).not.toContain(
      'real-user-a-secret-plain-999',
    );

    // 3. 安全撤回 Secret 并触发运行时失效
    mockSessions['workspace-a'] = 'active-session-a-revoke';
    const resDel = await pluginsRoutes.request('/secrets/API_CUSTOM_KEY', {
      method: 'DELETE',
      headers: { cookie: memberACookie },
    });
    expect(resDel.status).toBe(200);
    const bodyDel = (await resDel.json()) as any;
    expect(bodyDel.invalidated_runtime_jids).toBeGreaterThanOrEqual(1);
    expect(mockSessions['workspace-a']).toBeUndefined();

    // 再次查询已不在列表中
    const resGetAfter = await pluginsRoutes.request('/secrets', {
      headers: { cookie: memberACookie },
    });
    expect(((await resGetAfter.json()) as any).keys).not.toContain(
      'API_CUSTOM_KEY',
    );
  });

  test('POST /materialize 手工恢复接口：纳入能力事务与持久化审计记录', async () => {
    mockSessions['workspace-a'] = 'active-session-a-mat';
    const resMat = await pluginsRoutes.request('/materialize', {
      method: 'POST',
      headers: { cookie: memberACookie },
    });
    expect(resMat.status).toBe(200);
    const bodyMat = (await resMat.json()) as any;
    expect(bodyMat.success).toBe(true);
    expect(bodyMat.invalidated_runtime_jids).toBeGreaterThanOrEqual(1);
    expect(mockSessions['workspace-a']).toBeUndefined();

    // 验证审计日志
    const auditLogs = queryAuthAuditLogs({
      event_type: 'plugin_state_changed',
      username: memberAId,
    });
    const matLog = auditLogs.logs.find(
      (l) =>
        (l.details as Record<string, unknown>)?.action === 'manual_materialize',
    );
    expect(matLog).toBeDefined();
    expect((matLog?.details as Record<string, unknown>)?.scope).toBe(
      `user:${memberAId}`,
    );
  });

  test('MCP 共享与凭据变更审计：记录变更键名，严格不记录明文凭据值', async () => {
    // 1. 创建用户 MCP 服务器并设置凭据
    const serverId = 'test-mcp-server';
    const resCreate = await mcpRoutes.request('/', {
      method: 'POST',
      headers: { cookie: memberACookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: serverId,
        scope: 'user',
        command: 'node',
        args: ['server.js'],
        env: {
          API_TOKEN: 'super-sensitive-secret-token-12345',
          OTHER_KEY: 'secret-key-67890',
        },
        headers: {
          Authorization: 'Bearer bearer-token-abcde',
        },
      }),
    });
    expect(resCreate.status).toBe(200);

    // 2. 创建系统共享 MCP 服务器
    const sharedServerId = 'shared-system-mcp';
    const resShared = await mcpRoutes.request('/', {
      method: 'POST',
      headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sharedServerId,
        scope: 'system',
        command: 'node',
        args: ['sys.js'],
        memberAccess: 'shared',
      }),
    });
    expect(resShared.status).toBe(200);

    // 验证审计日志
    const auditLogs = queryAuthAuditLogs({ limit: 50 });

    // 1. 查找 mcp_credential_updated
    const credLog = auditLogs.logs.find(
      (l) =>
        l.event_type === 'mcp_credential_updated' &&
        (l.details as Record<string, unknown>)?.targetId === serverId,
    );
    expect(credLog).toBeDefined();
    const credDetails = credLog?.details as Record<string, unknown>;
    const sanitizedChanges = credDetails?.sanitizedChanges as {
      envKeys: string[];
      headerKeys: string[];
    };

    // 包含变更的键名
    expect(sanitizedChanges.envKeys).toContain('API_TOKEN');
    expect(sanitizedChanges.envKeys).toContain('OTHER_KEY');
    expect(sanitizedChanges.headerKeys).toContain('Authorization');

    // 严格不包含任何敏感明文值！
    const auditText = JSON.stringify(credLog);
    expect(auditText).not.toContain('super-sensitive-secret-token-12345');
    expect(auditText).not.toContain('secret-key-67890');
    expect(auditText).not.toContain('bearer-token-abcde');

    // 2. 查找 mcp_shared
    const shareLog = auditLogs.logs.find(
      (l) =>
        l.event_type === 'mcp_shared' &&
        (l.details as Record<string, unknown>)?.targetId === sharedServerId,
    );
    expect(shareLog).toBeDefined();
    expect((shareLog?.details as Record<string, unknown>)?.memberAccess).toBe(
      'shared',
    );
  });

  test('审计日志查询端点：支持按新增的能力与凭据事件类型过滤查询', async () => {
    // 按 plugin_deactivated_immediately 查询
    const resDeact = await fetchAuditLog(
      adminCookie,
      'plugin_deactivated_immediately',
    );
    expect(resDeact.status).toBe(200);
    const bodyDeact = (await resDeact.json()) as { logs: any[]; total: number };
    expect(bodyDeact.logs.length).toBeGreaterThanOrEqual(1);
    expect(bodyDeact.logs[0].event_type).toBe('plugin_deactivated_immediately');

    // 按 mcp_credential_updated 查询
    const resCred = await fetchAuditLog(adminCookie, 'mcp_credential_updated');
    expect(resCred.status).toBe(200);
    const bodyCred = (await resCred.json()) as { logs: any[]; total: number };
    expect(bodyCred.logs.length).toBeGreaterThanOrEqual(1);
    expect(bodyCred.logs[0].event_type).toBe('mcp_credential_updated');
  });

  test('DELETE /marketplaces 级联清理：统一能力锁保护、执行运行时失效并持久化审计日志', async () => {
    // 确保用户 B 已启用 auditplug@auditmarket
    const resEnable = await pluginsRoutes.request(
      `/enabled/${encodeURIComponent(fullId)}`,
      {
        method: 'PATCH',
        headers: { cookie: memberBCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(resEnable.status).toBe(200);

    // 用户 B 级联删除该 marketplace 的所有启用项
    const resCascade = await pluginsRoutes.request(
      '/marketplaces/auditmarket',
      {
        method: 'DELETE',
        headers: { cookie: memberBCookie },
      },
    );
    expect(resCascade.status).toBe(200);
    const bodyCascade = (await resCascade.json()) as {
      success: boolean;
      marketplace: string;
      removedEnabled: string[];
      invalidated_runtime_jids: number;
    };
    expect(bodyCascade.success).toBe(true);
    expect(bodyCascade.marketplace).toBe('auditmarket');
    expect(bodyCascade.removedEnabled).toContain(fullId);

    // 验证审计日志持久化
    const auditLogs = queryAuthAuditLogs({
      event_type: 'plugin_state_changed',
      username: memberBId,
    });
    const cascadeLog = auditLogs.logs.find(
      (l) =>
        (l.details as Record<string, unknown>)?.action === 'cascade_disable',
    );
    expect(cascadeLog).toBeDefined();
    const details = cascadeLog?.details as Record<string, unknown>;
    expect(details.marketplace).toBe('auditmarket');
    expect(details.removedEnabled as string[]).toContain(fullId);
    expect((details.runtimeResult as Record<string, unknown>).success).toBe(
      true,
    );
  });

  test('Post-commit 失败注入：安装安全 gate、记录失败审计、重试成功解除 gate 并记录修复', async () => {
    // 重新启用插件
    await pluginsRoutes.request(`/enabled/${encodeURIComponent(fullId)}`, {
      method: 'PATCH',
      headers: { cookie: memberACookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    // 物化目录（精准在 commit 之后生效）
    const runtimeDir = path.join(
      tmpRoot,
      'data',
      'plugins',
      'runtime',
      memberAId,
    );
    fs.mkdirSync(runtimeDir, { recursive: true });

    try {
      // 仅将 runtime 目录设为只读：此时 plugins.json 可以成功写入（commit成功），但随后的物化写入必然抛出 EACCES（post-commit失败）！
      fs.chmodSync(runtimeDir, 0o444);

      // 1. 尝试立即停用 -> 遇到物化失败 -> 返回 503
      const resFail = await pluginsRoutes.request(
        `/deactivate-immediately/${encodeURIComponent(fullId)}`,
        { method: 'POST', headers: { cookie: memberACookie } },
      );
      expect(resFail.status).toBe(503);

      // 验证：受影响的工作区已被真实队列安装安全 gate（blocked）！
      expect(realQueue.isGroupRuntimeSafetyBlocked('web:workspace-a')).toBe(
        true,
      );

      // 向真实队列排入待执行任务
      realQueue.enqueueTask(
        'web:workspace-a',
        'safety-block-probe-task',
        async () => {
          executedTasks.push('safety-block-probe-task');
        },
      );

      // 关键安全断言：在安全门禁存在期间，排队任务被严格拦截，绝不提前启动！
      expect(executedTasks).not.toContain('safety-block-probe-task');

      // 验证：审计表中记录了失败事件
      const logsFail = queryAuthAuditLogs({
        event_type: 'plugin_deactivated_immediately',
        username: memberAId,
        limit: 10,
      });
      const failedAudit = logsFail.logs.find(
        (l) => (l.details as any)?.runtimeResult?.success === false,
      );
      expect(failedAudit).toBeDefined();

      // 2. 恢复正常目录权限，执行重试停用！
      fs.chmodSync(runtimeDir, 0o755);

      const resRetry = await pluginsRoutes.request(
        `/deactivate-immediately/${encodeURIComponent(fullId)}`,
        { method: 'POST', headers: { cookie: memberACookie } },
      );
      expect(resRetry.status).toBe(200);

      // 验证：安全 gate 已经被成功解除（unblocked）！
      expect(realQueue.isGroupRuntimeSafetyBlocked('web:workspace-a')).toBe(
        false,
      );

      // 等待事件循环使恢复后的队列调度排队任务
      await new Promise((r) => setTimeout(r, 60));
      // 验证：只有在物化完全成功、事务成功提交并解除门禁后，排队任务才被安全调度启动！
      expect(executedTasks).toContain('safety-block-probe-task');

      // 验证：审计表中追加了成功的修复事件
      const logsSuccess = queryAuthAuditLogs({
        event_type: 'plugin_deactivated_immediately',
        username: memberAId,
        limit: 10,
      });
      const successAudit = logsSuccess.logs.find(
        (l) => (l.details as any)?.runtimeResult?.success === true,
      );
      expect(successAudit).toBeDefined();
    } finally {
      try {
        fs.chmodSync(runtimeDir, 0o755);
      } catch {}
    }
  });
});

async function fetchAuditLog(cookie: string, eventType: string) {
  const adminRoutes = (await import('../src/routes/admin.js')).default;
  return await adminRoutes.request(`/audit-log?event_type=${eventType}`, {
    headers: { cookie },
  });
}
