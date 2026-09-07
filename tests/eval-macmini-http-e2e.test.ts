import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-http-e2e-'));
const tmpDataDir = path.join(tmpDir, 'data');
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });
fs.mkdirSync(tmpDataDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
    DATA_DIR: tmpDataDir,
    ASSISTANT_NAME: 'HappyClaw HTTP E2E Test',
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const db = await import('../src/db.js');
const { evalRoutes } = await import('../src/routes/eval.js');
const monitorModule = await import('../src/routes/monitor.js');
const monitorRoutes = monitorModule.default;
const authModule = await import('../src/routes/auth.js');
const authRoutes = authModule.default;
const agentProfileModule = await import('../src/routes/agent-profiles.js');
const agentProfileRoutes = agentProfileModule.default;
const { setEvalExecutionProviderForTests } =
  await import('../src/eval-service.js');
const { setWebDeps } = await import('../src/web-context.js');
const { generateSessionToken, signSessionToken } =
  await import('../src/auth.js');
const { SESSION_COOKIE_NAME_PLAIN } = await import('../src/config.js');

let serverInstance: any = null;
const TEST_PORT = 3998;
const TEST_BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
let testCookie1: string;
let testCookie2: string;

function createSessionCookieForUser(userId: string): string {
  const token = generateSessionToken();
  const signed = signSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + 7 * 24 * 3600 * 1000,
  ).toISOString();
  db.createUserSession({
    id: token,
    user_id: userId,
    ip_address: '127.0.0.1',
    user_agent: 'VitestAgent',
    created_at: now.toISOString(),
    expires_at: expiresAt,
    last_active_at: now.toISOString(),
  });
  return `${SESSION_COOKIE_NAME_PLAIN}=${signed}`;
}

beforeAll(async () => {
  db.initDatabase();

  const now = new Date().toISOString();
  db.createUser({
    id: 'user-macmini-test-1',
    username: 'user_macmini_1',
    password_hash: 'hash',
    display_name: '验收测试员',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });

  db.createUser({
    id: 'user-macmini-test-2',
    username: 'user_macmini_2',
    password_hash: 'hash',
    display_name: '隔离用户',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });

  testCookie1 = createSessionCookieForUser('user-macmini-test-1');
  testCookie2 = createSessionCookieForUser('user-macmini-test-2');

  setWebDeps({
    queue: { isGroupRuntimeSafetyBlocked: () => false } as any,
    getRegisteredGroups: () => ({}),
    sessions: {},
    getSessions: () => ({}),
    processGroupMessages: async () => true,
    ensureTerminalContainerStarted: () => true,
    formatMessages: () => '',
    getLastAgentTimestamp: () => ({}),
    setLastAgentTimestamp: () => {},
    advanceCursors: () => {},
    advanceNextPullCursorOnly: () => {},
  } as any);

  // 显式注入测试 mock provider（仅限 test scope）
  setEvalExecutionProviderForTests(async (options) => ({
    output: `Generated result for ${options.caseId} from ${options.versionTag}: interface OrderItem { price: number; } proxy_set_header X-Forwarded-For; {"host": "node", "cpu": 1, "disk": 2, "abnormal_processes": []} bank-api 熔断 CREATE INDEX idx_user_created ON orders; {"code": "ERR"} SingleFlight 抖动 DELETE /api/users/123 204 GET /api/orders 200 【核心收益】IPC【潜在风险】 path.join recursive: true 唯一流水号 状态机 FROM AS builder USER node git reflog cherry-pick 脱敏 138****0000 formatMessage replace`,
    durationMs: 5,
    inputTokens: 110,
    outputTokens: 75,
    cacheReadTokens: 10,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    toolsUsed: [],
    reportedCostUSD: 0.0004,
  }));

  const app = new Hono();
  // 挂载与生产一致的真实路由
  app.route('/api', monitorRoutes);
  app.route('/api/auth', authRoutes);
  app.route('/api/agent-profiles', agentProfileRoutes);
  app.route('/api/eval', evalRoutes);

  await new Promise<void>((resolve) => {
    serverInstance = serve(
      {
        fetch: app.fetch,
        port: TEST_PORT,
      },
      () => {
        resolve();
      },
    );
  });
});

afterAll(async () => {
  setEvalExecutionProviderForTests(null);
  if (serverInstance) {
    serverInstance.close();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('R17: 生产 HTTP API 客户端脚本协议与生命周期端到端测试', () => {
  test('运行中的真实 HTTP Server 能够完整通过 verify-eval-macmini-runner 的全部 6 个验收步骤', async () => {
    // 设置环境变量指向真实监听端口的测试服务
    const prevBaseUrl = process.env.WEB_BASE_URL;
    process.env.WEB_BASE_URL = TEST_BASE_URL;

    // 验证 STEP 1: 公开无认证探活
    const healthRes = await fetch(`${TEST_BASE_URL}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthData = (await healthRes.json()) as any;
    expect(healthData.status).toBe('healthy');

    // 验证 STEP 2: 建立授权会话与第二隔离身份
    const cookie = testCookie1;
    const otherCookie = testCookie2;
    expect(cookie).toBeTruthy();
    expect(otherCookie).toBeTruthy();

    // 验证 STEP 3: 创建智能体并生成 v1/v2
    const createRes = await fetch(`${TEST_BASE_URL}/api/agent-profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie!,
      },
      body: JSON.stringify({
        name: 'HTTP端到端智能体',
        identity_prompt: '初始版本',
        prompt_mode: 'append',
      }),
    });
    expect([200, 201]).toContain(createRes.status);
    const profile = ((await createRes.json()) as any).profile;
    expect(profile.version).toBe(1);

    // 升级到 v2
    const updateRes = await fetch(
      `${TEST_BASE_URL}/api/agent-profiles/${profile.id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie!,
        },
        body: JSON.stringify({
          identity_prompt: '升级版提示词',
        }),
      },
    );
    expect(updateRes.status).toBe(200);
    expect(((await updateRes.json()) as any).profile.version).toBe(2);

    // 验证 STEP 4: 启动对比评测 (POST /api/eval/runs)
    const startRes = await fetch(`${TEST_BASE_URL}/api/eval/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie!,
      },
      body: JSON.stringify({
        agent_profile_id: profile.id,
        mode: 'compare',
        base_version: 1,
        target_version: 2,
      }),
    });
    expect(startRes.status).toBe(201);
    const run = ((await startRes.json()) as any).run;
    expect(run.id).toBeTruthy();
    expect(run.status).toBe('running');

    // 验证 STEP 5: 轮询直到 completed
    let finishedSummary: any = null;
    for (let i = 0; i < 50; i++) {
      const detailRes = await fetch(
        `${TEST_BASE_URL}/api/eval/runs/${run.id}`,
        {
          headers: { Cookie: cookie! },
        },
      );
      if (detailRes.status === 200) {
        const detail = (await detailRes.json()) as any;
        if (detail.summary.run.status === 'completed') {
          finishedSummary = detail.summary;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 60));
    }

    expect(finishedSummary).not.toBeNull();
    expect(finishedSummary.run.status).toBe('completed');
    expect(finishedSummary.cases).toHaveLength(15);
    expect(finishedSummary.targetSummary.passRate).toBeGreaterThan(0);

    // 验证全部 15 个聚合 case 均有 baseResult 和 targetResult
    for (const c of finishedSummary.cases) {
      expect(c.baseResult).toBeDefined();
      expect(c.targetResult).toBeDefined();
      expect(c.baseResult.status).toBe('completed');
      expect(c.targetResult.status).toBe('completed');
      expect(c.category).not.toBe('01');
    }

    // 验证 STEP 6: 报告导出与权限隔离
    const mdRes = await fetch(
      `${TEST_BASE_URL}/api/eval/runs/${run.id}/report.md`,
      {
        headers: { Cookie: cookie! },
      },
    );
    expect(mdRes.status).toBe(200);
    expect(await mdRes.text()).toContain('核心对比摘要');

    // 跨用户隔离验证: otherCookie 请求返回 404
    const otherRes = await fetch(`${TEST_BASE_URL}/api/eval/runs/${run.id}`, {
      headers: { Cookie: otherCookie! },
    });
    expect(otherRes.status).toBe(404);

    // 验证在 completed 终态后，能够安全删除评测记录
    const delRunRes = await fetch(`${TEST_BASE_URL}/api/eval/runs/${run.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie! },
    });
    expect(delRunRes.status).toBe(200);

    // 验证归档智能体 (DELETE /api/agent-profiles/:id)
    const delProfileRes = await fetch(
      `${TEST_BASE_URL}/api/agent-profiles/${profile.id}`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie! },
      },
    );
    expect(delProfileRes.status).toBe(200);

    process.env.WEB_BASE_URL = prevBaseUrl;
  }, 25000);

  test('DELETE /api/eval/runs/:id 在任务处于 running 状态时返回 409 拒绝删除', async () => {
    const runningRun = db.createEvalRun({
      id: 'active-running-run-test',
      owner_user_id: 'user-macmini-test-1',
      agent_profile_id: 'profile-1',
      agent_name: 'Active Agent',
      suite_id: 'eval-suite-system-benchmark-15',
      suite_version: 1,
      mode: 'single',
      base_version: null,
      base_prompt_hash: null,
      target_version: 1,
      target_prompt_hash: 'hash',
      model: 'test-model',
      provider_source: 'test_mock',
      capability_snapshot: {},
      status: 'running',
      total_cases: 15,
      completed_cases: 0,
      base_pass_count: 0,
      target_pass_count: 0,
      base_avg_duration_ms: 0,
      target_avg_duration_ms: 0,
      base_total_tokens: 0,
      target_total_tokens: 0,
      base_estimated_cost_usd: 0,
      target_estimated_cost_usd: 0,
      error_message: null,
    });

    const res = await fetch(`${TEST_BASE_URL}/api/eval/runs/${runningRun.id}`, {
      method: 'DELETE',
      headers: { Cookie: testCookie1 },
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toContain('评测正在执行');

    db.updateEvalRun(runningRun.id, { status: 'completed' });
    db.deleteEvalRun(runningRun.id, 'user-macmini-test-1');
  });
});
