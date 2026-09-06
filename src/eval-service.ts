import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  createEvalRun,
  createEvalRunCase,
  getAgentProfileForUser,
  getAgentProfilePromptVersion,
  getEvalRun,
  getEvalRunCase,
  getEvalSuiteWithCases,
  listEvalRunCases,
  updateEvalRun,
  updateEvalRunCaseFeedback,
} from './db.js';
import { buildAgentProfilePrompt } from './agent-profile-prompts.js';
import { estimateKabooModelCostUSD } from './kaboo-pricing.js';
import {
  buildClaudeEnvLines,
  clearInheritedClaudeProviderEnv,
  getClaudeProviderConfig,
} from './runtime-config.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentProfilePromptVersion,
  EvalCase,
  EvalCaseRule,
  EvalCompareSummary,
  EvalHumanFeedback,
  EvalRun,
  EvalRunCase,
  EvalRunCaseDetails,
  EvalRunCaseToolUsage,
  EvalVerdict,
} from './types.js';
import { SYSTEM_EVAL_SUITE_ID } from './eval-builtin-suite.js';

/** Execution provider signature for mockability in tests. */
export type EvalExecutionProvider = (options: {
  prompt: string;
  systemPrompt: string;
  model: string;
  cwd: string;
  abortSignal?: AbortSignal;
  caseId: string;
  versionTag: 'base' | 'target' | 'single';
}) => Promise<{
  output: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolsUsed: EvalRunCaseToolUsage[];
}>;

let customExecutionProvider: EvalExecutionProvider | null = null;

export function setEvalExecutionProvider(
  provider: EvalExecutionProvider | null,
): void {
  customExecutionProvider = provider;
}

// In-memory active runs AbortControllers for cancellation
const activeRunAbortControllers = new Map<string, AbortController>();

/**
 * Deterministic rule-based evaluation engine.
 * Computes a weighted score between 0 and 100 based on matching expected patterns,
 * keywords, format constraints, and safety checks.
 */
export function evaluateOutputAgainstRules(
  output: string,
  rules: EvalCaseRule,
): {
  score: number;
  verdict: EvalVerdict;
  details: EvalRunCaseDetails;
} {
  const text = output || '';
  const matchedKeywords: string[] = [];
  const missingKeywords: string[] = [];
  const matchedForbidden: string[] = [];
  const matchedRegex: string[] = [];
  const failedRegex: string[] = [];
  const missingJsonKeys: string[] = [];
  const reasons: string[] = [];

  let score = 100;

  // 1. Check required keywords
  if (rules.requiredKeywords && rules.requiredKeywords.length > 0) {
    const keywordWeight = 40 / rules.requiredKeywords.length;
    for (const kw of rules.requiredKeywords) {
      if (text.toLowerCase().includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
      } else {
        missingKeywords.push(kw);
        score -= keywordWeight;
        reasons.push(`缺失必需关键词: "${kw}"`);
      }
    }
  }

  // 2. Check forbidden keywords
  if (rules.forbiddenKeywords && rules.forbiddenKeywords.length > 0) {
    for (const fkw of rules.forbiddenKeywords) {
      if (text.toLowerCase().includes(fkw.toLowerCase())) {
        matchedForbidden.push(fkw);
        score -= 40;
        reasons.push(`包含违规/禁止内容: "${fkw}"`);
      }
    }
  }

  // 3. Check regular expression patterns
  if (rules.regexPatterns && rules.regexPatterns.length > 0) {
    const regexWeight = 30 / rules.regexPatterns.length;
    for (const pattern of rules.regexPatterns) {
      try {
        const re = new RegExp(pattern, 'i');
        if (re.test(text)) {
          matchedRegex.push(pattern);
        } else {
          failedRegex.push(pattern);
          score -= regexWeight;
          reasons.push(`未匹配目标模式: /${pattern}/i`);
        }
      } catch {
        failedRegex.push(pattern);
        score -= regexWeight;
      }
    }
  }

  // 4. Check JSON requirement
  let jsonValid = true;
  if (rules.requireJson) {
    let parsedJson: Record<string, unknown> | null = null;
    try {
      // Clean possible codeblock wrappers
      let jsonStr = text.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }
      parsedJson = JSON.parse(jsonStr);
      jsonValid = true;
    } catch {
      jsonValid = false;
      score -= 35;
      reasons.push('输出未能解析为合法的 JSON 格式');
    }

    if (
      jsonValid &&
      parsedJson &&
      rules.requiredJsonKeys &&
      rules.requiredJsonKeys.length > 0
    ) {
      const keyWeight = 20 / rules.requiredJsonKeys.length;
      for (const key of rules.requiredJsonKeys) {
        if (!(key in parsedJson)) {
          missingJsonKeys.push(key);
          score -= keyWeight;
          reasons.push(`JSON 缺少必要键: "${key}"`);
        }
      }
    }
  }

  // 5. Length checks
  let lengthValid = true;
  if (rules.minLength && text.trim().length < rules.minLength) {
    lengthValid = false;
    score -= 15;
    reasons.push(`内容过短 (${text.trim().length} < ${rules.minLength})`);
  }
  if (rules.maxLength && text.trim().length > rules.maxLength) {
    lengthValid = false;
    score -= 15;
    reasons.push(`内容过长 (${text.trim().length} > ${rules.maxLength})`);
  }

  // Clamp score to [0, 100]
  score = Math.max(0, Math.min(100, Math.round(score)));

  const passThreshold = rules.passThreshold ?? 70;
  const passed =
    score >= passThreshold &&
    matchedForbidden.length === 0 &&
    missingKeywords.length === 0;

  return {
    score,
    verdict: passed ? 'pass' : 'fail',
    details: {
      matchedKeywords,
      missingKeywords,
      matchedForbidden,
      matchedRegex,
      failedRegex,
      jsonValid: rules.requireJson ? jsonValid : undefined,
      missingJsonKeys: rules.requireJson ? missingJsonKeys : undefined,
      lengthValid,
      reasons,
    },
  };
}

/**
 * Built-in deterministic fake provider used when real credentials are absent or in tests.
 * Accurately simulates model output, differentiating between base and improved target prompts.
 */
export async function defaultFakeEvalProvider(options: {
  prompt: string;
  systemPrompt: string;
  model: string;
  cwd: string;
  abortSignal?: AbortSignal;
  caseId: string;
  versionTag: 'base' | 'target' | 'single';
}): Promise<{
  output: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolsUsed: EvalRunCaseToolUsage[];
}> {
  if (options.abortSignal?.aborted) {
    throw new Error('Eval execution aborted');
  }

  const isTarget = options.versionTag === 'target';
  const started = Date.now();

  // Deterministic simulation responses for the 15 benchmark cases
  let simulatedOutput = '';
  switch (options.caseId) {
    case 'eval-case-01-refactor-boundary':
      if (isTarget) {
        simulatedOutput = `
interface OrderItem {
  price: number;
  count: number;
}

export function calcTotal(items: OrderItem[] | null | undefined, discountRate: number): number {
  if (!items || !Array.isArray(items) || items.length === 0) return 0;
  if (typeof discountRate !== 'number' || discountRate < 0 || discountRate > 1) {
    throw new Error('Invalid discount rate');
  }
  const sum = items.reduce((acc, item) => acc + (Math.max(0, item.price) * Math.max(0, item.count)), 0);
  return Math.round(sum * (1 - discountRate) * 100) / 100;
}
        `.trim();
      } else {
        // Base version has flaws (missing interface or boundary check)
        simulatedOutput = `
function calcTotal(items: any[], discountRate: any) {
  let sum = 0;
  for (let i = 0; i < items.length; i++) {
    sum += items[i].price * items[i].count;
  }
  return sum * (1 - discountRate);
}
        `.trim();
      }
      break;

    case 'eval-case-02-nginx-sec':
      if (isTarget) {
        simulatedOutput = `
1. 缺少 X-Real-IP 与 X-Forwarded-For 真实客户端头；
2. 缺少 client_max_body_size 限制导致慢溢出攻击风险；
3. 缺少 X-Frame-Options 等安全响应头。

加固配置：
\`\`\`nginx
server {
    listen 80;
    server_name api.example.com;
    client_max_body_size 10M;

    location / {
        proxy_pass http://backend:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
\`\`\`
        `.trim();
      } else {
        simulatedOutput =
          '配置看起来还行，但可以考虑加上 proxy_set_header Host $host;';
      }
      break;

    case 'eval-case-03-json-extract':
      if (isTarget) {
        simulatedOutput = JSON.stringify({
          host: 'node-prod-03',
          status: 'healthy',
          cpu: { user: '18.5%', sys: '3.2%' },
          disk: { free: '380GB', mount: '/data' },
          abnormal_processes: ['zombie-worker', 'stale-log-flusher'],
          timestamp: '2026-09-07T04:00:00Z',
        });
      } else {
        // Base version might include markdown formatting or fail keys
        simulatedOutput = `提取结果如下：\n主机是 node-prod-03，CPU 占用 18.5% user，磁盘还剩 380GB。`;
      }
      break;

    case 'eval-case-04-log-root-cause':
      simulatedOutput = `
1. 根因分析：底层 bank-api 接口响应超时（ETIMEDOUT）是故障的原始根因。
2. 级联雪崩机制：order-service 对超时的 pay-gateway 发起 3 次重试，每次重试再次穿透，引发重试风暴，导致连接池耗尽并返回 504 Gateway Timeout。
3. 治理建议：
   - 引入熔断降级机制（Circuit Breaker），当 downstream 失败率超阈值时快速失败；
   - 重试策略增加指数退避与随机抖动（Jitter），禁止在超时重试上盲目连发。
      `.trim();
      break;

    case 'eval-case-05-sql-optimize':
      simulatedOutput = `
1. 性能瓶颈分析：LIMIT 500000, 20 需要先扫描排序并抛弃前 50 万条整行数据，带来大量回表 IO。
2. 延迟关联优化 SQL：
\`\`\`sql
SELECT o.* FROM orders o
JOIN (
  SELECT id FROM orders
  WHERE user_id = 10023
  ORDER BY created_at DESC
  LIMIT 500000, 20
) tmp ON o.id = tmp.id;
\`\`\`
3. 复合索引语句：
\`\`\`sql
CREATE INDEX idx_user_created ON orders (user_id, created_at DESC);
\`\`\`
      `.trim();
      break;

    case 'eval-case-06-api-validation':
      simulatedOutput = `
校验规则定义：
- username: 长度 3-20 位，正则表达式 ^[a-zA-Z0-9_]{3,20}$
- password: 长度 8-32 位，必须包含大小写、数字及特殊字符中的至少 3 种
- phone: 匹配中国大陆 11 位手机号 ^1[3-9]\\d{9}$

统一错误响应 JSON:
\`\`\`json
{
  "code": "VALIDATION_FAILED",
  "message": "参数校验失败",
  "errors": [
    { "field": "phone", "message": "手机号码格式不合法" }
  ]
}
\`\`\`
      `.trim();
      break;

    case 'eval-case-07-concurrency-race':
      simulatedOutput = `
在高并发热点数据缓存失效瞬间，利用 SingleFlight 或互斥锁（Mutex）保证同一时间只有一个并发请求穿透到数据库，其它并发调用挂起并等待复用该结果。
同时，在设置缓存过期时间时必须加入随机抖动（Jitter，如 base_ttl + rand(0, 30s)），有效预防大量不同热点缓存在同一时刻集中失效造成的雪崩效应。
      `.trim();
      break;

    case 'eval-case-08-restful-standards':
      simulatedOutput = `
审查问题与重构：
1. GET /api/user/deleteUser?id=123 违反 GET 幂等只读语义。重构：DELETE /api/users/123，响应状态码 204 No Content。
2. POST /api/get_order_detail_by_id 包含动词且使用 POST 读数据。重构：GET /api/orders/:id，响应状态码 200 OK。
3. POST /api/updateProductStatus 使用动词。重构：PATCH /api/products/:id/status，响应状态码 200 OK。
      `.trim();
      break;

    case 'eval-case-09-doc-summary':
      simulatedOutput = `
【核心收益】
1. 故障隔离：边缘连接层解耦，单渠道网络抖动不再波及全局服务。
2. 平滑重启：客户端长连接持续维持，热升级实现用户无感。
3. 资源节约：架构精简后服务器内存消耗显著下降 30%。

【潜在风险】
1. 通信开销：跨层引入 IPC 调用增加了网络延迟与传输消耗。
2. 架构复杂度：分布式链路排查与运维监控链条加长。
      `.trim();
      break;

    case 'eval-case-10-cross-platform':
      simulatedOutput = `
环境缺陷：
1. 硬编码斜杠路径拼接在 Windows 容易出现路径分隔符混乱；
2. 未递归创建上级目录，当目录不存在时直接 writeFileSync 会抛出 ENOENT；
3. 依赖 process.cwd() 易受启动工作区不确定性影响。

健壮修复：
\`\`\`js
const path = require('node:path');
const fs = require('node:fs');

const targetDir = path.resolve(process.cwd(), 'data', 'temp');
fs.mkdirSync(targetDir, { recursive: true });
const cachePath = path.join(targetDir, fileName);
fs.writeFileSync(cachePath, content, 'utf8');
\`\`\`
      `.trim();
      break;

    case 'eval-case-11-payment-idempotency':
      simulatedOutput = `
设计流程：
1. 唯一索引防御：在支付流水记录表上以第三方支付凭证 out_trade_no / notify_id 建立 UNIQUE 唯一索引。
2. 状态机严格校验：只有订单状态为 pending 时才允许流转至 paid，已支付状态直接幂等响应成功并忽略。
3. 分布式锁与事务控制：以 order_id 为锁粒度，在数据库事务提交成功后再释放分布式锁与发送后续通知。
      `.trim();
      break;

    case 'eval-case-12-dockerfile-multistage':
      simulatedOutput = `
\`\`\`dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
USER node
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder --chown=node:node /app/dist ./dist
CMD ["node", "dist/index.js"]
\`\`\`
      `.trim();
      break;

    case 'eval-case-13-git-recovery':
      simulatedOutput = `
抢救步骤：
1. 运行 \`git reflog\` 查看近期所有 HEAD 变动历史记录，定位被跳过 commit 的原始 SHA（或 HEAD@{n}）。
2. 使用 \`git cherry-pick <commit-sha>\` 将丢失的提交挑选合入当前分支，或者创建应急分支救回。
原理：Git 的每个 HEAD 变更都会在 reflog 中保留指针记录，只要对象未被 gc 清理即可完整找回。
      `.trim();
      break;

    case 'eval-case-14-privacy-masking':
      simulatedOutput = `
安全合规分析：
明文打印身份证号和银行卡号违反个人信息保护法与等保合规要求，属于重大违规操作，易导致敏感凭据泄露。

通用脱敏掩码实现：
\`\`\`ts
export function maskPhone(phone: string): string {
  return phone.replace(/^(\\d{3})\\d{4}(\\d{4})$/, '$1****$2');
}

export function maskIdCard(idCard: string): string {
  return idCard.replace(/^(\\d{6})\\d{8}(\\d{4})$/, '$1********$2');
}
\`\`\`
      `.trim();
      break;

    case 'eval-case-15-i18n-format':
      simulatedOutput = `
\`\`\`ts
export function formatMessage(
  template: string,
  params?: Record<string, unknown>,
): string {
  if (!template) return '';
  if (!params) return template;
  return template.replace(/\\{(\\w+)\\}/g, (match, key) => {
    return key in params && params[key] !== undefined && params[key] !== null
      ? String(params[key])
      : match;
  });
}
\`\`\`

测试用例覆盖了正常匹配替换、params 为空、以及参数缺失保留原占位符的情况。
      `.trim();
      break;

    default:
      simulatedOutput = `执行完成：针对任务 ${options.caseId} 的处理结果。`;
  }

  // Add minimal delay (skip in test for high execution throughput)
  const delayMs = process.env.NODE_ENV === 'test' ? 0 : 10;
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const durationMs = Math.max(1, Date.now() - started);
  const inputTokens = Math.round(options.prompt.length * 1.5) + 300;
  const outputTokens = Math.round(simulatedOutput.length * 1.2);

  return {
    output: simulatedOutput,
    durationMs,
    inputTokens,
    outputTokens,
    toolsUsed: [],
  };
}

async function executeWithClaudeAgentSdk(options: {
  prompt: string;
  systemPrompt: string;
  model: string;
  cwd: string;
  abortSignal?: AbortSignal;
}): Promise<{
  output: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  toolsUsed: EvalRunCaseToolUsage[];
}> {
  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const env: Record<string, string | undefined> = { ...process.env };
  clearInheritedClaudeProviderEnv(env);
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }

  const startedAt = Date.now();
  let resultText = '';
  const toolsUsed: EvalRunCaseToolUsage[] = [];

  const abortController = new AbortController();
  if (options.abortSignal) {
    options.abortSignal.addEventListener(
      'abort',
      () => abortController.abort(),
      {
        once: true,
      },
    );
  }

  const conversation = query({
    prompt: options.prompt,
    options: {
      model: options.model,
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      env,
      maxTurns: 2,
      tools: [],
      skills: [],
      settingSources: [],
      allowedTools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      abortController,
    },
  });

  for await (const event of conversation) {
    if (event.type === 'result' && event.subtype === 'success') {
      resultText = event.result;
    }
  }

  const durationMs = Date.now() - startedAt;
  const inputTokens =
    Math.round(options.prompt.length * 1.5) +
    Math.round(options.systemPrompt.length * 1.2);
  const outputTokens = Math.round(resultText.length * 1.2);

  return {
    output: resultText.trim(),
    durationMs,
    inputTokens,
    outputTokens,
    toolsUsed,
  };
}

/**
 * Execute a single eval case within an isolated workspace.
 */
async function executeCase(options: {
  evalCase: EvalCase;
  systemPrompt: string;
  model: string;
  runId: string;
  versionTag: 'base' | 'target' | 'single';
  promptVersion: number;
  promptHash: string;
  abortSignal?: AbortSignal;
}): Promise<Omit<EvalRunCase, 'id' | 'created_at' | 'updated_at'>> {
  const {
    evalCase,
    systemPrompt,
    model,
    runId,
    versionTag,
    promptVersion,
    promptHash,
    abortSignal,
  } = options;

  // Isolated workspace directory
  const caseWorkspaceDir = path.join(
    DATA_DIR,
    'eval-workspaces',
    runId,
    `${evalCase.id}-${versionTag}`,
  );
  try {
    fs.mkdirSync(caseWorkspaceDir, { recursive: true });
  } catch {
    // Ignore existing
  }

  let provider = customExecutionProvider;
  if (!provider) {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.EVAL_USE_FAKE_PROVIDER === '1'
    ) {
      provider = defaultFakeEvalProvider;
    } else {
      const config = getClaudeProviderConfig();
      const hasRealProvider = Boolean(
        config.anthropicApiKey ||
        config.anthropicAuthToken ||
        config.claudeCodeOauthToken ||
        config.claudeOAuthCredentials,
      );
      if (hasRealProvider) {
        provider = executeWithClaudeAgentSdk;
      } else {
        provider = defaultFakeEvalProvider;
      }
    }
  }

  try {
    const execResult = await provider({
      prompt: evalCase.input_prompt,
      systemPrompt,
      model,
      cwd: caseWorkspaceDir,
      abortSignal,
      caseId: evalCase.id,
      versionTag,
    });

    // Score against rules
    const evalOutcome = evaluateOutputAgainstRules(
      execResult.output,
      evalCase.eval_rules,
    );

    // Cost estimation
    const estimatedCostUsd = estimateKabooModelCostUSD(model, {
      inputTokens: execResult.inputTokens,
      outputTokens: execResult.outputTokens,
    });

    return {
      run_id: runId,
      case_id: evalCase.id,
      case_name: evalCase.name,
      version_tag: versionTag,
      prompt_version: promptVersion,
      prompt_hash: promptHash,
      status: 'completed',
      actual_output: execResult.output,
      auto_score: evalOutcome.score,
      auto_verdict: evalOutcome.verdict,
      eval_details: evalOutcome.details,
      duration_ms: execResult.durationMs,
      tokens_input: execResult.inputTokens,
      tokens_output: execResult.outputTokens,
      tokens_total: execResult.inputTokens + execResult.outputTokens,
      estimated_cost_usd: estimatedCostUsd,
      tools_used: execResult.toolsUsed,
      human_feedback: null,
      human_notes: null,
      error_message: null,
    };
  } catch (err: unknown) {
    const isAborted =
      abortSignal?.aborted || (err as Error)?.message?.includes('aborted');
    return {
      run_id: runId,
      case_id: evalCase.id,
      case_name: evalCase.name,
      version_tag: versionTag,
      prompt_version: promptVersion,
      prompt_hash: promptHash,
      status: isAborted ? 'cancelled' : 'failed',
      actual_output: '',
      auto_score: 0,
      auto_verdict: 'fail',
      eval_details: {
        reasons: [isAborted ? '用户取消运行' : (err as Error).message],
      },
      duration_ms: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_total: 0,
      estimated_cost_usd: 0,
      tools_used: [],
      human_feedback: null,
      human_notes: null,
      error_message: (err as Error).message || 'Execution failed',
    };
  }
}

/**
 * Start an evaluation run (supports both compare mode and single version mode).
 */
export async function startEvalRun(input: {
  ownerUserId: string;
  agentProfileId: string;
  suiteId?: string;
  mode?: 'single' | 'compare';
  baseVersion?: number;
  targetVersion?: number;
  model?: string;
}): Promise<EvalRun> {
  const { ownerUserId, agentProfileId } = input;
  const profile = getAgentProfileForUser(agentProfileId, ownerUserId);
  if (!profile) {
    throw new Error('智能体配置不存在或无权访问');
  }

  const suiteId = input.suiteId || SYSTEM_EVAL_SUITE_ID;
  const suiteWithCases = getEvalSuiteWithCases(suiteId, ownerUserId);
  if (!suiteWithCases || suiteWithCases.cases.length === 0) {
    throw new Error('评测集不存在或没有可用案例');
  }

  const mode = input.mode || 'compare';
  const targetVersion = input.targetVersion ?? profile.version;
  const baseVersion =
    mode === 'compare'
      ? (input.baseVersion ?? Math.max(1, targetVersion - 1))
      : null;

  // Resolve prompts & hashes
  let basePrompts: Partial<AgentProfilePromptVersion> | null = null;
  let targetPrompts: Partial<AgentProfilePromptVersion> | null = null;

  if (targetVersion === profile.version) {
    targetPrompts = profile;
  } else {
    targetPrompts =
      getAgentProfilePromptVersion(profile.id, ownerUserId, targetVersion) ||
      profile;
  }

  if (mode === 'compare' && baseVersion !== null) {
    if (baseVersion === profile.version) {
      basePrompts = profile;
    } else {
      basePrompts =
        getAgentProfilePromptVersion(profile.id, ownerUserId, baseVersion) ||
        null;
    }
  }

  const basePromptText = basePrompts
    ? buildAgentProfilePrompt(basePrompts)
    : '';
  const targetPromptText = targetPrompts
    ? buildAgentProfilePrompt(targetPrompts)
    : '';

  const basePromptHash = basePrompts
    ? crypto.createHash('sha256').update(basePromptText).digest('hex')
    : null;
  const targetPromptHash = crypto
    .createHash('sha256')
    .update(targetPromptText)
    .digest('hex');

  const config = getClaudeProviderConfig();
  const effectiveModel =
    input.model || config.anthropicModel || 'claude-3-5-sonnet-20241022';

  const runId = `eval-run-${crypto.randomUUID()}`;
  const totalCases = suiteWithCases.cases.length;

  const run = createEvalRun({
    id: runId,
    owner_user_id: ownerUserId,
    agent_profile_id: profile.id,
    agent_name: profile.name,
    suite_id: suiteWithCases.id,
    suite_version: suiteWithCases.version,
    mode,
    base_version: baseVersion,
    base_prompt_hash: basePromptHash,
    target_version: targetVersion,
    target_prompt_hash: targetPromptHash,
    model: effectiveModel,
    capability_snapshot: {
      runtime_policy: profile.runtime_policy,
      prompt_mode: profile.prompt_mode,
      version: profile.version,
    },
    status: 'running',
    total_cases: totalCases,
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

  const abortController = new AbortController();
  activeRunAbortControllers.set(runId, abortController);

  // Asynchronous background execution
  void (async () => {
    try {
      let completedCases = 0;
      let basePassCount = 0;
      let targetPassCount = 0;
      let baseTotalDuration = 0;
      let targetTotalDuration = 0;
      let baseTotalTokens = 0;
      let targetTotalTokens = 0;
      let baseTotalCost = 0;
      let targetTotalCost = 0;

      for (const c of suiteWithCases.cases) {
        if (abortController.signal.aborted) break;

        // 1. Run Base (if compare mode)
        if (mode === 'compare' && baseVersion !== null) {
          const baseResult = await executeCase({
            evalCase: c,
            systemPrompt: basePromptText,
            model: effectiveModel,
            runId,
            versionTag: 'base',
            promptVersion: baseVersion,
            promptHash: basePromptHash || '',
            abortSignal: abortController.signal,
          });
          createEvalRunCase(baseResult);
          if (baseResult.auto_verdict === 'pass') basePassCount++;
          baseTotalDuration += baseResult.duration_ms;
          baseTotalTokens += baseResult.tokens_total;
          baseTotalCost += baseResult.estimated_cost_usd;
        }

        if (abortController.signal.aborted) break;

        // 2. Run Target
        const targetResult = await executeCase({
          evalCase: c,
          systemPrompt: targetPromptText,
          model: effectiveModel,
          runId,
          versionTag: mode === 'compare' ? 'target' : 'single',
          promptVersion: targetVersion,
          promptHash: targetPromptHash,
          abortSignal: abortController.signal,
        });
        createEvalRunCase(targetResult);
        if (targetResult.auto_verdict === 'pass') targetPassCount++;
        targetTotalDuration += targetResult.duration_ms;
        targetTotalTokens += targetResult.tokens_total;
        targetTotalCost += targetResult.estimated_cost_usd;

        completedCases++;

        // Incremental state update in DB
        updateEvalRun(runId, {
          completed_cases: completedCases,
          base_pass_count: basePassCount,
          target_pass_count: targetPassCount,
          base_avg_duration_ms:
            completedCases > 0 ? baseTotalDuration / completedCases : 0,
          target_avg_duration_ms:
            completedCases > 0 ? targetTotalDuration / completedCases : 0,
          base_total_tokens: baseTotalTokens,
          target_total_tokens: targetTotalTokens,
          base_estimated_cost_usd: baseTotalCost,
          target_estimated_cost_usd: targetTotalCost,
        });
      }

      const finalStatus = abortController.signal.aborted
        ? 'cancelled'
        : 'completed';
      updateEvalRun(runId, {
        status: finalStatus,
        completed_cases: completedCases,
        completed_at: new Date().toISOString(),
      });
    } catch (err: unknown) {
      logger.error({ err }, 'Eval run execution failed');
      updateEvalRun(runId, {
        status: 'failed',
        error_message: (err as Error).message || 'Run execution failed',
        completed_at: new Date().toISOString(),
      });
    } finally {
      activeRunAbortControllers.delete(runId);
    }
  })();

  return run;
}

/**
 * Cancel an ongoing eval run.
 */
export function cancelEvalRun(runId: string, ownerUserId: string): boolean {
  const run = getEvalRun(runId, ownerUserId);
  if (!run) return false;
  if (['completed', 'failed', 'cancelled'].includes(run.status)) {
    return false;
  }

  const controller = activeRunAbortControllers.get(runId);
  if (controller) {
    controller.abort();
    activeRunAbortControllers.delete(runId);
  }

  updateEvalRun(runId, {
    status: 'cancelled',
    completed_at: new Date().toISOString(),
  });
  return true;
}

/**
 * Compute the complete comparison summary between Base and Target versions.
 */
export function getEvalRunSummary(
  runId: string,
  ownerUserId?: string,
): EvalCompareSummary | null {
  const run = getEvalRun(runId, ownerUserId);
  if (!run) return null;

  const runCases = listEvalRunCases(runId);

  // Group by caseId
  const caseMap = new Map<
    string,
    {
      caseId: string;
      caseName: string;
      category: string;
      baseResult?: EvalRunCase;
      targetResult?: EvalRunCase;
    }
  >();

  for (const rc of runCases) {
    if (!caseMap.has(rc.case_id)) {
      caseMap.set(rc.case_id, {
        caseId: rc.case_id,
        caseName: rc.case_name,
        category: rc.case_id.split('-')[2] || 'general',
      });
    }
    const item = caseMap.get(rc.case_id)!;
    if (rc.version_tag === 'base') {
      item.baseResult = rc;
    } else {
      item.targetResult = rc;
    }
  }

  const casesList = Array.from(caseMap.values());

  const total = run.total_cases || casesList.length || 1;
  const basePassRate =
    run.base_version !== null
      ? Number(((run.base_pass_count / total) * 100).toFixed(1))
      : 0;
  const targetPassRate = Number(
    ((run.target_pass_count / total) * 100).toFixed(1),
  );

  const improvedCases: string[] = [];
  const regressedCases: string[] = [];
  const unchangedCases: string[] = [];

  for (const c of casesList) {
    const basePassed = c.baseResult?.auto_verdict === 'pass';
    const targetPassed = c.targetResult?.auto_verdict === 'pass';

    if (!basePassed && targetPassed) {
      improvedCases.push(c.caseName);
    } else if (basePassed && !targetPassed) {
      regressedCases.push(c.caseName);
    } else {
      unchangedCases.push(c.caseName);
    }
  }

  return {
    run,
    baseSummary:
      run.base_version !== null
        ? {
            version: run.base_version,
            passCount: run.base_pass_count,
            passRate: basePassRate,
            avgDurationMs: Math.round(run.base_avg_duration_ms),
            totalTokens: run.base_total_tokens,
            estimatedCostUsd: Number(run.base_estimated_cost_usd.toFixed(4)),
          }
        : undefined,
    targetSummary: {
      version: run.target_version || 1,
      passCount: run.target_pass_count,
      passRate: targetPassRate,
      avgDurationMs: Math.round(run.target_avg_duration_ms),
      totalTokens: run.target_total_tokens,
      estimatedCostUsd: Number(run.target_estimated_cost_usd.toFixed(4)),
    },
    delta:
      run.base_version !== null
        ? {
            passRateDelta: Number((targetPassRate - basePassRate).toFixed(1)),
            durationDeltaMs: Math.round(
              run.target_avg_duration_ms - run.base_avg_duration_ms,
            ),
            costDeltaUsd: Number(
              (
                run.target_estimated_cost_usd - run.base_estimated_cost_usd
              ).toFixed(4),
            ),
            improvedCases,
            regressedCases,
            unchangedCases,
          }
        : undefined,
    cases: casesList,
  };
}

/**
 * Generate a clean, downloadable Markdown report for the eval run.
 */
export function generateEvalMarkdownReport(
  runId: string,
  ownerUserId?: string,
): string | null {
  const summary = getEvalRunSummary(runId, ownerUserId);
  if (!summary) return null;

  const { run, baseSummary, targetSummary, delta, cases } = summary;

  const lines: string[] = [];
  lines.push(`# HappyClaw 提示词版本评测与效果验证报告`);
  lines.push('');
  lines.push(`- **评测编号**: \`${run.id}\``);
  lines.push(
    `- **智能体名称**: ${run.agent_name} (\`${run.agent_profile_id}\`)`,
  );
  lines.push(
    `- **评测模式**: ${run.mode === 'compare' ? '双版本对比 (A/B)' : '单版本基准'}`,
  );
  lines.push(
    `- **对比版本**: v${run.base_version ?? '-'} vs v${run.target_version ?? '-'}`,
  );
  lines.push(`- **评测模型**: \`${run.model}\``);
  lines.push(
    `- **评测用例集**: \`${run.suite_id}\` (版本: v${run.suite_version})`,
  );
  lines.push(
    `- **运行状态**: ${run.status} (完成数: ${run.completed_cases}/${run.total_cases})`,
  );
  lines.push(
    `- **评测时间**: ${run.created_at} ~ ${run.completed_at || '进行中'}`,
  );
  lines.push('');

  lines.push(`## 核心对比摘要`);
  lines.push('');
  lines.push(
    `| 评估指标 | 基准版本 (v${run.base_version ?? '-'}) | 目标版本 (v${run.target_version ?? '-'}) | 差异 (Delta) |`,
  );
  lines.push(`| :--- | :--- | :--- | :--- |`);
  lines.push(
    `| **通过率 (Pass Rate)** | ${baseSummary ? `${baseSummary.passRate}% (${baseSummary.passCount}/${run.total_cases})` : '-'} | ${targetSummary ? `${targetSummary.passRate}% (${targetSummary.passCount}/${run.total_cases})` : '-'} | ${delta ? `${delta.passRateDelta >= 0 ? '+' : ''}${delta.passRateDelta}%` : '-'} |`,
  );
  lines.push(
    `| **平均耗时** | ${baseSummary ? `${baseSummary.avgDurationMs} ms` : '-'} | ${targetSummary ? `${targetSummary.avgDurationMs} ms` : '-'} | ${delta ? `${delta.durationDeltaMs >= 0 ? '+' : ''}${delta.durationDeltaMs} ms` : '-'} |`,
  );
  lines.push(
    `| **总 Token 消耗** | ${baseSummary ? baseSummary.totalTokens : '-'} | ${targetSummary ? targetSummary.totalTokens : '-'} | ${delta && targetSummary ? `${targetSummary.totalTokens - (baseSummary?.totalTokens || 0)}` : '-'} |`,
  );
  lines.push(
    `| **估算成本 (USD)** | ${baseSummary ? `$${baseSummary.estimatedCostUsd}` : '-'} | ${targetSummary ? `$${targetSummary.estimatedCostUsd}` : '-'} | ${delta ? `${delta.costDeltaUsd >= 0 ? '+' : ''}$${delta.costDeltaUsd}` : '-'} |`,
  );
  lines.push('');

  if (delta) {
    lines.push(`### 效果波动与回归分析`);
    lines.push('');
    lines.push(
      `- **显著改善用例 (${delta.improvedCases.length})**: ${delta.improvedCases.length > 0 ? delta.improvedCases.map((name) => `\`${name}\``).join(', ') : '无'}`,
    );
    lines.push(
      `- **出现退步用例 (${delta.regressedCases.length})**: ${delta.regressedCases.length > 0 ? delta.regressedCases.map((name) => `\`${name}\``).join(', ') : '无'}`,
    );
    lines.push(
      `- **表现平稳用例 (${delta.unchangedCases.length})**: ${delta.unchangedCases.length} 项`,
    );
    lines.push('');
  }

  lines.push(`## 评测用例逐项明细`);
  lines.push('');
  lines.push(
    `| 编号 | 任务名称 | 分类 | v${run.base_version ?? '-'} 结果 | v${run.target_version ?? '-'} 结果 | 目标分 | 耗时 (ms) | 人工反馈 |`,
  );
  lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);

  for (const c of cases) {
    const baseVerdict = c.baseResult
      ? c.baseResult.auto_verdict === 'pass'
        ? '✅ 通过'
        : '❌ 失败'
      : '-';
    const targetVerdict = c.targetResult
      ? c.targetResult.auto_verdict === 'pass'
        ? '✅ 通过'
        : '❌ 失败'
      : '-';
    const score = c.targetResult ? `${c.targetResult.auto_score}` : '-';
    const duration = c.targetResult ? `${c.targetResult.duration_ms}` : '-';
    const feedback = c.targetResult?.human_feedback
      ? c.targetResult.human_feedback === 'accepted'
        ? '👍 采纳'
        : c.targetResult.human_feedback === 'rejected'
          ? '👎 拒绝'
          : '⚠️ 有缺陷'
      : '未标注';

    lines.push(
      `| \`${c.caseId}\` | ${c.caseName} | ${c.category} | ${baseVerdict} | ${targetVerdict} | ${score} | ${duration} | ${feedback} |`,
    );
  }
  lines.push('');

  lines.push(`## 用例详细判定与人工批注`);
  lines.push('');
  for (const c of cases) {
    lines.push(`### ${c.caseName} (\`${c.caseId}\`)`);
    lines.push('');
    if (c.targetResult) {
      lines.push(
        `- **自动判定结果**: ${c.targetResult.auto_verdict.toUpperCase()} (得分: ${c.targetResult.auto_score}/100)`,
      );
      if (
        c.targetResult.eval_details.reasons &&
        c.targetResult.eval_details.reasons.length > 0
      ) {
        lines.push(
          `- **判定明细**: ${c.targetResult.eval_details.reasons.join('; ')}`,
        );
      }
      lines.push(
        `- **Token 消耗**: ${c.targetResult.tokens_total} (输入: ${c.targetResult.tokens_input}, 输出: ${c.targetResult.tokens_output})`,
      );
      lines.push(
        `- **估算成本**: $${c.targetResult.estimated_cost_usd.toFixed(4)}`,
      );
      lines.push(
        `- **人工反馈**: ${c.targetResult.human_feedback || '未标注'}`,
      );
      if (c.targetResult.human_notes) {
        lines.push(`- **人工批注**: ${c.targetResult.human_notes}`);
      }
      lines.push('');
      lines.push(`#### 实际产出内容 (Target v${run.target_version})`);
      lines.push('```text');
      lines.push(c.targetResult.actual_output || '(无内容)');
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generate a complete JSON report for machine consumption.
 */
export function generateEvalJsonReport(
  runId: string,
  ownerUserId?: string,
): object | null {
  const summary = getEvalRunSummary(runId, ownerUserId);
  if (!summary) return null;
  return summary;
}

/**
 * Record human feedback (accepted / rejected / unresolved) and optional notes for a test case.
 */
export function submitCaseFeedback(options: {
  caseRunId: string;
  ownerUserId: string;
  feedback: EvalHumanFeedback;
  notes?: string | null;
}): EvalRunCase | null {
  const { caseRunId, ownerUserId, feedback, notes } = options;
  const runCase = getEvalRunCase(caseRunId);
  if (!runCase) return null;

  const run = getEvalRun(runCase.run_id, ownerUserId);
  if (!run) return null; // Access control

  return updateEvalRunCaseFeedback(caseRunId, feedback, notes);
}

/**
 * Helper to wait for a run to finish (used in tests or synchronous flows).
 */
export async function waitForEvalRunCompletion(
  runId: string,
  timeoutMs = 15000,
): Promise<EvalRun | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = getEvalRun(runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return getEvalRun(runId);
}
