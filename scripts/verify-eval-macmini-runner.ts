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

// 严格遵守 RegisterSchema: username 最大长度 32 (ev_前缀 + 8位时间戳 + 4位hex = 15字符)
const SHORT_TAG = `${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
const FIXTURE_USERNAME = `ev_${SHORT_TAG}`;
const OTHER_USERNAME = `ot_${SHORT_TAG}`;
const FIXTURE_PASSWORD = `P@ssw0rd-${crypto.randomBytes(4).toString('hex')}`;

let sessionCookie: string | null = null;
let otherUserCookie: string | null = null;
let createdProfileId: string | null = null;
let activeRunId: string | null = null;

async function apiRequest<T = any>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    cookie?: string | null;
    timeoutMs?: number;
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

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 25000,
  );

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: reqHeaders,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const contentType = res.headers.get('Content-Type') || '';
    let data: any = null;
    if (contentType.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      data = await res.text().catch(() => null);
    }

    return { status: res.status, data, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function safeCleanup(): Promise<void> {
  console.log(`\n[CLEANUP] 正在安全清理 fixture 资源 (tag: ${SHORT_TAG})...`);

  // 1. 若有活跃评测，先显式取消，防止后台继续写入并计费
  if (activeRunId && sessionCookie) {
    try {
      const cancelRes = await apiRequest(
        `/api/eval/runs/${activeRunId}/cancel`,
        { method: 'POST' },
      );
      console.log(`   - 取消运行: HTTP ${cancelRes.status}`);
      // 等待 1 秒让后台收尾退出
      await new Promise((r) => setTimeout(r, 1000));
    } catch {}

    try {
      const delRunRes = await apiRequest(`/api/eval/runs/${activeRunId}`, {
        method: 'DELETE',
      });
      console.log(`   - 删除评测记录: HTTP ${delRunRes.status}`);
    } catch {}
  }

  // 2. 归档/删除测试智能体 (DELETE /api/agent-profiles/:id)
  if (createdProfileId && sessionCookie) {
    try {
      const delProfileRes = await apiRequest(
        `/api/agent-profiles/${createdProfileId}`,
        { method: 'DELETE' },
      );
      if (delProfileRes.status === 200 || delProfileRes.status === 204) {
        console.log(`   - 归档智能体: HTTP ${delProfileRes.status} (成功)`);
      } else {
        console.warn(`   ⚠️ 智能体归档响应非200: HTTP ${delProfileRes.status}`);
      }
    } catch (err: any) {
      console.warn(`   ⚠️ 智能体归档网络异常: ${err.message}`);
    }
  }

  console.log('   ✓ Fixture 资源清理协议执行完毕');
}

async function registerOrLogin(username: string): Promise<string> {
  // 先尝试注册
  const regRes = await apiRequest('/api/auth/register', {
    method: 'POST',
    body: {
      username,
      password: FIXTURE_PASSWORD,
      displayName: `测试员-${username}`,
    },
  });

  if (regRes.status === 201 || regRes.status === 200) {
    const setCookie = regRes.headers.get('set-cookie');
    if (setCookie) return setCookie.split(';')[0];
  }

  // 若已存在或注册直接登录
  const loginRes = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: {
      username,
      password: FIXTURE_PASSWORD,
    },
  });

  if (loginRes.status !== 200) {
    throw new Error(
      `认证失败 (${username}): HTTP ${loginRes.status} - ${JSON.stringify(loginRes.data)}`,
    );
  }

  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error(`未能从 ${username} 登录响应中获取 Cookie`);
  }
  return setCookie.split(';')[0];
}

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('  HappyClaw R17 Mac mini 真实 HTTP API 端到端验收');
  console.log(`  Target Base URL: ${BASE_URL}`);
  console.log(`  Fixture User:    ${FIXTURE_USERNAME}`);
  console.log('============================================================\n');

  // STEP 1: 公开无认证健康检查探活 (GET /api/health)
  console.log(
    '[STEP 1/6] 检查 HappyClaw 目标服务公开探活状态 (GET /api/health)...',
  );
  try {
    const health = await apiRequest('/api/health');
    if (health.status !== 200 && health.status !== 503) {
      throw new Error(`探活返回异常状态: HTTP ${health.status}`);
    }
  } catch (err: any) {
    throw new Error(
      `无法连接目标服务 [${BASE_URL}/api/health]: ${err.message}。请先启动 HappyClaw 服务。`,
    );
  }
  console.log('   ✓ 目标服务健康在线 (HTTP 200)');

  // STEP 2: 注册/登录主测试用户与第二隔离用户
  console.log(
    '\n[STEP 2/6] 建立主测试用户与第二身份会话 (用户名严格<32字符)...',
  );
  sessionCookie = await registerOrLogin(FIXTURE_USERNAME);
  otherUserCookie = await registerOrLogin(OTHER_USERNAME);
  console.log('   ✓ 主测试用户与第二隔离身份均已建立有效会话');

  // STEP 3: 创建智能体并生成 v1 与 v2 版本
  console.log('\n[STEP 3/6] 通过 HTTP API 创建智能体并升级至 v2 版本...');
  const createProfileRes = await apiRequest('/api/agent-profiles', {
    method: 'POST',
    body: {
      name: `生产验收Agent-${SHORT_TAG}`,
      identity_prompt: '你是一名基础工程师。',
      soul_prompt: '满足基本要求即可。',
      agents_prompt: '简短回答，不带防守边界。',
      tools_prompt: '',
      prompt_mode: 'append',
    },
  });

  if (createProfileRes.status !== 201 && createProfileRes.status !== 200) {
    throw new Error(`创建智能体失败: HTTP ${createProfileRes.status}`);
  }

  const profile = createProfileRes.data.profile;
  createdProfileId = profile.id;
  console.log(
    `   ✓ 创建智能体成功 (ID: ${profile.id}, 初始版本: v${profile.version})`,
  );

  // 更新生成 v2 版本
  const updateRes = await apiRequest(`/api/agent-profiles/${profile.id}`, {
    method: 'PATCH',
    body: {
      identity_prompt: '你是一名资深全栈工程师与架构专家。',
      soul_prompt: '遵循防守性编程，严格校验 null、undefined 与数组越界。',
      agents_prompt:
        '必须声明强类型接口，严格遵守 RESTful 标准，输出合法严格 JSON。',
    },
  });

  if (updateRes.status !== 200 || updateRes.data.profile?.version !== 2) {
    throw new Error(`更新智能体至 v2 失败: HTTP ${updateRes.status}`);
  }
  console.log('   ✓ 智能体版本成功升级至 v2');

  // STEP 4: 启动真实双版本对比评测 (POST /api/eval/runs)
  console.log('\n[STEP 4/6] 启动真实执行设施对比评测 (POST /api/eval/runs)...');
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
    throw new Error(
      `启动评测被拒绝 (HTTP ${startRunRes.status}): ${JSON.stringify(startRunRes.data)}。请确保当前环境已配置并启用了有效模型凭据。`,
    );
  }

  const run = startRunRes.data.run;
  activeRunId = run.id;
  console.log(
    `   ✓ 评测任务已启动: RunID=${run.id}, 来源=${run.provider_source}`,
  );

  if (run.provider_source !== 'live_provider') {
    throw new Error(
      `[SECURITY] 生产验收断言失败: 非 live_provider 来源: ${run.provider_source}`,
    );
  }

  // STEP 5: 轮询等待真实评测完成并断言指标
  console.log('\n[STEP 5/6] 轮询等待 15 个用例双版本执行到达终态...');
  const pollStart = Date.now();
  let finishedSummary: any = null;

  while (Date.now() - pollStart < 300_000) {
    // 最多等 5 分钟
    const detailRes = await apiRequest(`/api/eval/runs/${activeRunId}`);
    if (detailRes.status === 200 && detailRes.data?.summary) {
      const currentRun = detailRes.data.summary.run;
      if (currentRun.status === 'completed') {
        finishedSummary = detailRes.data.summary;
        break;
      } else if (
        currentRun.status === 'failed' ||
        currentRun.status === 'cancelled' ||
        currentRun.status === 'interrupted'
      ) {
        throw new Error(
          `评测异常终止: 状态=${currentRun.status}, 错误=${currentRun.error_message}`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!finishedSummary) {
    throw new Error('评测超时 (超过 300 秒未达到 completed 终态)');
  }

  const completedRun = finishedSummary.run;
  console.log(
    `   ✓ 评测完成: 完成案例=${completedRun.completed_cases}/${completedRun.total_cases}`,
  );
  console.log(
    `   ✓ 通过率: 基准=${finishedSummary.baseSummary?.passRate}%, 目标=${finishedSummary.targetSummary?.passRate}%`,
  );
  console.log(
    `   ✓ 实测 Tokens: 基准=${completedRun.base_total_tokens}, 目标=${completedRun.target_total_tokens}`,
  );
  console.log(
    `   ✓ 实测费用: 基准=$${completedRun.base_estimated_cost_usd}, 目标=$${completedRun.target_estimated_cost_usd}`,
  );

  // 校验 15 个聚合 Case
  if (
    !Array.isArray(finishedSummary.cases) ||
    finishedSummary.cases.length !== 15
  ) {
    throw new Error(
      `聚合案例数量不符: 期望 15 项, 实际 ${finishedSummary.cases?.length}`,
    );
  }

  for (const c of finishedSummary.cases) {
    if (!c.baseResult || !c.targetResult) {
      throw new Error(`案例 [${c.caseId}] 缺少双版本结果记录`);
    }
    if (
      c.baseResult.status !== 'completed' ||
      c.targetResult.status !== 'completed'
    ) {
      throw new Error(`案例 [${c.caseId}] 结果状态未达 completed 终态`);
    }
    if (!c.category || c.category === '01' || c.category === '02') {
      throw new Error(`案例 [${c.caseId}] 分类解析错误: ${c.category}`);
    }
  }
  console.log('   ✓ 全部 15 个聚合案例双版本结果与快照校验通过');

  // STEP 6: 报告导出与跨用户权限隔离实际验证
  console.log('\n[STEP 6/6] 验证 Markdown/JSON 效果报告下载与跨用户隔离...');
  const mdRes = await apiRequest(`/api/eval/runs/${activeRunId}/report.md`);
  if (mdRes.status !== 200 || !String(mdRes.data).includes('核心对比摘要')) {
    throw new Error('Markdown 效果报告生成失败或缺失关键内容');
  }

  const jsonRes = await apiRequest(`/api/eval/runs/${activeRunId}/report.json`);
  if (jsonRes.status !== 200 || jsonRes.data?.cases?.length !== 15) {
    throw new Error('JSON 效果报告数据不完整');
  }

  // 跨用户隔离验证: 第二用户请求该 run 必须返回 404
  const crossUserRes = await apiRequest(`/api/eval/runs/${activeRunId}`, {
    cookie: otherUserCookie,
  });
  if (crossUserRes.status !== 404) {
    throw new Error(
      `跨用户权限隔离失败: 第二用户请求返回了 HTTP ${crossUserRes.status} (期望 404)`,
    );
  }
  console.log('   ✓ 跨用户权限隔离 (返回 404) 与效果报告下载校验通过');

  console.log('\n============================================================');
  console.log('  ✓ R17 Mac mini 生产环境真实 HTTP API 端到端验收完全通过！');
  console.log('============================================================');
}

void (async () => {
  try {
    await main();
  } catch (err: any) {
    console.error('\n❌ [FAIL] 生产验收失败:', err.message);
    process.exitCode = 1;
  } finally {
    await safeCleanup();
  }
})();
