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

  // 嵌套子目录下包含敏感凭据
  const subConfigDir = path.join(pluginDir, 'subconfig');
  fs.mkdirSync(subConfigDir, { recursive: true });
  fs.writeFileSync(
    path.join(subConfigDir, '.env.nested'),
    'NESTED_SECRET=nested-plain-secret-555\n',
  );

  // 文档样例 .env.example 包含真实高熵 token（即使文件名含 example 也要清洗真实密钥）
  fs.writeFileSync(
    path.join(pluginDir, '.env.example'),
    'REAL_KEY_IN_EXAMPLE=sk-ant-api03-real-leak-token-111222333\n',
  );

  // 危险私钥与凭据文件
  fs.writeFileSync(
    path.join(pluginDir, 'server.key'),
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'credentials.json'),
    '{"client_secret": "forbidden-secret"}',
  );

  // .mcp.json 包含敏感 env、带连字符的 header，以及已有规范引用
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
            'X-API-Key': 'publisher-x-key-999',
            Authorization: 'Bearer ${EXISTING_AUTH_REF}',
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

  test('共享快照导入预检：识别凭据并脱敏，预检警告中不打印任何明文凭据，危险文件被移除', async () => {
    const report = await scanHostMarketplaces({
      source: { type: 'directory', path: fixtureSource },
    });

    expect(report.pluginsScanned).toBe(1);
    expect(report.snapshotsCreated).toBe(1);

    // 预检警告中必须指出敏感变量与危险文件，但严格不包含明文凭据值！
    const warningsText = report.warnings.join('\n');
    expect(warningsText).toContain('API_SECRET_TOKEN');
    expect(warningsText).toContain('CUSTOM_KEY');
    expect(warningsText).toContain('plugserver.env.API_KEY');
    expect(warningsText).toContain('NESTED_SECRET');
    expect(warningsText).toContain('REAL_KEY_IN_EXAMPLE');
    expect(warningsText).toContain('server.key');
    expect(warningsText).toContain('credentials.json');

    expect(warningsText).not.toContain(
      'super-secret-original-publisher-token-999',
    );
    expect(warningsText).not.toContain('custom-plain-secret-777');
    expect(warningsText).not.toContain('publisher-mcp-key-888');
    expect(warningsText).not.toContain('publisher-x-key-999');
    expect(warningsText).not.toContain(
      'sk-ant-api03-real-leak-token-111222333',
    );

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

    // 验证普通成员物化目录中：危险私钥和凭据文件已被彻底删除，绝不在成员目录
    const runtimeA = getUserPluginRuntimePath(
      userAId,
      activeSnapshot,
      'secmarket',
      'secretplug',
    );
    expect(fs.existsSync(path.join(runtimeA, 'server.key'))).toBe(false);
    expect(fs.existsSync(path.join(runtimeA, 'credentials.json'))).toBe(false);

    // 原始发布者的凭据值已被清洗为 Secret 占位符
    const envContent = fs.readFileSync(path.join(runtimeA, '.env'), 'utf-8');
    expect(envContent).toContain('PORT=8080');
    expect(envContent).toContain('APP_ENV=production');
    expect(envContent).not.toContain(
      'super-secret-original-publisher-token-999',
    );
    expect(envContent).toContain('API_SECRET_TOKEN=${API_SECRET_TOKEN}');

    // 嵌套子目录与 example 均被脱敏
    const nestedContent = fs.readFileSync(
      path.join(runtimeA, 'subconfig', '.env.nested'),
      'utf-8',
    );
    expect(nestedContent).not.toContain('nested-plain-secret-555');
    expect(nestedContent).toContain('NESTED_SECRET=${NESTED_SECRET}');

    // .mcp.json 已有的 Bearer ${EXISTING_AUTH_REF} 规范引用完整保留
    const mcpRaw = fs.readFileSync(path.join(runtimeA, '.mcp.json'), 'utf-8');
    expect(mcpRaw).toContain('Bearer ${EXISTING_AUTH_REF}');
  });

  test('双用户 Secret 隔离与特殊字符安全注入：JSON 结构完整，特殊字符严格转义无注入', async () => {
    // 为用户 A 配置包含反斜杠、双引号、换行的特殊 Secret
    const complexSecretA = 'secret"with\\quotes\nand-newline';
    setUserPluginSecret(userAId, 'API_SECRET_TOKEN', complexSecretA);
    setUserPluginSecret(userAId, 'CUSTOM_KEY', 'custom-secret-of-user-alice');
    setUserPluginSecret(userAId, 'X_API_Key', 'user-a-x-api-key');

    // 为用户 B 配置普通的 Secret
    setUserPluginSecret(
      userBId,
      'API_SECRET_TOKEN',
      'secret-value-of-user-bob',
    );

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

    // 验证用户 A 的 .mcp.json 依然是合法 JSON，且特殊字符被安全转义与解析！
    const mcpAContent = fs.readFileSync(
      path.join(runtimeA, '.mcp.json'),
      'utf-8',
    );
    const parsedMcpA = JSON.parse(mcpAContent);
    expect(parsedMcpA.mcpServers.plugserver.headers['X-API-Key']).toBe(
      'user-a-x-api-key',
    );

    const envA = fs.readFileSync(path.join(runtimeA, '.env'), 'utf-8');
    const envB = fs.readFileSync(path.join(runtimeB, '.env'), 'utf-8');

    // 用户 A 看到的是用户 A 自己的复杂 Secret（带有引号与换行，env 中安全包裹）
    expect(envA).toContain(JSON.stringify(complexSecretA));
    expect(envA).toContain('CUSTOM_KEY=custom-secret-of-user-alice');
    expect(envA).not.toContain('secret-value-of-user-bob');

    // 用户 B 看到的是用户 B 自己的 Secret，绝无用户 A 的 Secret！
    expect(envB).toContain('API_SECRET_TOKEN=secret-value-of-user-bob');
    expect(envB).not.toContain(complexSecretA);
    expect(envB).not.toContain('custom-secret-of-user-alice');
  });

  test('Secret 存储安全验证：存储在不可挂载的 users 目录，且具有安全权限', async () => {
    const { getUserPluginSecretsPath } = await import('../src/plugin-utils.js');
    const secretPathA = getUserPluginSecretsPath(userAId);

    // 存储路径必须位于 plugins/users/，绝不能位于会被容器挂载的 runtime/ 树下！
    expect(secretPathA).toContain(path.join('plugins', 'users'));
    expect(secretPathA).not.toContain(path.join('plugins', 'runtime'));

    // 文件与目录权限检查
    const fileStat = fs.statSync(secretPathA);
    expect(fileStat.mode & 0o077).toBe(0);
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
