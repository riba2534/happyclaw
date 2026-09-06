import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-routes-test-'));
const tmpDataDir = path.join(tmpDir, 'data');
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });
fs.mkdirSync(tmpDataDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
  DATA_DIR: tmpDataDir,
  ASSISTANT_NAME: 'HappyClaw Eval Routes Test',
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

let mockUserId = 'route-test-user-1';

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const unauthHeader = c.req.header('x-unauth');
    if (unauthHeader === '1') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const customUser = c.req.header('x-user-id') || mockUserId;
    c.set('user', {
      id: customUser,
      username: customUser,
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const { evalRoutes } = await import('../src/routes/eval.js');
const { waitForEvalRunCompletion, setEvalExecutionProviderForTests } =
  await import('../src/eval-service.js');
const { SYSTEM_EVAL_SUITE_ID } = await import('../src/eval-builtin-suite.js');

const app = new Hono();
app.route('/api/eval', evalRoutes);

beforeAll(() => {
  db.initDatabase();
  setEvalExecutionProviderForTests(async (options) => ({
    output: `Test output for ${options.caseId} from ${options.versionTag}: interface OrderItem { price: number; } proxy_set_header X-Forwarded-For; {"host": "node", "cpu": 1, "disk": 2, "abnormal_processes": []} bank-api 熔断 CREATE INDEX idx_user_created ON orders; {"code": "ERR"} SingleFlight 抖动 DELETE /api/users/123 204 GET /api/orders 200 【核心收益】IPC【潜在风险】 path.join recursive: true 唯一流水号 状态机 FROM AS builder USER node git reflog cherry-pick 脱敏 138****0000 formatMessage replace`,
    durationMs: 5,
    inputTokens: 100,
    outputTokens: 80,
    cacheReadTokens: 10,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    toolsUsed: [],
    reportedCostUSD: 0.0004,
  }));

  db.createUser({
    id: 'route-test-user-1',
    username: 'route-test-user-1',
    password_hash: 'hash',
    display_name: 'Test User 1',
    role: 'member',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    must_change_password: false,
  });

  db.createUser({
    id: 'route-test-user-2',
    username: 'route-test-user-2',
    password_hash: 'hash',
    display_name: 'Test User 2',
    role: 'member',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    must_change_password: false,
  });
});

afterAll(() => {
  setEvalExecutionProviderForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('R17: 提示词评测与基准 API 路由 (eval routes)', () => {
  describe('认证与评测集管理 (Suites & Cases)', () => {
    test('未认证请求返回 401', async () => {
      const res = await app.request('/api/eval/suites', {
        headers: { 'x-unauth': '1' },
      });
      expect(res.status).toBe(401);
    });

    test('列出评测集包含系统内置基准集 (15案例)', async () => {
      const res = await app.request('/api/eval/suites');
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(Array.isArray(data.suites)).toBe(true);

      const builtin = data.suites.find(
        (s: any) => s.id === SYSTEM_EVAL_SUITE_ID,
      );
      expect(builtin).toBeDefined();
      expect(builtin.is_system).toBe(true);
      expect(builtin.case_count).toBe(15);
    });

    test('获取内置评测集详情包含 15 条完整案例', async () => {
      const res = await app.request(`/api/eval/suites/${SYSTEM_EVAL_SUITE_ID}`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.suite.id).toBe(SYSTEM_EVAL_SUITE_ID);
      expect(data.suite.cases).toHaveLength(15);
      expect(data.suite.cases[0].input_prompt).toBeTruthy();
    });

    test('创建与编辑自定义评测集', async () => {
      // 1. 创建自定义 suite
      const createRes = await app.request('/api/eval/suites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '前端专有评测集',
          description: '针对 UI/UX 与 React 组件的专属评测',
        }),
      });
      expect(createRes.status).toBe(201);
      const createdSuite = ((await createRes.json()) as any).suite;
      expect(createdSuite.name).toBe('前端专有评测集');
      expect(createdSuite.is_system).toBe(false);

      // 2. 向自定义 suite 添加 case
      const addCaseRes = await app.request(
        `/api/eval/suites/${createdSuite.id}/cases`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'React 自定义 Hook 性能测试',
            category: 'frontend',
            input_prompt: '请编写一个利用 useCallback 防抖的自定义 hook',
            expected_output: '返回 useDebounceCallback 实现',
            eval_rules: { requiredKeywords: ['useCallback', 'useRef'] },
          }),
        },
      );
      expect(addCaseRes.status).toBe(201);
      const createdCase = ((await addCaseRes.json()) as any).case;
      expect(createdCase.name).toBe('React 自定义 Hook 性能测试');

      // 3. 修改该 case
      const editCaseRes = await app.request(
        `/api/eval/suites/${createdSuite.id}/cases/${createdCase.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'React 防抖 Hook 重构与内存泄漏防范',
          }),
        },
      );
      expect(editCaseRes.status).toBe(200);
      const updatedCase = ((await editCaseRes.json()) as any).case;
      expect(updatedCase.name).toBe('React 防抖 Hook 重构与内存泄漏防范');

      // 4. 系统内置集禁止修改或添加 case
      const forbiddenAdd = await app.request(
        `/api/eval/suites/${SYSTEM_EVAL_SUITE_ID}/cases`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: '非法注入案例',
            input_prompt: 'test',
          }),
        },
      );
      expect(forbiddenAdd.status).toBe(403);
    });
  });

  describe('评测执行、报告导出与人工反馈 API', () => {
    let agentId: string;
    let runId: string;

    beforeAll(() => {
      const profile = db.createAgentProfile({
        ownerUserId: mockUserId,
        name: 'API评测智能体',
        identityPrompt: '全栈专家',
        promptMode: 'append',
      });
      agentId = profile.id;
    });

    test('POST /api/eval/runs 启动对比评测', async () => {
      const res = await app.request('/api/eval/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_profile_id: agentId,
          mode: 'compare',
          base_version: 1,
          target_version: 1,
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.run).toBeDefined();
      expect(data.run.agent_profile_id).toBe(agentId);
      expect(data.run.status).toBe('running');
      runId = data.run.id;

      // 等待异步执行完毕
      await waitForEvalRunCompletion(runId);
    });

    test('GET /api/eval/runs/:id 获取运行详情与对比分析', async () => {
      const res = await app.request(`/api/eval/runs/${runId}`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.summary).toBeDefined();
      expect(data.summary.run.status).toBe('completed');
      expect(data.summary.cases).toHaveLength(15);
      expect(data.summary.targetSummary.passRate).toBeDefined();
    });

    test('GET /api/eval/runs/:id/report.md 下载 Markdown 报告', async () => {
      const res = await app.request(`/api/eval/runs/${runId}/report.md`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/markdown');
      expect(res.headers.get('Content-Disposition')).toContain('attachment');
      const text = await res.text();
      expect(text).toContain('# HappyClaw 提示词版本评测与效果验证报告');
      expect(text).toContain(runId);
      expect(text).toContain('API评测智能体');
      expect(text).toContain('通过率 (Pass Rate)');
    });

    test('GET /api/eval/runs/:id/report.json 下载 JSON 格式完整数据', async () => {
      const res = await app.request(`/api/eval/runs/${runId}/report.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      expect(res.headers.get('Content-Disposition')).toContain('attachment');
      const json = (await res.json()) as any;
      expect(json.run.id).toBe(runId);
      expect(json.cases).toHaveLength(15);
    });

    test('POST /api/eval/cases/:caseRunId/feedback 提交人工反馈', async () => {
      const runCases = db.listEvalRunCases(runId);
      expect(runCases.length).toBeGreaterThan(0);
      const targetCaseRun = runCases[0];

      const res = await app.request(
        `/api/eval/cases/${targetCaseRun.id}/feedback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedback: 'accepted',
            notes: '人工审核通过，无格式偏差',
          }),
        },
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.case.human_feedback).toBe('accepted');
      expect(data.case.human_notes).toBe('人工审核通过，无格式偏差');
    });

    test('POST /api/eval/runs/:id/cancel 取消评测接口', async () => {
      // 启动一个单版本运行
      const startRes = await app.request('/api/eval/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_profile_id: agentId,
          mode: 'single',
        }),
      });
      const newRunId = ((await startRes.json()) as any).run.id;

      const cancelRes = await app.request(`/api/eval/runs/${newRunId}/cancel`, {
        method: 'POST',
      });
      expect([200, 400]).toContain(cancelRes.status);
    });

    test('权限隔离：用户 2 无法获取或修改用户 1 的评测', async () => {
      // 用户 2 读取用户 1 的评测运行返回 404
      const res = await app.request(`/api/eval/runs/${runId}`, {
        headers: { 'x-user-id': 'route-test-user-2' },
      });
      expect(res.status).toBe(404);

      // 用户 2 下载用户 1 的评测报告返回 404
      const reportRes = await app.request(`/api/eval/runs/${runId}/report.md`, {
        headers: { 'x-user-id': 'route-test-user-2' },
      });
      expect(reportRes.status).toBe(404);

      // 用户 2 尝试为用户 1 的评测录入反馈返回 404
      const runCases = db.listEvalRunCases(runId);
      const fbRes = await app.request(
        `/api/eval/cases/${runCases[0].id}/feedback`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-id': 'route-test-user-2',
          },
          body: JSON.stringify({
            feedback: 'rejected',
            notes: 'attacker note',
          }),
        },
      );
      expect(fbRes.status).toBe(404);
    });
  });
});
