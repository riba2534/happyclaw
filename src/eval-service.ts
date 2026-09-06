import vm from 'node:vm';
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
  updateEvalRunCase,
  updateEvalRunCaseFeedback,
} from './db.js';
import { buildAgentProfilePrompt } from './agent-profile-prompts.js';
import { estimateKabooModelCostUSD } from './kaboo-pricing.js';
import {
  buildClaudeEnvLines,
  clearInheritedClaudeProviderEnv,
  getEnabledProviders,
  getProviders,
  providerToConfig,
  type ClaudeProviderConfig,
} from './runtime-config.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentProfile,
  AgentProfilePrompts,
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

/** Execution provider signature for mockability in tests only. */
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
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  toolsUsed: EvalRunCaseToolUsage[];
  reportedCostUSD?: number;
}>;

let testInjectedProvider: EvalExecutionProvider | null = null;

/**
 * Strictly restricted test-only hook.
 * Disallows fake execution outside of automated tests to guarantee genuine model evaluation.
 */
export function setEvalExecutionProviderForTests(
  provider: EvalExecutionProvider | null,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'Test execution provider can only be injected in test environment',
    );
  }
  testInjectedProvider = provider;
}

// Backward compatibility alias for test suites
export const setEvalExecutionProvider = setEvalExecutionProviderForTests;

// In-memory active runs AbortControllers for cancellation
const activeRunAbortControllers = new Map<string, AbortController>();

/**
 * Hard-gated rule-based evaluation engine.
 *
 * Requirements act as strict acceptance gates:
 * 1. Missing required keywords => Hard Gate Fail.
 * 2. Matched forbidden keywords => Immediate Disqualification.
 * 3. Invalid JSON or non-plain-object (when requireJson is true) => Hard Gate Fail.
 * 4. Missing required JSON keys => Hard Gate Fail.
 * 5. Failed regex match or ReDoS-dangerous pattern => Hard Gate Fail.
 * 6. Empty output or length violation => Hard Gate Fail.
 *
 * Only when all hard gates pass AND score >= passThreshold can auto_verdict be 'pass'.
 */

/**
 * Custom error class carrying actual accumulated usage even across failures or aborts.
 */
export class SdkExecutionError extends Error {
  accumulatedUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    reasoningTokens: number;
  };
  durationMs: number;
  toolsUsed: EvalRunCaseToolUsage[];
  reportedCostUSD?: number;

  constructor(
    message: string,
    options?: {
      accumulatedUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        reasoningTokens: number;
      };
      durationMs?: number;
      toolsUsed?: EvalRunCaseToolUsage[];
      reportedCostUSD?: number;
    },
  ) {
    super(message);
    this.name = 'SdkExecutionError';
    this.accumulatedUsage = options?.accumulatedUsage;
    this.durationMs = options?.durationMs || 0;
    this.toolsUsed = options?.toolsUsed || [];
    this.reportedCostUSD = options?.reportedCostUSD;
  }
}

/**
 * Execute regex test within a strictly bounded VM context to completely eliminate ReDoS thread locks.
 */
export function safeRegexMatch(
  pattern: string,
  text: string,
  timeoutMs = 150,
): { matched: boolean; timedOut: boolean; error?: string } {
  if (pattern.length > 200) {
    return {
      matched: false,
      timedOut: false,
      error: '正则表达式长度超过200字符限制',
    };
  }

  // Bounded sample to avoid infinite search spaces
  const safeText = text.slice(0, 15000);

  try {
    const sandbox = {
      re: new RegExp(pattern, 'i'),
      text: safeText,
      result: false,
    };
    const context = vm.createContext(sandbox);
    const script = new vm.Script('result = re.test(text)');
    script.runInContext(context, { timeout: timeoutMs });
    return { matched: Boolean(sandbox.result), timedOut: false };
  } catch (err: any) {
    const isTimeout =
      err?.message?.includes('timed out') ||
      err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
    return {
      matched: false,
      timedOut: isTimeout,
      error: isTimeout
        ? `正则匹配执行超时 (${timeoutMs}ms, 防 ReDoS)`
        : err?.message,
    };
  }
}

export function evaluateOutputAgainstRules(
  output: string,
  rules: EvalCaseRule,
): {
  score: number;
  verdict: EvalVerdict;
  details: EvalRunCaseDetails;
} {
  const text = output?.trim() || '';
  const matchedKeywords: string[] = [];
  const missingKeywords: string[] = [];
  const matchedForbidden: string[] = [];
  const matchedRegex: string[] = [];
  const failedRegex: string[] = [];
  const missingJsonKeys: string[] = [];
  const failedHardGates: string[] = [];
  const reasons: string[] = [];

  let score = 100;
  let isHardGatePassed = true;

  // Gate 0: Non-empty output check
  if (!text) {
    failedHardGates.push('模型输出为空');
    reasons.push('模型输出为空，任务未完成');
    return {
      score: 0,
      verdict: 'fail',
      details: {
        lengthValid: false,
        failedHardGates,
        gateExplanation: 'Hard Gate 未通过: 模型输出为空',
        reasons,
      },
    };
  }

  // Gate 1: Required keywords (all must be present)
  if (rules.requiredKeywords && rules.requiredKeywords.length > 0) {
    const kwWeight = 50 / rules.requiredKeywords.length;
    for (const kw of rules.requiredKeywords) {
      if (text.toLowerCase().includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
      } else {
        missingKeywords.push(kw);
        score -= kwWeight;
        reasons.push(`缺失必需关键词: "${kw}"`);
      }
    }
    if (missingKeywords.length > 0) {
      isHardGatePassed = false;
      failedHardGates.push(`缺失必需关键词 (${missingKeywords.join(', ')})`);
    }
  }

  // Gate 2: Forbidden keywords (none must be present)
  if (rules.forbiddenKeywords && rules.forbiddenKeywords.length > 0) {
    for (const fkw of rules.forbiddenKeywords) {
      if (text.toLowerCase().includes(fkw.toLowerCase())) {
        matchedForbidden.push(fkw);
        score -= 60;
        reasons.push(`命中违禁/禁止内容: "${fkw}"`);
      }
    }
    if (matchedForbidden.length > 0) {
      isHardGatePassed = false;
      failedHardGates.push(`命中违禁内容 (${matchedForbidden.join(', ')})`);
    }
  }

  // Gate 3: Regular expressions with bounded VM execution for absolute ReDoS safety
  if (rules.regexPatterns && rules.regexPatterns.length > 0) {
    const rxWeight = 30 / rules.regexPatterns.length;
    for (const pattern of rules.regexPatterns) {
      const matchOutcome = safeRegexMatch(pattern, text, 150);
      if (matchOutcome.matched) {
        matchedRegex.push(pattern);
      } else {
        failedRegex.push(pattern);
        score -= rxWeight;
        if (matchOutcome.timedOut) {
          reasons.push(`正则表达式匹配超时 (防 ReDoS): /${pattern}/`);
        } else if (matchOutcome.error) {
          reasons.push(`正则匹配失败: ${matchOutcome.error}`);
        } else {
          reasons.push(`未匹配必需正则模式: /${pattern}/i`);
        }
      }
    }

    if (failedRegex.length > 0) {
      isHardGatePassed = false;
      failedHardGates.push(`未匹配必需正则模式 (${failedRegex.join(', ')})`);
    }
  }

  // Gate 4: JSON object validation & key presence protection
  let jsonValid = true;
  if (rules.requireJson) {
    let parsedJson: unknown = null;
    try {
      let jsonStr = text;
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }
      parsedJson = JSON.parse(jsonStr);
    } catch {
      jsonValid = false;
      score -= 60;
      reasons.push('输出未能解析为合法 JSON');
      failedHardGates.push('输出未能解析为合法 JSON');
      isHardGatePassed = false;
    }

    if (jsonValid) {
      const isPlainObject =
        parsedJson !== null &&
        typeof parsedJson === 'object' &&
        !Array.isArray(parsedJson);

      if (!isPlainObject) {
        jsonValid = false;
        score -= 50;
        reasons.push(
          'JSON 顶层必须为 Key-Value Object 字典，不支持 Primitive 或 Array',
        );
        failedHardGates.push('JSON 结构必须为 Object 字典');
        isHardGatePassed = false;
      } else {
        const objRecord = parsedJson as Record<string, unknown>;
        if (rules.requiredJsonKeys && rules.requiredJsonKeys.length > 0) {
          const keyWeight = 30 / rules.requiredJsonKeys.length;
          for (const key of rules.requiredJsonKeys) {
            const hasKey = Object.prototype.hasOwnProperty.call(objRecord, key);
            if (!hasKey || objRecord[key] === undefined) {
              missingJsonKeys.push(key);
              score -= keyWeight;
              reasons.push(`JSON 缺少必需键: "${key}"`);
            }
          }
          if (missingJsonKeys.length > 0) {
            isHardGatePassed = false;
            failedHardGates.push(
              `JSON 缺失必需键 (${missingJsonKeys.join(', ')})`,
            );
          }
        }
      }
    }
  }

  // Gate 5: Length constraints
  let lengthValid = true;
  if (rules.minLength && text.length < rules.minLength) {
    lengthValid = false;
    score -= 20;
    reasons.push(`输出长度不足 (${text.length} < ${rules.minLength})`);
    failedHardGates.push(`输出长度不足 (<${rules.minLength})`);
    isHardGatePassed = false;
  }
  if (rules.maxLength && text.length > rules.maxLength) {
    lengthValid = false;
    score -= 20;
    reasons.push(`输出长度超标 (${text.length} > ${rules.maxLength})`);
    failedHardGates.push(`输出长度超标 (>${rules.maxLength})`);
    isHardGatePassed = false;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const passThreshold = rules.passThreshold ?? 70;
  const passed = isHardGatePassed && score >= passThreshold;

  const gateExplanation = isHardGatePassed
    ? '所有必需验收门禁均已通过'
    : `必需验收门禁未通过: ${failedHardGates.join('; ')}`;

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
      failedHardGates: failedHardGates.length > 0 ? failedHardGates : undefined,
      gateExplanation,
      reasons,
    },
  };
}

/**
 * Resolve authorized model provider and configuration for the agent.
 * Respects agent.model_config_id if pinned, otherwise resolves to the enabled provider.
 * Throws actionable errors if providers are missing, disabled, or unconfigured.
 */
export function resolveAgentModelExecutionConfig(
  profile: AgentProfile,
  modelOverride?: string,
): {
  providerId: string;
  providerName: string;
  model: string;
  providerConfig: ClaudeProviderConfig;
  customEnv?: Record<string, string>;
} {
  const providers = getProviders();

  if (profile.model_config_id) {
    const matched = providers.find((p) => p.id === profile.model_config_id);
    if (!matched) {
      throw new Error(
        `智能体绑定的模型配置 [${profile.model_config_id}] 不存在，无法启动评测`,
      );
    }
    if (!matched.enabled) {
      throw new Error(
        `智能体绑定的模型配置 [${matched.name || profile.model_config_id}] 已被禁用，无法启动评测`,
      );
    }
    return {
      providerId: matched.id,
      providerName: matched.name,
      model:
        modelOverride || matched.anthropicModel || 'claude-3-5-sonnet-20241022',
      providerConfig: providerToConfig(matched),
      customEnv: matched.customEnv,
    };
  }

  const enabled = getEnabledProviders();
  if (enabled.length === 0) {
    throw new Error(
      '系统没有启用的模型 Provider 配置，请先在模型配置页面启用一个 Provider',
    );
  }

  const defaultProvider = enabled[0];
  return {
    providerId: defaultProvider.id,
    providerName: defaultProvider.name,
    model:
      modelOverride ||
      defaultProvider.anthropicModel ||
      'claude-3-5-sonnet-20241022',
    providerConfig: providerToConfig(defaultProvider),
    customEnv: defaultProvider.customEnv,
  };
}

export async function executeWithClaudeAgentSdk(options: {
  prompt: string;
  systemPrompt: string;
  model: string;
  providerConfig: ClaudeProviderConfig;
  customEnv?: Record<string, string>;
  cwd: string;
  abortSignal?: AbortSignal;
}): Promise<{
  output: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  toolsUsed: EvalRunCaseToolUsage[];
  reportedCostUSD?: number;
}> {
  const envLines = buildClaudeEnvLines(
    options.providerConfig,
    options.customEnv,
  );
  const env: Record<string, string | undefined> = { ...process.env };
  clearInheritedClaudeProviderEnv(env);
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }

  const startedAt = Date.now();
  let resultText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let reasoningTokens = 0;
  let reportedCostUSD: number | undefined;
  const toolMap = new Map<string, number>();
  const seenToolUseIds = new Set<string>();

  const abortController = new AbortController();
  if (options.abortSignal) {
    options.abortSignal.addEventListener(
      'abort',
      () => abortController.abort(),
      { once: true },
    );
  }

  const conversation = query({
    prompt: options.prompt,
    options: {
      model: options.model,
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
      env,
      maxTurns: 3,
      tools: [],
      skills: [],
      settingSources: [],
      allowedTools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      abortController,
    },
  });

  try {
    for await (const message of conversation) {
      // 1. Primary authority: Result event usage & modelUsage
      if (message.type === 'result') {
        const isApiError =
          (message as any).is_error === true || message.subtype !== 'success';
        if (!isApiError) {
          resultText = message.result || '';
        }

        const rawUsage = (message as any).usage;
        if (rawUsage) {
          inputTokens =
            rawUsage.input_tokens ?? rawUsage.inputTokens ?? inputTokens;
          outputTokens =
            rawUsage.output_tokens ?? rawUsage.outputTokens ?? outputTokens;
          cacheReadTokens =
            rawUsage.cache_read_input_tokens ??
            rawUsage.cacheReadInputTokens ??
            cacheReadTokens;
          cacheCreationTokens =
            rawUsage.cache_creation_input_tokens ??
            rawUsage.cacheCreationInputTokens ??
            cacheCreationTokens;
          reasoningTokens =
            rawUsage.reasoning_output_tokens ??
            rawUsage.reasoningTokens ??
            reasoningTokens;
        }
        const rawModelUsage = (message as any).modelUsage;
        if (rawModelUsage && typeof rawModelUsage === 'object') {
          let mInput = 0;
          let mOutput = 0;
          let mCacheRead = 0;
          let mCacheCreate = 0;
          let mReasoning = 0;
          let mCost = 0;
          for (const mUsage of Object.values(rawModelUsage) as any[]) {
            if (mUsage && typeof mUsage === 'object') {
              mInput += mUsage.inputTokens ?? 0;
              mOutput += mUsage.outputTokens ?? 0;
              mCacheRead += mUsage.cacheReadInputTokens ?? 0;
              mCacheCreate += mUsage.cacheCreationInputTokens ?? 0;
              mReasoning += mUsage.reasoningTokens ?? 0;
              if (typeof mUsage.costUSD === 'number') {
                mCost += mUsage.costUSD;
              }
            }
          }
          if (mInput > 0) inputTokens = mInput;
          if (mOutput > 0) outputTokens = mOutput;
          if (mCacheRead > 0) cacheReadTokens = mCacheRead;
          if (mCacheCreate > 0) cacheCreationTokens = mCacheCreate;
          if (mReasoning > 0) reasoningTokens = mReasoning;
          if (mCost > 0) reportedCostUSD = mCost;
        }
        if (typeof (message as any).total_cost_usd === 'number') {
          reportedCostUSD = (message as any).total_cost_usd;
        }

        // Intercept API errors: error text must never masquerade as completed output
        if (isApiError) {
          const errDetail =
            (message as any).result ||
            (Array.isArray((message as any).errors)
              ? (message as any).errors.join('; ')
              : null) ||
            `SDK execution ended with subtype: ${message.subtype}`;
          throw new SdkExecutionError(`API Error: ${errDetail}`, {
            accumulatedUsage: {
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheCreationTokens,
              reasoningTokens,
            },
            durationMs: Math.max(1, Date.now() - startedAt),
            toolsUsed: Array.from(toolMap.entries()).map(([name, count]) => ({
              name,
              count,
            })),
          });
        }
      }

      // 2. Stream events usage observation
      if (message.type === 'stream_event') {
        const ev = (message as any).event;
        if (ev?.type === 'message_start' && ev.message?.usage) {
          inputTokens = ev.message.usage.input_tokens ?? inputTokens;
          cacheReadTokens =
            ev.message.usage.cache_read_input_tokens ?? cacheReadTokens;
          cacheCreationTokens =
            ev.message.usage.cache_creation_input_tokens ?? cacheCreationTokens;
        }
        if (ev?.type === 'message_delta' && ev.usage) {
          outputTokens = ev.usage.output_tokens ?? outputTokens;
        }
      }

      // 3. Tool use observation with tool_use_id deduplication
      if (
        message.type === 'tool_progress' ||
        message.type === 'tool_use_summary'
      ) {
        const toolId =
          (message as any).tool_use_id || (message as any).toolUseId;
        const toolName =
          (message as any).tool_name || (message as any).toolName || 'tool';
        if (toolId && toolName && !seenToolUseIds.has(toolId)) {
          seenToolUseIds.add(toolId);
          toolMap.set(toolName, (toolMap.get(toolName) || 0) + 1);
        }
      } else if (message.type === 'assistant') {
        const assistantContent = (message as any).message?.content;
        if (Array.isArray(assistantContent)) {
          for (const block of assistantContent) {
            if (block?.type === 'tool_use' && block.name) {
              const toolId =
                block.id || `${block.name}-${toolMap.get(block.name) || 0}`;
              if (!seenToolUseIds.has(toolId)) {
                seenToolUseIds.add(toolId);
                toolMap.set(block.name, (toolMap.get(block.name) || 0) + 1);
              }
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof SdkExecutionError) {
      throw err;
    }
    throw new SdkExecutionError((err as Error).message || 'SDK Query Failure', {
      accumulatedUsage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        reasoningTokens,
      },
      durationMs: Math.max(1, Date.now() - startedAt),
      toolsUsed: Array.from(toolMap.entries()).map(([name, count]) => ({
        name,
        count,
      })),
      reportedCostUSD,
    });
  }

  if (!resultText.trim() && !abortController.signal.aborted) {
    throw new SdkExecutionError('模型执行未产生有效输出内容', {
      accumulatedUsage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        reasoningTokens,
      },
      durationMs: Math.max(1, Date.now() - startedAt),
      toolsUsed: Array.from(toolMap.entries()).map(([name, count]) => ({
        name,
        count,
      })),
      reportedCostUSD,
    });
  }

  const durationMs = Math.max(1, Date.now() - startedAt);
  const toolsUsed: EvalRunCaseToolUsage[] = Array.from(toolMap.entries()).map(
    ([name, count]) => ({ name, count }),
  );

  return {
    output: resultText.trim(),
    durationMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    toolsUsed,
    reportedCostUSD,
  };
}

/**
 * Execute a single eval case within an isolated workspace.
 */
async function executeCase(options: {
  evalCase: EvalCase;
  systemPrompt: string;
  model: string;
  providerConfig?: ClaudeProviderConfig;
  customEnv?: Record<string, string>;
  runId: string;
  versionTag: 'base' | 'target' | 'single';
  promptVersion: number;
  promptHash: string;
  abortSignal?: AbortSignal;
}): Promise<
  Omit<EvalRunCase, 'id' | 'created_at' | 'updated_at'> & {
    case_input_snapshot: string;
    case_expected_snapshot: string;
    case_rules_snapshot: EvalCaseRule;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    reasoning_tokens: number;
  }
> {
  const {
    evalCase,
    systemPrompt,
    model,
    providerConfig,
    customEnv,
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
  } catch {}

  const startedAt = Date.now();

  try {
    let execResult: {
      output: string;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      reasoningTokens?: number;
      toolsUsed: EvalRunCaseToolUsage[];
      reportedCostUSD?: number;
    };

    // Use test injected provider if strictly in test scope
    if (process.env.NODE_ENV === 'test' && testInjectedProvider) {
      execResult = await testInjectedProvider({
        prompt: evalCase.input_prompt,
        systemPrompt,
        model,
        cwd: caseWorkspaceDir,
        abortSignal,
        caseId: evalCase.id,
        versionTag,
      });
    } else {
      if (!providerConfig) {
        throw new Error('未配置有效的模型 Provider，无法执行评测');
      }
      execResult = await executeWithClaudeAgentSdk({
        prompt: evalCase.input_prompt,
        systemPrompt,
        model,
        providerConfig,
        customEnv,
        cwd: caseWorkspaceDir,
        abortSignal,
      });
    }

    if (!execResult.output && !abortSignal?.aborted) {
      throw new Error('模型执行未产生有效输出内容');
    }

    // Score against rules
    const evalOutcome = evaluateOutputAgainstRules(
      execResult.output,
      evalCase.eval_rules,
    );

    // Cost estimation
    const estimatedCostUsd =
      execResult.reportedCostUSD !== undefined
        ? execResult.reportedCostUSD
        : estimateKabooModelCostUSD(model, {
            inputTokens: execResult.inputTokens,
            outputTokens: execResult.outputTokens,
            cacheReadInputTokens: execResult.cacheReadTokens,
            cacheCreationInputTokens: execResult.cacheCreationTokens,
            reasoningTokens: execResult.reasoningTokens,
          });

    return {
      run_id: runId,
      case_id: evalCase.id,
      case_name: evalCase.name,
      category: evalCase.category || 'general',
      case_input_snapshot: evalCase.input_prompt,
      case_expected_snapshot: evalCase.expected_output,
      case_rules_snapshot: evalCase.eval_rules,
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
      cache_read_tokens: execResult.cacheReadTokens || 0,
      cache_creation_tokens: execResult.cacheCreationTokens || 0,
      reasoning_tokens: execResult.reasoningTokens || 0,
      estimated_cost_usd: estimatedCostUsd,
      tools_used: execResult.toolsUsed,
      human_feedback: null,
      human_notes: null,
      error_message: null,
    };
  } catch (err: unknown) {
    const isAborted =
      abortSignal?.aborted || (err as Error)?.message?.includes('aborted');

    // Retain real accumulated usage even on failure or abort (defense against 0cost loss)
    const sdkErr = err instanceof SdkExecutionError ? err : null;
    const tokensInput = sdkErr?.accumulatedUsage?.inputTokens ?? 0;
    const tokensOutput = sdkErr?.accumulatedUsage?.outputTokens ?? 0;
    const cacheReadTokens = sdkErr?.accumulatedUsage?.cacheReadTokens ?? 0;
    const cacheCreationTokens =
      sdkErr?.accumulatedUsage?.cacheCreationTokens ?? 0;
    const reasoningTokens = sdkErr?.accumulatedUsage?.reasoningTokens ?? 0;
    const toolsUsed = sdkErr?.toolsUsed ?? [];

    const estimatedCostUsd =
      tokensInput > 0 || tokensOutput > 0
        ? estimateKabooModelCostUSD(model, {
            inputTokens: tokensInput,
            outputTokens: tokensOutput,
            cacheReadInputTokens: cacheReadTokens,
            cacheCreationInputTokens: cacheCreationTokens,
            reasoningTokens,
          })
        : 0;

    return {
      run_id: runId,
      case_id: evalCase.id,
      case_name: evalCase.name,
      category: evalCase.category || 'general',
      case_input_snapshot: evalCase.input_prompt,
      case_expected_snapshot: evalCase.expected_output,
      case_rules_snapshot: evalCase.eval_rules,
      version_tag: versionTag,
      prompt_version: promptVersion,
      prompt_hash: promptHash,
      status: isAborted ? 'cancelled' : 'failed',
      actual_output: '',
      auto_score: 0,
      auto_verdict: 'fail',
      eval_details: {
        failedHardGates: [
          isAborted ? '用户取消运行' : `执行失败: ${(err as Error).message}`,
        ],
        gateExplanation: isAborted ? '运行被主动取消' : '执行遇到异常中断',
        reasons: [(err as Error).message || 'Execution failed'],
      },
      duration_ms: sdkErr?.durationMs || Math.max(1, Date.now() - startedAt),
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      tokens_total: tokensInput + tokensOutput,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      reasoning_tokens: reasoningTokens,
      estimated_cost_usd: estimatedCostUsd,
      tools_used: toolsUsed,
      human_feedback: null,
      human_notes: null,
      error_message: (err as Error).message || 'Execution failed',
    };
  }
}

/**
 * Start an evaluation run (supports both compare mode and single version mode).
 * Performs strict existence and ownership validation on all prompt versions.
 */

/**
 * Safely clean up physical isolated workspace directories for a completed/cancelled/deleted run.
 */
export function cleanupEvalRunWorkspace(runId: string): void {
  try {
    const wsDir = path.join(DATA_DIR, 'eval-workspaces', runId);
    if (fs.existsSync(wsDir)) {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn({ err, runId }, 'Failed to clean up eval workspace directory');
  }
}

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

  // 1. Strict targetVersion existence & ownership validation
  const targetVersion = input.targetVersion ?? profile.version;
  let targetPrompts: AgentProfilePrompts;

  if (targetVersion === profile.version) {
    targetPrompts = {
      identity_prompt: profile.identity_prompt,
      soul_prompt: profile.soul_prompt,
      agents_prompt: profile.agents_prompt,
      tools_prompt: profile.tools_prompt,
      prompt_mode: profile.prompt_mode,
    };
  } else {
    const versionRow = getAgentProfilePromptVersion(
      profile.id,
      ownerUserId,
      targetVersion,
    );
    if (!versionRow) {
      throw new Error(
        `目标提示词版本 v${targetVersion} 不存在或不属于当前智能体`,
      );
    }
    targetPrompts = {
      identity_prompt: versionRow.identity_prompt,
      soul_prompt: versionRow.soul_prompt,
      agents_prompt: versionRow.agents_prompt,
      tools_prompt: versionRow.tools_prompt,
      prompt_mode: versionRow.prompt_mode,
    };
  }

  // 2. Strict baseVersion existence & ownership validation (compare mode)
  let basePrompts: AgentProfilePrompts | null = null;
  let baseVersion: number | null = null;

  if (mode === 'compare') {
    if (input.baseVersion === undefined || input.baseVersion === null) {
      throw new Error('对比模式必须指定基准版本 base_version');
    }
    baseVersion = input.baseVersion;
    if (baseVersion === profile.version) {
      basePrompts = {
        identity_prompt: profile.identity_prompt,
        soul_prompt: profile.soul_prompt,
        agents_prompt: profile.agents_prompt,
        tools_prompt: profile.tools_prompt,
        prompt_mode: profile.prompt_mode,
      };
    } else {
      const versionRow = getAgentProfilePromptVersion(
        profile.id,
        ownerUserId,
        baseVersion,
      );
      if (!versionRow) {
        throw new Error(
          `基准提示词版本 v${baseVersion} 不存在或不属于当前智能体`,
        );
      }
      basePrompts = {
        identity_prompt: versionRow.identity_prompt,
        soul_prompt: versionRow.soul_prompt,
        agents_prompt: versionRow.agents_prompt,
        tools_prompt: versionRow.tools_prompt,
        prompt_mode: versionRow.prompt_mode,
      };
    }
  }

  const basePromptText = basePrompts
    ? buildAgentProfilePrompt(basePrompts)
    : '';
  const targetPromptText = buildAgentProfilePrompt(targetPrompts);

  const basePromptHash = basePrompts
    ? crypto.createHash('sha256').update(basePromptText).digest('hex')
    : null;
  const targetPromptHash = crypto
    .createHash('sha256')
    .update(targetPromptText)
    .digest('hex');

  // 3. Resolve execution provider and ensure real credentials unless test mock is injected
  const isTestExecution =
    process.env.NODE_ENV === 'test' && testInjectedProvider !== null;
  let resolvedModelConfig: ReturnType<
    typeof resolveAgentModelExecutionConfig
  > | null = null;

  if (!isTestExecution) {
    resolvedModelConfig = resolveAgentModelExecutionConfig(
      profile,
      input.model,
    );
    const hasCredentials = Boolean(
      resolvedModelConfig.providerConfig.anthropicApiKey ||
      resolvedModelConfig.providerConfig.anthropicAuthToken ||
      resolvedModelConfig.providerConfig.claudeCodeOauthToken ||
      resolvedModelConfig.providerConfig.claudeOAuthCredentials,
    );
    if (!hasCredentials) {
      throw new Error(
        `智能体授权 Provider [${resolvedModelConfig.providerName}] 未配置有效凭据，无法启动真实评测`,
      );
    }
  }

  const effectiveModel =
    resolvedModelConfig?.model || input.model || 'claude-3-5-sonnet-20241022';
  const providerSource = isTestExecution ? 'test_mock' : 'live_provider';
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
    provider_source: providerSource,
    capability_snapshot: {
      requested_agent_policy: {
        runtime_policy: profile.runtime_policy,
        prompt_mode: profile.prompt_mode,
        version: profile.version,
      },
      effective_execution_boundary: {
        provider_id: resolvedModelConfig?.providerId || 'test_injected',
        provider_name:
          resolvedModelConfig?.providerName || 'Test Injected Provider',
        model: effectiveModel,
        model_config_id: profile.model_config_id || null,
        sandbox_isolation: {
          fs: 'isolated_eval_workspace',
          network: 'model_api_only',
          tools_policy:
            'eval_safe_isolation_sandbox: external write tools are strictly restricted',
        },
      },
      prompts_snapshot: {
        base: basePrompts,
        target: targetPrompts,
      },
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

  // Pre-create all test cases with pending status so state is durable against restarts or cancellation
  const preCreatedCaseIds = new Map<string, string>();
  for (const c of suiteWithCases.cases) {
    if (mode === 'compare' && baseVersion !== null) {
      const baseCase = createEvalRunCase({
        run_id: runId,
        case_id: c.id,
        case_name: c.name,
        category: c.category || 'general',
        case_input_snapshot: c.input_prompt,
        case_expected_snapshot: c.expected_output,
        case_rules_snapshot: c.eval_rules,
        version_tag: 'base',
        prompt_version: baseVersion,
        prompt_hash: basePromptHash || '',
        status: 'pending',
        actual_output: '',
        auto_score: 0,
        auto_verdict: 'fail',
        eval_details: {},
        duration_ms: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_total: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost_usd: 0,
        tools_used: [],
        human_feedback: null,
        human_notes: null,
        error_message: null,
      });
      preCreatedCaseIds.set(`${c.id}-base`, baseCase.id);
    }

    const targetCase = createEvalRunCase({
      run_id: runId,
      case_id: c.id,
      case_name: c.name,
      category: c.category || 'general',
      case_input_snapshot: c.input_prompt,
      case_expected_snapshot: c.expected_output,
      case_rules_snapshot: c.eval_rules,
      version_tag: mode === 'compare' ? 'target' : 'single',
      prompt_version: targetVersion,
      prompt_hash: targetPromptHash,
      status: 'pending',
      actual_output: '',
      auto_score: 0,
      auto_verdict: 'fail',
      eval_details: {},
      duration_ms: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_total: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      reasoning_tokens: 0,
      estimated_cost_usd: 0,
      tools_used: [],
      human_feedback: null,
      human_notes: null,
      error_message: null,
    });
    preCreatedCaseIds.set(
      `${c.id}-${mode === 'compare' ? 'target' : 'single'}`,
      targetCase.id,
    );
  }

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
          const baseCaseDbId = preCreatedCaseIds.get(`${c.id}-base`)!;
          updateEvalRunCase(baseCaseDbId, { status: 'running' });

          const baseResult = await executeCase({
            evalCase: c,
            systemPrompt: basePromptText,
            model: effectiveModel,
            providerConfig: resolvedModelConfig?.providerConfig,
            customEnv: resolvedModelConfig?.customEnv,
            runId,
            versionTag: 'base',
            promptVersion: baseVersion,
            promptHash: basePromptHash || '',
            abortSignal: abortController.signal,
          });

          updateEvalRunCase(baseCaseDbId, baseResult);

          if (baseResult.auto_verdict === 'pass') basePassCount++;
          baseTotalDuration += baseResult.duration_ms;
          baseTotalTokens += baseResult.tokens_total;
          baseTotalCost += baseResult.estimated_cost_usd;
        }

        if (abortController.signal.aborted) break;

        // 2. Run Target
        const targetTag = mode === 'compare' ? 'target' : 'single';
        const targetCaseDbId = preCreatedCaseIds.get(`${c.id}-${targetTag}`)!;
        updateEvalRunCase(targetCaseDbId, { status: 'running' });

        const targetResult = await executeCase({
          evalCase: c,
          systemPrompt: targetPromptText,
          model: effectiveModel,
          providerConfig: resolvedModelConfig?.providerConfig,
          customEnv: resolvedModelConfig?.customEnv,
          runId,
          versionTag: targetTag,
          promptVersion: targetVersion,
          promptHash: targetPromptHash,
          abortSignal: abortController.signal,
        });

        updateEvalRunCase(targetCaseDbId, targetResult);

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

      // If aborted, mark any remaining pending cases as cancelled
      if (abortController.signal.aborted) {
        const remainingCases = listEvalRunCases(runId).filter(
          (rc) => rc.status === 'pending' || rc.status === 'running',
        );
        for (const rc of remainingCases) {
          updateEvalRunCase(rc.id, {
            status: 'cancelled',
            error_message: '运行已取消',
          });
        }
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
      cleanupEvalRunWorkspace(runId);
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
  if (
    ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
  ) {
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

  // Mark all pending or running cases as cancelled
  const cases = listEvalRunCases(runId).filter(
    (rc) => rc.status === 'pending' || rc.status === 'running',
  );
  for (const rc of cases) {
    updateEvalRunCase(rc.id, {
      status: 'cancelled',
      error_message: '用户主动取消评测',
    });
  }

  cleanupEvalRunWorkspace(runId);
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
        category: rc.category || 'general',
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
  lines.push(`- **执行来源**: \`${run.provider_source}\``);
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
      lines.push(`- **分类**: ${c.category}`);
      lines.push(
        `- **自动判定结果**: ${c.targetResult.auto_verdict.toUpperCase()} (得分: ${c.targetResult.auto_score}/100)`,
      );
      if (c.targetResult.eval_details.gateExplanation) {
        lines.push(
          `- **门禁检验**: ${c.targetResult.eval_details.gateExplanation}`,
        );
      }
      if (
        c.targetResult.eval_details.reasons &&
        c.targetResult.eval_details.reasons.length > 0
      ) {
        lines.push(
          `- **判定明细**: ${c.targetResult.eval_details.reasons.join('; ')}`,
        );
      }
      lines.push(
        `- **Token 消耗**: ${c.targetResult.tokens_total} (输入: ${c.targetResult.tokens_input}, 输出: ${c.targetResult.tokens_output}, 缓存读取: ${c.targetResult.cache_read_tokens})`,
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
    if (
      !run ||
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
    ) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return getEvalRun(runId);
}
