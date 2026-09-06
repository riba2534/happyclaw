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
  setEvalExecutionProvider,
  waitForEvalRunCompletion,
} = await import('../src/eval-service.js');
const { BUILTIN_EVAL_CASES, SYSTEM_EVAL_SUITE_ID } =
  await import('../src/eval-builtin-suite.js');

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
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
  describe('规则判定引擎 evaluateOutputAgainstRules', () => {
    test('正确判定必需关键词与及格通过', () => {
      const output =
        'interface User { id: number; } export function test(): number { return 1; }';
      const outcome = evaluateOutputAgainstRules(output, {
        requiredKeywords: ['interface', 'number'],
        passThreshold: 70,
      });

      expect(outcome.verdict).toBe('pass');
      expect(outcome.score).toBe(100);
      expect(outcome.details.matchedKeywords).toEqual(['interface', 'number']);
      expect(outcome.details.missingKeywords).toEqual([]);
    });

    test('缺失关键约束时扣分并给出具体原因', () => {
      const output = 'const a = 1;';
      const outcome = evaluateOutputAgainstRules(output, {
        requiredKeywords: ['interface', 'export'],
        passThreshold: 70,
      });

      expect(outcome.verdict).toBe('fail');
      expect(outcome.score).toBeLessThan(70);
      expect(outcome.details.missingKeywords).toContain('interface');
      expect(outcome.details.missingKeywords).toContain('export');
      expect(
        outcome.details.reasons?.some((r) => r.includes('缺失必需关键词')),
      ).toBe(true);
    });

    test('包含违禁词时直接判为 fail', () => {
      const output = 'interface Foo { bar: any; }';
      const outcome = evaluateOutputAgainstRules(output, {
        requiredKeywords: ['interface'],
        forbiddenKeywords: ['any'],
        passThreshold: 60,
      });

      expect(outcome.verdict).toBe('fail');
      expect(outcome.details.matchedForbidden).toContain('any');
      expect(
        outcome.details.reasons?.some((r) => r.includes('包含违规/禁止内容')),
      ).toBe(true);
    });

    test('正则表达式匹配校验', () => {
      const output = 'CREATE INDEX idx_user_id ON users(user_id);';
      const outcome = evaluateOutputAgainstRules(output, {
        regexPatterns: ['CREATE\\s+INDEX', 'ON\\s+users'],
        passThreshold: 70,
      });

      expect(outcome.verdict).toBe('pass');
      expect(outcome.details.matchedRegex).toHaveLength(2);
      expect(outcome.details.failedRegex).toHaveLength(0);
    });

    test('有效 JSON 与必需 JSON 键校验', () => {
      const validJsonOutput =
        '```json\n{"host": "prod-1", "cpu": 12, "disk": 40}\n```';
      const passOutcome = evaluateOutputAgainstRules(validJsonOutput, {
        requireJson: true,
        requiredJsonKeys: ['host', 'cpu', 'disk'],
        passThreshold: 70,
      });

      expect(passOutcome.verdict).toBe('pass');
      expect(passOutcome.details.jsonValid).toBe(true);
      expect(passOutcome.details.missingJsonKeys).toEqual([]);

      const invalidJsonOutput = '非JSON纯文本响应';
      const failOutcome = evaluateOutputAgainstRules(invalidJsonOutput, {
        requireJson: true,
        passThreshold: 70,
      });

      expect(failOutcome.verdict).toBe('fail');
      expect(failOutcome.details.jsonValid).toBe(false);
      expect(
        failOutcome.details.reasons?.some((r) => r.includes('合法的 JSON')),
      ).toBe(true);
    });

    test('长度区间限制校验', () => {
      const shortOutput = 'too short';
      const outcome = evaluateOutputAgainstRules(shortOutput, {
        minLength: 50,
      });

      expect(outcome.details.lengthValid).toBe(false);
      expect(outcome.details.reasons?.some((r) => r.includes('内容过短'))).toBe(
        true,
      );
    });
  });

  describe('内置典型基准案例集 (15条脱敏任务)', () => {
    test('自动初始化 15 个脱敏典型工程任务', () => {
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

      for (const c of BUILTIN_EVAL_CASES) {
        expect(c.input_prompt.length).toBeGreaterThan(20);
        expect(c.expected_output.length).toBeGreaterThan(10);
        expect(c.timeout_ms).toBeGreaterThanOrEqual(1000);
      }
    });

    test('DB 中能够检索到内置系统评测集与全部案例', () => {
      const suites = db.listEvalSuites('user-eval-a');
      const builtin = suites.find((s) => s.id === SYSTEM_EVAL_SUITE_ID);
      expect(builtin).toBeDefined();
      expect(builtin?.is_system).toBe(true);
      expect(builtin?.case_count).toBe(15);

      const suiteWithCases = db.getEvalSuiteWithCases(SYSTEM_EVAL_SUITE_ID);
      expect(suiteWithCases?.cases).toHaveLength(15);
    });
  });

  describe('评测执行生命周期与双版本对比 (startEvalRun & Summary)', () => {
    const userId = 'eval-test-user-01';

    beforeAll(() => {
      seedUser(userId);
    });

    test('创建 Agent 历史版本并成功执行双版本对比评测', async () => {
      // 1. 创建 AgentProfile
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

      // 2. 更新 AgentProfile 产生 v2
      const profileV2 = db.updateAgentProfile(profile.id, userId, {
        identityPrompt:
          '你是一名资深全栈工程师，执行严格防守性重构与安全加固。',
        agentsPrompt:
          '必须处理 null/undefined 边界，使用标准 TypeScript 接口，输出规范 JSON。',
      });
      expect(profileV2?.version).toBe(2);

      // 3. 触发双版本对比评测
      const run = await startEvalRun({
        ownerUserId: userId,
        agentProfileId: profile.id,
        baseVersion: 1,
        targetVersion: 2,
        mode: 'compare',
      });

      expect(run.id).toBeDefined();
      expect(run.agent_profile_id).toBe(profile.id);
      expect(run.base_version).toBe(1);
      expect(run.target_version).toBe(2);
      expect(run.status).toBe('running');
      expect(run.base_prompt_hash).toBeTruthy();
      expect(run.target_prompt_hash).toBeTruthy();

      // 等待异步后台执行结束
      const finishedRun = await waitForEvalRunCompletion(run.id);

      expect(finishedRun?.status).toBe('completed');
      expect(finishedRun?.completed_cases).toBe(15);
      expect(finishedRun?.target_pass_count).toBeGreaterThan(0);
      expect(finishedRun?.target_avg_duration_ms).toBeGreaterThan(0);
      expect(finishedRun?.target_estimated_cost_usd).toBeGreaterThan(0);

      // 4. 验证对比指标与 Delta 分析
      const summary = getEvalRunSummary(run.id, userId);
      expect(summary).not.toBeNull();
      expect(summary?.run.id).toBe(run.id);
      expect(summary?.baseSummary?.version).toBe(1);
      expect(summary?.targetSummary.version).toBe(2);
      expect(summary?.delta).toBeDefined();
      expect(summary?.delta?.passRateDelta).toBeDefined();
      expect(summary?.cases).toHaveLength(15);

      // 案例明细中有 baseResult 和 targetResult
      const case01 = summary?.cases.find(
        (c) => c.caseId === 'eval-case-01-refactor-boundary',
      );
      expect(case01).toBeDefined();
      expect(case01?.baseResult?.version_tag).toBe('base');
      expect(case01?.targetResult?.version_tag).toBe('target');
      expect(case01?.targetResult?.auto_verdict).toBe('pass');
    }, 20000);

    test('运行取消控制：能够在执行过程中终止任务', async () => {
      const profile = db.listAgentProfilesForUser(userId)[0];

      // 设置一个慢速 provider 用于测试取消
      setEvalExecutionProvider(async ({ abortSignal }) => {
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

      // 立即取消
      const cancelOk = cancelEvalRun(slowRun.id, userId);
      expect(cancelOk).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));
      const afterCancel = db.getEvalRun(slowRun.id, userId);
      expect(afterCancel?.status).toBe('cancelled');

      // 恢复默认 provider
      setEvalExecutionProvider(null);
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

      // 等待完成
      await waitForEvalRunCompletion(run.id);

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

  describe('人工反馈与审核 (Human Feedback)', () => {
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

      await waitForEvalRunCompletion(run.id);

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

      // 验证重新读取
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
        id: 'eval-run-isolated-test',
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
        id: 'eval-rcase-isolated-test',
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
