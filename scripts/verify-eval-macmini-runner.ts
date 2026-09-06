/**
 * Mac mini 生产环境 R17 提示词评测端到端真实验收驱动脚本
 *
 * 必须在配置了真实 Provider 凭据的环境下运行。
 * 严格拒绝任何模拟或 FakeProvider 兜底，验证失败或缺少配置时必须退出非 0。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, STORE_DIR } from '../src/config.js';
import {
  initDatabase,
  createUser,
  deleteUser,
  createAgentProfile,
  updateAgentProfile,
  archiveAgentProfile,
  getEvalRun,
  listEvalRunCases,
  deleteEvalRun,
} from '../src/db.js';
import {
  startEvalRun,
  waitForEvalRunCompletion,
  getEvalRunSummary,
  generateEvalMarkdownReport,
  generateEvalJsonReport,
  resolveAgentModelExecutionConfig,
} from '../src/eval-service.js';
import {
  getClaudeProviderConfig,
  getEnabledProviders,
} from '../src/runtime-config.js';

const FIXTURE_TAG = `macmini-verify-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const FIXTURE_USER_ID = `user-${FIXTURE_TAG}`;
let fixtureAgentId: string | null = null;
let fixtureRunId: string | null = null;

async function cleanup(): Promise<void> {
  console.log(`[CLEANUP] 清理测试 fixture 数据 (tag: ${FIXTURE_TAG})...`);
  try {
    if (fixtureRunId) {
      deleteEvalRun(fixtureRunId, FIXTURE_USER_ID);
    }
    if (fixtureAgentId) {
      archiveAgentProfile(fixtureAgentId, FIXTURE_USER_ID);
    }
    deleteUser(FIXTURE_USER_ID);

    // 清理可能产生的临时 eval-workspace
    if (fixtureRunId) {
      const wsDir = path.join(DATA_DIR, 'eval-workspaces', fixtureRunId);
      if (fs.existsSync(wsDir)) {
        fs.rmSync(wsDir, { recursive: true, force: true });
      }
    }
    console.log('   ✓ 临时测试数据清理完毕');
  } catch (err) {
    console.warn('   ⚠️ 清理过程出现警告:', (err as Error).message);
  }
}

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('  HappyClaw R17 Mac mini 真实生产验收运行');
  console.log(`  Fixture Tag: ${FIXTURE_TAG}`);
  console.log('============================================================\n');

  // 1. 初始化数据库
  initDatabase();

  // 2. 检查真实模型 Provider 配置（绝不 fallback fake）
  console.log('[STEP 1/6] 检查当前环境模型 Provider 凭据配置...');
  const enabledProviders = getEnabledProviders();
  if (enabledProviders.length === 0) {
    console.error('❌ [FATAL] 生产环境中未检测到任何已启用的 Provider！');
    console.error(
      '   请先在 Web 界面「模型配置」中配置并启用 Anthropic 或兼容 Provider。',
    );
    process.exit(1);
  }

  const globalConfig = getClaudeProviderConfig();
  const hasValidCredentials = Boolean(
    globalConfig.anthropicApiKey ||
    globalConfig.anthropicAuthToken ||
    globalConfig.claudeCodeOauthToken ||
    globalConfig.claudeOAuthCredentials,
  );

  if (!hasValidCredentials) {
    console.error(
      '❌ [FATAL] 启用的 Provider 未配置任何可用认证凭据 (API Key/Token/OAuth)！',
    );
    console.error(
      '   契约严禁使用固定/模拟数据冒充评测，无凭据时必须拒绝执行。',
    );
    process.exit(1);
  }
  console.log(
    `   ✓ 检测到有效 Provider 配置: 模型=${globalConfig.anthropicModel || '默认'}, BaseURL=${globalConfig.anthropicBaseUrl || '官方'}`,
  );

  // 3. 创建测试隔离用户与 AgentProfile
  console.log('\n[STEP 2/6] 创建隔离 fixture 用户与智能体版本 (v1 & v2)...');
  const now = new Date().toISOString();
  createUser({
    id: FIXTURE_USER_ID,
    username: FIXTURE_USER_ID,
    password_hash: 'fixture-hash',
    display_name: `验收测试员-${FIXTURE_TAG}`,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });

  const profile = createAgentProfile({
    ownerUserId: FIXTURE_USER_ID,
    name: `全栈架构助手-${FIXTURE_TAG}`,
    identityPrompt: '你是一名初级工程师。',
    soulPrompt: '追求完成基本要求。',
    agentsPrompt: '简要回答，无边界考虑。',
    toolsPrompt: '',
    promptMode: 'append',
  });
  fixtureAgentId = profile.id;
  console.log(
    `   ✓ 成功创建 AgentProfile (ID: ${profile.id}, 初始版本: v${profile.version})`,
  );

  // 更新为 v2 版本（优化版提示词）
  const profileV2 = updateAgentProfile(profile.id, FIXTURE_USER_ID, {
    identityPrompt: '你是一名严谨的资深全栈工程师与安全合规专家。',
    soulPrompt: '追求防守性编程，杜绝 null 穿透、类型缺失与越界风险。',
    agentsPrompt:
      '必须使用标准 TypeScript 接口，严格遵循 RESTful 原则，输出标准合法 JSON，严禁明文敏感信息。',
  });
  if (!profileV2 || profileV2.version !== 2) {
    throw new Error('更新智能体至版本 v2 失败');
  }
  console.log(`   ✓ 成功创建优化后版本: v${profileV2.version}`);

  // 4. 启动真实模型对比评测（15 项典型脱敏任务）
  console.log(
    '\n[STEP 3/6] 启动真实执行设施对比评测 (v1 vs v2, 15项典型任务)...',
  );
  const run = await startEvalRun({
    ownerUserId: FIXTURE_USER_ID,
    agentProfileId: profile.id,
    mode: 'compare',
    baseVersion: 1,
    targetVersion: 2,
  });
  fixtureRunId = run.id;
  console.log(
    `   ✓ 评测任务已入队运行 (Run ID: ${run.id}, 来源: ${run.provider_source})`,
  );

  if (run.provider_source !== 'live_provider') {
    throw new Error(
      `[SECURITY] 生产验收检测到非真实 Provider 来源: ${run.provider_source}`,
    );
  }

  // 5. 轮询等待执行终态并验证
  console.log('\n[STEP 4/6] 等待真实模型推理执行完成并轮询状态...');
  const completedRun = await waitForEvalRunCompletion(run.id, 180_000); // 最多等 3 分钟

  if (!completedRun) {
    throw new Error('未能在超时时间内取得评测结果');
  }
  if (completedRun.status !== 'completed') {
    throw new Error(
      `评测运行未达到 completed 终态: 当前状态=${completedRun.status}, 错误=${completedRun.error_message}`,
    );
  }
  console.log(
    `   ✓ 评测运行完成: 状态=${completedRun.status}, 完成案例=${completedRun.completed_cases}/${completedRun.total_cases}`,
  );
  console.log(
    `   ✓ 实测指标: 基准通过=${completedRun.base_pass_count}, 目标通过=${completedRun.target_pass_count}`,
  );
  console.log(
    `   ✓ 实测用量: 基准Tokens=${completedRun.base_total_tokens}, 目标Tokens=${completedRun.target_total_tokens}`,
  );
  console.log(
    `   ✓ 实测成本: 基准=$${completedRun.base_estimated_cost_usd.toFixed(4)}, 目标=$${completedRun.target_estimated_cost_usd.toFixed(4)}`,
  );

  // 6. 验证用例明细与真实输出
  console.log('\n[STEP 5/6] 验证用例明细、真实输出与快照完整性...');
  const runCases = listEvalRunCases(run.id);
  if (runCases.length !== 30) {
    // 15 base + 15 target
    throw new Error(
      `用例执行快照数量不符: 期望 30 条, 实际 ${runCases.length} 条`,
    );
  }

  for (const rc of runCases) {
    if (!rc.actual_output || rc.actual_output.trim().length === 0) {
      throw new Error(`用例 [${rc.case_id}] 实际输出为空，存在伪造完成嫌疑`);
    }
  }
  console.log('   ✓ 全部 30 个版本运行用例均包含真实生成的有效输出');

  // 7. 验证报告导出与权限隔离
  console.log('\n[STEP 6/6] 验证效果报告导出与权限隔离...');
  const mdReport = generateEvalMarkdownReport(run.id, FIXTURE_USER_ID);
  if (
    !mdReport ||
    !mdReport.includes('核心对比摘要') ||
    !mdReport.includes(run.id)
  ) {
    throw new Error('Markdown 效果报告生成失败或缺失关键内容');
  }

  const jsonReport = generateEvalJsonReport(run.id, FIXTURE_USER_ID);
  if (!jsonReport || (jsonReport as any).cases.length !== 15) {
    throw new Error('JSON 效果报告结构不完整');
  }

  // 权限隔离验证
  const unauthorizedAccess = getEvalRun(run.id, 'unauthorized-user-id');
  if (unauthorizedAccess !== null) {
    throw new Error('权限隔离校验失败: 未授权用户能够读取该评测结果');
  }
  console.log('   ✓ 报告生成与权限隔离校验通过');

  console.log('\n============================================================');
  console.log('  ✓ R17 Mac mini 生产环境端到端真实验收完全通过！');
  console.log('============================================================');
}

void (async () => {
  try {
    await main();
  } catch (err) {
    console.error('\n❌ [FAIL] 验收执行失败:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
