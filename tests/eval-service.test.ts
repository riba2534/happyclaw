import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-service-test-'));
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
  ASSISTANT_NAME: 'HappyClaw Eval Test',
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const db = await import('../src/db.js');
const {
  evaluateOutputAgainstRules,
  startEvalRun,
  cancelEvalRun,
  getEvalRunSummary,
  generateEvalMarkdownReport,
  generateEvalJsonReport,
  submitCaseFeedback,
  setEvalExecutionProviderForTests,
  waitForEvalRunCompletion,
} = await import('../src/eval-service.js');
const { BUILTIN_EVAL_CASES, SYSTEM_EVAL_SUITE_ID } =
  await import('../src/eval-builtin-suite.js');

/**
 * Explicit test-only execution provider to simulate deterministic tool and model outputs.
 * Never available in production code paths.
 */
function createTestMockProvider() {
  return async (options: {
    prompt: string;
    systemPrompt: string;
    model: string;
    cwd: string;
    abortSignal?: AbortSignal;
    caseId: string;
    versionTag: 'base' | 'target' | 'single';
  }) => {
    if (options.abortSignal?.aborted) {
      throw new Error('Eval execution aborted');
    }

    const isTarget = options.versionTag === 'target';
    let output = '';

    switch (options.caseId) {
      case 'eval-case-01-refactor-boundary':
        output = isTarget
          ? 'interface OrderItem { price: number; count: number; }\nexport function calcTotal(items: OrderItem[]): number { return items.reduce((a, b) => a + b.price * b.count, 0); }'
          : 'function calcTotal(items: any[]) { return items.length; }';
        break;
      case 'eval-case-02-nginx-sec':
        output =
          'proxy_set_header X-Forwarded-For $remote_addr; client_max_body_size 20M;';
        break;
      case 'eval-case-03-json-extract':
        output = JSON.stringify({
          host: 'node-prod-03',
          cpu: '18.5%',
          disk: '380GB',
          abnormal_processes: ['zombie-worker'],
        });
        break;
      case 'eval-case-04-log-root-cause':
        output =
          '底层 bank-api 超时，引起 order-service 重试风暴，建议引入熔断降级。';
        break;
      case 'eval-case-05-sql-optimize':
        output =
          'CREATE INDEX idx_user_created ON orders (user_id, created_at DESC); LIMIT 500000, 20';
        break;
      case 'eval-case-06-api-validation':
        output =
          '校验 username 与 password 以及 phone (13800000000)。{"code": "ERR_VALIDATION", "message": "fail"}';
        break;
      case 'eval-case-07-concurrency-race':
        output =
          '在高并发热点缓存击穿时，利用 SingleFlight 或互斥锁控制单个穿透，并引入随机抖动 Jitter。';
        break;
      case 'eval-case-08-restful-standards':
        output = 'DELETE /api/users/123 返回 204。GET /api/orders 返回 200。';
        break;
      case 'eval-case-09-doc-summary':
        output =
          '【核心收益】长连接隔离，平滑重启，内存降低30%。【潜在风险】IPC跨层延迟增加，排障链路变长。';
        break;
      case 'eval-case-10-cross-platform':
        output =
          'const path = require("node:path"); path.join(dir, file); fs.mkdirSync(dir, { recursive: true });';
        break;
      case 'eval-case-11-payment-idempotency':
        output =
          '基于唯一流水号索引与状态机校验，在数据库事务提交后释放锁以保证幂等。';
        break;
      case 'eval-case-12-dockerfile-multistage':
        output =
          'FROM node:20 AS builder\nRUN npm run build\nFROM node:20 AS runner\nUSER node\nENV NODE_ENV=production';
        break;
      case 'eval-case-13-git-recovery':
        output =
          '使用 git reflog 查找丢失的 HEAD@{1}，通过 git cherry-pick 恢复。';
        break;
      case 'eval-case-14-privacy-masking':
        output =
          '明文打印严重违规合规要求，必须脱敏掩码：138****0000，身份证号加*脱敏。';
        break;
      case 'eval-case-15-i18n-format':
        output =
          'export function formatMessage(template: string, params?: Record<string, unknown>): string { return template.replace(/\\{(\\w+)\\}/g, ""); }';
        break;
      default:
        output = `Executed case ${options.caseId}`;
    }

    return {
      output,
      durationMs: 5,
      inputTokens: 120,
      outputTokens: 80,
      cacheReadTokens: 15,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      toolsUsed: [{ name: 'read_file', count: 1 }],
      reportedCostUSD: 0.0005,
    };
  };
}

beforeAll(() => {
  db.initDatabase();
  setEvalExecutionProviderForTests(createTestMockProvider());
});

afterAll(() => {
  setEvalExecutionProviderForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedUser(id: string): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

describe('R17: 提示词版本任务评测核心服务 (eval-service)', () => {
  describe('规则判定引擎 evaluateOutputAgainstRules (Hard Gates 门禁)', () => {
    test('全部硬门禁满足时正确裁决通过', () => {
      const output =
        'interface User { id: number; } export function test(): number { return 1; }';
      const outcome = evaluateOutputAgainstRules(output, {
        requiredKeywords: ['interface', 'number'],
        passThreshold: 70,
      });

      expect(outcome.verdict).toBe('pass');
      expect(outcome.score).toBe(100);
      expect(outcome.details.failedHardGates).toBeUndefined();
      expect(outcome.details.gateExplanation).toContain('均已通过');
    });

    test('缺失必需关键词时硬门禁一票否决 (必判 fail)', () => {
      const output = 'const a = 1;';
      const outcome = evaluateOutputAgainstRules(output, {
        requiredKeywords: ['interface', 'export'],
        passThreshold: 70,
      });

      expect(outcome.verdict).toBe('fail');
      expect(outcome.details.failedHardGates).toBeDefined();
      expect(
        outcome.details.failedHardGates?.some((g) =>
          g.includes('缺失必需关键词'),
        ),
      ).toBe(true);
    });

    test('包含违禁词时直接一票否决 (必判 fail)', () => {
      const output = 'interface Foo { bar: any; }';
      const outcome = evaluateOutputAgainstRules(output, {
        requiredKeywords: ['interface'],
        forbiddenKeywords: ['any'],
        passThreshold: 60,
      });

      expect(outcome.verdict).toBe('fail');
      expect(outcome.details.matchedForbidden).toContain('any');
      expect(
        outcome.details.failedHardGates?.some((g) =>
          g.includes('命中违禁内容'),
        ),
      ).toBe(true);
    });

    test('JSON 顶层为 primitive 或 array 时硬门禁拦截', () => {
      const arrayJson = '[1, 2, 3]';
      const outcome = evaluateOutputAgainstRules(arrayJson, {
        requireJson: true,
      });

      expect(outcome.verdict).toBe('fail');
      expect(
        outcome.details.failedHardGates?.some((g) => g.includes('Object 字典')),
      ).toBe(true);
    });

    test('JSON 缺失必需键时安全拦截且不抛 TypeError', () => {
      const jsonStr = '{"host": "prod-1"}';
      const outcome = evaluateOutputAgainstRules(jsonStr, {
        requireJson: true,
        requiredJsonKeys: ['host', 'cpu', 'disk'],
      });

      expect(outcome.verdict).toBe('fail');
      expect(outcome.details.missingJsonKeys).toEqual(['cpu', 'disk']);
      expect(
        outcome.details.failedHardGates?.some((g) =>
          g.includes('JSON 缺失必需键'),
        ),
      ).toBe(true);
    });

    test('防 ReDoS 安全检查：检测超长或危险灾难性回溯模式', () => {
      const outcome = evaluateOutputAgainstRules('test text', {
        regexPatterns: ['(a+)+b'], // 典型灾难性回溯 pattern
      });

      expect(outcome.verdict).toBe('fail');
      expect(outcome.details.failedRegex).toContain('(a+)+b');
      expect(outcome.details.reasons?.some((r) => r.includes('ReDoS'))).toBe(
        true,
      );
    });
  });

  describe('内置典型基准案例集 (15条脱敏任务)', () => {
    test('自动初始化 15 个脱敏典型工程任务与确定性验收条件', () => {
      expect(BUILTIN_EVAL_CASES).toHaveLength(15);
      const categories = new Set(BUILTIN_EVAL_CASES.map((c) => c.category));
      expect(categories).toContain('code');
      expect(categories).toContain('ops');
      expect(categories).toContain('data');
      expect(categories).toContain('security');
      expect(categories).toContain('architecture');
      expect(categories).toContain('doc');
      expect(categories).toContain('tooling');
      expect(categories).toContain('i18n');
    });

    test('DB 中能够检索到系统内置基准集与 15 个完整案例', () => {
      const suites = db.listEvalSuites('user-eval-a');
      const builtin = suites.find((s) => s.id === SYSTEM_EVAL_SUITE_ID);
      expect(builtin).toBeDefined();
      expect(builtin?.is_system).toBe(true);
      expect(builtin?.case_count).toBe(15);

      const suiteWithCases = db.getEvalSuiteWithCases(SYSTEM_EVAL_SUITE_ID);
      expect(suiteWithCases?.cases).toHaveLength(15);
    });
  });

  describe('版本严格校验与快照锁定', () => {
    const userId = 'eval-strict-ver-user';

    beforeAll(() => {
      seedUser(userId);
    });

    test('target_version 不存在时必须明确拒绝 (杜绝静默 fallback)', async () => {
      const profile = db.createAgentProfile({
        ownerUserId: userId,
        name: '版本测试智能体',
        identityPrompt: '测试版本校验',
        promptMode: 'append',
      });

      await expect(
        startEvalRun({
          ownerUserId: userId,
          agentProfileId: profile.id,
          mode: 'single',
          targetVersion: 999, // 不存在的版本
        }),
      ).rejects.toThrow('目标提示词版本 v999 不存在');
    });

    test('base_version 不存在时必须明确拒绝 (杜绝空 prompt 冒充)', async () => {
      const profile = db.createAgentProfile({
        ownerUserId: userId,
        name: '对比版本测试智能体',
        identityPrompt: '测试对比版本',
        promptMode: 'append',
      });

      await expect(
        startEvalRun({
          ownerUserId: userId,
          agentProfileId: profile.id,
          mode: 'compare',
          baseVersion: 999, // 不存在的基准版本
          targetVersion: 1,
        }),
      ).rejects.toThrow('基准提示词版本 v999 不存在');
    });

    test('未配置有效 Provider 凭据且未显式注入测试替身时必须拒绝启动 (无 Fake 兜底)', async () => {
      const profile = db.createAgentProfile({
        ownerUserId: userId,
        name: '无凭据智能体',
        identityPrompt: '测试凭据校验',
        promptMode: 'append',
      });

      // 临时移除测试注入
      setEvalExecutionProviderForTests(null);

      await expect(
        startEvalRun({
          ownerUserId: userId,
          agentProfileId: profile.id,
          mode: 'single',
          targetVersion: 1,
        }),
      ).rejects.toThrow();

      // 恢复测试注入
      setEvalExecutionProviderForTests(createTestMockProvider());
    });
  });

  describe('评测执行生命周期与双版本对比 (startEvalRun & Summary)', () => {
    const userId = 'eval-test-user-01';

    beforeAll(() => {
      seedUser(userId);
    });

    test('执行双版本对比评测，验证真实快照持久化与指标汇总', async () => {
      // 1. 创建 AgentProfile v1
      const profile = db.createAgentProfile({
        ownerUserId: userId,
        name: '代码与架构助手',
        identityPrompt: '你是一名经验丰富的全栈工程师。',
        soulPrompt: '追求代码质量与边界防守。',
        agentsPrompt: '优先重构边界缺陷，保证输出结构规范。',
        toolsPrompt: '无特殊限制。',
        promptMode: 'append',
      });
      expect(profile.version).toBe(1);

      // 2. 更新生成 v2
      const profileV2 = db.updateAgentProfile(profile.id, userId, {
        identityPrompt:
          '你是一名资深全栈工程师，执行严格防守性重构与安全加固。',
        agentsPrompt:
          '必须处理 null/undefined 边界，使用标准 TypeScript 接口，输出规范 JSON。',
      });
      expect(profileV2?.version).toBe(2);

      // 3. 触发评测运行
      const run = await startEvalRun({
        ownerUserId: userId,
        agentProfileId: profile.id,
        baseVersion: 1,
        targetVersion: 2,
        mode: 'compare',
      });

      expect(run.id).toBeDefined();
      expect(run.provider_source).toBe('test_mock'); // 明确标识测试注入
      expect(run.status).toBe('running');

      // 等待执行完成
      const finishedRun = await waitForEvalRunCompletion(run.id, 10000);
      expect(finishedRun?.status).toBe('completed');
      expect(finishedRun?.completed_cases).toBe(15);
      expect(finishedRun?.target_pass_count).toBeGreaterThan(0);
      expect(finishedRun?.target_estimated_cost_usd).toBeGreaterThan(0);

      // 4. 验证案例快照持久化
      const runCases = db.listEvalRunCases(run.id);
      expect(runCases.length).toBe(30); // 15 base + 15 target
      for (const rc of runCases) {
        expect(rc.actual_output.length).toBeGreaterThan(0);
        expect(rc.status).toBe('completed');
      }

      // 5. 验证对比指标与 Delta 分析
      const summary = getEvalRunSummary(run.id, userId);
      expect(summary).not.toBeNull();
      expect(summary?.run.id).toBe(run.id);
      expect(summary?.baseSummary?.version).toBe(1);
      expect(summary?.targetSummary.version).toBe(2);
      expect(summary?.delta).toBeDefined();
    }, 20000);

    test('运行取消控制：能够在执行过程中终止任务', async () => {
      const profile = db.listAgentProfilesForUser(userId)[0];

      // 设置慢速 provider 测试取消
      setEvalExecutionProviderForTests(async ({ abortSignal }) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
          });
        });
        return {
          output: 'slow output',
          durationMs: 500,
          inputTokens: 100,
          outputTokens: 50,
          toolsUsed: [],
        };
      });

      const slowRun = await startEvalRun({
        ownerUserId: userId,
        agentProfileId: profile.id,
        mode: 'single',
      });

      expect(slowRun.status).toBe('running');

      const cancelOk = cancelEvalRun(slowRun.id, userId);
      expect(cancelOk).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));
      const afterCancel = db.getEvalRun(slowRun.id, userId);
      expect(afterCancel?.status).toBe('cancelled');

      // 恢复常规 testMockProvider
      setEvalExecutionProviderForTests(createTestMockProvider());
    });
  });

  describe('服务重启与孤儿 running 状态恢复 (recoverDanglingEvalRuns)', () => {
    test('系统启动时自动将未完成的 running 评测转为 interrupted 终态', () => {
      const runId = 'dangling-test-run-1';
      db.createEvalRun({
        id: runId,
        owner_user_id: 'user-dangling',
        agent_profile_id: 'profile-dangling',
        agent_name: 'Dangling Agent',
        suite_id: SYSTEM_EVAL_SUITE_ID,
        suite_version: 1,
        mode: 'single',
        base_version: null,
        base_prompt_hash: null,
        target_version: 1,
        target_prompt_hash: 'hash',
        model: 'test-model',
        provider_source: 'test_mock',
        capability_snapshot: {},
        status: 'running', // 模拟崩溃前留在 running
        total_cases: 15,
        completed_cases: 3,
        base_pass_count: 0,
        target_pass_count: 3,
        base_avg_duration_ms: 0,
        target_avg_duration_ms: 10,
        base_total_tokens: 0,
        target_total_tokens: 300,
        base_estimated_cost_usd: 0,
        target_estimated_cost_usd: 0.001,
        error_message: null,
      });

      // 执行恢复
      const result = db.recoverDanglingEvalRuns();
      expect(result.recoveredRuns).toBeGreaterThanOrEqual(1);

      const recovered = db.getEvalRun(runId);
      expect(recovered?.status).toBe('interrupted');
      expect(recovered?.error_message).toContain('服务重启');
      expect(recovered?.completed_at).toBeTruthy();
    });
  });

  describe('效果报告生成 (Markdown & JSON)', () => {
    const userId = 'eval-report-user';

    beforeAll(() => {
      seedUser(userId);
    });

    test('生成包含元数据、对比表格和明细的完整 Markdown 报告', async () => {
      const profile = db.createAgentProfile({
        ownerUserId: userId,
        name: '报表评测智能体',
        identityPrompt: '测试报告生成',
        promptMode: 'append',
      });

      const run = await startEvalRun({
        ownerUserId: userId,
        agentProfileId: profile.id,
        mode: 'compare',
        baseVersion: 1,
        targetVersion: 1,
      });

      await waitForEvalRunCompletion(run.id, 10000);

      const mdReport = generateEvalMarkdownReport(run.id, userId);
      expect(mdReport).not.toBeNull();
      expect(mdReport).toContain('# HappyClaw 提示词版本评测与效果验证报告');
      expect(mdReport).toContain(run.id);
      expect(mdReport).toContain('报表评测智能体');
      expect(mdReport).toContain('核心对比摘要');
      expect(mdReport).toContain('通过率 (Pass Rate)');
      expect(mdReport).toContain('eval-case-01-refactor-boundary');
      expect(mdReport).toContain('估算成本');

      const jsonReport = generateEvalJsonReport(run.id, userId);
      expect(jsonReport).not.toBeNull();
      expect((jsonReport as any).run.id).toBe(run.id);
      expect((jsonReport as any).cases.length).toBe(15);
    }, 20000);
  });

  describe('人工反馈与权限隔离 (Human Feedback & ACL)', () => {
    const userId = 'eval-feedback-user';

    beforeAll(() => {
      seedUser(userId);
    });

    test('录入人工采纳、驳回和缺陷批注', async () => {
      const profile = db.createAgentProfile({
        ownerUserId: userId,
        name: '反馈测试智能体',
        identityPrompt: '测试人工反馈',
        promptMode: 'append',
      });

      const run = await startEvalRun({
        ownerUserId: userId,
        agentProfileId: profile.id,
        mode: 'single',
      });

      await waitForEvalRunCompletion(run.id, 10000);

      const runCases = db.listEvalRunCases(run.id);
      expect(runCases.length).toBeGreaterThan(0);

      const targetCase = runCases[0];
      expect(targetCase.human_feedback).toBeNull();

      // 录入采纳反馈
      const updated = submitCaseFeedback({
        caseRunId: targetCase.id,
        ownerUserId: userId,
        feedback: 'accepted',
        notes: '重构很规范，符合工程防守标准',
      });

      expect(updated).not.toBeNull();
      expect(updated?.human_feedback).toBe('accepted');
      expect(updated?.human_notes).toBe('重构很规范，符合工程防守标准');

      const refreshed = db.getEvalRunCase(targetCase.id);
      expect(refreshed?.human_feedback).toBe('accepted');
      expect(refreshed?.human_notes).toBe('重构很规范，符合工程防守标准');
    }, 20000);

    test('权限隔离：跨用户无法修改或访问他人评测', () => {
      seedUser('eval-other-user');
      const profile = db.createAgentProfile({
        ownerUserId: userId,
        name: '隔离测试智能体',
        identityPrompt: '隔离测试',
        promptMode: 'append',
      });

      const run = db.createEvalRun({
        id: 'eval-run-isolated-test-2',
        owner_user_id: userId,
        agent_profile_id: profile.id,
        agent_name: profile.name,
        suite_id: SYSTEM_EVAL_SUITE_ID,
        suite_version: 1,
        mode: 'single',
        base_version: null,
        base_prompt_hash: null,
        target_version: 1,
        target_prompt_hash: 'hash',
        model: 'test-model',
        provider_source: 'test_mock',
        capability_snapshot: {},
        status: 'completed',
        total_cases: 1,
        completed_cases: 1,
        base_pass_count: 0,
        target_pass_count: 1,
        base_avg_duration_ms: 0,
        target_avg_duration_ms: 100,
        base_total_tokens: 0,
        target_total_tokens: 200,
        base_estimated_cost_usd: 0,
        target_estimated_cost_usd: 0.001,
        error_message: null,
      });

      const runCase = db.createEvalRunCase({
        id: 'eval-rcase-isolated-test-2',
        run_id: run.id,
        case_id: 'case-1',
        case_name: 'case-1',
        version_tag: 'target',
        prompt_version: 1,
        prompt_hash: 'hash',
        status: 'completed',
        actual_output: 'output',
        auto_score: 90,
        auto_verdict: 'pass',
        eval_details: {},
        duration_ms: 100,
        tokens_input: 100,
        tokens_output: 100,
        tokens_total: 200,
        estimated_cost_usd: 0.001,
        tools_used: [],
        human_feedback: null,
        human_notes: null,
        error_message: null,
      });

      // other-user 查询不到该 run
      expect(db.getEvalRun(run.id, 'eval-other-user')).toBeNull();

      // other-user 无法提交反馈
      const feedbackAttempt = submitCaseFeedback({
        caseRunId: runCase.id,
        ownerUserId: 'eval-other-user',
        feedback: 'rejected',
        notes: 'hacked',
      });
      expect(feedbackAttempt).toBeNull();
    });
  });
});
