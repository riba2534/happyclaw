import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-plugin-secret-'),
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

process.env.WEB_SESSION_SECRET = 'test-session-secret-for-plugin-isolation';
process.env.DISABLE_MIGRATION_BACKUPS = 'true';

const { initDatabase, createUser, createUserSession } =
  await import('../src/db.js');
const { signSessionToken } = await import('../src/auth.js');
const { scanHostMarketplaces } = await import('../src/plugin-importer.js');
const { getUserPluginRuntimePath, setUserPluginSecret } =
  await import('../src/plugin-utils.js');
const { materializeUserRuntime } =
  await import('../src/plugin-materializer.js');
const pluginsRoutes = (await import('../src/routes/plugins.js')).default;

const userAId = 'user-a-' + Date.now();
const userBId = 'user-b-' + Date.now();
let userACookie: string;
let userBCookie: string;

const fixtureSource = path.join(tmpRoot, 'fixture-marketplaces');
const marketplaceDir = path.join(fixtureSource, 'secmarket');
const pluginDir = path.join(marketplaceDir, 'plugins', 'secretplug');

beforeAll(() => {
  initDatabase();
  const now = new Date().toISOString();

  // 创建用户 A
  createUser({
    id: userAId,
    username: userAId,
    password_hash: 'unused',
    display_name: 'User A',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  const tokenA = 'a'.repeat(64);
  createUserSession({
    id: tokenA,
    user_id: userAId,
    ip_address: null,
    user_agent: null,
    created_at: now,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    last_active_at: now,
  });
  userACookie = 'happyclaw_session=' + signSessionToken(tokenA);

  // 创建用户 B
  createUser({
    id: userBId,
    username: userBId,
    password_hash: 'unused',
    display_name: 'User B',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  const tokenB = 'b'.repeat(64);
  createUserSession({
    id: tokenB,
    user_id: userBId,
    ip_address: null,
    user_agent: null,
    created_at: now,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    last_active_at: now,
  });
  userBCookie = 'happyclaw_session=' + signSessionToken(tokenB);

  // 构造插件目录与配置
  fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });

  fs.writeFileSync(
    path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'secmarket',
      plugins: [{ name: 'secretplug', source: './plugins/secretplug' }],
    }),
  );

  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'secretplug',
      version: '1.0.0',
      description: 'Security testing plugin',
    }),
  );

  // .env 包含普通配置、样例注释和敏感凭据
  fs.writeFileSync(
    path.join(pluginDir, '.env'),
    [
      '# Comment line',
      'PORT=8080',
      'APP_ENV=production',
      'API_SECRET_TOKEN=super-secret-original-publisher-token-999',
      'CUSTOM_KEY=custom-plain-secret-777',
    ].join('\n'),
  );

  // 文档样例 .env.example 包含说明性占位符
  fs.writeFileSync(
    path.join(pluginDir, '.env.example'),
    'API_SECRET_TOKEN=your_token_here\n',
  );

  // .mcp.json 包含敏感 env 和 header
  fs.writeFileSync(
    path.join(pluginDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        plugserver: {
          command: 'echo',
          env: {
            API_KEY: 'publisher-mcp-key-888',
            NORMAL_CONFIG: 'some-value',
          },
          headers: {
            Authorization: 'Bearer publisher-bearer-999',
          },
        },
      },
    }),
  );
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe('R14: 共享 Catalog 导入预检与双用户 Secret 隔离及撤回测试', () => {
  let activeSnapshot: string;

  test('共享快照导入预检：识别凭据并脱敏，预检警告中不打印任何明文凭据', async () => {
    const report = await scanHostMarketplaces({
      source: { type: 'directory', path: fixtureSource },
    });

    expect(report.pluginsScanned).toBe(1);
    expect(report.snapshotsCreated).toBe(1);

    // 预检警告中必须指出敏感变量，但严格不包含明文凭据值！
    const warningsText = report.warnings.join('\n');
    expect(warningsText).toContain('API_SECRET_TOKEN');
    expect(warningsText).toContain('CUSTOM_KEY');
    expect(warningsText).toContain('plugserver.env.API_KEY');

    expect(warningsText).not.toContain(
      'super-secret-original-publisher-token-999',
    );
    expect(warningsText).not.toContain('custom-plain-secret-777');
    expect(warningsText).not.toContain('publisher-mcp-key-888');
    expect(warningsText).not.toContain('publisher-bearer-999');

    // 检查普通成员启用插件
    const fullId = 'secretplug@secmarket';
    const resA = await pluginsRoutes.request(
      `/enabled/${encodeURIComponent(fullId)}`,
      {
        method: 'PATCH',
        headers: { cookie: userACookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as { snapshot: string };
    activeSnapshot = bodyA.snapshot;

    // 验证普通成员物化目录中：原始发布者的凭据值已被清洗为 Secret 占位符
    const runtimeA = getUserPluginRuntimePath(
      userAId,
      activeSnapshot,
      'secmarket',
      'secretplug',
    );
    const envContent = fs.readFileSync(path.join(runtimeA, '.env'), 'utf-8');
    // 普通配置保留
    expect(envContent).toContain('PORT=8080');
    expect(envContent).toContain('APP_ENV=production');
    // 文档样例未被删除
    expect(fs.existsSync(path.join(runtimeA, '.env.example'))).toBe(true);
    // 原始发布者的明文凭据绝不在成员目录
    expect(envContent).not.toContain(
      'super-secret-original-publisher-token-999',
    );
    expect(envContent).not.toContain('custom-plain-secret-777');
    expect(envContent).toContain('API_SECRET_TOKEN=${API_SECRET_TOKEN}');
    expect(envContent).toContain('CUSTOM_KEY=${CUSTOM_KEY}');
  });

  test('双用户 Secret 隔离：用户 A 与用户 B 各自解析私有凭据，互不可见', async () => {
    // 为用户 A 配置 Secret
    setUserPluginSecret(
      userAId,
      'API_SECRET_TOKEN',
      'secret-value-of-user-alice',
    );
    setUserPluginSecret(userAId, 'CUSTOM_KEY', 'custom-secret-of-user-alice');

    // 为用户 B 配置不同的 Secret（或不配置）
    setUserPluginSecret(
      userBId,
      'API_SECRET_TOKEN',
      'secret-value-of-user-bob',
    );
    // 用户 B 未配置 CUSTOM_KEY

    // 用户 A 重新物化（强制刷新）
    materializeUserRuntime(userAId, { force: true });

    // 用户 B 启用并物化
    const fullId = 'secretplug@secmarket';
    const resB = await pluginsRoutes.request(
      `/enabled/${encodeURIComponent(fullId)}`,
      {
        method: 'PATCH',
        headers: { cookie: userBCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(resB.status).toBe(200);

    const runtimeA = getUserPluginRuntimePath(
      userAId,
      activeSnapshot,
      'secmarket',
      'secretplug',
    );
    const runtimeB = getUserPluginRuntimePath(
      userBId,
      activeSnapshot,
      'secmarket',
      'secretplug',
    );

    const envA = fs.readFileSync(path.join(runtimeA, '.env'), 'utf-8');
    const envB = fs.readFileSync(path.join(runtimeB, '.env'), 'utf-8');

    // 用户 A 看到的是用户 A 自己的 Secret
    expect(envA).toContain('API_SECRET_TOKEN=secret-value-of-user-alice');
    expect(envA).toContain('CUSTOM_KEY=custom-secret-of-user-alice');
    expect(envA).not.toContain('secret-value-of-user-bob');

    // 用户 B 看到的是用户 B 自己的 Secret，绝无用户 A 的 Secret！
    expect(envB).toContain('API_SECRET_TOKEN=secret-value-of-user-bob');
    expect(envB).not.toContain('secret-value-of-user-alice');
    expect(envB).not.toContain('custom-secret-of-user-alice');
    // 用户 B 未配置的保留占位符
    expect(envB).toContain('CUSTOM_KEY=${CUSTOM_KEY}');
  });

  test('Secret 撤回：用户 A 撤回凭据后重新物化，真实凭据立即从运行目录清除', async () => {
    // 用户 A 撤回 API_SECRET_TOKEN
    setUserPluginSecret(userAId, 'API_SECRET_TOKEN', undefined);

    // 重新物化
    materializeUserRuntime(userAId, { force: true });

    const runtimeA = getUserPluginRuntimePath(
      userAId,
      activeSnapshot,
      'secmarket',
      'secretplug',
    );
    const envA = fs.readFileSync(path.join(runtimeA, '.env'), 'utf-8');

    // 凭据已被撤回，不再包含敏感值
    expect(envA).not.toContain('secret-value-of-user-alice');
    expect(envA).toContain('API_SECRET_TOKEN=${API_SECRET_TOKEN}');
    // 未撤回的 CUSTOM_KEY 依然保留
    expect(envA).toContain('CUSTOM_KEY=custom-secret-of-user-alice');
  });
});
