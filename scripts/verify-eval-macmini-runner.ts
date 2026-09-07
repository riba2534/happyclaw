/**
 * Mac mini 生产环境 R17 提示词评测纯 HTTP API 端到端真实验收脚本
 *
 * 绝对不直接 import 内部源码或调用 initDatabase，避免并发污染生产数据库与误杀正在运行的任务。
 * 完全通过 HTTP RESTful API 对运行中的 HappyClaw 实例进行端到端验证。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE_URL = (
  process.env.WEB_BASE_URL || `http://127.0.0.1:${process.env.WEB_PORT || 3000}`
).replace(/\/+$/, '');

// 严格遵守 RegisterSchema: username 最大长度 32
const SHORT_TAG = `${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
const FIXTURE_USERNAME = `ev_${SHORT_TAG}`;
const OTHER_USERNAME = `ot_${SHORT_TAG}`;
const FIXTURE_PASSWORD = `P@ssw0rd-${crypto.randomBytes(4).toString('hex')}`;
const POLL_DEADLINE_MS = Number(process.env.EVAL_POLL_TIMEOUT_MS) || 600_000;

let sessionCookie: string | null = null;
let otherUserCookie: string | null = null;
let activeRunId: string | null = null;
let createdProfileId: string | null = null;

const createdFixtures = {
  runId: null as string | null,
  profileId: null as string | null,
  userIds: [] as string[],
  adminCookie: null as string | null,
};

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
  const uncleanedItems: string[] = [];

  // 1. 若有活跃评测，先显式取消并等待收尾，防止后台继续写入并计费
  if (activeRunId && sessionCookie) {
    try {
      const checkRes = await apiRequest(`/api/eval/runs/${activeRunId}`, {
        timeoutMs: 5000,
      });
      if (
        checkRes.status === 200 &&
        ['pending', 'running', 'cancelling'].includes(
          checkRes.data?.summary?.run?.status,
        )
      ) {
        console.log('   - 发现未完成评测，发送取消请求并等待退出...');
        await apiRequest(`/api/eval/runs/${activeRunId}/cancel`, {
          method: 'POST',
          timeoutMs: 25000,
        });
      }
    } catch (err: any) {
      console.warn(`   ⚠️ 评测取消请求异常: ${err.message}`);
    }

    try {
      const delRunRes = await apiRequest(`/api/eval/runs/${activeRunId}`, {
        method: 'DELETE',
        timeoutMs: 15000,
      });
      if (delRunRes.status !== 200 && delRunRes.status !== 404) {
        uncleanedItems.push(
          `评测运行 ID: ${activeRunId} (DELETE 返回 HTTP ${delRunRes.status})`,
        );
      } else {
        console.log(`   ✓ 评测记录已删除: ${activeRunId}`);
      }
    } catch (err: any) {
      uncleanedItems.push(
        `评测运行 ID: ${activeRunId} (网络异常: ${err.message})`,
      );
    }
  }

  // 2. 归档/删除测试智能体 (DELETE /api/agent-profiles/:id)
  if (createdProfileId && sessionCookie) {
    try {
      const delProfileRes = await apiRequest(
        `/api/agent-profiles/${createdProfileId}`,
        { method: 'DELETE', timeoutMs: 15000 },
      );
      if (
        delProfileRes.status !== 200 &&
        delProfileRes.status !== 204 &&
        delProfileRes.status !== 404
      ) {
        uncleanedItems.push(
          `智能体 ID: ${createdProfileId} (DELETE 返回 HTTP ${delProfileRes.status})`,
        );
      } else {
        console.log(`   ✓ 测试智能体已归档删除: ${createdProfileId}`);
      }
    } catch (err: any) {
      uncleanedItems.push(
        `智能体 ID: ${createdProfileId} (网络异常: ${err.message})`,
      );
    }
  }

  // 3. 删除由脚本创建的临时测试用户
  for (const uid of createdFixtures.userIds) {
    const adminAuthCookie = createdFixtures.adminCookie || sessionCookie;
    if (adminAuthCookie) {
      try {
        const delUserRes = await apiRequest(`/api/admin/users/${uid}`, {
          method: 'DELETE',
          cookie: adminAuthCookie,
          timeoutMs: 15000,
        });
        if (delUserRes.status !== 200 && delUserRes.status !== 404) {
          uncleanedItems.push(
            `测试用户 ID: ${uid} (DELETE 返回 HTTP ${delUserRes.status})`,
          );
        } else {
          console.log(`   ✓ 临时测试用户已清理: ${uid}`);
        }
      } catch (err: any) {
        uncleanedItems.push(`测试用户 ID: ${uid} (网络异常: ${err.message})`);
      }
    }
  }

  if (uncleanedItems.length > 0) {
    console.error('❌ [CLEANUP_FAILURE] 以下 fixture 资源未能成功清理:');
    for (const item of uncleanedItems) {
      console.error(`   - ${item}`);
    }
    process.exitCode = 1;
  } else {
    console.log('   ✓ 全部创建的 fixture 资源已安全清理完毕');
  }
}

function readCookieFromEnvOrFile(
  envVar: string,
  fileEnvVar: string,
): string | null {
  if (process.env[envVar]?.trim()) {
    return process.env[envVar]!.trim();
  }
  const filePath = process.env[fileEnvVar]?.trim();
  if (filePath && fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content) return content;
    } catch {}
  }
  return null;
}

/**
 * Parse and validate the response structure of GET /api/auth/me.
 * /api/auth/me returns { user: UserPublic, appearance, setupStatus? }.
 * Accurately extracts user identity and role from data.user, preventing false invalidations.
 */
export function parseAuthMeResponse(data: unknown): {
  isValid: boolean;
  userId?: string;
  role?: string;
  isAdmin: boolean;
} {
  const user = (data as any)?.user;
  if (user && typeof user.id === 'string' && user.id.trim()) {
    return {
      isValid: true,
      userId: user.id,
      role: user.role,
      isAdmin: user.role === 'admin',
    };
  }
  return {
    isValid: false,
    isAdmin: false,
  };
}

async function resolveIdentities(): Promise<{
  primaryCookie: string;
  otherCookie: string | null;
}> {
  // 1. 优先尝试环境变量或受控 Cookie 文件注入
  const injectedCookie = readCookieFromEnvOrFile(
    'EVAL_TEST_COOKIE',
    'EVAL_TEST_COOKIE_FILE',
  );
  const injectedAdminCookie = readCookieFromEnvOrFile(
    'EVAL_ADMIN_COOKIE',
    'EVAL_ADMIN_COOKIE_FILE',
  );
  let resolvedPrimaryCookie: string | null =
    injectedCookie || injectedAdminCookie;
  let isAdmin = false;

  if (resolvedPrimaryCookie) {
    const meRes = await apiRequest('/api/auth/me', {
      cookie: resolvedPrimaryCookie,
    });
    const parsed = parseAuthMeResponse(meRes.data);
    if (meRes.status === 200 && parsed.isValid) {
      console.log('   ✓ 成功载入已授权测试身份会话 (无须公开注册)');
      if (parsed.isAdmin) {
        isAdmin = true;
        createdFixtures.adminCookie = resolvedPrimaryCookie;
      }
    } else {
      console.warn('   ⚠️ 注入的 Cookie 无效或已过期，尝试备选注册方式');
      resolvedPrimaryCookie = null;
    }
  }

  // 2. 若未注入有效 Cookie，尝试注册新用户
  if (!resolvedPrimaryCookie) {
    const regRes = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: FIXTURE_USERNAME,
        password: FIXTURE_PASSWORD,
        displayName: `验收测试员-${SHORT_TAG}`,
      },
    });

    if (regRes.status === 201 || regRes.status === 200) {
      const setCookie = regRes.headers.get('set-cookie');
      if (setCookie) {
        resolvedPrimaryCookie = setCookie.split(';')[0];
        if (regRes.data?.user?.id) {
          createdFixtures.userIds.push(regRes.data.user.id);
        }
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
      if (loginRes.status === 200) {
        const setCookie = loginRes.headers.get('set-cookie');
        if (setCookie) {
          resolvedPrimaryCookie = setCookie.split(';')[0];
        }
      } else {
        throw new Error(
          `未提供有效测试身份且公开注册不可用 (HTTP ${regRes.status}: ${JSON.stringify(regRes.data)})。请通过 EVAL_TEST_COOKIE 或 EVAL_TEST_COOKIE_FILE 环境变量传入已授权 Cookie。`,
        );
      }
    }
  }

  if (!resolvedPrimaryCookie) {
    throw new Error('未能建立有效的主测试身份会话');
  }

  // 3. 解析第二隔离身份 (用于越权隔离断言)
  let resolvedOtherCookie = readCookieFromEnvOrFile(
    'EVAL_TEST_OTHER_COOKIE',
    'EVAL_TEST_OTHER_COOKIE_FILE',
  );

  if (!resolvedOtherCookie && isAdmin) {
    // 管理员可创建隔离 member 测试用户
    const createOtherRes = await apiRequest('/api/admin/users', {
      method: 'POST',
      cookie: resolvedPrimaryCookie,
      body: {
        username: OTHER_USERNAME,
        password: FIXTURE_PASSWORD,
        display_name: 'ACL隔离测试员',
        role: 'member',
      },
    });

    if (createOtherRes.status === 201 && createOtherRes.data?.user?.id) {
      createdFixtures.userIds.push(createOtherRes.data.user.id);
      const loginOtherRes = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: {
          username: OTHER_USERNAME,
          password: FIXTURE_PASSWORD,
        },
      });
      if (loginOtherRes.status === 200) {
        const setCookie = loginOtherRes.headers.get('set-cookie');
        if (setCookie) {
          resolvedOtherCookie = setCookie.split(';')[0];
        }
      }
    }
  } else if (!resolvedOtherCookie) {
    // 尝试注册第二用户
    const regOtherRes = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: OTHER_USERNAME,
        password: FIXTURE_PASSWORD,
        displayName: 'ACL隔离测试员',
      },
    });
    if (regOtherRes.status === 201 || regOtherRes.status === 200) {
      const setCookie = regOtherRes.headers.get('set-cookie');
      if (setCookie) {
        resolvedOtherCookie = setCookie.split(';')[0];
        if (regOtherRes.data?.user?.id) {
          createdFixtures.userIds.push(regOtherRes.data.user.id);
        }
      }
    }
  }

  return {
    primaryCookie: resolvedPrimaryCookie,
    otherCookie: resolvedOtherCookie,
  };
}

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('  HappyClaw R17 Mac mini 真实 HTTP API 端到端验收');
  console.log(`  Target Base URL: ${BASE_URL}`);
  console.log(`  Fixture Tag:     ${SHORT_TAG}`);
  console.log(`  Poll Timeout:    ${POLL_DEADLINE_MS / 1000}s`);
  console.log('============================================================\n');

  // STEP 1: 公开无认证健康检查探活 (GET /api/health)
  console.log(
    '[STEP 1/6] 检查 HappyClaw 目标服务公开探活状态 (GET /api/health)...',
  );
  try {
    const health = await apiRequest('/api/health');
    if (health.status === 200) {
      console.log('   ✓ 目标服务健康 (HTTP 200: healthy)');
    } else if (health.status === 503) {
      console.log(
        `   ℹ 目标服务可用但处于降级状态 (HTTP 503: ${JSON.stringify(health.data?.checks || {})})`,
      );
    } else {
      throw new Error(`目标服务健康检查返回异常状态: HTTP ${health.status}`);
    }
  } catch (err: any) {
    throw new Error(
      `无法连接目标服务 [${BASE_URL}/api/health]: ${err.message}。请先启动 HappyClaw 服务。`,
    );
  }

  // STEP 2: 建立主测试用户与第二身份会话
  console.log('\n[STEP 2/6] 解析主测试会话与越权隔离身份...');
  const identities = await resolveIdentities();
  sessionCookie = identities.primaryCookie;
  otherUserCookie = identities.otherCookie;
  console.log('   ✓ 身份解析完成，安全凭据未输出至日志');

  // STEP 3: 通过 API 创建智能体并生成 v1 与 v2 版本
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
  createdFixtures.profileId = profile.id;
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
  createdFixtures.runId = run.id;
  console.log(
    `   ✓ 评测任务已启动: RunID=${run.id}, 来源=${run.provider_source}`,
  );

  if (run.provider_source !== 'live_provider') {
    throw new Error(
      `[SECURITY] 生产验收断言失败: 检测到非 live_provider 来源: ${run.provider_source}`,
    );
  }

  // STEP 5: 轮询等待真实评测完成并断言指标
  console.log('\n[STEP 5/6] 轮询等待 15 个用例双版本执行到达终态...');
  const pollStart = Date.now();
  let finishedSummary: any = null;

  while (Date.now() - pollStart < POLL_DEADLINE_MS) {
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
    throw new Error(
      `评测超时 (超过 ${POLL_DEADLINE_MS / 1000} 秒未达到 completed 终态)`,
    );
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

  // 严格断言 15 个聚合 Case
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
    if (
      !c.baseResult.case_input_snapshot ||
      !c.targetResult.case_input_snapshot
    ) {
      throw new Error(`案例 [${c.caseId}] 缺失用例输入快照记录`);
    }
    if (
      typeof c.baseResult.tokens_total !== 'number' ||
      typeof c.targetResult.tokens_total !== 'number'
    ) {
      throw new Error(`案例 [${c.caseId}] Token 用量类型异常`);
    }
    if (
      typeof c.baseResult.estimated_cost_usd !== 'number' ||
      typeof c.targetResult.estimated_cost_usd !== 'number'
    ) {
      throw new Error(`案例 [${c.caseId}] 估算成本类型异常`);
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
  if (
    jsonRes.status !== 200 ||
    !Array.isArray(jsonRes.data?.cases) ||
    jsonRes.data.cases.length !== 15
  ) {
    throw new Error('JSON 效果报告数据不完整');
  }

  // 跨用户隔离验证: 第二用户请求该 run 必须返回 404
  if (otherUserCookie) {
    const crossUserRes = await apiRequest(`/api/eval/runs/${activeRunId}`, {
      cookie: otherUserCookie,
    });
    if (crossUserRes.status !== 404) {
      throw new Error(
        `跨用户权限隔离失败: 第二用户请求返回了 HTTP ${crossUserRes.status} (期望 404)`,
      );
    }
    console.log('   ✓ 第二用户访问返回 HTTP 404，跨用户权限隔离严格生效');
  } else {
    // 验证未认证请求返回 401
    const unauthRes = await apiRequest(`/api/eval/runs/${activeRunId}`, {
      cookie: null,
    });
    if (unauthRes.status !== 401 && unauthRes.status !== 404) {
      throw new Error(
        `未认证访问防护断言失败: 返回了 HTTP ${unauthRes.status}`,
      );
    }
    console.log('   ✓ 未认证访问拦截生效');
  }

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
