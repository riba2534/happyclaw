/**
 * Mac mini 生产环境 R17 提示词评测纯 HTTP API 端到端真实验收脚本
 *
 * 绝对不直接 import 内部源码或调用 initDatabase，避免并发污染生产数据库与误杀正在运行的任务。
 * 完全通过 HTTP RESTful API 对运行中的 HappyClaw 实例进行端到端验证。
 */

import crypto from 'node:crypto';

const BASE_URL = (
  process.env.WEB_BASE_URL || `http://127.0.0.1:${process.env.WEB_PORT || 3000}`
).replace(/\/+$/, '');
const FIXTURE_TAG = `macmini-eval-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const FIXTURE_USERNAME = `eval_verify_${FIXTURE_TAG}`;
const FIXTURE_PASSWORD = `P@ssw0rd-${crypto.randomBytes(6).toString('hex')}`;

let sessionCookie: string | null = null;
let createdProfileId: string | null = null;
let activeRunId: string | null = null;

async function apiRequest<T = any>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    cookie?: string | null;
  } = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const cookie = options.cookie !== undefined ? options.cookie : sessionCookie;
  if (cookie) {
    reqHeaders['Cookie'] = cookie;
  }

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: reqHeaders,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const contentType = res.headers.get('Content-Type') || '';
  let data: any = null;
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else {
    data = await res.text().catch(() => null);
  }

  return { status: res.status, data, headers: res.headers };
}

async function safeCleanup(): Promise<void> {
  console.log(`\n[CLEANUP] 正在安全清理 fixture 资源 (tag: ${FIXTURE_TAG})...`);

  // 1. 如果有未完成的评测，必须先显式取消，防止后台继续写入
  if (activeRunId && sessionCookie) {
    try {
      await apiRequest(`/api/eval/runs/${activeRunId}/cancel`, {
        method: 'POST',
      });
    } catch {}
    try {
      await apiRequest(`/api/eval/runs/${activeRunId}`, { method: 'DELETE' });
    } catch {}
  }

  // 2. 归档/删除测试智能体
  if (createdProfileId && sessionCookie) {
    try {
      await apiRequest(`/api/agent-profiles/${createdProfileId}/archive`, {
        method: 'POST',
      });
    } catch {}
  }

  console.log('   ✓ Fixture 资源清理协议执行完毕');
}

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('  HappyClaw R17 Mac mini 真实 HTTP API 端到端验收');
  console.log(`  Target Base URL: ${BASE_URL}`);
  console.log(`  Fixture Tag:     ${FIXTURE_TAG}`);
  console.log('============================================================\n');

  // STEP 1: 服务探活
  console.log('[STEP 1/6] 检查 HappyClaw 目标服务健康状态...');
  try {
    const health = await apiRequest('/api/status');
    if (health.status !== 200) {
      throw new Error(`服务返回非 200 状态码: ${health.status}`);
    }
  } catch (err: any) {
    console.error(`❌ [FATAL] 无法连接目标服务 [${BASE_URL}]: ${err.message}`);
    console.error(
      '   请确保已在此机器上启动 HappyClaw (例如 npm run dev 或 make start)。',
    );
    process.exit(1);
  }
  console.log('   ✓ 目标服务在线且响应正常');

  // STEP 2: 注册并登录隔离 fixture 测试用户
  console.log('\n[STEP 2/6] 创建隔离 fixture 用户并建立 Session 会话...');
  const regRes = await apiRequest('/api/auth/register', {
    method: 'POST',
    body: {
      username: FIXTURE_USERNAME,
      password: FIXTURE_PASSWORD,
      displayName: `验收测试员-${FIXTURE_TAG}`,
    },
  });

  if (regRes.status === 201 || regRes.status === 200) {
    const setCookie = regRes.headers.get('set-cookie');
    if (setCookie) {
      sessionCookie = setCookie.split(';')[0];
    }
  } else {
    // 尝试登录
    const loginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
      },
    });
    if (loginRes.status !== 200) {
      throw new Error(
        `创建或登录 fixture 用户失败: ${JSON.stringify(loginRes.data)}`,
      );
    }
    const setCookie = loginRes.headers.get('set-cookie');
    if (setCookie) {
      sessionCookie = setCookie.split(';')[0];
    }
  }

  if (!sessionCookie) {
    throw new Error('未能从认证响应中取得有效 Session Cookie');
  }
  console.log('   ✓ 隔离测试用户已登录');

  // STEP 3: 创建智能体并生成 v1 与 v2 版本
  console.log('\n[STEP 3/6] 通过 API 创建智能体并生成提示词版本 (v1 & v2)...');
  const createProfileRes = await apiRequest('/api/agent-profiles', {
    method: 'POST',
    body: {
      name: `生产验收Agent-${FIXTURE_TAG}`,
      identity_prompt: '你是一名基础工程师。',
      soul_prompt: '满足基本要求即可。',
      agents_prompt: '回答尽量简短，无需防守校验。',
      tools_prompt: '',
      prompt_mode: 'append',
    },
  });

  if (createProfileRes.status !== 201 && createProfileRes.status !== 200) {
    throw new Error(`创建智能体失败: ${JSON.stringify(createProfileRes.data)}`);
  }

  const profile = createProfileRes.data.profile;
  createdProfileId = profile.id;
  console.log(
    `   ✓ 成功创建智能体 (ID: ${profile.id}, 初始版本: v${profile.version})`,
  );

  // 更新为 v2 版本
  const updateRes = await apiRequest(`/api/agent-profiles/${profile.id}`, {
    method: 'PATCH',
    body: {
      identity_prompt: '你是一名经验丰富的资深全栈工程师与安全架构专家。',
      soul_prompt: '遵循防守性编程，严格校验 null、undefined 与数组边界。',
      agents_prompt:
        '必须声明强类型接口，严格遵守 RESTful 标准，输出合法严格 JSON，对敏感数据进行脱敏掩码。',
    },
  });

  if (updateRes.status !== 200 || updateRes.data.profile?.version !== 2) {
    throw new Error(`更新智能体至 v2 失败: ${JSON.stringify(updateRes.data)}`);
  }
  console.log('   ✓ 成功升级至优化后提示词版本: v2');

  // STEP 4: 启动真实双版本对比评测
  console.log('\n[STEP 4/6] 调用 POST /api/eval/runs 启动真实对比评测...');
  const startRunRes = await apiRequest('/api/eval/runs', {
    method: 'POST',
    body: {
      agent_profile_id: profile.id,
      mode: 'compare',
      base_version: 1,
      target_version: 2,
    },
  });

  if (startRunRes.status !== 201) {
    console.error(
      `❌ [FATAL] 启动评测失败 (HTTP ${startRunRes.status}):`,
      startRunRes.data,
    );
    console.error(
      '   提示: 契约严格拒绝 FakeProvider 兜底，若当前未配置有效真实凭据，服务将明确拒绝执行。',
    );
    process.exit(1);
  }

  const run = startRunRes.data.run;
  activeRunId = run.id;
  console.log(
    `   ✓ 评测任务成功启动: ID=${run.id}, 来源=${run.provider_source}, 状态=${run.status}`,
  );

  if (run.provider_source !== 'live_provider') {
    throw new Error(
      `[SECURITY] 生产验收断言失败: 检测到非 live_provider 来源: ${run.provider_source}`,
    );
  }

  // STEP 5: 轮询等待真实执行完成并断言
  console.log('\n[STEP 5/6] 轮询等待评测达到完成终态并核验实测数据...');
  const pollStart = Date.now();
  let finishedSummary: any = null;

  while (Date.now() - pollStart < 180_000) {
    // 最多等 3 分钟
    const detailRes = await apiRequest(`/api/eval/runs/${activeRunId}`);
    if (detailRes.status === 200 && detailRes.data?.summary) {
      const currentRun = detailRes.data.summary.run;
      if (currentRun.status === 'completed') {
        finishedSummary = detailRes.data.summary;
        break;
      } else if (
        currentRun.status === 'failed' ||
        currentRun.status === 'cancelled'
      ) {
        throw new Error(
          `评测异常终止: 状态=${currentRun.status}, 错误=${currentRun.error_message}`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!finishedSummary) {
    throw new Error('评测执行超时 (超过 180 秒未达到 completed 终态)');
  }

  const completedRun = finishedSummary.run;
  console.log(
    `   ✓ 评测成功完成: 完成案例=${completedRun.completed_cases}/${completedRun.total_cases}`,
  );
  console.log(
    `   ✓ 真实通过率: 基准=${finishedSummary.baseSummary?.passRate}%, 目标=${finishedSummary.targetSummary?.passRate}%`,
  );
  console.log(
    `   ✓ 实测 Tokens: 基准=${completedRun.base_total_tokens}, 目标=${completedRun.target_total_tokens}`,
  );
  console.log(
    `   ✓ 实测费用: 基准=$${completedRun.base_estimated_cost_usd}, 目标=$${completedRun.target_estimated_cost_usd}`,
  );

  // 严格断言
  if (completedRun.completed_cases !== 15) {
    throw new Error(
      `完成案例数量不符: 期望 15, 实际 ${completedRun.completed_cases}`,
    );
  }
  if (completedRun.target_total_tokens <= 0) {
    throw new Error('实测 Token 消耗为 0，存在伪造完成嫌疑');
  }
  if (completedRun.target_estimated_cost_usd <= 0) {
    throw new Error('实测估算费用为 0，存在抹零违规');
  }

  // STEP 6: 报告导出与权限隔离断言
  console.log('\n[STEP 6/6] 验证报告导出格式与越权访问隔离...');
  const mdRes = await apiRequest(`/api/eval/runs/${activeRunId}/report.md`);
  if (mdRes.status !== 200 || !String(mdRes.data).includes('核心对比摘要')) {
    throw new Error('Markdown 报告导出失败或格式不正确');
  }

  const jsonRes = await apiRequest(`/api/eval/runs/${activeRunId}/report.json`);
  if (
    jsonRes.status !== 200 ||
    !Array.isArray(jsonRes.data?.cases) ||
    jsonRes.data.cases.length !== 15
  ) {
    throw new Error('JSON 报告数据不完整');
  }

  // 未授权用户访问隔离断言
  const unauthRes = await apiRequest(`/api/eval/runs/${activeRunId}`, {
    cookie: null, // 无登录态
  });
  if (unauthRes.status !== 401 && unauthRes.status !== 404) {
    throw new Error(`越权防护断言失败: 未认证访问返回了 ${unauthRes.status}`);
  }

  console.log('   ✓ 效果报告完整可下载，权限隔离安全生效');
  console.log('\n============================================================');
  console.log('  ✓ R17 Mac mini 生产环境真实 HTTP API 端到端验收完全通过！');
  console.log('============================================================');
}

void (async () => {
  try {
    await main();
  } catch (err) {
    console.error('\n❌ [FAIL] 验收失败:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await safeCleanup();
  }
})();
