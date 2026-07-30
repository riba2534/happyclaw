/**
 * HappyClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import {
  query,
  HookCallback,
  PreCompactHookInput,
  createSdkMcpServer,
  type Query,
  type SDKAssistantMessageError,
  type SDKControlGetContextUsageResponse,
  type SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { detectImageMimeTypeFromBase64Strict } from './image-detector.js';
import { pruneProcessedHistoryImagesInTranscript as pruneProcessedHistoryImagesInTranscriptFile } from './history-image-prune.js';
import { getChannelFromJid } from './channel-prefixes.js';

import type {
  ContainerInput,
  ContainerOutput,
  ImageMediaType,
  SessionsIndex,
  SDKUserMessage,
  ParsedMessage,
  StreamEvent,
  ChannelTurnContext,
} from './types.js';
import {
  formatChannelTurnContextForPrompt,
  normalizeChannelTurnContext,
} from './types.js';
import type { ClaudeContextAudit } from './stream-event.types.js';
export type { StreamEventType, StreamEvent } from './types.js';

import {
  sanitizeFilename,
  generateFallbackName,
  isSuspectTruncatedStreamResult,
  shouldForceBackgroundTaskSummary,
  buildBackgroundTaskSummaryPrompt,
  AssistantTextTracker,
} from './utils.js';
import {
  extractSessionHistory as extractSessionHistoryImpl,
  parseTranscript,
} from './session-history.js';
import { StreamEventProcessor } from './stream-processor.js';
import {
  acknowledgeHappyClawOwnerProfileFirstWake,
  createMcpTools,
  fetchHappyClawOwnerProfileTurn,
  fetchWorkspaceMemorySnapshot,
  type McpContext,
  type WorkspaceMemorySnapshot,
} from './mcp-tools.js';
import { HappyClawFirstWakeAcknowledger } from './owner-profile-first-wake.js';
import {
  createSerializedAsyncTrigger,
  loadWorkspaceMemoryTurnContext,
} from './workspace-memory-context.js';
import { loadHappyClawOwnerProfileTurnContext } from './owner-profile-context.js';
import { createWorkspaceMemoryWriteGuard } from './workspace-memory-runtime.js';
import {
  parseAgentMcpPolicyMode,
  resolveAgentMcpPolicy,
} from './runtime-mcp-policy.js';
import {
  IpcTurnDeliveryTracker,
  IpcTurnOutputCorrelation,
  isHealthyInputTurnCompletion,
  latestIpcDeliveryId,
  latestIpcInputMessage,
  orderIpcInputMessages,
  parseIpcReceipt,
  partitionIpcMessagesForLogicalTurn,
  requeueIpcInputMessages,
  resolveLogicalQueryInputTurnId,
  shouldAcceptIpcMessagesDuringQuery,
  type IpcDeliveryReceipt,
  type IpcInputMessage,
} from './ipc-delivery.js';
import {
  isExtendedContextModel,
  resolveAutoCompactWindow,
  resolveLegacyAutoCompactWindow,
} from './context-window.js';
import {
  resolveClaudeProviderRuntime,
  resolveClaudeQueryModelRuntime,
} from './provider-runtime.js';
import {
  decideProviderLimitAction,
  isAccountProviderAssistantError,
  ProviderFallbackModelState,
  ProviderFallbackTurnLedger,
  type ProviderFallbackRetryTurn,
} from './provider-fallback.js';
import {
  runSdkControlWithTimeout,
  SdkFirstResponseWatchdog,
} from './sdk-control.js';
import {
  createResultUsageState,
  extractResultUsage,
  type SdkModelUsage,
  type SdkResultUsage,
} from './result-usage.js';
import {
  AssistantUsageCollector,
  type AssistantUsageBatch,
} from './assistant-usage.js';
import { buildHappyClawPromptPlan, type PromptPlan } from './prompt-plan.js';
import { withHappyClawSubagentContract } from './sdk-compat.js';
import { assessContextBudget } from './context-budget.js';
import {
  findClaudeMdExcludeLeaks,
  resolveManagedHostClaudeMdExcludes,
} from './claude-memory-policy.js';
import {
  anchorAgentProfileToUserTurn,
  resolveAgentTurnAnchor,
  shouldAnchorInitialAgentTurn,
} from './agent-turn-contract.js';
import { prepareMessageStreamText } from './message-stream-text.js';
import {
  DurableInputTurnCompletion,
  QuiescentResultGate,
  shouldFailIncompleteQueryExit,
} from './background-task-drain.js';

// 路径解析：优先读取环境变量，降级到容器内默认路径（保持向后兼容）
const WORKSPACE_GROUP =
  process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';

// 第三方端点必须显式配置模型，官方 Claude 则允许 SDK/CLI 选择默认模型。
// host/docker runner 会注入权威端点类型；旧运行环境仍可由 base URL 兼容推断。
const CLAUDE_PROVIDER_RUNTIME = resolveClaudeProviderRuntime(process.env);
const PROVIDER_FALLBACK_MODELS = new ProviderFallbackModelState(
  CLAUDE_PROVIDER_RUNTIME.model,
  process.env.HAPPYCLAW_FALLBACK_MODEL,
);

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_FALLBACK_POLL_MS = 5000; // 后备轮询间隔（仅防止 inotify 事件丢失）

let hadCompaction = false;
// Module-level session ID so SIGTERM handler can emit it before exit.
// Updated in main() whenever a query returns a new session.
let latestSessionId: string | undefined;
// Durable identity of the SDK input turn that currently owns runner output.
// writeOutput snapshots it into every frame so direct status/error/session
// frames cannot silently lose correlation just because they bypass emit().
let activeOutputInputTurnId: string | undefined;

const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  // 'Skill' removed: since SDK 0.3.x skills are enabled via the `skills` option
  // (skills: 'all' below), not by listing a 'Skill' tool here. Keeping the dead
  // entry just invited confusion.
  'TodoWrite',
  'ToolSearch',
  'NotebookEdit',
  'mcp__happyclaw__*',
];

let activeAgentMcpPolicy = resolveAgentMcpPolicy('inherit');

const IMAGE_MAX_DIMENSION = 8000; // Anthropic API 限制

// ── 系统提示词从独立 Markdown 文件加载（启动期一次性 readFileSync 缓存到模块级常量）──
// 文件位于 container/agent-runner/prompts/，便于改提示词无需重编译 + CR 友好。

// 用 fileURLToPath 而非 new URL(...).pathname：后者在 Windows host 模式上返回
// "/E:/.../index.js"（带前导斜杠 + 盘符），path.join 后会丢盘符变成 "\E:\..."，
// 再被 Node 按当前盘根解析成 "E:\E:\..." 导致 ENOENT。fileURLToPath 在
// Linux 容器与 Windows host 模式下都返回正确的本地路径。
const PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
);

function loadPrompt(...segments: string[]): string {
  return fs
    .readFileSync(path.join(PROMPTS_DIR, ...segments), 'utf-8')
    .trimEnd();
}

// 解析本地依赖 @anthropic-ai/claude-code 的真实 CLI binary 路径。
// 该包 postinstall 会把平台对应的 native binary 落地到其 `bin` 字段指向的位置
// （Windows / macOS / Linux 一致），作为 SDK 的 pathToClaudeCodeExecutable 最可靠来源——
// 它不依赖 PATH，也不会命中 SDK optionalDependencies 里那些空的 native binary 占位包。
function resolveBundledClaudeCli(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath =
      require.resolve('@anthropic-ai/claude-code/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
      bin?: string | Record<string, string>;
    };
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
    if (!binRel) return undefined;
    const binPath = path.join(path.dirname(pkgJsonPath), binRel);
    if (!fs.existsSync(binPath)) return undefined;
    // postinstall replaces the ~500-byte shell stub with the real native binary;
    // if it hasn't run, the stub is still there — skip so we fall through to which/where.
    const size = fs.statSync(binPath).size;
    return size > 4096 ? binPath : undefined;
  } catch {
    return undefined;
  }
}

const SECURITY_RULES = loadPrompt('security-rules.md');
const INTERACTION_GUIDELINES = loadPrompt('interaction.md');
const ASSISTANT_OUTPUT_GUIDELINES = loadPrompt('output.assistant.md');
const PROACTIVE_OUTPUT_GUIDELINES = loadPrompt('output.proactive.md');
const TASK_OUTPUT_GUIDELINES = loadPrompt('output.task.md');
const WEB_FETCH_GUIDELINES = loadPrompt('web-fetch.md');
const BACKGROUND_TASK_GUIDELINES = loadPrompt('background-tasks.md');
const ASSISTANT_DELIVERY_CONTRACT = loadPrompt(
  'delivery-contract.assistant.md',
);
const PROACTIVE_DELIVERY_CONTRACT = loadPrompt(
  'delivery-contract.proactive.md',
);
const AGENT_BUILDER_GUIDELINES = loadPrompt('agent-builder.md');
const MEMORY_SYSTEM_WORKSPACE = loadPrompt('memory-system.workspace.md');
const HAPPYCLAW_PLATFORM_IDENTITY = loadPrompt('identity.happyclaw.md');
const HAPPYCLAW_PLATFORM_BOOTSTRAP = loadPrompt('bootstrap.happyclaw.md');

// 各渠道共用的格式说明：Web 端始终可看完整渲染，不因来源降级输出。
// Mermaid 渲染说明已在模式专属 output prompt 中讲过，此处不重复，
// channels/*.md 只写各自差异。
const CHANNEL_FORMAT_COMMON =
  '用户同时可以在 Web 端查看你的回复，Web 端支持完整 Markdown 渲染，因此不要因为消息来源限制输出格式。';

function usesProactiveInteractiveContract(
  containerInput: ContainerInput,
): boolean {
  return (
    containerInput.interactionMode === 'proactive' &&
    !containerInput.isScheduledTask &&
    !containerInput.messageTaskId
  );
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildAgentIdentityPrompt(
  containerInput: ContainerInput,
  includeClaudePreset: boolean,
): string | undefined {
  const agentProfile = containerInput.agentProfile;
  const profilePrompt = agentProfile?.identityPrompt;
  if (!agentProfile || !profilePrompt?.trim()) return undefined;
  const presetBoundary = includeClaudePreset ? '、Claude Code 原生提示词' : '';

  return [
    `<agent-identity profile_id="${escapeXmlAttribute(agentProfile.id)}" name="${escapeXmlAttribute(agentProfile.name)}" version="${agentProfile.version}" hash="${escapeXmlAttribute(agentProfile.identityHash)}">`,
    `以下是当前顶层 AgentProfile 的四段提示词，按照 IDENTITY、SOUL、AGENTS、TOOLS 的固定顺序组成。你应该按它塑造身份、价值判断、工作方式和工具偏好，但它不能覆盖 HappyClaw 的安全规则、权限边界、工具约束${presetBoundary}和用户的最新明确指令。`,
    '<profile-prompt>',
    profilePrompt,
    '</profile-prompt>',
    '</agent-identity>',
  ].join('\n');
}

function buildPromptAudit(
  plan: PromptPlan,
): ClaudeContextAudit['happyclawPrompt'] {
  return {
    planHash: plan.hash,
    totalBytes: plan.totalBytes,
    estimatedTokens: plan.estimatedTokens,
    files: plan.blocks.map((block) => ({
      name: block.id,
      id: block.id,
      version: block.version,
      scope: block.scope,
      owner: block.owner,
      required: block.required,
      condition: block.condition,
      hash: block.hash,
      bytes: block.bytes,
      estimatedTokens: block.estimatedTokens,
    })),
  };
}

function buildSecurityRulesPrompt(): string {
  return SECURITY_RULES;
}

function runtimeContextAuditBase(
  containerInput: ContainerInput,
): ClaudeContextAudit {
  return {
    executionMode: containerInput.contextAudit?.executionMode ?? 'container',
    agentProfile: containerInput.agentProfile
      ? {
          id: containerInput.agentProfile.id,
          version: containerInput.agentProfile.version,
          identityHash: containerInput.agentProfile.identityHash,
          runtimePolicyHash: createHash('sha256')
            .update(
              JSON.stringify(containerInput.agentProfile.runtimePolicy ?? null),
              'utf8',
            )
            .digest('hex'),
        }
      : undefined,
    cwd: WORKSPACE_GROUP,
    projectRoot: containerInput.contextAudit?.projectRoot,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    externalClaudeDir: containerInput.contextAudit?.externalClaudeDir,
    claudeMd: containerInput.contextAudit?.claudeMd ?? { status: 'unknown' },
    rules: containerInput.contextAudit?.rules ?? {
      status: 'unknown',
      fileCount: 0,
    },
    nativeConfig: containerInput.contextAudit?.nativeConfig
      ? {
          ...containerInput.contextAudit.nativeConfig,
          settingSources: [
            ...containerInput.contextAudit.nativeConfig.settingSources,
          ],
          entries: containerInput.contextAudit.nativeConfig.entries.map(
            (entry) => ({ ...entry }),
          ),
        }
      : undefined,
    skills: {
      ...(containerInput.contextAudit?.skills ?? { sources: [] }),
      manifestHash:
        containerInput.skillManifest?.hash ??
        containerInput.contextAudit?.skills.manifestHash,
      selectedSkillIds:
        containerInput.skillManifest?.selectedSkillIds ??
        containerInput.contextAudit?.skills.selectedSkillIds,
    },
    mcp: containerInput.contextAudit?.mcp
      ? {
          manifestHash: containerInput.contextAudit.mcp.manifestHash,
          serverIds: [...containerInput.contextAudit.mcp.serverIds],
        }
      : undefined,
    happyclawPrompt: containerInput.contextAudit?.happyclawPrompt ?? {
      totalBytes: 0,
      files: [],
    },
    warnings: [...(containerInput.contextAudit?.warnings ?? [])],
  };
}

function classifySkillSource(
  source: string,
): ClaudeContextAudit['skills']['sources'][number]['name'] {
  if (source.includes('/opt/builtin-skills')) return 'builtin';
  if (source.includes('/external-skills')) return 'external';
  if (
    source.includes('/workspace-skills') ||
    source.includes('/workspace/group/.claude/skills')
  )
    return 'workspace';
  if (
    source.includes('/project-skills') ||
    source.includes('/container/skills')
  )
    return 'project';
  if (source.includes('/user-skills') || source.includes('/data/skills/'))
    return 'managed';
  if (source.includes('/.claude/skills')) return 'user';
  if (source.includes('/plugins/')) return 'plugin';
  return 'unknown';
}

function pathMatches(candidate: string, expected?: string): boolean {
  if (!expected) return false;
  return (
    candidate === expected ||
    candidate.endsWith(expected) ||
    expected.endsWith(candidate)
  );
}

function enrichContextAudit(
  baseAudit: ClaudeContextAudit,
  promptAudit: ClaudeContextAudit['happyclawPrompt'],
  ctxUsage?: SDKControlGetContextUsageResponse,
): ClaudeContextAudit {
  const audit: ClaudeContextAudit = {
    ...baseAudit,
    cwd: WORKSPACE_GROUP,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    happyclawPrompt: promptAudit,
    warnings: [...baseAudit.warnings],
    claudeMd: { ...baseAudit.claudeMd },
    rules: { ...baseAudit.rules },
    skills: {
      ...baseAudit.skills,
      sources: [...baseAudit.skills.sources],
    },
  };

  if (!ctxUsage) {
    audit.warnings.push('SDK context usage unavailable');
    return audit;
  }

  audit.sdkContextUsage = ctxUsage;

  const memoryFiles = ctxUsage.memoryFiles ?? [];
  const excludedMemoryLeaks = findClaudeMdExcludeLeaks(
    memoryFiles,
    audit.claudeMdExcludes ?? [],
  );
  if (excludedMemoryLeaks.length > 0) {
    audit.warnings.push(
      `managed context isolation failed; SDK loaded excluded memory: ${excludedMemoryLeaks.join(', ')}`,
    );
  }
  const claudeMemory = memoryFiles.find(
    (file) =>
      pathMatches(file.path, audit.claudeMd.runtimePath) ||
      pathMatches(file.path, audit.claudeMd.sourcePath),
  );
  if (claudeMemory) {
    audit.claudeMd.loaded = true;
    audit.claudeMd.tokens = claudeMemory.tokens;
  } else if (
    audit.claudeMd.status === 'linked' ||
    audit.claudeMd.status === 'mounted'
  ) {
    audit.claudeMd.loaded = false;
    audit.warnings.push('CLAUDE.md not reported by SDK memoryFiles');
  }

  const loadedRuleFiles = memoryFiles
    .filter(
      (file) =>
        pathMatches(file.path, audit.rules.runtimePath) ||
        pathMatches(file.path, audit.rules.sourcePath) ||
        file.path.includes('/rules/'),
    )
    .map((file) => ({ path: file.path, tokens: file.tokens }));
  audit.rules.loadedFiles = loadedRuleFiles;
  audit.rules.loadedFileCount = loadedRuleFiles.length;
  if (audit.rules.fileCount > 0 && loadedRuleFiles.length === 0) {
    audit.warnings.push('rules not loaded by SDK');
  }

  if (ctxUsage.skills) {
    audit.skills.totalSkills = ctxUsage.skills.totalSkills;
    audit.skills.includedSkills = ctxUsage.skills.includedSkills;
    audit.skills.tokens = ctxUsage.skills.tokens;
    if (ctxUsage.skills.totalSkills > 150)
      audit.warnings.push('skills count > 150');
    if (ctxUsage.skills.tokens > 15000)
      audit.warnings.push('skills tokens > 15000');

    const tokensBySource = new Map<string, number>();
    for (const skill of ctxUsage.skills.skillFrontmatter ?? []) {
      const key = classifySkillSource(skill.source);
      tokensBySource.set(
        key,
        (tokensBySource.get(key) ?? 0) + (skill.tokens ?? 0),
      );
    }
    audit.skills.sources = audit.skills.sources.map((source) => ({
      ...source,
      tokens: tokensBySource.get(source.name) ?? source.tokens,
    }));
  }

  return audit;
}

// 启动期扫描 prompts/channels/*.md，文件名（去 .md 后缀）= channel key（feishu / telegram / qq / dingtalk / ...）
// 新增渠道时只需在 channels/ 下加一个 .md 文件，无需改代码。
const CHANNEL_GUIDELINES: Record<string, string> = (() => {
  const channelsDir = path.join(PROMPTS_DIR, 'channels');
  const result: Record<string, string> = {};
  if (!fs.existsSync(channelsDir)) return result;
  for (const file of fs.readdirSync(channelsDir)) {
    if (!file.endsWith('.md')) continue;
    const channelKey = file.slice(0, -'.md'.length);
    result[channelKey] = fs
      .readFileSync(path.join(channelsDir, file), 'utf-8')
      .trimEnd();
  }
  return result;
})();

/**
 * 规范化图片 MIME：
 * - 优先使用声明值（若合法且与内容一致）
 * - 若声明缺失或与内容不一致，使用内容识别值
 * - 最后兜底 image/jpeg
 */
function resolveImageMimeType(img: {
  data: string;
  mimeType?: string;
}): ImageMediaType {
  const declared =
    typeof img.mimeType === 'string' && img.mimeType.startsWith('image/')
      ? img.mimeType.toLowerCase()
      : undefined;
  const detected = detectImageMimeTypeFromBase64Strict(img.data);

  if (declared && detected && declared !== detected) {
    log(
      `Image MIME mismatch: declared=${declared}, detected=${detected}, using detected`,
    );
    return detected as ImageMediaType;
  }

  return (declared || detected || 'image/jpeg') as ImageMediaType;
}

/**
 * 从 base64 编码的图片数据中提取宽高（支持 PNG / JPEG / GIF / WebP / BMP）。
 * 仅解析头部字节，不需要完整解码图片。
 * 返回 null 表示无法识别格式。
 */
function getImageDimensions(
  base64Data: string,
): { width: number; height: number } | null {
  try {
    const headerB64 = base64Data.slice(0, 400);
    const buf = Buffer.from(headerB64, 'base64');

    // PNG: 固定位置 (bytes 16-23)
    if (
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // JPEG: 扫描 SOF marker（SOF 可能在大 EXIF/ICC 之后，需要 ~30KB）
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      const JPEG_SCAN_B64_LEN = 40000; // ~30KB binary，覆盖大多数 EXIF/ICC 场景
      const fullHeader = Buffer.from(
        base64Data.slice(0, JPEG_SCAN_B64_LEN),
        'base64',
      );
      for (let i = 2; i < fullHeader.length - 9; i++) {
        if (fullHeader[i] !== 0xff) continue;
        const marker = fullHeader[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            width: fullHeader.readUInt16BE(i + 7),
            height: fullHeader.readUInt16BE(i + 5),
          };
        }
        if (marker !== 0xd8 && marker !== 0xd9 && marker !== 0x00) {
          i += 1 + fullHeader.readUInt16BE(i + 2);
        }
      }
    }

    // GIF: bytes 6-9 (little-endian)
    if (
      buf.length >= 10 &&
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46
    ) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    // BMP: bytes 18-25
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return {
        width: buf.readInt32LE(18),
        height: Math.abs(buf.readInt32LE(22)),
      };
    }

    // WebP
    if (
      buf.length >= 30 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46
    ) {
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ' && buf.length >= 30)
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      if (fourCC === 'VP8L' && buf.length >= 25) {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fourCC === 'VP8X' && buf.length >= 30)
        return {
          width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
          height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
        };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 过滤超过 API 尺寸限制的图片。
 */
function filterOversizedImages(
  images: Array<{ data: string; mimeType?: string }>,
): { valid: Array<{ data: string; mimeType?: string }>; rejected: string[] } {
  const valid: Array<{ data: string; mimeType?: string }> = [];
  const rejected: string[] = [];
  for (const img of images) {
    const dims = getImageDimensions(img.data);
    if (
      dims &&
      (dims.width > IMAGE_MAX_DIMENSION || dims.height > IMAGE_MAX_DIMENSION)
    ) {
      const reason = `图片尺寸 ${dims.width}×${dims.height} 超过 API 限制（最大 ${IMAGE_MAX_DIMENSION}px），已跳过`;
      log(reason);
      rejected.push(reason);
    } else {
      valid.push(img);
    }
  }
  return { valid, rejected };
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(
    text: string,
    images?: Array<{ data: string; mimeType?: string }>,
    decorateText?: (text: string) => string,
  ): string[] {
    // stream.done=true 后禁止写入已关闭的 SDK transport，否则触发 "ProcessTransport is not ready for writing"
    if (this.done) {
      return [
        'Stream already ended, message will be processed in the next query',
      ];
    }

    const rejectedReasons: string[] = [];
    const originalImageCount = images?.length ?? 0;
    let filteredImages = images;

    if (filteredImages && filteredImages.length > 0) {
      const { valid, rejected } = filterOversizedImages(filteredImages);
      rejectedReasons.push(...rejected);
      filteredImages = valid.length > 0 ? valid : undefined;
    }

    // 每条 user message 前置当前本地时间，让 agent 能正确推理相对时间 / schedule_task 的
    // once/cron 取值（#563）。刻意放在 user message（缓存前缀之后的未缓存区）而非 system
    // prompt：① 不会因每 turn 时间不同而击穿整段 system+历史的 prompt cache；② 长会话里
    // 每个 turn 都拿到新鲜时间，而非会话启动那一刻的陈旧时间。
    const effectiveText = prepareMessageStreamText({
      text,
      originalImageCount,
      validImageCount: filteredImages?.length ?? 0,
      maxImageDimension: IMAGE_MAX_DIMENSION,
      decorateText,
    });

    let content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | {
              type: 'image';
              source: {
                type: 'base64';
                media_type: ImageMediaType;
                data: string;
              };
            }
        >;

    if (filteredImages && filteredImages.length > 0) {
      // 多模态消息：text + images
      content = [
        { type: 'text', text: effectiveText },
        ...filteredImages.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: resolveImageMimeType(img),
            data: img.data,
          },
        })),
      ];
    } else {
      // 纯文本消息
      content = effectiveText;
    }

    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
    return rejectedReasons;
  }

  get ended(): boolean {
    return this.done;
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';
const SDK_CONTEXT_USAGE_TIMEOUT_MS = 5_000;
const SDK_FIRST_RESPONSE_TIMEOUT_MS = 60_000;
const SDK_PROVIDER_FAILURE_EXIT_GRACE_MS = 250;

function writeOutput(output: ContainerOutput): void {
  const correlatedOutput: ContainerOutput = activeOutputInputTurnId
    ? { ...output, inputTurnId: output.inputTurnId ?? activeOutputInputTurnId }
    : output;
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(correlatedOutput));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Failures the operator must see. The host consumes runner stderr at debug
 * level, so plain log() lines vanish from production logs entirely; this
 * prefix is elevated to warn by the host's stderr handler.
 */
function logWarn(message: string): void {
  console.error(`[agent-runner:warn] ${message}`);
}

function generateTurnId(): string {
  return `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize isMain/isHome/isAdminHome flags for backward compatibility.
 * If the host sends the old `isMain` field, treat it as isHome=true + isAdminHome=true.
 */
function normalizeHomeFlags(input: ContainerInput): {
  isHome: boolean;
  isAdminHome: boolean;
} {
  if (input.isHome !== undefined) {
    return { isHome: !!input.isHome, isAdminHome: !!input.isAdminHome };
  }
  // Legacy: isMain was the only flag
  const legacy = !!input.isMain;
  return { isHome: legacy, isAdminHome: legacy };
}

function resolveAgentBuilderEnabled(
  input: ContainerInput,
  isHome: boolean,
): boolean {
  return (
    input.agentBuilderEnabled ??
    (isHome && !input.agentId && !input.isScheduledTask)
  );
}

/**
 * 检测是否为上下文溢出错误
 */
function isContextOverflowError(msg: string): boolean {
  const patterns: RegExp[] = [
    /prompt is too long/i,
    /maximum context length/i,
    /context.*too large/i,
    /exceeds.*token limit/i,
    /context window.*exceeded/i,
  ];
  return patterns.some((pattern) => pattern.test(msg));
}

/**
 * 检测会话转录中不可恢复的请求错误（400 invalid_request_error）。
 * 这类错误被固化在会话历史中，每次 resume 都会重放导致永久失败。
 * 例如：图片尺寸超过 8000px 限制、图片 MIME 声明与真实内容不一致等。
 *
 * 判定条件：必须同时满足「图片特征」+「API 拒绝」，避免对通用 400 错误误判导致会话丢失。
 */
function isImageMimeMismatchError(msg: string): boolean {
  return (
    /image\s+was\s+specified\s+using\s+the\s+image\/[a-z0-9.+-]+\s+media\s+type,\s+but\s+the\s+image\s+appears\s+to\s+be\s+(?:an?\s+)?image\/[a-z0-9.+-]+\s+image/i.test(
      msg,
    ) ||
    /image\/[a-z0-9.+-]+\s+media\s+type.*appears\s+to\s+be.*image\/[a-z0-9.+-]+/i.test(
      msg,
    )
  );
}

function isUnrecoverableTranscriptError(msg: string): boolean {
  const isImageSizeError =
    /image.*dimensions?\s+exceed/i.test(msg) ||
    /max\s+allowed\s+size.*pixels/i.test(msg);
  const isMimeMismatch = isImageMimeMismatchError(msg);
  const isApiReject = /invalid_request_error/i.test(msg);
  return isApiReject && (isImageSizeError || isMimeMismatch);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Trim session JSONL file by removing all entries before the last compact_boundary.
 * After compaction, entries before the boundary are already summarized and no longer
 * needed for session reconstruction. This prevents unbounded file growth.
 *
 * Safety: uses atomic write (tmp + rename) to avoid data loss on crash.
 */
function trimSessionJsonl(jsonlPath: string): void {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n');
    const nonEmptyLines: { index: number; line: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) nonEmptyLines.push({ index: i, line: lines[i] });
    }

    // Find the last compact_boundary entry (and any preserved segment it references)
    let lastBoundaryPos = -1;
    let preservedHeadUuid: string | undefined;
    let parseSkipped = 0;
    for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(nonEmptyLines[i].line);
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          lastBoundaryPos = i;
          preservedHeadUuid =
            entry.compact_metadata?.preserved_segment?.head_uuid;
          break;
        }
      } catch {
        parseSkipped++;
      }
    }
    if (parseSkipped > 0) {
      log(`Session trim: skipped ${parseSkipped} unparseable JSONL lines`);
    }

    if (lastBoundaryPos <= 0) {
      // No boundary found or it's already the first entry — nothing to trim
      log('Session trim: no compact_boundary found or already minimal');
      return;
    }

    // partial compaction 时 boundary 带 preserved_segment{head_uuid, anchor_uuid, tail_uuid}：
    // 保留段内容是 head_uuid..tail_uuid，SDK 的 resume loader 会在 anchor_uuid 处把它拼回。
    // 若裁切越过 head_uuid，会连同这些消息及其 uuid 一起删掉，导致 loader 找不到锚点、resume
    // 丢上下文。因此把裁切起点回退到 head_uuid 所在行，保住整段保留消息。
    let trimStartPos = lastBoundaryPos;
    if (preservedHeadUuid) {
      const preservedPos = nonEmptyLines.findIndex((e) => {
        try {
          return JSON.parse(e.line).uuid === preservedHeadUuid;
        } catch {
          return false;
        }
      });
      if (preservedPos >= 0 && preservedPos < trimStartPos) {
        trimStartPos = preservedPos;
        log(
          `Session trim: preserving segment from head_uuid=${preservedHeadUuid.slice(0, 8)} (pos ${preservedPos} < boundary ${lastBoundaryPos})`,
        );
      }
    }

    // Keep entries from trimStartPos onwards
    const trimmedLines = nonEmptyLines.slice(trimStartPos).map((e) => e.line);
    const removedCount = trimStartPos;

    const TRIM_MIN_ENTRIES = 50; // Skip trimming if fewer entries before boundary (not worth the I/O)
    if (removedCount < TRIM_MIN_ENTRIES) {
      log(
        `Session trim: only ${removedCount} entries before boundary, skipping`,
      );
      return;
    }

    // Atomic write: temp file + rename
    const tmpPath = jsonlPath + '.trim-tmp';
    fs.writeFileSync(tmpPath, trimmedLines.join('\n') + '\n');
    fs.renameSync(tmpPath, jsonlPath);

    const sizeBefore = Buffer.byteLength(content, 'utf-8');
    const sizeAfter = fs.statSync(jsonlPath).size;
    log(
      `Session trim: ${nonEmptyLines.length} → ${trimmedLines.length} entries (removed ${removedCount}), ` +
        `${(sizeBefore / 1024 / 1024).toFixed(1)}MB → ${(sizeAfter / 1024 / 1024).toFixed(1)}MB`,
    );
  } catch (err) {
    log(
      `Session trim failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Archive the full transcript to conversations/ before compaction.
 * Also flush any accumulated streaming text as a compact_partial message
 * so users don't lose the response that was being generated.
 * Finally, trim the JSONL file to remove already-compacted history.
 */
function createPreCompactHook(deps: {
  emit: (output: ContainerOutput) => void;
  getFullText: () => string;
  resetFullText: () => void;
}): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    // Skip sub-agent compactions — they'd archive the unchanged main transcript
    // and set hadCompaction, triggering a spurious main-session auto-continue.
    if (preCompact.agent_id) {
      log(
        `PreCompact: skipping sub-agent compact (agent_id=${preCompact.agent_id})`,
      );
      return {};
    }

    // ── Flush accumulated streaming text as compact_partial ──
    // This ensures users see the partial response even after compaction.
    const partialText = deps.getFullText();
    if (partialText.trim()) {
      log(
        `PreCompact: flushing ${partialText.length} chars as compact_partial`,
      );
      deps.emit({
        status: 'success',
        result: partialText,
        sourceKind: 'compact_partial',
        finalizationReason: 'completed',
      });
      deps.resetFullText();
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Trim session JSONL to prevent unbounded growth ──
    // Remove entries before the last compact_boundary (already summarized).
    // Must run AFTER archiving (archive needs full transcript).
    trimSessionJsonl(transcriptPath);

    // Flag compaction so the query loop auto-continues instead of
    // waiting for user input (non-blocking compaction #229).
    hadCompaction = true;

    return {};
  };
}

/**
 * SDK transcript 目录推导。CLI 的 projects 目录编码把 cwd 中**所有非字母数字
 * 字符**替换为 '-'（实测 `/a/enc_test.v1` → `-a-enc-test-v1`，`.` `_` 均被
 * 替换）——不能只替换 '/'，否则含 `.`/`_` 的 customCwd 会推导出不存在的目录。
 */
function resolveTranscriptDir(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || '/home/node', '.claude');
  const encodedCwd = WORKSPACE_GROUP.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(configDir, 'projects', encodedCwd);
}

function extractSessionHistory(oldSessionId: string): string | null {
  return extractSessionHistoryImpl({
    transcriptDir: resolveTranscriptDir(),
    sessionId: oldSessionId,
    log,
  });
}

// Resume 重放防御的 uuid 增量缓存：transcript 是 append-only JSONL，同一
// sessionId 的多次 runQuery（每条 warm 消息、auto-continue）
// 只需读上次之后新增的字节，避免每条消息全量重扫（长会话 O(M²) 阻塞 I/O）。
// 文件被截断重写（trimSessionFile）时按文件粒度重建。
let transcriptUuidCache: {
  sessionId: string;
  fileSizes: Map<string, number>;
  uuids: Set<string>;
} | null = null;

const TRANSCRIPT_UUID_RE =
  /"uuid":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;

/**
 * Resume 重放防御：SDK 的 `--resume` 可能把旧 transcript 的 assistant/user
 * 消息重放给 for-await 消费者，且消息上没有 isReplay 标记（实测 string-prompt
 * 模式下干净会话 resume 会重放上一轮 assistant + result；streaming 模式下
 * 带孤儿后台任务的会话 resume 会合成 init/result 对）。收集旧 transcript
 *（主会话 + subagents，含嵌套子目录）里已有消息的 uuid，for-await 中命中即
 * 跳过——否则重放的旧 assistant 文本会混进 assistantTextTracker 造成回复
 * 重复历史内容。
 * 注意：result 不写入 transcript（CLI 重放时现场合成、uuid 全新），无法用
 * 本集合判别——调用方用 num_turns===0 指纹 + 活体信号双重判别，且该判别
 * 不依赖本函数成功（本函数 fail 时重放 result 仍会被拦住）。
 * 用正则提取 uuid 而非逐行 JSON.parse：只需要 uuid 字段，7 倍提速且免去
 * 对超大行的对象树分配；多收的内嵌 uuid 只会进 skip 集合，新消息 uuid 是
 * 全新随机 v4，不可能预先出现在旧文本中，无误伤。
 * 错误处理为 per-file 容错：单个文件读失败只丢该文件，不整体 fail-open。
 */
function collectTranscriptUuids(oldSessionId: string): Set<string> | null {
  try {
    const transcriptDir = resolveTranscriptDir();
    const files: string[] = [];
    const mainFile = path.join(transcriptDir, `${oldSessionId}.jsonl`);
    if (fs.existsSync(mainFile)) files.push(mainFile);
    // subagents 下可能有嵌套子目录（如 workflows/wf_*/agent-*.jsonl），递归收集。
    const subRoot = path.join(transcriptDir, oldSessionId, 'subagents');
    if (fs.existsSync(subRoot)) {
      const stack = [subRoot];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name.endsWith('.jsonl')) files.push(full);
        }
      }
    }
    if (files.length === 0) {
      log(
        `[replay-guard] WARNING: no transcript found for resumed session ${oldSessionId.slice(0, 8)} in ${transcriptDir} — uuid replay guard inactive for this query`,
      );
      return null;
    }

    if (transcriptUuidCache?.sessionId !== oldSessionId) {
      transcriptUuidCache = {
        sessionId: oldSessionId,
        fileSizes: new Map(),
        uuids: new Set(),
      };
    }
    const cache = transcriptUuidCache;
    for (const file of files) {
      try {
        const size = fs.statSync(file).size;
        const prevSize = cache.fileSizes.get(file) ?? 0;
        if (size === prevSize) continue;
        let chunk: string;
        if (size > prevSize && prevSize > 0) {
          // 增量读：从上次读到的位置继续。往回退 1KB 覆盖上次可能截断的半行。
          const start = Math.max(0, prevSize - 1024);
          const buf = Buffer.alloc(size - start);
          const fd = fs.openSync(file, 'r');
          try {
            fs.readSync(fd, buf, 0, buf.length, start);
          } finally {
            fs.closeSync(fd);
          }
          chunk = buf.toString('utf-8');
        } else {
          // 首次读取或文件被截断重写：全量。
          chunk = fs.readFileSync(file, 'utf-8');
        }
        for (const m of chunk.matchAll(TRANSCRIPT_UUID_RE)) {
          cache.uuids.add(m[1]);
        }
        cache.fileSizes.set(file, size);
      } catch (fileErr) {
        log(
          `[replay-guard] skipping unreadable transcript file ${path.basename(file)}: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`,
        );
      }
    }
    log(
      `[replay-guard] ${cache.uuids.size} transcript uuid(s) across ${files.length} file(s) for resumed session ${oldSessionId.slice(0, 8)}`,
    );
    return cache.uuids;
  } catch (err) {
    log(
      `[replay-guard] failed to collect transcript uuids: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'HappyClaw';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

const IPC_INPUT_DRAIN_SENTINEL = path.join(IPC_INPUT_DIR, '_drain');

const IPC_INPUT_INTERRUPT_SENTINEL = path.join(IPC_INPUT_DIR, '_interrupt');
const INTERRUPT_GRACE_WINDOW_MS = 10_000;
let lastInterruptRequestedAt = 0;

function markInterruptRequested(): void {
  lastInterruptRequestedAt = Date.now();
}

function clearInterruptRequested(): void {
  lastInterruptRequestedAt = 0;
}

function isWithinInterruptGraceWindow(): boolean {
  return (
    lastInterruptRequestedAt > 0 &&
    Date.now() - lastInterruptRequestedAt <= INTERRUPT_GRACE_WINDOW_MS
  );
}

function isInterruptRelatedError(err: unknown): boolean {
  const errno = err as NodeJS.ErrnoException;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    errno?.code === 'ABORT_ERR' ||
    /abort|aborted|interrupt|interrupted|cancelled|canceled/i.test(message)
  );
}

/**
 * Check for _interrupt sentinel (graceful query interruption).
 */
function shouldInterrupt(): boolean {
  if (fs.existsSync(IPC_INPUT_INTERRUPT_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
    } catch {
      /* ignore */
    }
    markInterruptRequested();
    return true;
  }
  return false;
}

function cleanupStartupInterruptSentinel(): void {
  try {
    const stat = fs.statSync(IPC_INPUT_INTERRUPT_SENTINEL);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs <= INTERRUPT_GRACE_WINDOW_MS) {
      log(
        `Preserving recent interrupt sentinel at startup (${Math.round(ageMs)}ms old)`,
      );
      return;
    }
    fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
    log(
      `Removed stale interrupt sentinel at startup (${Math.round(ageMs)}ms old)`,
    );
  } catch {
    /* ignore */
  }
}

/**
 * Check for _drain sentinel (finish current query then exit).
 * Unlike _close which exits from idle wait, _drain is checked after
 * a query completes to implement one-question-one-answer semantics.
 */
function shouldDrain(): boolean {
  if (fs.existsSync(IPC_INPUT_DRAIN_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_DRAIN_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found (with optional images), or empty array.
 */
interface IpcDrainResult {
  messages: IpcInputMessage[];
}

function drainIpcInput(): IpcDrainResult {
  const result: IpcDrainResult = { messages: [] };
  try {
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          result.messages.push({
            text: data.text,
            images: data.images,
            queryRunId:
              typeof data.queryRunId === 'string' ? data.queryRunId : undefined,
            taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
            sourceJid:
              typeof data.sourceJid === 'string' ? data.sourceJid : undefined,
            channelContext: normalizeChannelTurnContext(
              data.channelContext,
              typeof data.sourceJid === 'string' ? data.sourceJid : undefined,
            ),
            receipt: parseIpcReceipt(data.receipt),
          });
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    result.messages = orderIpcInputMessages(result.messages);
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

/**
 * Create a fs.watch() based IPC watcher for event-driven file detection.
 * Falls back to periodic polling every IPC_FALLBACK_POLL_MS.
 */
function createIpcWatcher(onFileDetected: () => void): { close: () => void } {
  let watcher: fs.FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const debouncedDetect = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onFileDetected();
    }, 50);
  };

  // Ensure IPC_INPUT_DIR exists
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  } catch {}

  try {
    // Listen to all event types — 'rename' covers atomic writes on Linux,
    // but Docker bind mounts (macOS virtiofs) may emit 'change' instead.
    watcher = fs.watch(IPC_INPUT_DIR, () => {
      debouncedDetect();
    });
    watcher.on('error', (err) => {
      log(
        `IPC watcher error: ${err.message}, degrading to ${IPC_FALLBACK_POLL_MS}ms fallback polling`,
      );
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    log(
      `Failed to create IPC watcher: ${err instanceof Error ? err.message : String(err)}, using fallback polling`,
    );
  }

  // Fallback polling for reliability
  fallbackTimer = setInterval(() => {
    if (!closed) onFileDetected();
  }, IPC_FALLBACK_POLL_MS);
  fallbackTimer.unref(); // Don't prevent process from naturally exiting

  return {
    close() {
      closed = true;
      watcher?.close();
      watcher = null;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    },
  };
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages (with optional images), or null if _close.
 */
function waitForIpcMessage(): Promise<
  (IpcInputMessage & { messages: IpcInputMessage[] }) | null
> {
  return new Promise((resolve) => {
    let resolved = false;
    const tryDrain = () => {
      if (resolved) return;

      if (shouldClose()) {
        resolved = true;
        ipcWatcher?.close();
        resolve(null);
        return;
      }

      if (shouldDrain()) {
        log('Drain sentinel received, exiting after completed query');
        resolved = true;
        ipcWatcher?.close();
        resolve(null);
        return;
      }

      if (shouldInterrupt()) {
        log('Interrupt sentinel received while idle, ignoring');
        clearInterruptRequested();
      }

      const { messages } = drainIpcInput();

      if (messages.length > 0) {
        const combinedText = messages.map((m) => m.text).join('\n');
        const allImages = messages.flatMap((m) => m.images || []);
        // If any drained message carries a taskId, attribute the combined turn
        // to it (take the last one — later messages supersede earlier in a batch).
        let combinedTaskId: string | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].taskId) {
            combinedTaskId = messages[i].taskId;
            break;
          }
        }
        // Same convention for sourceJid: per-channel MCP tools should see the
        // chat the most recent message arrived from.
        let combinedSourceJid = latestIpcInputMessage(messages)?.sourceJid;
        if (!combinedSourceJid) {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].sourceJid) {
              combinedSourceJid = messages[i].sourceJid;
              break;
            }
          }
        }
        const latestMessage = latestIpcInputMessage(messages);
        const combinedChannelContext = normalizeChannelTurnContext(
          latestMessage?.channelContext,
          combinedSourceJid,
        );
        resolved = true;
        ipcWatcher?.close();
        resolve({
          text: combinedText,
          images: allImages.length > 0 ? allImages : undefined,
          taskId: combinedTaskId,
          sourceJid: combinedSourceJid,
          channelContext: combinedChannelContext,
          messages,
        });
        return;
      }
    };

    const ipcWatcher = createIpcWatcher(tryDrain);
    // Initial check in case files already exist
    tryDrain();
  });
}

/** 读取用户配置的 MCP servers（stdio/http/sse 类型） */
function loadUserMcpServers(): Record<string, unknown> {
  // CLAUDE_CONFIG_DIR may point at an isolated session directory. HappyClaw
  // therefore passes the effective per-user MCP set through env first.
  const envJson = process.env.HAPPYCLAW_USER_MCP_SERVERS_JSON;
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to settings.json */
    }
  }
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || '/home/node', '.claude');
  const settingsFile = path.join(configDir, 'settings.json');
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (settings.mcpServers && typeof settings.mcpServers === 'object') {
        return settings.mcpServers;
      }
    }
  } catch {
    /* ignore parse errors */
  }
  return {};
}

function pruneProcessedHistoryImagesInTranscript(
  sessionId: string | undefined,
): void {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || '/home/node', '.claude');
  const result = pruneProcessedHistoryImagesInTranscriptFile({
    claudeConfigDir: configDir,
    sessionId,
    getImageDimensions,
  });
  if (result.didMutate) {
    log(
      `History image prune: removed ${result.prunedImages} image block(s)` +
        `${result.transcriptPath ? ` from ${result.transcriptPath}` : ''}`,
    );
  }
}

function setCurrentChannelTurn(
  containerInput: ContainerInput,
  sourceJid: string | undefined,
  channelContext: ChannelTurnContext | undefined,
): void {
  if (sourceJid) containerInput.currentSourceJid = sourceJid;
  const normalized = normalizeChannelTurnContext(
    channelContext,
    sourceJid || containerInput.currentSourceJid || containerInput.chatJid,
  );
  containerInput.channelContext = normalized;
  if (normalized?.sourceJid) {
    containerInput.currentSourceJid = normalized.sourceJid;
  }
}

function decorateChannelUserTurn(
  message: string,
  context: ChannelTurnContext | undefined,
): string {
  const channelBlock = formatChannelTurnContextForPrompt(context);
  return channelBlock ? `${channelBlock}\n\n${message}` : message;
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQueryAttempt(
  prompt: string,
  sessionId: string | undefined,
  mcpServerConfig: ReturnType<typeof createSdkMcpServer>,
  containerInput: ContainerInput,
  workspaceMemoryInstructions: string,
  resumeAt?: string,
  emitOutput = true,
  allowedTools: string[] = DEFAULT_ALLOWED_TOOLS,
  disallowedTools?: string[],
  images?: Array<{ data: string; mimeType?: string }>,
  sourceKindOverride?: ContainerOutput['sourceKind'],
  initialIpcMessages: IpcInputMessage[] = [],
  mcpToolsContext?: McpContext,
  logicalInputTurnIdOverride?: string,
  acceptIpcMessagesDuringQuery = true,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  contextOverflow?: boolean;
  unrecoverableTranscriptError?: boolean;
  interruptedDuringQuery: boolean;
  cancelledIpcReceipts?: IpcDeliveryReceipt[];
  sessionResumeFailed?: boolean;
  contextBudgetExceeded?: {
    startupTokens: number;
    maxTokens: number;
    hardThreshold: number;
    message: string;
  };
  pipedMessagesDuringQuery: IpcInputMessage[];
  suspectTruncatedTail?: string;
  durableInputTurnCompleted?: boolean;
  providerFailureTurn?: ProviderFallbackRetryTurn;
  providerAccountFailure?: boolean;
  terminalModelLimitFailure?: boolean;
}> {
  const queryModelRuntime = resolveClaudeQueryModelRuntime(
    CLAUDE_PROVIDER_RUNTIME,
    PROVIDER_FALLBACK_MODELS.activeModelOverride,
  );
  const stream = new MessageStream();
  // Track messages piped into this query.  When the query is interrupted,
  // these messages would otherwise be lost (consumed by the aborted query).
  // The main loop uses them as the next prompt so the user's queued intent
  // continues after the cancelled turn (#421, Claude Code-style queuing).
  // Unacknowledged IPC inputs owned by this query. Despite the legacy field
  // name in the return type, this includes the initial startup/idle-drain batch
  // as well as messages piped while the query is active.
  const ipcDeliveryTracker = new IpcTurnDeliveryTracker(initialIpcMessages);
  const coldInputTurnId =
    resolveLogicalQueryInputTurnId(
      containerInput.turnId,
      logicalInputTurnIdOverride,
    ) ?? generateTurnId();
  const outputCorrelation = new IpcTurnOutputCorrelation(
    ipcDeliveryTracker,
    coldInputTurnId,
    logicalInputTurnIdOverride,
  );
  const activateCurrentInputTurn = (
    fallbackInputTurnId: string = outputCorrelation.currentInputTurnId,
  ): void => {
    const currentMessages = ipcDeliveryTracker.currentTurnMessages;
    const currentMessage = latestIpcInputMessage(currentMessages);
    const currentInputTurnId =
      outputCorrelation.syncCurrentTurn(fallbackInputTurnId);
    if (!emitOutput) return;
    activeOutputInputTurnId = currentInputTurnId;
    if (mcpToolsContext) {
      mcpToolsContext.currentInputTurnId = currentInputTurnId;
      if (currentMessage) {
        mcpToolsContext.currentTaskId = currentMessage.taskId ?? null;
      }
    }
    if (currentMessage) {
      if (currentMessage.queryRunId) {
        containerInput.queryRunId = currentMessage.queryRunId;
      }
      setCurrentChannelTurn(
        containerInput,
        currentMessage.sourceJid,
        currentMessage.channelContext,
      );
      containerInput.messageTaskId = currentMessage.taskId ?? undefined;
    }
  };
  activateCurrentInputTurn(coldInputTurnId);
  const [workspaceMemoryTurn, ownerProfileTurn] = mcpToolsContext
    ? await Promise.all([
        loadWorkspaceMemoryTurnContext(prompt, (query) =>
          fetchWorkspaceMemorySnapshot(mcpToolsContext, query),
        ),
        loadHappyClawOwnerProfileTurnContext(() =>
          fetchHappyClawOwnerProfileTurn(mcpToolsContext),
        ),
      ])
    : [
        { snapshot: null, block: '' },
        { result: null, block: '' },
      ];
  const firstWakeAcknowledger = new HappyClawFirstWakeAcknowledger();
  firstWakeAcknowledger.register(
    activeOutputInputTurnId || coldInputTurnId,
    ownerProfileTurn.result,
  );
  if (mcpToolsContext && !workspaceMemoryTurn.snapshot) {
    logWarn(
      'Workspace memory snapshot unavailable; continuing this turn without durable memory context',
    );
  }
  const emitWorkspaceMemoryRecall = (
    workspaceMemorySnapshot: WorkspaceMemorySnapshot,
    inputTurnId: string,
    queryRunId: string | undefined = containerInput.queryRunId,
  ): void => {
    if (!emitOutput) return;
    const trace = workspaceMemorySnapshot.retrievalTrace;
    writeOutput({
      status: 'stream',
      result: null,
      inputTurnId,
      streamEvent: {
        eventType: 'memory_recall',
        agentScope: 'system',
        isSynthetic: true,
        displayLevel: 'detail',
        title: 'Workspace memory snapshot',
        summary: `revision ${workspaceMemorySnapshot.storeRevision}; ${trace.itemRevisions.length} item(s)`,
        detail: trace.itemRevisions
          .map((item) => `${item.id}@${item.revision}`)
          .slice(0, 10)
          .join(', '),
        queryRunId,
        turnId: containerInput.turnId,
        sessionId,
      },
    });
    log(
      `Workspace memory snapshot revision=${workspaceMemorySnapshot.storeRevision} items=${trace.itemRevisions.length} generatedAt=${trace.generatedAt}`,
    );
  };
  if (workspaceMemoryTurn.snapshot) {
    emitWorkspaceMemoryRecall(
      workspaceMemoryTurn.snapshot,
      activeOutputInputTurnId || coldInputTurnId,
    );
  }
  const pipedMessagesDuringQuery = ipcDeliveryTracker.unacknowledgedMessages;
  const providerFallbackTurns = new ProviderFallbackTurnLedger({
    prompt,
    images,
    sessionId,
    resumeAt,
  });
  let providerFailureTurn: ProviderFallbackRetryTurn | undefined;
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  const durableInputCompletion = new DurableInputTurnCompletion();
  const assistantTextTracker = new AssistantTextTracker();
  let canonicalAssistantUuid: string | undefined;
  const agentTurnAnchor = resolveAgentTurnAnchor(
    containerInput.agentProfile,
    CLAUDE_PROVIDER_RUNTIME.endpointKind,
  );
  const anchorUserTurn = (message: string): string =>
    anchorAgentProfileToUserTurn(agentTurnAnchor, message);
  const decorateInitialUserTurn = (message: string): string => {
    const withChannelContext = decorateChannelUserTurn(
      message,
      containerInput.channelContext,
    );
    const withWorkspaceMemory = workspaceMemoryTurn.block
      ? `${workspaceMemoryTurn.block}\n\n${withChannelContext}`
      : withChannelContext;
    const withOwnerProfile = ownerProfileTurn.block
      ? `${ownerProfileTurn.block}\n\n${withWorkspaceMemory}`
      : withWorkspaceMemory;
    return shouldAnchorInitialAgentTurn(emitOutput, sourceKindOverride)
      ? anchorUserTurn(withOwnerProfile)
      : withOwnerProfile;
  };
  const initialRejected = stream.push(prompt, images, decorateInitialUserTurn);
  const decorateStreamEvent = (event: StreamEvent): StreamEvent => ({
    ...event,
    queryRunId: containerInput.queryRunId,
    turnId: containerInput.turnId,
    sessionId: newSessionId || sessionId,
  });
  const emit = (output: ContainerOutput): void => {
    if (output.streamEvent) {
      output = outputCorrelation.correlate({
        ...output,
        streamEvent: decorateStreamEvent(output.streamEvent),
        turnId: containerInput.turnId,
        sessionId: newSessionId || sessionId,
      });
    } else if (output.status === 'success' || output.status === 'error') {
      output = outputCorrelation.correlate({
        ...output,
        turnId: containerInput.turnId,
        sessionId: newSessionId || sessionId,
      });
    } else {
      output = outputCorrelation.correlate(output);
    }
    if (emitOutput) writeOutput(output);
  };
  let providerFailurePublished = false;
  const publishProviderAccountFailure = (
    error: SDKAssistantMessageError,
  ): void => {
    if (providerFailurePublished) return;
    providerFailurePublished = true;
    // Produce the exact receipt candidates for a terminal host projection.
    // The host ACKs them only when no healthy provider remains; otherwise its
    // durable IPC recovery rewinds the input for failover replay.
    const ipcReceipts = ipcDeliveryTracker.completeNextTurn();
    const output: ContainerOutput = {
      status: 'success',
      result: null,
      newSessionId,
      providerFailure: true,
      ...(!emitOutput ? { providerFailureMaintenance: true } : {}),
      finalizationReason: 'error',
      ...(emitOutput && ipcReceipts.length > 0 ? { ipcReceipts } : {}),
      ...(sourceKindOverride ? { sourceKind: sourceKindOverride } : {}),
    };
    log(`Publishing provider failure control signal (${error})`);
    if (emitOutput) {
      emit(output);
    } else {
      writeOutput(outputCorrelation.correlate(output));
    }
  };
  const publishTerminalModelLimitFailure = (): void => {
    if (!emitOutput) return;
    const ipcReceipts = ipcDeliveryTracker.completeNextTurn();
    emit({
      status: 'error',
      result:
        '⚠️ 当前模型额度已用尽，本次处理已停止。请稍后重试，或联系管理员配置回退模型。',
      error: 'model_limit_exhausted',
      finalizationReason: 'error',
      inputTurnCompleted: true,
      ...(ipcReceipts.length > 0 ? { ipcReceipts } : {}),
      ...(sourceKindOverride ? { sourceKind: sourceKindOverride } : {}),
    });
  };
  let firstResponseWatchdog: SdkFirstResponseWatchdog | undefined;

  // 如果有图片被拒绝，立即通知用户
  for (const reason of initialRejected) {
    emit({
      status: 'success',
      result: `\u26a0\ufe0f ${reason}`,
      newSessionId: undefined,
      sourceKind: 'input_rejection_warning',
    });
  }

  // Poll IPC for follow-up messages and _close/_interrupt sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let interruptedDuringQuery = false;
  let cancelledIpcReceipts: IpcDeliveryReceipt[] = [];
  let suppressOutputAfterInterrupt = false;
  let visibleOutputStarted = false;
  // After a result is received, allow a short window for the host to write _drain
  // before force-closing the stream.
  let resultReceivedAt: number | null = null;
  let cancelBackgroundResultCompletion: () => void = () => {};
  const POST_RESULT_TIMEOUT_MS = 5_000;
  // queryRef is set just before the for-await loop so pollIpcDuringQuery can call interrupt()
  let queryRef: Pick<Query, 'interrupt'> | null = null;
  let messageCount = 0;
  let resultCount = 0;
  let postResultInterruptRequested = false;
  // SDK transport is not ready until system/init is received. Piping user messages
  // before init causes "ProcessTransport is not ready for writing" unhandled rejection.
  let sdkTransportReady = false;
  // Resume 重放防御（见 collectTranscriptUuids 注释）。
  // sawLiveTurnActivity：本次 query 是否已出现"活体"信号（stream_event / 非合成
  // 非重放的 assistant/user）。重放严格发生在新 LLM 调用之前，因此活体信号出现
  // 前收到的 success result 一定是重放合成的；此外重放合成 result 有内在指纹
  // num_turns === 0（真实 success result 恒 ≥1），该指纹不依赖到达时序，也不
  // 依赖 transcript 文件能否被找到。error result 永不跳过（新 turn 可能不产生
  // 任何输出直接失败，误跳会让 runner 干等到容器超时）。
  const isResumedQuery = !!sessionId;
  const replayedUuids = isResumedQuery
    ? collectTranscriptUuids(sessionId!)
    : null;
  let sawLiveTurnActivity = false;
  // 疑似截断流的 partial 结尾片段（最后 ~200 字符）：最后一条 result 命中
  // 零 usage 指纹时置位，healthy result 到达即清空。随返回值交给会话循环
  // 触发自动续写（见 isSuspectTruncatedStreamResult）。
  let suspectTruncatedTail: string | undefined;
  // 后台 Task 完成保护：一旦本 query 因 pendingBgTasks>0 挂起过，后续
  // pending 清零的 result 必须是真正汇总，而不能仍是"等待其余 Agent"的
  // 过期进度文本。命中时压制该 result，并向同一 SDK stream 注入一次
  // "全部完成，请最终汇总"的内部消息。限制次数防无限自续写。
  let sawPendingBackgroundTasks = false;
  let backgroundSummaryForceAttempts = 0;
  const MAX_BACKGROUND_SUMMARY_FORCE_ATTEMPTS = 2;
  // SDK scopes vary by implementation: the official SDK exposes cumulative
  // root/model totals, while compatible proxies may reset the root per result.
  // Assistant message usage is the primary Kaboo-compatible source; this
  // stateful result normalizer is only the fallback when no assistant usage
  // snapshot was observed.
  const resultUsageState = createResultUsageState();
  const assistantUsageCollector = new AssistantUsageCollector();
  let assistantBatchFlushedSinceLastResult = false;
  const emitResultUsage = (
    resultMessage: Record<string, unknown>,
    fallbackEventId: string,
  ): void => {
    const resultUuid =
      typeof resultMessage.uuid === 'string' ? resultMessage.uuid.trim() : '';
    // SDK result UUID survives delivery retries and gives the host's event
    // ledger a stronger idempotency key than a process-local generated turn.
    const eventId = resultUuid ? `sdk-result:${resultUuid}` : fallbackEventId;
    const fallbackUsage = extractResultUsage(
      {
        eventId,
        usage: resultMessage.usage as SdkResultUsage | undefined,
        totalCostUSD: resultMessage.total_cost_usd as number | undefined,
        durationMs: resultMessage.duration_ms as number | undefined,
        numTurns: resultMessage.num_turns as number | undefined,
        modelUsage: resultMessage.modelUsage as
          | Record<string, SdkModelUsage>
          | undefined,
        fallbackModelKey: queryModelRuntime.usageModelKey,
      },
      resultUsageState,
    );
    const assistantBatches: AssistantUsageBatch[] = [];
    for (;;) {
      const batch = assistantUsageCollector.drain(newSessionId || sessionId);
      if (!batch) break;
      assistantBatches.push(batch);
    }
    if (assistantBatches.length > 0) {
      assistantBatchFlushedSinceLastResult = true;
      assistantBatches.forEach((assistantBatch, index) => {
        // Result duration/turn count describe the whole SDK result, so attach
        // them only to the final per-message event instead of multiplying them.
        const isLast = index === assistantBatches.length - 1;
        const usage = {
          eventId: assistantBatch.eventId,
          batchIndex: index,
          batchCount: assistantBatches.length,
          ...assistantBatch.tokens,
          costUSD: isLast ? fallbackUsage?.costUSD || 0 : 0,
          durationMs: isLast ? fallbackUsage?.durationMs || 0 : 0,
          numTurns: isLast ? fallbackUsage?.numTurns || 0 : 0,
        };
        emit({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'usage', usage },
        });
        log(
          `Usage: input=${usage.inputTokens} output=${usage.outputTokens} reasoning=${usage.reasoningTokens} cacheRead=${usage.cacheReadInputTokens} cacheCreate=${usage.cacheCreationInputTokens} cost=$${usage.costUSD} turns=${usage.numTurns}`,
        );
      });
      return;
    }
    if (assistantBatchFlushedSinceLastResult || !fallbackUsage) return;
    emit({
      status: 'stream',
      result: null,
      streamEvent: { eventType: 'usage', usage: fallbackUsage },
    });
    log(
      `Usage: input=${fallbackUsage.inputTokens} output=${fallbackUsage.outputTokens} reasoning=${fallbackUsage.reasoningTokens} cacheRead=${fallbackUsage.cacheReadInputTokens} cacheCreate=${fallbackUsage.cacheCreationInputTokens} cost=$${fallbackUsage.costUSD} turns=${fallbackUsage.numTurns}`,
    );
  };

  // 收尾阶段中止挂起的工具调用：当 stream 准备关闭（_close/_drain/post-result-timeout）时，
  // SDK 可能仍卡在最终回复之后的某个工具调用上，光 stream.end() 不会让它退出。
  // 这里主动 query.interrupt() 中止那个卡住的工具调用，让 for-await 自然结束、runner 回到
  // waitForIpcMessage() 保持 warm——不杀整个 runner。interrupt 引发的 SDK 错误由 catch 分支
  // 通过 postResultInterruptRequested 归类为 non-fatal（不退避、不上报为失败）。
  const interruptQueryForShutdown = (reason: string) => {
    if (!queryRef) return;
    if (postResultInterruptRequested) return;
    const activeQuery = queryRef;
    postResultInterruptRequested = true;
    log(`${reason}, interrupting current query before closing stream`);
    activeQuery
      .interrupt()
      .catch((err: unknown) => log(`Shutdown interrupt failed: ${err}`));
  };

  const pollIpcDuringQuery = async (): Promise<void> => {
    if (!ipcPolling) return;

    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      cancelBackgroundResultCompletion();
      closedDuringQuery = true;
      emitResultUsage({}, containerInput.turnId || generateTurnId());
      interruptQueryForShutdown('Close sentinel detected during query');
      stream.end();
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }
    if (shouldInterrupt()) {
      log('Interrupt sentinel detected, interrupting current query');
      cancelBackgroundResultCompletion();
      interruptedDuringQuery = true;
      const cancelledInputs = ipcDeliveryTracker.cancelCurrentTurn();
      cancelledIpcReceipts = cancelledInputs
        .map((message) => message.receipt)
        .filter((receipt): receipt is IpcDeliveryReceipt => !!receipt);
      log(
        `Cancelled ${cancelledInputs.length} IPC input message(s) owned by the superseded turn`,
      );
      suppressOutputAfterInterrupt = true;
      log(
        visibleOutputStarted || resultCount > 0
          ? 'Interrupt arrived after output started; suppressing all later output from the superseded turn'
          : 'Interrupt arrived before visible output; suppressing query output',
      );
      // The SDK may abort without producing a Result. Flush already observed
      // assistant API calls now so a deliberate stop/steer cannot erase their
      // real token usage. A later Result only advances fallback high-water
      // state and is suppressed by assistantBatchFlushedSinceLastResult.
      emitResultUsage({}, containerInput.turnId || generateTurnId());
      lastInterruptRequestedAt = Date.now();
      queryRef
        ?.interrupt()
        .catch((err: unknown) => log(`Interrupt call failed: ${err}`));
      stream.end();
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }
    // _drain: finish current query then exit. Once a result has been received,
    // the query is logically done but the MessageStream keeps the SDK alive.
    // Treat drain as close at this point to release the container.
    if (resultCount > 0 && shouldDrain()) {
      log('Drain sentinel detected after query result, ending stream');
      cancelBackgroundResultCompletion();
      closedDuringQuery = true;
      interruptQueryForShutdown('Drain sentinel detected after query result');
      stream.end();
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }
    // ── 结果后超时：result 已收到，给 host 短暂时间写 _drain ──
    // 注意：不设置 closedDuringQuery — 这只是 stream 清理，不是退出信号。
    // 主循环会继续进入 waitForIpcMessage()，等待 _close/_drain 才退出。
    // 这保证了终端预热等场景下容器不会在查询完成后立即退出。
    if (
      resultReceivedAt &&
      !ipcDeliveryTracker.hasPendingTurns &&
      Date.now() - resultReceivedAt > POST_RESULT_TIMEOUT_MS
    ) {
      log(
        `Post-result timeout (${POST_RESULT_TIMEOUT_MS / 1000}s), closing stream`,
      );
      interruptQueryForShutdown('Post-result timeout');
      stream.end();
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }
    // Maintenance and internal continuation queries must NOT consume later
    // user IPC messages — those belong to the main query loop. Only sentinels
    // are checked above. The preceding truncated query requeues anything it
    // already drained before the continuation disables consumption here.
    if (
      !shouldAcceptIpcMessagesDuringQuery(
        emitOutput,
        acceptIpcMessagesDuringQuery,
      )
    ) {
      return; // No setTimeout needed — watcher will trigger next check on file change
    }

    // 预防性 invariant：当前所有 stream.end() 路径（sentinel handlers / interrupt-before-query
    // / immediate-interrupt）都在同一同步 tick 把 ipcPolling=false，理论上 !ipcPolling 早退
    // 已覆盖 stream.ended=true 的情况；此守护保留作为未来重构时的 invariant 断言，
    // 避免后续改动引入"流已关闭但 polling 未停"的竞态窗口（消息会被 drain 后又被 stream.push 拒绝丢失）。
    if (stream.ended) {
      log(
        'Stream already ended, skipping IPC drain (messages will be picked up by waitForIpcMessage)',
      );
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }

    // Don't pipe user messages before system/init — the SDK ProcessTransport is not
    // ready yet and streamInput() will throw "ProcessTransport is not ready for writing".
    // IPC files remain on disk; we'll drain them once sdkTransportReady is set.
    if (!sdkTransportReady) {
      return;
    }

    const { messages } = drainIpcInput();
    for (const msg of messages) {
      log(
        `Piping IPC message into active query (${msg.text.length} chars, ${msg.images?.length || 0} images)`,
      );
      const becomesCurrentTurn = !ipcDeliveryTracker.hasPendingTurns;
      ipcDeliveryTracker.acceptTurn([msg]);
      if (becomesCurrentTurn) {
        durableInputCompletion.activateInput();
        providerFallbackTurns.acceptCurrentTurn([msg]);
        activateCurrentInputTurn(
          msg.receipt?.deliveryId || containerInput.turnId || generateTurnId(),
        );
      }
      // A new user turn arrived after a prior result. Cancel that result's
      // post-timeout so the stream cannot close before this turn completes.
      resultReceivedAt = null;
      // Build this queued turn with its own channel context, but do not mutate
      // the runner/MCP "current" context while an older SDK turn still owns
      // output. That ownership changes only after completeNextTurn().
      const queuedChannelContext = normalizeChannelTurnContext(
        msg.channelContext,
        msg.sourceJid ||
          containerInput.currentSourceJid ||
          containerInput.chatJid,
      );
      const [workspaceMemoryTurn, ownerProfileTurn] = mcpToolsContext
        ? await Promise.all([
            loadWorkspaceMemoryTurnContext(msg.text, (query) =>
              fetchWorkspaceMemorySnapshot(mcpToolsContext, query),
            ),
            loadHappyClawOwnerProfileTurnContext(() =>
              fetchHappyClawOwnerProfileTurn(
                mcpToolsContext,
                5_000,
                msg.receipt?.deliveryId,
              ),
            ),
          ])
        : [
            { snapshot: null, block: '' },
            { result: null, block: '' },
          ];
      if (msg.receipt?.deliveryId) {
        firstWakeAcknowledger.register(
          msg.receipt.deliveryId,
          ownerProfileTurn.result,
        );
      }
      if (mcpToolsContext && !workspaceMemoryTurn.snapshot) {
        logWarn(
          'Workspace memory snapshot unavailable for warm turn; continuing without durable memory context',
        );
      }
      // The query may have completed while the host snapshot request was in
      // flight. The accepted input remains in the delivery tracker and will be
      // requeued by the caller; never emit a recall trace or push it into an
      // ended SDK stream.
      if (!ipcPolling || stream.ended) return;
      if (workspaceMemoryTurn.snapshot) {
        emitWorkspaceMemoryRecall(
          workspaceMemoryTurn.snapshot,
          msg.receipt?.deliveryId ||
            outputCorrelation.currentInputTurnId ||
            containerInput.turnId ||
            generateTurnId(),
          msg.queryRunId || containerInput.queryRunId,
        );
      }
      const rejected = stream.push(msg.text, msg.images, (message) => {
        const withChannelContext = decorateChannelUserTurn(
          message,
          queuedChannelContext,
        );
        const withWorkspaceMemory = workspaceMemoryTurn.block
          ? `${workspaceMemoryTurn.block}\n\n${withChannelContext}`
          : withChannelContext;
        const withOwnerProfile = ownerProfileTurn.block
          ? `${ownerProfileTurn.block}\n\n${withWorkspaceMemory}`
          : withWorkspaceMemory;
        return anchorUserTurn(withOwnerProfile);
      });
      for (const reason of rejected) {
        emit({
          status: 'success',
          result: `\u26a0\ufe0f ${reason}`,
          newSessionId: undefined,
        });
      }
    }
    // No setTimeout needed — watcher will trigger next check on file change
  };

  const scheduleIpcPoll = createSerializedAsyncTrigger(
    pollIpcDuringQuery,
    (err: unknown) => {
      log(`IPC polling failed: ${err instanceof Error ? err.message : err}`);
    },
  );
  const ipcQueryWatcher = createIpcWatcher(() => {
    if (!ipcPolling) return;
    scheduleIpcPoll();
  });
  // Initial drain to process any pre-existing files
  scheduleIpcPoll();

  const processor = new StreamEventProcessor(emit, log);

  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
  const agentBuilderEnabled = resolveAgentBuilderEnabled(
    containerInput,
    isHome,
  );
  const channel =
    containerInput.channelContext?.provider ||
    getChannelFromJid(
      containerInput.currentSourceJid || containerInput.chatJid,
    );
  const channelGuidelines = CHANNEL_GUIDELINES[channel] ?? '';
  const memoryPromptName = 'memory-system.workspace' as const;
  const hasMemoryTools = allowedTools.some(
    (tool) =>
      tool === 'mcp__happyclaw__*' ||
      tool === 'mcp__happyclaw__workspace_memory_search' ||
      tool === 'mcp__happyclaw__workspace_memory_get' ||
      tool === 'mcp__happyclaw__workspace_memory_remember' ||
      tool === 'mcp__happyclaw__workspace_memory_update' ||
      tool === 'mcp__happyclaw__workspace_memory_forget',
  );
  const hasWebTools = allowedTools.some(
    (tool) => tool === 'WebSearch' || tool === 'WebFetch',
  );
  const hasBackgroundTaskTools =
    allowedTools.includes('Task') && allowedTools.includes('TaskOutput');
  const proactiveInteractiveContract =
    usesProactiveInteractiveContract(containerInput);
  const backgroundResultGate = new QuiescentResultGate(100);
  type BackgroundResultCandidate = {
    finalText: string | null;
    suspectTruncated: boolean;
    pendingBgTasks: number;
    sdkMessageUuid?: string;
    completedAssistantUuid?: string;
  };
  let pendingBackgroundResult: BackgroundResultCandidate | undefined;
  cancelBackgroundResultCompletion = () => {
    backgroundResultGate.activityObserved();
    pendingBackgroundResult = undefined;
    processor.invalidateObservedBackgroundResult();
  };

  const publishResultCandidate = (
    candidate: BackgroundResultCandidate,
    inputTurnCompleted: boolean,
  ): void => {
    const ipcReceipts = inputTurnCompleted
      ? ipcDeliveryTracker.completeNextTurn()
      : undefined;
    const queryIdle = inputTurnCompleted && !ipcDeliveryTracker.hasPendingTurns;
    durableInputCompletion.publishResult(
      inputTurnCompleted,
      ipcDeliveryTracker.hasPendingTurns,
    );
    emit({
      status: 'success',
      // Proactive SDK text is control-plane only; user-visible speech must
      // normally have crossed the send_message delivery boundary. Preserve a
      // completed non-empty candidate for host-side, ACK-aware recovery rather
      // than silently discarding it when the model violates that contract.
      result: proactiveInteractiveContract ? null : candidate.finalText,
      ...(proactiveInteractiveContract &&
      inputTurnCompleted &&
      !candidate.suspectTruncated &&
      candidate.finalText?.trim()
        ? { proactiveFinalCandidate: candidate.finalText }
        : {}),
      newSessionId,
      sdkMessageUuid: candidate.sdkMessageUuid,
      sourceKind: sourceKindOverride ?? 'sdk_final',
      finalizationReason: candidate.suspectTruncated
        ? 'truncated'
        : 'completed',
      pendingBgTasks: candidate.pendingBgTasks,
      inputTurnCompleted,
      queryIdle,
      ...(ipcReceipts && ipcReceipts.length > 0 ? { ipcReceipts } : {}),
    });

    containerInput.turnId = generateTurnId();
    if (inputTurnCompleted) {
      providerFallbackTurns.completeHealthyTurn({
        sessionId: newSessionId || sessionId,
        resumeAt: candidate.completedAssistantUuid,
        nextTurnMessages: ipcDeliveryTracker.currentTurnMessages,
      });
    }

    if (!inputTurnCompleted) {
      resultReceivedAt = null;
      return;
    }
    if (!ipcDeliveryTracker.hasPendingTurns) {
      sawPendingBackgroundTasks = false;
      backgroundSummaryForceAttempts = 0;
      resultReceivedAt = Date.now();
      return;
    }

    // The completed output still belongs to A. Activate B only after A's
    // immutable receipt has been emitted.
    resultReceivedAt = null;
    durableInputCompletion.activateInput();
    activateCurrentInputTurn(containerInput.turnId);
    log(
      `Result completed after background drain; keeping stream open for ${ipcDeliveryTracker.pendingTurnCount} accepted follow-up turn(s)`,
    );
  };

  const scheduleBackgroundResultCompletion = (): void => {
    const candidate = pendingBackgroundResult;
    if (!candidate || !processor.canCompleteObservedBackgroundResult()) {
      return;
    }
    backgroundResultGate.schedule(() => {
      if (
        pendingBackgroundResult !== candidate ||
        !processor.canCompleteObservedBackgroundResult()
      ) {
        return;
      }
      pendingBackgroundResult = undefined;
      processor.commitObservedBackgroundResult();
      publishResultCandidate({ ...candidate, pendingBgTasks: 0 }, true);
      log('Background completion debt drained after quiescence');
    });
  };
  // The reference person-like runtime supplies its own complete system prompt
  // instead of inheriting Claude Code's Assistant-oriented preset. Proactive
  // mode follows that boundary while preserving the same SDK tools.
  const includeClaudePreset =
    !proactiveInteractiveContract &&
    (containerInput.agentProfile?.includeClaudePreset ?? true);
  const promptPlan = buildHappyClawPromptPlan({
    platformIdentity: containerInput.agentProfile?.isDefault
      ? HAPPYCLAW_PLATFORM_IDENTITY
      : undefined,
    platformBootstrap:
      containerInput.agentProfile?.isDefault &&
      containerInput.happyClawOwnerProfileEnabled
        ? HAPPYCLAW_PLATFORM_BOOTSTRAP
        : undefined,
    // Agent identity leads platform workspace/context material per the
    // documented Agent-first composition order.
    agentIdentity: buildAgentIdentityPrompt(
      containerInput,
      includeClaudePreset,
    ),
    interaction: INTERACTION_GUIDELINES,
    security: buildSecurityRulesPrompt(),
    ...(workspaceMemoryInstructions && hasMemoryTools
      ? {
          memory: {
            id: memoryPromptName,
            text: workspaceMemoryInstructions,
          },
        }
      : {}),
    ...(agentBuilderEnabled &&
    !containerInput.isScheduledTask &&
    !containerInput.messageTaskId
      ? { agentBuilder: AGENT_BUILDER_GUIDELINES }
      : {}),
    output:
      containerInput.isScheduledTask || containerInput.messageTaskId
        ? TASK_OUTPUT_GUIDELINES
        : proactiveInteractiveContract
          ? PROACTIVE_OUTPUT_GUIDELINES
          : ASSISTANT_OUTPUT_GUIDELINES,
    ...(hasWebTools ? { web: WEB_FETCH_GUIDELINES } : {}),
    ...(hasBackgroundTaskTools
      ? { backgroundTasks: BACKGROUND_TASK_GUIDELINES }
      : {}),
    ...(channelGuidelines
      ? {
          channel: {
            id: channel,
            text: `${channelGuidelines}\n${CHANNEL_FORMAT_COMMON}`,
          },
        }
      : {}),
    ...(!containerInput.isScheduledTask && !containerInput.messageTaskId
      ? {
          deliveryContract: proactiveInteractiveContract
            ? PROACTIVE_DELIVERY_CONTRACT
            : ASSISTANT_DELIVERY_CONTRACT,
        }
      : {}),
  });
  for (const warning of promptPlan.warnings) log(`[WARN] ${warning}`);
  if (promptPlan.errors.length > 0) {
    throw new Error(`prompt_plan_invalid: ${promptPlan.errors.join('; ')}`);
  }
  const systemPromptAppend = promptPlan.text;
  const systemPrompt = includeClaudePreset
    ? {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: systemPromptAppend,
      }
    : systemPromptAppend;
  const promptAudit = buildPromptAudit(promptPlan);
  if (agentTurnAnchor) promptAudit.turnAnchor = agentTurnAnchor.audit;
  const contextAuditBase = runtimeContextAuditBase(containerInput);

  // 调试观察：HAPPYCLAW_DUMP_PROMPT=true 时把最终 system prompt 输出到 stderr
  // host 已通过 logs/ 捕获 stderr，方便对比改 prompts/*.md 前后的差异
  if (process.env.HAPPYCLAW_DUMP_PROMPT === 'true') {
    log(
      `PROMPT DUMP (${systemPromptAppend.length} chars):\n${systemPromptAppend}\n--- END PROMPT DUMP ---`,
    );
  }

  if (shouldInterrupt()) {
    log('Interrupt sentinel detected before query start, skipping query');
    interruptedDuringQuery = true;
    const cancelledInputs = ipcDeliveryTracker.cancelCurrentTurn();
    cancelledIpcReceipts = cancelledInputs
      .map((message) => message.receipt)
      .filter((receipt): receipt is IpcDeliveryReceipt => !!receipt);
    log(
      `Cancelled ${cancelledInputs.length} IPC input message(s) before the superseded turn started`,
    );
    suppressOutputAfterInterrupt = true;
    ipcPolling = false;
    // 这条 early-return 在下方 try 块之前，不被 finally 覆盖，需就地关闭 watcher（close 幂等）。
    ipcQueryWatcher.close();
    stream.end();
    return {
      newSessionId,
      lastAssistantUuid,
      closedDuringQuery,
      interruptedDuringQuery,
      cancelledIpcReceipts,
      pipedMessagesDuringQuery,
    };
  }

  // No override = SDK model-aware default: normally 200K; [1m] requests 1M.
  // Percentage policy takes precedence over the legacy absolute-token setting.
  const autoCompactPercentage = parseInt(
    process.env.AUTO_COMPACT_PERCENTAGE ?? '0',
    10,
  );
  const percentageWindow = resolveAutoCompactWindow(
    queryModelRuntime.model,
    autoCompactPercentage,
  );
  const legacyAutoCompactWindow = parseInt(
    process.env.AUTO_COMPACT_WINDOW ?? '0',
    10,
  );
  const safeLegacyAutoCompactWindow = resolveLegacyAutoCompactWindow(
    queryModelRuntime.model,
    legacyAutoCompactWindow,
  );
  const flagSettings: Record<string, unknown> = {};
  const claudeMdExcludes = resolveManagedHostClaudeMdExcludes({
    executionMode: contextAuditBase.executionMode,
    runtimePolicy: containerInput.agentProfile?.runtimePolicy,
    externalClaudeDir: contextAuditBase.externalClaudeDir,
    homeDir: process.env.HOME,
    projectRoot: contextAuditBase.projectRoot,
  });
  if (claudeMdExcludes.length > 0) {
    flagSettings.claudeMdExcludes = claudeMdExcludes;
    contextAuditBase.claudeMdExcludes = claudeMdExcludes;
  }
  if (percentageWindow !== undefined) {
    flagSettings.autoCompactWindow = percentageWindow;
  } else if (safeLegacyAutoCompactWindow !== undefined) {
    flagSettings.autoCompactWindow = safeLegacyAutoCompactWindow;
    if (safeLegacyAutoCompactWindow !== legacyAutoCompactWindow) {
      log(
        `[WARN] AUTO_COMPACT_WINDOW=${legacyAutoCompactWindow} exceeds the safe window for ${queryModelRuntime.model}; clamped to ${safeLegacyAutoCompactWindow}`,
      );
    }
  }
  // Resolve the actual claude CLI path for the SDK.
  // SDK 的 optionalDependencies（@anthropic-ai/claude-agent-sdk-{platform} 等）不保证被安装，
  // pathToClaudeCodeExecutable 留空、且 SDK 自带平台包缺失时会报
  // "Claude Code native binary not found at .../claude-agent-sdk-win32-x64/claude"（Windows 宿主机模式）。
  // 仅在 Windows 上优先解析本地依赖 @anthropic-ai/claude-code 里 postinstall 落地的真实 binary
  // （Windows 没有 which、SDK 平台包又常缺失，故需此兜底）；Linux 容器 / macOS 宿主机
  // 保持原有 which 解析逻辑不变，避免改变既有 claude 解析来源。
  let pathToClaudeCodeExecutable: string | undefined =
    process.platform === 'win32' ? resolveBundledClaudeCli() : undefined;
  if (!pathToClaudeCodeExecutable) {
    try {
      // `which` 在 Windows 上不存在，改用 `where`；其多行输出取第一行。
      const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
      const resolvedPath = execFileSync(lookupCmd, ['claude'], {
        timeout: 5_000,
        encoding: 'utf-8',
      })
        .split(/\r?\n/)[0]
        .trim();
      if (resolvedPath) {
        pathToClaudeCodeExecutable = resolvedPath;
      }
    } catch {
      // Fallback: try to find it in common locations
      const commonPaths = [
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        path.join(process.env.HOME || '/root', '.local/bin/claude'),
        // 容器内 agent-runner 的本地依赖（package.json 声明了 @anthropic-ai/claude-code）
        '/app/node_modules/.bin/claude',
      ];
      for (const p of commonPaths) {
        if (fs.existsSync(p)) {
          pathToClaudeCodeExecutable = p;
          break;
        }
      }
    }
  }

  // Claude Code plugins injected by HappyClaw main process via ContainerInput.
  // SDK converts this array to `--plugin-dir <path>` args for the spawned
  // claude CLI, which loads each plugin's commands/agents/hooks/skills/mcp.
  // Paths are already runtime-translated upstream (container-internal for
  // Docker, host absolute for host mode).
  const userPlugins =
    activeAgentMcpPolicy.loadUserPlugins &&
    containerInput.plugins &&
    containerInput.plugins.length > 0
      ? containerInput.plugins.map((plugin) => ({
          ...plugin,
          ...(activeAgentMcpPolicy.skipPluginMcpDiscovery
            ? { skipMcpDiscovery: true }
            : {}),
        }))
      : undefined;
  if (userPlugins) {
    log(
      `Loading ${userPlugins.length} plugin(s): ${userPlugins.map((p) => p.path).join(', ')}`,
    );
  }
  const effectiveDisallowedTools =
    disallowedTools && disallowedTools.length > 0
      ? [...new Set(disallowedTools)]
      : undefined;
  const userMcpServers = activeAgentMcpPolicy.includeUserMcpServers
    ? loadUserMcpServers()
    : {};

  try {
    const sdkCompat = withHappyClawSubagentContract({
      ...(pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable }),
      ...queryModelRuntime.queryModelOptions,
      cwd: WORKSPACE_GROUP,
      resume: sessionId,
      ...(sessionId && resumeAt ? { resumeSessionAt: resumeAt } : {}),
      systemPrompt,
      allowedTools,
      ...(effectiveDisallowedTools && {
        disallowedTools: effectiveDisallowedTools,
      }),
      thinking: { type: 'adaptive' as const, display: 'summarized' as const },
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      agentProgressSummaries: true,
      settingSources: activeAgentMcpPolicy.settingSources,
      // New hosts pass the canonical manifest. Undefined preserves compatibility
      // with older hosts; an explicit [] intentionally enables no Skills.
      skills:
        containerInput.skillManifest?.selectedSkillIds ?? ('all' as const),
      includePartialMessages: true,
      // Forward sub-agent (Task) text/thinking as stream events so the card's
      // sub-agent transcript lights up live instead of only filling in when the
      // Task completes.
      forwardSubagentText: true,
      ...(Object.keys(flagSettings).length > 0
        ? { settings: flagSettings as any }
        : {}),
      ...(userPlugins && { plugins: userPlugins }),
      ...(activeAgentMcpPolicy.strictMcpConfig
        ? { strictMcpConfig: true }
        : {}),
      mcpServers: {
        ...userMcpServers,
        happyclaw: mcpServerConfig,
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [createWorkspaceMemoryWriteGuard()],
          },
        ],
        PreCompact: [
          {
            hooks: [
              createPreCompactHook({
                emit,
                getFullText: () => processor.getFullText(),
                resetFullText: () => processor.resetFullTextAccumulator(),
              }),
            ],
          },
        ],
      },
    });
    log(
      `Subagent runtime contract: ${sdkCompat.audit.enabled ? 'enabled' : 'disabled'} (${sdkCompat.audit.hash.slice(0, 12)})`,
    );
    const q = query({
      prompt: stream,
      options: sdkCompat.options,
    });
    queryRef = q;
    firstResponseWatchdog = new SdkFirstResponseWatchdog(
      SDK_FIRST_RESPONSE_TIMEOUT_MS,
      () => {
        log(
          `No model response event within ${SDK_FIRST_RESPONSE_TIMEOUT_MS}ms; marking provider unhealthy`,
        );
        publishProviderAccountFailure('server_error');
        processor.discardPendingTextOutput();
        processor.cleanup();
        stream.end();
        // Give the framed stdout control signal one event-loop turn to flush
        // before terminating a transport that stopped yielding SDK messages.
        setTimeout(
          () => forceExitWithSafetyNet(0),
          SDK_PROVIDER_FAILURE_EXIT_GRACE_MS,
        );
      },
    );
    if (shouldInterrupt()) {
      firstResponseWatchdog.clear();
      log(
        'Interrupt sentinel already present when query started, interrupting immediately',
      );
      interruptedDuringQuery = true;
      const cancelledInputs = ipcDeliveryTracker.cancelCurrentTurn();
      cancelledIpcReceipts = cancelledInputs
        .map((message) => message.receipt)
        .filter((receipt): receipt is IpcDeliveryReceipt => !!receipt);
      log(
        `Cancelled ${cancelledInputs.length} IPC input message(s) as the superseded turn started`,
      );
      suppressOutputAfterInterrupt = true;
      q.interrupt().catch((err: unknown) =>
        log(`Immediate interrupt call failed: ${err}`),
      );
      stream.end();
      ipcPolling = false;
    }
    for await (const message of q) {
      firstResponseWatchdog.observe(message.type);
      const preservesObservedBackgroundResult =
        (message.type === 'system' &&
          (message.subtype === 'background_tasks_changed' ||
            message.subtype === 'task_notification' ||
            (message.subtype === 'session_state_changed' &&
              message.state === 'idle'))) ||
        (message.type === 'user' &&
          message.origin?.kind === 'task-notification' &&
          message.shouldQuery === false);
      backgroundResultGate.activityObserved();
      if (!preservesObservedBackgroundResult && pendingBackgroundResult) {
        pendingBackgroundResult = undefined;
        processor.invalidateObservedBackgroundResult();
      }
      if (providerFailurePublished) {
        continue;
      }
      if (providerFailureTurn) {
        // The failed turn and any already-accepted later turns will be replayed
        // from the pre-failure anchor by runQuery(); suppress this spent stream.
        continue;
      }
      // A rejected subscription limit is a structured SDK signal. Record its
      // blast radius and terminate this SDK attempt immediately. Some
      // third-party CLIs never emit a Result after this event, so merely
      // remembering it would clear the first-response watchdog and recreate
      // the original indefinite "thinking" state.
      if (message.type === 'rate_limit_event') {
        const info: SDKRateLimitInfo = message.rate_limit_info;
        if (info.status === 'rejected') {
          const limitDecision = decideProviderLimitAction({
            structuredRejection: { rateLimitType: info.rateLimitType },
            result: null,
            canFallback: PROVIDER_FALLBACK_MODELS.canActivateFallback,
          });
          if (limitDecision.action === 'provider_failure') {
            log(
              `Account rate limit rejected (${info.rateLimitType ?? 'unknown'}); marking provider unhealthy immediately`,
            );
            publishProviderAccountFailure('rate_limit');
            processor.discardPendingTextOutput();
            processor.cleanup();
            assistantTextTracker.reset();
            canonicalAssistantUuid = undefined;
            stream.end();
            q.interrupt().catch((err: unknown) =>
              log(`Rate-limit interrupt failed: ${err}`),
            );
            return {
              newSessionId,
              lastAssistantUuid,
              closedDuringQuery,
              interruptedDuringQuery,
              cancelledIpcReceipts,
              pipedMessagesDuringQuery,
              providerAccountFailure: true,
            };
          }
          if (
            limitDecision.action === 'model_fallback' &&
            limitDecision.scope &&
            PROVIDER_FALLBACK_MODELS.activateForScope(limitDecision.scope)
          ) {
            providerFailureTurn = providerFallbackTurns.snapshotFailure({
              ipcMessages: ipcDeliveryTracker.currentTurnMessages,
              laterIpcMessages: ipcDeliveryTracker.laterTurnMessages,
              turnId: containerInput.turnId,
            });
            log(
              `Model-specific rate limit rejected; retrying current turn with fallback model ${PROVIDER_FALLBACK_MODELS.fallbackModel}`,
            );
            writeOutput({
              status: 'stream',
              result: null,
              providerFailureRetrying: true,
              turnId: containerInput.turnId,
              sessionId: newSessionId || sessionId,
            });
            processor.discardPendingTextOutput();
            processor.cleanup();
            assistantTextTracker.reset();
            canonicalAssistantUuid = undefined;
            stream.end();
            ipcPolling = false;
            ipcQueryWatcher.close();
            q.interrupt().catch((err: unknown) =>
              log(`Model-fallback interrupt failed: ${err}`),
            );
            return {
              newSessionId,
              lastAssistantUuid,
              closedDuringQuery,
              interruptedDuringQuery,
              cancelledIpcReceipts,
              pipedMessagesDuringQuery,
              providerFailureTurn,
              providerAccountFailure: false,
            };
          }

          log(
            `Model-specific rate limit rejected without a fallback (${info.rateLimitType ?? 'unknown'}); surfacing terminal error`,
          );
          publishTerminalModelLimitFailure();
          processor.discardPendingTextOutput();
          processor.cleanup();
          assistantTextTracker.reset();
          canonicalAssistantUuid = undefined;
          stream.end();
          q.interrupt().catch((err: unknown) =>
            log(`Model-limit interrupt failed: ${err}`),
          );
          return {
            newSessionId,
            lastAssistantUuid,
            closedDuringQuery,
            interruptedDuringQuery,
            cancelledIpcReceipts,
            pipedMessagesDuringQuery,
            terminalModelLimitFailure: true,
            providerAccountFailure: false,
          };
        } else if (info.status === 'allowed_warning') {
          processor.emitStatus(`接近 API 限流阈值`);
        }
        continue;
      }

      // 流式事件处理
      if (message.type === 'stream_event') {
        // 重放消息是完整消息、不产生 partial stream_event——见到 stream_event
        // 即说明新 turn 的 LLM 调用已开始。
        sawLiveTurnActivity = true;
        if (!suppressOutputAfterInterrupt) {
          visibleOutputStarted = true;
        }
        if (suppressOutputAfterInterrupt) {
          continue;
        }
        if (
          (message.parent_tool_use_id ?? null) === null &&
          message.event.type === 'message_start' &&
          processor.getBlockingBackgroundCompletionDebtCount() > 0 &&
          ipcDeliveryTracker.pendingTurnCount <= 1
        ) {
          // Compatibility fallback for CLI builds which omit
          // user.origin=task-notification. Never apply it while B is already
          // accepted, or B's assistant activity could repay A's debt.
          processor.observeBackgroundNotificationActivity();
        }
        processor.processStreamEvent(message as any);
        continue;
      }

      if (message.type === 'tool_progress') {
        if (!suppressOutputAfterInterrupt) {
          visibleOutputStarted = true;
        }
        if (suppressOutputAfterInterrupt) {
          continue;
        }
        processor.processToolProgress(message as any);
        continue;
      }

      if (message.type === 'tool_use_summary') {
        if (!suppressOutputAfterInterrupt) {
          visibleOutputStarted = true;
        }
        if (suppressOutputAfterInterrupt) {
          continue;
        }
        processor.processToolUseSummary(message as any);
        continue;
      }

      // System messages
      if (message.type === 'system') {
        const sys = message as any;
        const handled = processor.processSystemMessage(sys);
        if (
          sys.subtype === 'background_tasks_changed' ||
          (sys.subtype === 'session_state_changed' && sys.state === 'idle')
        ) {
          scheduleBackgroundResultCompletion();
        }
        if (handled) {
          continue;
        }
      }

      if (processor.processMiscMessage(message as any)) {
        continue;
      }

      messageCount++;
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      const msgParentToolUseId = (message as any).parent_tool_use_id ?? null;
      // 诊断：对所有 assistant/user 消息打印 parent_tool_use_id 和内容块类型
      if (message.type === 'assistant' || message.type === 'user') {
        const rawParent = (message as any).parent_tool_use_id;
        const contentTypes = Array.isArray((message as any).message?.content)
          ? ((message as any).message.content as Array<{ type: string }>)
              .map((b) => b.type)
              .join(',')
          : typeof (message as any).message?.content === 'string'
            ? 'string'
            : 'none';
        log(
          `[msg #${messageCount}] type=${msgType} parent_tool_use_id=${rawParent === undefined ? 'UNDEFINED' : rawParent === null ? 'NULL' : rawParent} content_types=[${contentTypes}] keys=[${Object.keys(message).join(',')}]`,
        );
      } else {
        log(
          `[msg #${messageCount}] type=${msgType}${msgParentToolUseId ? ` parent=${msgParentToolUseId.slice(0, 12)}` : ''}`,
        );
      }

      // ── Resume 重放消息防御 ──
      // 1) uuid 命中旧 transcript 的 assistant/user → 完全跳过（不累积文本、不置
      //    visibleOutputStarted、不触发 tool_result 处理）。init 等运行时事件
      //    不入 transcript，uuid 不会命中，照常处理（幂等）。
      // 2) resume 时 CLI 现场合成的 result（不入 transcript、uuid 全新）用双重
      //    判别：num_turns === 0 内在指纹（真实 success result 恒 ≥1，不依赖到达
      //    时序、也不依赖 transcript 文件能否找到），或活体信号出现之前到达。
      //    error result 永不跳过（新 turn 可能不产生任何输出直接失败）。
      //    检查必须在 visibleOutputStarted 置位之前——被跳过的合成 result 不得
      //    影响 interrupt 抑制判定。
      const incomingUuid = (message as { uuid?: string }).uuid;
      if (replayedUuids && incomingUuid && replayedUuids.has(incomingUuid)) {
        log(
          `[replay-skip] ${msgType} uuid=${incomingUuid.slice(0, 8)} (replayed from resumed session)`,
        );
        continue;
      }
      if (
        isResumedQuery &&
        message.type === 'result' &&
        message.subtype === 'success'
      ) {
        const numTurns = (message as { num_turns?: number }).num_turns;
        if (numTurns === 0 || !sawLiveTurnActivity) {
          log(
            `[replay-skip] synthetic result (num_turns=${numTurns}, live=${sawLiveTurnActivity}) from resumed session`,
          );
          continue;
        }
      }
      if (message.type === 'assistant') {
        sawLiveTurnActivity = true;
      } else if (message.type === 'user') {
        // CLI 合成/注入的 user 消息（任务完成通知、重放回显）不代表新 LLM 调用
        // 已开始，不得提前翻转活体信号——否则其后的重放合成 result 会漏判。
        const um = message as {
          isReplay?: boolean;
          isSynthetic?: boolean;
          origin?: { kind?: string };
        };
        if (
          !um.isReplay &&
          !um.isSynthetic &&
          um.origin?.kind !== 'task-notification'
        ) {
          sawLiveTurnActivity = true;
        }
        if (um.origin?.kind === 'task-notification') {
          if ((message as { shouldQuery?: boolean }).shouldQuery === false) {
            processor.observeBackgroundNotificationWithoutQuery();
            scheduleBackgroundResultCompletion();
          } else {
            processor.observeBackgroundNotificationActivity();
          }
        }
      }

      if (message.type !== 'system') {
        visibleOutputStarted = true;
      }
      // Collect Claude's per-API-call assistant usage before any presentation
      // suppression. A stopped/steered reply may be hidden, but its provider
      // usage is still real. The collector deduplicates repeated message IDs
      // and keeps the largest final snapshot, matching Kaboo's transcript
      // parser contract.
      if (message.type === 'assistant') {
        assistantUsageCollector.ingest(
          message as unknown as Record<string, unknown>,
        );
      }
      if (suppressOutputAfterInterrupt && message.type !== 'system') {
        if (message.type === 'result') {
          resultCount++;
          // Deliberately suppress the superseded reply, not the provider bill.
          // SDK error/interrupted results can still carry real usage.
          emitResultUsage(
            message as unknown as Record<string, unknown>,
            containerInput.turnId || generateTurnId(),
          );
          assistantBatchFlushedSinceLastResult = false;
          resultReceivedAt = Date.now();
        }
        log(`[msg #${messageCount}] suppressed after early interrupt`);
        continue;
      }

      // ── 子 Agent 消息转 StreamEvent ──
      if (processor.processSubAgentMessage(message as any)) {
        continue;
      }

      // ── Main-agent tool results → tool_result stream events ──
      // (sub-agent results are handled inside processSubAgentMessage above)
      if (message.type === 'user') {
        processor.processMainToolResults(message as any);
      }

      if (message.type === 'assistant' && 'uuid' in message) {
        const assistantError = (message as { error?: SDKAssistantMessageError })
          .error;
        if (isAccountProviderAssistantError(assistantError)) {
          log(
            `Assistant provider error (${assistantError}); marking provider unhealthy`,
          );
          publishProviderAccountFailure(assistantError);
          processor.discardPendingTextOutput();
          processor.cleanup();
          assistantTextTracker.reset();
          canonicalAssistantUuid = undefined;
          stream.end();
          return {
            newSessionId,
            lastAssistantUuid,
            closedDuringQuery,
            interruptedDuringQuery,
            cancelledIpcReceipts,
            pipedMessagesDuringQuery,
            providerAccountFailure: true,
          };
        }
        lastAssistantUuid = (message as { uuid: string }).uuid;
        const assistantMsg = message as Record<string, unknown>;
        if ((assistantMsg.parent_tool_use_id ?? null) === null) {
          if (!assistantError && emitOutput && mcpToolsContext) {
            const inputTurnId = outputCorrelation.currentInputTurnId;
            const acknowledged = await firstWakeAcknowledger.acknowledge(
              inputTurnId,
              (candidate) =>
                acknowledgeHappyClawOwnerProfileFirstWake(
                  mcpToolsContext,
                  candidate.leaseToken,
                  candidate.inputTurnId,
                ),
            );
            if (acknowledged) {
              log(
                `Acknowledged HappyClaw first-wake after healthy Assistant progress for ${inputTurnId}`,
              );
            }
          }
          if (
            processor.getBlockingBackgroundCompletionDebtCount() > 0 &&
            ipcDeliveryTracker.pendingTurnCount <= 1
          ) {
            processor.observeBackgroundNotificationActivity();
          }
          const msgContent = (
            assistantMsg.message as Record<string, unknown> | undefined
          )?.content;
          if (Array.isArray(msgContent)) {
            // 以整条 AssistantMessage 为原子分类：只要含 top-level
            // tool_use，该消息全部 text 都是过程旁白；完全不含工具的消息
            // 才能在 SDK Result 缺失时作为候选正文。
            const sawText = assistantTextTracker.addContentBlocks(
              msgContent as Array<{ type: string; text?: string }>,
            );
            if (sawText) {
              canonicalAssistantUuid = assistantMsg.uuid as string;
            }
          }
        }
        processor.processAssistantMessage(message as any);
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
        // Mark transport ready and drain any IPC messages that arrived before init.
        sdkTransportReady = true;
        scheduleIpcPoll();

        // Log skills and context usage for observability.
        // getContextUsage() is a newer SDK API; feature-detect to avoid spamming
        // error logs on older SDK versions where the method is absent.
        const getCtxUsage = (
          q as unknown as {
            getContextUsage?: () => Promise<SDKControlGetContextUsageResponse>;
          }
        ).getContextUsage;
        let contextUsage: SDKControlGetContextUsageResponse | undefined;
        if (typeof getCtxUsage === 'function') {
          try {
            contextUsage = await runSdkControlWithTimeout(
              'getContextUsage',
              () => getCtxUsage.call(q),
              SDK_CONTEXT_USAGE_TIMEOUT_MS,
            );
            if (contextUsage.skills) {
              log(
                `Skills: ${contextUsage.skills.includedSkills}/${contextUsage.skills.totalSkills} loaded, ${contextUsage.skills.tokens} tokens`,
              );
            }
            log(
              `Context: ${contextUsage.totalTokens}/${contextUsage.maxTokens} tokens (${contextUsage.percentage.toFixed(1)}%)`,
            );
          } catch (ctxErr) {
            log(
              `[debug] getContextUsage failed: ${ctxErr instanceof Error ? ctxErr.message : String(ctxErr)}`,
            );
          }
        }
        const contextAudit = enrichContextAudit(
          contextAuditBase,
          promptAudit,
          contextUsage,
        );
        contextAudit.subagentContract = sdkCompat.audit;
        const contextBudget = assessContextBudget(contextUsage);
        contextAudit.contextBudget = contextBudget;
        if (contextBudget.warning) {
          contextAudit.warnings.push(contextBudget.warning);
          log(`[WARN] ${contextBudget.warning}`);
        }
        // 1M 上下文缩水告警：带 [1m] 后缀的模型期望约 1M 上下文窗口，若 SDK / 模型资格判定
        // 静默退回（例如 200K），在此立即暴露而非等到溢出。push 进 warnings 会让下方
        // emit 的 displayLevel 自动升为 'primary'，在前端醒目展示。
        if (
          isExtendedContextModel(queryModelRuntime.model) &&
          contextUsage &&
          contextUsage.maxTokens > 0 &&
          contextUsage.maxTokens < 900_000
        ) {
          contextAudit.warnings.push(
            `上下文窗口仅 ${Math.round(contextUsage.maxTokens / 1000)}K tokens（预期约 1M），1M 上下文可能未生效`,
          );
          log(
            `[WARN] 1M context not active: maxTokens=${contextUsage.maxTokens}`,
          );
        }
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'context_audit',
            agentScope: 'system',
            displayLevel:
              contextAudit.warnings.length > 0 ? 'primary' : 'detail',
            title: 'Agent Context',
            summary: `${contextAudit.skills.includedSkills ?? contextAudit.skills.totalSkills ?? 0} skills · ${contextAudit.rules.fileCount} rules`,
            contextAudit,
          },
        });
        if (
          contextBudget.status === 'hard_exceeded' &&
          contextBudget.startupTokens !== undefined &&
          contextBudget.maxTokens !== undefined &&
          contextBudget.hardThreshold !== undefined
        ) {
          const message =
            contextBudget.error ?? 'startup context budget exceeded';
          log(`[ERROR] ${message}`);
          stream.end();
          return {
            newSessionId,
            lastAssistantUuid,
            closedDuringQuery,
            interruptedDuringQuery,
            cancelledIpcReceipts,
            pipedMessagesDuringQuery,
            contextBudgetExceeded: {
              startupTokens: contextBudget.startupTokens,
              maxTokens: contextBudget.maxTokens,
              hardThreshold: contextBudget.hardThreshold,
              message,
            },
          };
        }
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        const resultSubtype = message.subtype;
        log(
          `Result #${resultCount}: subtype=${resultSubtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
        );
        const resultMsg = message as unknown as Record<string, unknown>;
        const limitDecision = decideProviderLimitAction({
          result: textResult ?? null,
          canFallback: PROVIDER_FALLBACK_MODELS.canActivateFallback,
        });

        // Account/session limits apply to every model on this OAuth profile.
        // Emit an explicit provider failure even if the CLI's final text is
        // absent or changed; the host will quarantine the profile and retry
        // elsewhere without ACKing this input turn.
        if (limitDecision.action === 'provider_failure') {
          log(
            'Account rate limit recognized from compatibility text; marking provider unhealthy',
          );
          publishProviderAccountFailure('rate_limit');
          emitResultUsage(resultMsg, containerInput.turnId || generateTurnId());
          assistantBatchFlushedSinceLastResult = false;
          processor.discardPendingTextOutput();
          processor.cleanup();
          assistantTextTracker.reset();
          canonicalAssistantUuid = undefined;
          stream.end();
          return {
            newSessionId,
            lastAssistantUuid,
            closedDuringQuery,
            interruptedDuringQuery,
            cancelledIpcReceipts,
            pipedMessagesDuringQuery,
            providerAccountFailure: true,
          };
        }

        // A model-specific limit leaves the OAuth profile healthy. If a
        // fallback model is configured, retry exactly this turn in-process;
        // otherwise keep processing the original result so the user sees the
        // model limit instead of having it silently swallowed.
        if (
          limitDecision.action === 'model_fallback' &&
          limitDecision.scope &&
          PROVIDER_FALLBACK_MODELS.activateForScope(limitDecision.scope)
        ) {
          providerFailureTurn = providerFallbackTurns.snapshotFailure({
            ipcMessages: ipcDeliveryTracker.currentTurnMessages,
            laterIpcMessages: ipcDeliveryTracker.laterTurnMessages,
            turnId: containerInput.turnId,
          });
          log(
            `Primary model hit a model-specific limit; retrying current turn with fallback model ${PROVIDER_FALLBACK_MODELS.fallbackModel}`,
          );
          writeOutput({
            status: 'stream',
            result: null,
            providerFailureRetrying: true,
            turnId: containerInput.turnId,
            sessionId: newSessionId || sessionId,
          });
          emitResultUsage(resultMsg, containerInput.turnId || generateTurnId());
          assistantBatchFlushedSinceLastResult = false;
          processor.discardPendingTextOutput();
          assistantTextTracker.reset();
          canonicalAssistantUuid = undefined;
          stream.end();
          ipcPolling = false;
          ipcQueryWatcher.close();
          // Do not process or emit the limit notice as an assistant result.
          continue;
        }

        // SDK 在某些失败场景会返回 error_* subtype 且不抛异常。
        // 不能把这类结果当 success(null)，否则前端会一直停留在"思考中"。
        // 匹配策略：显式枚举已知的 error subtype，并用 startsWith('error') 兜底未知的未来 error subtype。
        // 参考 SDK result subtype 约定：error_during_execution、error_max_turns 等均以 'error' 开头。
        if (
          typeof resultSubtype === 'string' &&
          (resultSubtype === 'error_during_execution' ||
            resultSubtype.startsWith('error'))
        ) {
          emitResultUsage(resultMsg, containerInput.turnId || generateTurnId());
          // If session never initialized (no system/init), resume itself failed — report it
          // so the caller can retry with a fresh session instead of crashing.
          if (!newSessionId) {
            log(`Session resume failed (no init): ${resultSubtype}`);
            return {
              newSessionId,
              lastAssistantUuid,
              closedDuringQuery,
              interruptedDuringQuery,
              pipedMessagesDuringQuery,
              sessionResumeFailed: true,
            };
          }
          const detail = textResult?.trim()
            ? textResult.trim()
            : `Claude Code execution failed (${resultSubtype})`;
          throw new Error(detail);
        }

        // SDK 将某些 API 错误包装为 subtype=success 的 result（不抛异常）
        if (textResult && isContextOverflowError(textResult)) {
          log(
            `Context overflow detected in result: ${textResult.slice(0, 100)}`,
          );
          // ── 发射已累积的部分回复，避免用户已看到的流式内容丢失 ──
          const partialText = processor.getFullText();
          if (partialText.trim()) {
            log(`Emitting overflow_partial with ${partialText.length} chars`);
            emit({
              status: 'success',
              result: partialText,
              newSessionId,
              sourceKind: 'overflow_partial',
              finalizationReason: 'error',
            });
          }
          emitResultUsage(resultMsg, containerInput.turnId || generateTurnId());
          processor.resetFullTextAccumulator();
          return {
            newSessionId,
            lastAssistantUuid,
            closedDuringQuery,
            contextOverflow: true,
            interruptedDuringQuery,
            pipedMessagesDuringQuery,
          };
        }
        if (textResult && isUnrecoverableTranscriptError(textResult)) {
          log(
            `Unrecoverable transcript error in result: ${textResult.slice(0, 200)}`,
          );
          emitResultUsage(resultMsg, containerInput.turnId || generateTurnId());
          processor.resetFullTextAccumulator();
          return {
            newSessionId,
            lastAssistantUuid,
            closedDuringQuery,
            unrecoverableTranscriptError: true,
            interruptedDuringQuery,
            pipedMessagesDuringQuery,
          };
        }

        // processResult 的调用保留其副作用（flush 流式缓冲、重置 fullTextAccumulator），
        // 但定稿正文不再取"全量拼接与 SDK result 的更长者"——那会把工具调用之间的
        // 过程旁白混进最终回复。选择链固定为：非空 SDK Result → 最近一条
        // 完全不含 top-level tool_use 的 AssistantMessage；旁白绝不兜底。
        processor.processResult(textResult);
        const finalText = assistantTextTracker.pickFinalText(textResult);
        // ── emit 前置计算：截断指纹 + 后台任务数 ──
        // finalizationReason / pendingBgTasks 必须随本条 result 一起送达主进程，
        // 主进程据此决定流式卡片是定稿「已完成」还是保持「后台任务运行中/自动续写中」。
        // 事后补发的 status 事件到达时卡片可能已定稿轮换（提示会被静默吞掉），
        // 这正是"卡片显示已完成但后台还在跑"的可见性 bug 的根源。
        const sdkUsage = resultMsg.usage as Record<string, number> | undefined;
        const suspectTruncated =
          emitOutput &&
          !!finalText &&
          isSuspectTruncatedStreamResult(sdkUsage, finalText.length);
        const pendingBgTasks = emitOutput
          ? processor.getBlockingPendingSdkTaskCount()
          : 0;
        if (pendingBgTasks > 0) {
          sawPendingBackgroundTasks = true;
        }
        if (
          shouldForceBackgroundTaskSummary({
            emitOutput,
            sawPendingBackgroundTasks,
            pendingBgTasks,
            finalText,
            attempts: backgroundSummaryForceAttempts,
            maxAttempts: MAX_BACKGROUND_SUMMARY_FORCE_ATTEMPTS,
          })
        ) {
          backgroundSummaryForceAttempts++;
          const forcePrompt = buildBackgroundTaskSummaryPrompt();
          log(
            `Result #${resultCount} looked like a stale background-task wait reply after all tasks settled; forcing final summary (${backgroundSummaryForceAttempts}/${MAX_BACKGROUND_SUMMARY_FORCE_ATTEMPTS})`,
          );
          emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'status',
              agentScope: 'system',
              statusText: '后台任务已全部完成，正在自动汇总最终结果',
              summary: '后台任务已全部完成，正在自动汇总最终结果',
              displayLevel: 'primary',
            },
          });
          assistantTextTracker.reset();
          canonicalAssistantUuid = undefined;
          suspectTruncatedTail = undefined;
          const rejected = stream.push(forcePrompt);
          if (rejected.length === 0) {
            containerInput.turnId = generateTurnId();
            resultReceivedAt = null;
            continue;
          }
          log(
            `Forced background summary prompt was rejected: ${rejected.join('; ')}`,
          );
        }
        if (suspectTruncated && finalText) {
          log(
            `Result #${resultCount} suspected truncated stream (zero-usage success, ${finalText.length} chars), will auto-continue`,
          );
          suspectTruncatedTail = finalText.slice(-200);
        } else {
          suspectTruncatedTail = undefined;
        }
        const resultOriginKind = (
          resultMsg.origin as { kind?: string } | undefined
        )?.kind;
        const backgroundResultReady = emitOutput
          ? processor.observeBackgroundResult(resultOriginKind)
          : true;
        const blockingBackgroundProtocol = emitOutput
          ? processor.getBlockingBackgroundProtocolCount()
          : 0;
        const inputTurnCompleted = isHealthyInputTurnCompletion(
          blockingBackgroundProtocol,
          suspectTruncated,
        );
        const candidate: BackgroundResultCandidate = {
          finalText,
          suspectTruncated,
          pendingBgTasks,
          sdkMessageUuid: canonicalAssistantUuid || lastAssistantUuid,
          completedAssistantUuid: canonicalAssistantUuid || lastAssistantUuid,
        };

        // Usage belongs to every real SDK result, including an old boundary
        // withheld while notification completion debt is still outstanding.
        // Keeping it here avoids losing provider billing facts when a newer
        // notification-driven result supersedes this candidate.
        emitResultUsage(resultMsg, containerInput.turnId || generateTurnId());
        assistantBatchFlushedSinceLastResult = false;
        assistantTextTracker.reset();
        canonicalAssistantUuid = undefined;

        if (
          inputTurnCompleted &&
          backgroundResultReady &&
          emitOutput &&
          processor.requiresBackgroundResultQuiescence()
        ) {
          // A task-completion result is only a candidate. A late init,
          // assistant or notification frame cancels this timer and requires a
          // newer result; an authoritative late empty level may reschedule it.
          pendingBackgroundResult = candidate;
          resultReceivedAt = null;
          scheduleBackgroundResultCompletion();
          log(
            `Result #${resultCount} background drain ready; waiting for quiescence`,
          );
        } else if (inputTurnCompleted && backgroundResultReady) {
          pendingBackgroundResult = undefined;
          publishResultCandidate(candidate, true);
        } else if (pendingBgTasks > 0 || suspectTruncated) {
          // Preserve the existing visible interim-result behavior while live
          // work remains. Completion debt without a live task is withheld so
          // an old result cannot be mistaken for the final summary.
          pendingBackgroundResult = undefined;
          publishResultCandidate(candidate, false);
        } else {
          // Retain the boundary while protocol debt is unresolved. A normal
          // notification-driven query will invalidate it before producing its
          // newer Result; `shouldQuery:false` deliberately has no newer Result
          // and may accept this candidate after settling the notification.
          pendingBackgroundResult =
            processor.requiresBackgroundResultQuiescence()
              ? candidate
              : undefined;
          resultReceivedAt = null;
          log(
            `Result #${resultCount} withheld: ${blockingBackgroundProtocol} background protocol obligation(s) remain`,
          );
          emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'status',
              agentScope: 'system',
              statusText: '后台任务已结束，正在等待 Agent 完成最终汇总',
              summary: '后台任务通知正在由主 Agent 收尾',
              displayLevel: 'primary',
            },
          });
        }

        if (pendingBgTasks > 0) {
          resultReceivedAt = null;
          log(
            `Result #${resultCount} emitted; holding stream open for ${pendingBgTasks} background task(s): ${processor.describePendingSdkTasks().join(' | ')}`,
          );
          emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'status',
              agentScope: 'system',
              statusText: `${pendingBgTasks} 个后台任务运行中，完成后将继续汇总`,
              summary: `${pendingBgTasks} 个后台任务运行中，完成后将继续汇总`,
              displayLevel: 'primary',
            },
          });
        }
      }
    }

    if (
      shouldFailIncompleteQueryExit({
        emitOutput,
        closedDuringQuery,
        interruptedDuringQuery,
        hasPendingTurns: ipcDeliveryTracker.hasPendingTurns,
        durableInputTurnCompleted: durableInputCompletion.isCompleted,
      })
    ) {
      throw new Error(
        'background_drain_incomplete: SDK query ended before the active input reached a durable result',
      );
    }

    // Cleanup residual state（IPC watcher 统一由下方 finally 关闭）
    processor.cleanup();

    log(
      `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, interruptedDuringQuery: ${interruptedDuringQuery}`,
    );
    return {
      newSessionId,
      lastAssistantUuid,
      closedDuringQuery,
      interruptedDuringQuery,
      cancelledIpcReceipts,
      pipedMessagesDuringQuery,
      suspectTruncatedTail,
      durableInputTurnCompleted: durableInputCompletion.isCompleted,
      providerFailureTurn,
      providerAccountFailure: false,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Ending the spent primary stream after a quota notice can make the SDK
    // throw while it tears down. The retry payload is already authoritative;
    // never let a transport-close error erase it.
    if (providerFailureTurn) {
      log(
        `Ignoring SDK teardown error after provider fallback handoff: ${errorMessage}`,
      );
      processor.discardPendingTextOutput();
      processor.cleanup();
      return {
        newSessionId,
        lastAssistantUuid,
        closedDuringQuery,
        interruptedDuringQuery,
        cancelledIpcReceipts,
        pipedMessagesDuringQuery,
        providerFailureTurn,
        providerAccountFailure: false,
      };
    }

    // 检测上下文溢出错误
    if (isContextOverflowError(errorMessage)) {
      log(`Context overflow detected: ${errorMessage}`);
      // ── 发射已累积的部分回复，避免用户已看到的流式内容丢失 ──
      const partialText = processor.getFullText();
      if (partialText.trim()) {
        log(
          `Emitting overflow_partial (catch) with ${partialText.length} chars`,
        );
        emit({
          status: 'success',
          result: partialText,
          newSessionId,
          sourceKind: 'overflow_partial',
          finalizationReason: 'error',
        });
      }
      return {
        newSessionId,
        lastAssistantUuid,
        closedDuringQuery,
        contextOverflow: true,
        interruptedDuringQuery,
        cancelledIpcReceipts,
        pipedMessagesDuringQuery,
      };
    }

    // 检测不可恢复的转录错误
    if (isUnrecoverableTranscriptError(errorMessage)) {
      log(`Unrecoverable transcript error: ${errorMessage}`);
      return {
        newSessionId,
        lastAssistantUuid,
        closedDuringQuery,
        unrecoverableTranscriptError: true,
        interruptedDuringQuery,
        cancelledIpcReceipts,
        pipedMessagesDuringQuery,
      };
    }

    // 中断导致的 SDK 错误（error_during_execution 等）：正常返回，不抛出
    if (interruptedDuringQuery) {
      log(`runQuery error during interrupt (non-fatal): ${errorMessage}`);
      // 收尾：catch 路径跳过了正常出口的 processor.cleanup()，残留 <200 字符的
      // 缓冲尾巴（未达 flush 阈值、定时器未触发）会永久丢失，导致 interrupt_partial 缺尾。
      // cleanup() 幂等安全（seenTextualResult 时丢尾避重复，否则 flushBuffers）。
      processor.cleanup();
      return {
        newSessionId,
        lastAssistantUuid,
        closedDuringQuery,
        interruptedDuringQuery,
        cancelledIpcReceipts,
        pipedMessagesDuringQuery,
      };
    }

    // Shutdown 触发的 interrupt（_close/_drain/post-result-timeout）：interruptQueryForShutdown()
    // 调用 query.interrupt() 中止挂起的工具调用，SDK 随后可能抛出 error_during_execution。
    // 这与 _interrupt sentinel 是同一类"主动中止"，不是真正的执行失败——必须按 interrupted
    // 同级处理为 non-fatal。否则在 result 尚未发射（resultCount===0，如 _close 在 query 刚起步就到）
    // 时会落到下方 re-throw，被外层当 error 退避，把一次干净的 shutdown 误报成失败。
    if (postResultInterruptRequested) {
      log(
        `runQuery error after shutdown interrupt (non-fatal): ${errorMessage}`,
      );
      // 同 interruptedDuringQuery：补 cleanup() 刷新残留缓冲尾巴，避免 shutdown
      // 中断时未达阈值的最后一小段文本丢失。
      processor.cleanup();
      return {
        newSessionId,
        lastAssistantUuid,
        closedDuringQuery,
        interruptedDuringQuery,
        cancelledIpcReceipts,
        pipedMessagesDuringQuery,
      };
    }

    // SDK 在 durable result 后可能再抛异常（如检测到 result text 含错误内容）。
    // 只有当前 input 已真实越过 publishResultCandidate(..., true) 才能降级；
    // resultCount 也包含被 background debt/quiescence 暂扣的边界，不能作为
    // “已成功发射”的替代，否则会吞掉未确认输入的恢复信号。
    if (durableInputCompletion.isCompleted) {
      log(
        `runQuery post-result SDK error (non-fatal, ${resultCount} result(s) already emitted): ${errorMessage}`,
      );
      if (err instanceof Error && err.stack) {
        log(`runQuery post-result error stack:\n${err.stack}`);
      }
      return {
        newSessionId,
        lastAssistantUuid,
        closedDuringQuery,
        interruptedDuringQuery,
        cancelledIpcReceipts,
        pipedMessagesDuringQuery,
        durableInputTurnCompleted: true,
      };
    }

    // 其他错误：记录完整堆栈后继续抛出
    log(
      `runQuery error [${(err as NodeJS.ErrnoException).code ?? 'unknown'}]: ${errorMessage}`,
    );
    if (err instanceof Error && err.stack) {
      log(`runQuery error stack:\n${err.stack}`);
    }
    // 继续抛出
    throw err;
  } finally {
    firstResponseWatchdog?.clear();
    backgroundResultGate.dispose();
    pendingBackgroundResult = undefined;
    // IPC watcher 清理：覆盖 try 块内的正常出口、catch 抛出，以及 try 内所有 early-return
    // （resume 失败 / 上下文溢出 / 不可恢复 transcript 错误）。query 启动前的中断 early-return
    // 在 try 之外，已就地 close()。finally 必然执行，避免长生命周期容器累积 FSWatcher + 后备
    // 定时器，以及旧 watcher 抢先 drain 本应进入新 query 的 IPC 消息。
    ipcPolling = false;
    ipcQueryWatcher.close();
  }
}

type RunQueryResult = Awaited<ReturnType<typeof runQueryAttempt>>;

/**
 * Run one logical query, retrying only its failed input turn when the primary
 * model quota is exhausted. The model state remains on fallback afterwards,
 * so later warm IPC turns do not first replay against the exhausted tier.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerConfig: ReturnType<typeof createSdkMcpServer>,
  containerInput: ContainerInput,
  workspaceMemoryInstructions: string,
  resumeAt?: string,
  emitOutput = true,
  allowedTools: string[] = DEFAULT_ALLOWED_TOOLS,
  disallowedTools?: string[],
  images?: Array<{ data: string; mimeType?: string }>,
  sourceKindOverride?: ContainerOutput['sourceKind'],
  initialIpcMessages: IpcInputMessage[] = [],
  mcpToolsContext?: McpContext,
  logicalInputTurnIdOverride?: string,
  acceptIpcMessagesDuringQuery = true,
): Promise<RunQueryResult> {
  const first = await runQueryAttempt(
    prompt,
    sessionId,
    mcpServerConfig,
    containerInput,
    workspaceMemoryInstructions,
    resumeAt,
    emitOutput,
    allowedTools,
    disallowedTools,
    images,
    sourceKindOverride,
    initialIpcMessages,
    mcpToolsContext,
    logicalInputTurnIdOverride,
    acceptIpcMessagesDuringQuery,
  );
  const failed = first.providerFailureTurn;
  if (!failed) return first;

  if (failed.laterIpcMessages.length > 0) {
    log(
      `Re-enqueueing ${failed.laterIpcMessages.length} later IPC message(s) behind provider fallback retry`,
    );
    requeueIpcInputMessages(IPC_INPUT_DIR, failed.laterIpcMessages);
  }

  containerInput.turnId = failed.turnId;
  const retryInput = latestIpcInputMessage(failed.ipcMessages);
  if (retryInput) {
    setCurrentChannelTurn(
      containerInput,
      retryInput.sourceJid,
      retryInput.channelContext,
    );
  }
  return runQueryAttempt(
    failed.prompt,
    failed.sessionIdBeforeTurn,
    mcpServerConfig,
    containerInput,
    workspaceMemoryInstructions,
    failed.resumeAt,
    emitOutput,
    allowedTools,
    disallowedTools,
    failed.images,
    sourceKindOverride,
    failed.ipcMessages,
    mcpToolsContext,
    logicalInputTurnIdOverride,
    acceptIpcMessagesDuringQuery,
  );
}

/**
 * process.exit() with SIGKILL safety net.
 * When SDK has pending async resources (background Task tools, MCP connections),
 * process.exit() may hang indefinitely. Force SIGKILL after 5 seconds.
 * See GitHub issue #236.
 *
 * The timer must NOT use .unref() — if process.exit() silently fails to
 * terminate (observed with SDK MCP transports holding the event loop),
 * an unref'd timer won't keep the loop alive and the SIGKILL never fires.
 * Using a ref'd timer guarantees the safety net triggers.
 */
function forceExitWithSafetyNet(code: number): never {
  log(`Exiting with code ${code}, SIGKILL safety net in 5s`);
  setTimeout(() => {
    console.error(
      '[agent-runner] process.exit() did not terminate, forcing SIGKILL',
    );
    process.kill(process.pid, 'SIGKILL');
  }, 5000);
  process.exit(code);
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // A cold turn without a durable IPC receipt is correlated by the original
    // host turn ID. Keep that fallback stable for every frame in this run.
    containerInput.turnId ||= generateTurnId();
    activeOutputInputTurnId = containerInput.turnId;
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  setCurrentChannelTurn(
    containerInput,
    containerInput.currentSourceJid,
    containerInput.channelContext,
  );

  // 第三方端点没有通用的官方默认模型，缺失时必须 fail-fast；官方
  // Claude 未指定模型则交给 SDK/CLI 选择默认模型。
  if (CLAUDE_PROVIDER_RUNTIME.missingRequiredModel) {
    writeOutput({
      status: 'error',
      result: null,
      error:
        '未配置模型：当前第三方 provider 缺少模型名（ANTHROPIC_MODEL 未注入）。请在 Claude 供应商设置中为该 provider 填写模型名（anthropicModel）后重试。',
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  latestSessionId = sessionId;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
  const agentBuilderEnabled = resolveAgentBuilderEnabled(
    containerInput,
    isHome,
  );

  // Create in-process SDK MCP server (replaces the stdio subprocess)
  // NOTE: chatJid and currentTaskId are mutated in-place by the main loop
  // below so that createMcpTools() closures observe updates via ctx reference.
  // See the per-turn updates at the bottom of the query loop.
  //
  // chatJid is initialized to the IM source of the message that triggered
  // this run (when known) — falls back to the container's startup chatJid.
  // This lets per-channel MCP tools (discord_*, etc.) see the actual incoming
  // chat even when the home container is shared across channels.
  const mcpToolsConfig: McpContext = {
    get chatJid() {
      return containerInput.currentSourceJid || containerInput.chatJid;
    },
    set chatJid(value: string) {
      containerInput.currentSourceJid = value;
    },
    get channelContext() {
      return containerInput.channelContext;
    },
    set channelContext(value: ChannelTurnContext | undefined) {
      containerInput.channelContext = value;
    },
    groupFolder: containerInput.groupFolder,
    isHome,
    isAdminHome,
    agentBuilderEnabled,
    ownerProfileEnabled: containerInput.happyClawOwnerProfileEnabled === true,
    interactionMode: containerInput.interactionMode ?? 'assistant',
    isScheduledTask: containerInput.isScheduledTask || false,
    currentTaskId: containerInput.messageTaskId ?? null,
    currentInputTurnId: containerInput.turnId,
    workspaceMemoryMutationAuth:
      containerInput.workspaceMemoryMutationSigningSecret &&
      containerInput.workspaceMemoryRunnerInstanceId
        ? {
            runnerInstanceId: containerInput.workspaceMemoryRunnerInstanceId,
            secret: containerInput.workspaceMemoryMutationSigningSecret,
            agentId: containerInput.agentId ?? null,
            taskRunId: containerInput.taskRunId ?? null,
          }
        : undefined,
    get currentSessionId() {
      return sessionId;
    },
    set currentSessionId(value: string | null | undefined) {
      sessionId = value ?? undefined;
    },
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
  };
  activeAgentMcpPolicy = resolveAgentMcpPolicy(
    parseAgentMcpPolicyMode(process.env.HAPPYCLAW_AGENT_MCP_POLICY),
  );
  const buildMcpServerConfig = () =>
    createSdkMcpServer({
      name: 'happyclaw',
      version: '1.0.0',
      tools: createMcpTools(mcpToolsConfig),
    });
  let mcpServerConfig = buildMcpServerConfig();
  const workspaceMemoryInstructions = MEMORY_SYSTEM_WORKSPACE;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale sentinels from previous container runs.
  // Note: _drain is NOT cleaned here — the host's cleanupIpcSentinels() in
  // runForGroup's finally block already removes stale sentinels between runs.
  // A _drain present at startup was written by registerProcess() for the
  // CURRENT run (indicating pending messages arrived during container boot).
  // Deleting it here causes those messages to be silently lost (#xxx).
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  cleanupStartupInterruptSentinel();

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  if (containerInput.isScheduledTask) {
    const scheduledTaskPrefixLines = [
      '[定时任务 - 以下内容由系统自动发送，并非来自用户或群组的直接消息。]',
      '',
      '重要：你正在定时任务模式下运行。你的最终输出会自动作为正式任务结果归档到所属 Web 工作区，但不会自动发送到飞书等外部渠道。',
      '',
      '最终输出必须包含一份完整、可独立阅读的业务结果，不得只回复“已完成”“已发送”、消息 ID、文件路径或简短摘要。需要向外部渠道交付时，默认在完成任务后调用一次 mcp__happyclaw__send_message；如果任务明确要求使用 feishu-cli 等其他工具，则按任务要求执行，不要重复发送。',
      '',
      '此外：本次运行就是该定时任务本身的执行，对应任务已在调度中。即使下面内容里出现「每隔/每天/定期/提醒我」等字样，也不要再调用 mcp__happyclaw__schedule_task 创建新的定时任务（除非内容明确要求你另外新建一个不同的任务）。',
    ];
    const scheduledTaskPrefix = scheduledTaskPrefixLines.join('\n');
    prompt = scheduledTaskPrefix + '\n\n' + prompt;
  }
  const pendingDrain = drainIpcInput();
  // Files replayed after a runner failure may still carry the previous
  // attempt's ID. Startup belongs to the host's newly allocated exact query,
  // so normalize the entire initial batch to ContainerInput.queryRunId.
  if (containerInput.queryRunId) {
    pendingDrain.messages = pendingDrain.messages.map((message) => ({
      ...message,
      queryRunId: containerInput.queryRunId,
    }));
  }
  let currentIpcMessages: IpcInputMessage[] = pendingDrain.messages;
  if (pendingDrain.messages.length > 0) {
    log(
      `Draining ${pendingDrain.messages.length} pending IPC messages into initial prompt`,
    );
    prompt += '\n' + pendingDrain.messages.map((m) => m.text).join('\n');
    const pendingImages = pendingDrain.messages.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
    // The latest drained message reflects the freshest incoming chat —
    // override the startup chatJid so per-channel MCP tools see it correctly.
    const latestPendingMessage = latestIpcInputMessage(pendingDrain.messages);
    setCurrentChannelTurn(
      containerInput,
      latestPendingMessage?.sourceJid,
      latestPendingMessage?.channelContext,
    );
    mcpToolsConfig.currentInputTurnId =
      latestIpcDeliveryId(pendingDrain.messages) ?? containerInput.turnId;
    // Likewise carry the task identity. A group-mode scheduled task injected
    // into this cold-start window (process registered, SDK transport not yet
    // ready) arrives via IPC with a taskId; without propagating it here the
    // first query's send_message would route as a non-task message and the task
    // notify would be lost (#559, on the boot-drain path the piped-message
    // taskId plumbing doesn't cover). Only override when a taskId is present so
    // a plain message in the batch doesn't wipe the startup messageTaskId.
    for (let i = pendingDrain.messages.length - 1; i >= 0; i--) {
      const tid = pendingDrain.messages[i].taskId;
      if (tid) {
        mcpToolsConfig.currentTaskId = tid;
        containerInput.messageTaskId = tid;
        break;
      }
    }
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  let resumeAt: string | undefined;
  let overflowRetryCount = 0;
  const MAX_OVERFLOW_RETRIES = 3;
  let consecutiveCompactions = 0;
  const MAX_CONSECUTIVE_COMPACTIONS = 3;
  // 暂存的会话历史上下文：当 auto-continue 阶段发生 sessionResumeFailed 时，
  // 历史无法直接拼到 auto-continue prompt（因为 fall-through 等下一条 IPC 消息后才重启 query），
  // 需要在下一轮主循环 query 之前消费它，避免新会话完全丢失上下文。
  let pendingHistoryContext: string | null = null;
  try {
    while (true) {
      pruneProcessedHistoryImagesInTranscript(sessionId);

      // 清理残留的 _interrupt sentinel（空闲期间写入的中断信号不应影响下一次 query）。
      // 注意：_drain 不在此处清理 — 如果 _drain 存在，说明有待处理的消息，
      // pollIpcDuringQuery 会在查询结果后检测到并正确退出容器。
      try {
        fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
      } catch {
        /* ignore */
      }
      clearInterruptRequested();

      // 消费 auto-continue 阶段暂存的 history context（如果存在）。
      // 对应 sessionResumeFailed 在 auto-continue 路径上的镜像处理：
      // 此时 sessionId 已被清空，pendingHistoryContext 是从旧 JSONL 转录中
      // 提取的最近对话历史，需在 fresh session 启动前注入到 prompt 前面。
      if (pendingHistoryContext) {
        prompt = pendingHistoryContext + prompt;
        log(
          'Injected pending session history context (from auto-continue resume failure) into prompt',
        );
        pendingHistoryContext = null;
      }

      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerConfig,
        containerInput,
        workspaceMemoryInstructions,
        resumeAt,
        true,
        DEFAULT_ALLOWED_TOOLS,
        undefined,
        promptImages,
        undefined,
        currentIpcMessages,
        mcpToolsConfig,
      );
      currentIpcMessages = queryResult.pipedMessagesDuringQuery;
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
        latestSessionId = sessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }
      if (queryResult.providerAccountFailure) {
        log('Account provider failure emitted; exiting runner');
        forceExitWithSafetyNet(0);
        return;
      }
      if (queryResult.terminalModelLimitFailure) {
        log('Model limit failure emitted; exiting runner');
        forceExitWithSafetyNet(0);
        return;
      }

      // A startup-context hard limit is a deterministic configuration error,
      // not a transient provider/context-overflow failure. Surface the stable
      // code once so the host can avoid retrying the same immutable snapshot.
      if (queryResult.contextBudgetExceeded) {
        writeOutput({
          status: 'error',
          result: null,
          error: `context_budget_exceeded: ${queryResult.contextBudgetExceeded.message}`,
          newSessionId: sessionId,
        });
        process.exit(1);
      }

      // Session resume 失败（SDK 无法恢复旧会话）：清除 session，以新会话重试
      // 同时从旧会话的 JSONL 转录中提取最近对话历史，注入到 prompt 中，
      // 避免新会话完全丢失上下文（类似 recoveryGroups 机制）。
      if (queryResult.sessionResumeFailed) {
        log(
          `Session resume failed, retrying with fresh session (old: ${sessionId})`,
        );
        // Extract recent history from the old session transcript before clearing
        if (sessionId) {
          const historyContext = extractSessionHistory(sessionId);
          if (historyContext) {
            prompt = historyContext + prompt;
            log(
              `Injected session history context into prompt for fresh session retry`,
            );
          }
        }
        sessionId = undefined;
        latestSessionId = undefined;
        resumeAt = undefined;
        consecutiveCompactions = 0;
        // Rebuild MCP server to avoid "Already connected to a transport" error
        mcpServerConfig = buildMcpServerConfig();
        continue;
      }

      pruneProcessedHistoryImagesInTranscript(sessionId);

      // 不可恢复的转录错误（如超大图片或 MIME 错配被固化在会话历史中）
      if (queryResult.unrecoverableTranscriptError) {
        const errorMsg =
          '会话历史中包含无法处理的数据（如超大图片或图片 MIME 错配），会话需要重置。';
        log(`Unrecoverable transcript error, signaling session reset`);
        writeOutput({
          status: 'error',
          result: null,
          error: `unrecoverable_transcript: ${errorMsg}`,
          newSessionId: sessionId,
        });
        process.exit(1);
      }

      // 检查上下文溢出
      if (queryResult.contextOverflow) {
        overflowRetryCount++;
        log(
          `Context overflow detected, retry ${overflowRetryCount}/${MAX_OVERFLOW_RETRIES}`,
        );

        if (overflowRetryCount >= MAX_OVERFLOW_RETRIES) {
          const errorMsg = `上下文溢出错误：已重试 ${MAX_OVERFLOW_RETRIES} 次仍失败。请联系管理员检查 CLAUDE.md 大小或减少会话历史。`;
          log(errorMsg);
          writeOutput({
            status: 'error',
            result: null,
            error: `context_overflow: ${errorMsg}`,
            newSessionId: sessionId,
          });
          process.exit(1);
        }

        // 未超过重试次数，等待后继续下一轮循环（会触发自动压缩）
        log(
          'Retrying query after context overflow (will trigger auto-compaction)...',
        );
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      // 成功执行后重置溢出重试计数器
      overflowRetryCount = 0;

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        // Notify host that this exit was due to _close, not a normal completion.
        // Without this marker the host treats the exit as silent success and
        // commits the message cursor, causing the in-flight IM message to be
        // consumed without a reply (the "swallowed message" bug).
        writeOutput({ status: 'closed', result: null });
        break;
      }

      // 中断后跳过 session update
      if (queryResult.interruptedDuringQuery) {
        // 中断后清除 resumeAt：被中断的 assistant 消息可能未完整提交到 session 历史。
        // 使用 undefined 让 SDK 自行选择恢复点，避免因指向不完整消息的 UUID 导致 resume 失败。
        resumeAt = undefined;
        writeOutput({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'status',
            statusText: 'interrupted',
            queryRunId: containerInput.queryRunId,
            turnId: containerInput.turnId,
            sessionId,
          },
          newSessionId: sessionId, // 确保主进程持久化 session ID
          turnId: containerInput.turnId,
          sessionId,
          ...(queryResult.cancelledIpcReceipts?.length
            ? { ipcReceipts: queryResult.cancelledIpcReceipts }
            : {}),
        });
        // 清理可能残留的 _interrupt / _drain 文件
        try {
          fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(IPC_INPUT_DRAIN_SENTINEL);
        } catch {
          /* ignore */
        }
        clearInterruptRequested();
        consecutiveCompactions = 0;

        // 当前 turn 已由 cancelCurrentTurn() 从未确认列表移除，不能重放；否则热
        // runner 的旧用户输入会抢在 steer 后再次执行。这里只回放当前 turn 之后
        // 已经被 SDK 接受、但尚未获得结果的后续 turn（若有）。
        if (queryResult.pipedMessagesDuringQuery.length > 0) {
          const piped = queryResult.pipedMessagesDuringQuery;
          log(
            `Query interrupted; re-enqueueing ${piped.length} later accepted message(s) to IPC`,
          );
          requeueIpcInputMessages(IPC_INPUT_DIR, piped);
        }

        // 等待下一条消息（包括刚重新入队的 piped 消息）
        log('Query interrupted by user, waiting for next message');
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received after interrupt, exiting');
          // 退出前发送 session 更新，确保主进程持久化最新 session ID
          writeOutput({
            status: 'success',
            result: null,
            newSessionId: sessionId,
          });
          break;
        }
        prompt = nextMessage.text;
        promptImages = nextMessage.images;
        currentIpcMessages = nextMessage.messages;
        containerInput.turnId = generateTurnId();
        mcpToolsConfig.currentInputTurnId =
          latestIpcDeliveryId(nextMessage.messages) ?? containerInput.turnId;
        // See main-loop comment: reset task attribution for this new turn.
        mcpToolsConfig.currentTaskId = nextMessage.taskId ?? null;
        containerInput.messageTaskId =
          mcpToolsConfig.currentTaskId ?? undefined;
        setCurrentChannelTurn(
          containerInput,
          nextMessage.sourceJid,
          nextMessage.channelContext,
        );
        // Rebuild MCP server to avoid "Already connected to a transport" error
        // when the previous query was aborted mid-stream (#421).
        mcpServerConfig = buildMcpServerConfig();
        continue;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      // ── Non-blocking compaction: auto-continue after context compaction ──
      // Instead of waiting for user to send "继续", automatically start a
      // new query so the agent resumes seamlessly where it left off.
      // The query is tagged with sourceKind='auto_continue' so the host
      // process can suppress context-maintenance noise that leaked into the
      // agent's session transcript — the host only forwards substantive user-facing
      // content to IM, preventing the bug described in issue #275.
      //
      // Guard: if compaction keeps firing repeatedly (e.g. system prompt alone
      // nearly fills the context window), stop auto-continuing to avoid an
      // infinite loop that burns API tokens without producing useful work.
      let ranCompactionContinue = false;
      if (hadCompaction) {
        hadCompaction = false;
        consecutiveCompactions++;
        if (consecutiveCompactions <= MAX_CONSECUTIVE_COMPACTIONS) {
          ranCompactionContinue = true;
          log(
            `Auto-continuing after compaction (${consecutiveCompactions}/${MAX_CONSECUTIVE_COMPACTIONS})`,
          );
          const autoContinuePrompt = [
            '继续。',
            '注意：刚刚发生了当前会话的上下文压缩。',
            '请**只关注与用户的实际对话**，从压缩前的最后一个对话话题自然衔接。',
            '如果压缩前你正在进行方案设计、讨论或等待用户确认，请简要回顾当前状态和待确认事项。',
            '如果压缩前已经在执行中，则继续执行。',
            '不要把压缩摘要当作其他会话或工作区的长期记忆，也不要向用户播报内部压缩状态。',
          ].join('');
          containerInput.turnId = generateTurnId();
          const autoContResult = await runQuery(
            autoContinuePrompt,
            sessionId,
            mcpServerConfig,
            containerInput,
            workspaceMemoryInstructions,
            resumeAt,
            true,
            DEFAULT_ALLOWED_TOOLS,
            undefined,
            undefined,
            'auto_continue',
            [],
            mcpToolsConfig,
          );
          if (autoContResult.newSessionId) {
            sessionId = autoContResult.newSessionId;
            latestSessionId = sessionId;
          }
          if (autoContResult.lastAssistantUuid) {
            resumeAt = autoContResult.lastAssistantUuid;
          }
          if (autoContResult.providerAccountFailure) {
            log(
              'Account provider failure during auto-continue; exiting runner',
            );
            forceExitWithSafetyNet(0);
            return;
          }
          if (autoContResult.terminalModelLimitFailure) {
            log('Model limit failure during auto-continue; exiting runner');
            forceExitWithSafetyNet(0);
            return;
          }
          if (autoContResult.closedDuringQuery) {
            log('Close sentinel during auto-continue, exiting');
            writeOutput({ status: 'closed', result: null });
            break;
          }
          if (autoContResult.sessionResumeFailed) {
            log(
              'WARN: Session resume failed during auto-continue, clearing session',
            );
            if (sessionId) {
              const historyContext = extractSessionHistory(sessionId);
              if (historyContext) {
                pendingHistoryContext = historyContext;
                log(
                  'Stashed session history context for next user-initiated query',
                );
              }
            }
            sessionId = undefined;
            latestSessionId = undefined;
            resumeAt = undefined;
            mcpServerConfig = buildMcpServerConfig();
          }
          if (autoContResult.unrecoverableTranscriptError) {
            log(
              'WARN: Unrecoverable transcript error during auto-continue, signaling reset',
            );
            writeOutput({
              status: 'error',
              result: null,
              error:
                'unrecoverable_transcript: 会话历史中包含无法处理的数据，会话需要重置。',
              newSessionId: sessionId,
            });
            process.exit(1);
          }
          if (autoContResult.contextOverflow) {
            log(
              'WARN: Context overflow during auto-continue, will be handled on next query',
            );
            // Don't retry here — the main loop's overflow-retry logic will
            // kick in on the next user-initiated query.
          }
          if (autoContResult.interruptedDuringQuery) {
            log('WARN: Auto-continue query was interrupted by user');
            resumeAt = undefined;
            try {
              fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
            } catch {
              /* ignore */
            }
          }
          // Auto-continue can consume user IPC while it is running. A query
          // that ends without a healthy result leaves those messages in the
          // delivery tracker; requeue them now so they become the next turn
          // instead of remaining invisible until host-side exit recovery.
          if (autoContResult.pipedMessagesDuringQuery.length > 0) {
            const pending = autoContResult.pipedMessagesDuringQuery;
            log(
              `Auto-continue ended with ${pending.length} unacknowledged IPC message(s); re-enqueueing`,
            );
            requeueIpcInputMessages(IPC_INPUT_DIR, pending);
          }
          // After auto-continue, fall through to wait for next IPC message.
        } else {
          log(
            `Compaction loop detected (${consecutiveCompactions} consecutive), stopping auto-continue and waiting for user input`,
          );
          consecutiveCompactions = 0;
        }
      } else {
        consecutiveCompactions = 0;
      }

      // ── 截断续写：上游断流的 partial 自动补全 ──
      // runQuery 检出「零 usage 成功 + 正文非空」指纹（上游网关长文本生成中断流，
      // SDK 把半截缓冲当 success 收口）时返回 suspectTruncatedTail。此处仿照压缩
      // auto-continue 的模式自动开续写 turn，把没写完的内容以后续消息补发——否则
      // 半截回复会被当成完整回复交付，进程空转到 IDLE_TIMEOUT 才死。
      // 上限 2 次防止网关持续断流时无限烧 token；压缩 auto-continue 本轮已跑过
      // 新 query 时跳过（模型已经继续过了）。
      let truncatedTail = ranCompactionContinue
        ? undefined
        : queryResult.suspectTruncatedTail;
      const truncationLogicalInputTurnId = activeOutputInputTurnId;
      const initialTruncationInputs = partitionIpcMessagesForLogicalTurn(
        queryResult.pipedMessagesDuringQuery,
        truncationLogicalInputTurnId,
      );
      let truncationIpcMessages = initialTruncationInputs.owned;
      if (initialTruncationInputs.deferred.length > 0) {
        requeueIpcInputMessages(
          IPC_INPUT_DIR,
          initialTruncationInputs.deferred,
        );
        log(
          `Re-enqueued ${initialTruncationInputs.deferred.length} later IPC message(s) before truncation continuation`,
        );
      }
      let truncationContinues = 0;
      const MAX_TRUNCATION_CONTINUES = 2;
      let closedDuringTruncationContinue = false;
      while (truncatedTail && truncationContinues < MAX_TRUNCATION_CONTINUES) {
        truncationContinues++;
        log(
          `Auto-continuing after suspected truncated stream (${truncationContinues}/${MAX_TRUNCATION_CONTINUES})`,
        );
        const truncationContinuePrompt = [
          '你的上一条回复在生成过程中被上游截断，用户看到的内容在以下结尾处戛然而止：',
          '```',
          truncatedTail,
          '```',
          '请从中断处直接继续写完剩余内容。不要重复已输出的部分，不要重新开头，不要道歉或解释截断，直接衔接上文继续。',
        ].join('\n');
        containerInput.turnId = generateTurnId();
        const contResult = await runQuery(
          truncationContinuePrompt,
          sessionId,
          mcpServerConfig,
          containerInput,
          workspaceMemoryInstructions,
          resumeAt,
          true,
          DEFAULT_ALLOWED_TOOLS,
          undefined,
          undefined,
          'truncation_continue',
          truncationIpcMessages,
          mcpToolsConfig,
          truncationLogicalInputTurnId,
          false,
        );
        truncationIpcMessages = contResult.pipedMessagesDuringQuery;
        currentIpcMessages = truncationIpcMessages;
        if (contResult.newSessionId) {
          sessionId = contResult.newSessionId;
          latestSessionId = sessionId;
        }
        if (contResult.lastAssistantUuid)
          resumeAt = contResult.lastAssistantUuid;
        if (contResult.providerAccountFailure) {
          log(
            'Account provider failure during truncation-continue; exiting runner',
          );
          forceExitWithSafetyNet(0);
          return;
        }
        if (contResult.terminalModelLimitFailure) {
          log('Model limit failure during truncation-continue; exiting runner');
          forceExitWithSafetyNet(0);
          return;
        }
        if (contResult.closedDuringQuery) {
          closedDuringTruncationContinue = true;
          break;
        }
        if (contResult.sessionResumeFailed) {
          // 同压缩 auto-continue 的处理：清 session 暂存历史，停止续写等下一条消息
          log(
            'WARN: Session resume failed during truncation-continue, clearing session',
          );
          if (sessionId) {
            const historyContext = extractSessionHistory(sessionId);
            if (historyContext) {
              pendingHistoryContext = historyContext;
              log(
                'Stashed session history context for next user-initiated query',
              );
            }
          }
          sessionId = undefined;
          latestSessionId = undefined;
          resumeAt = undefined;
          mcpServerConfig = buildMcpServerConfig();
          break;
        }
        if (contResult.unrecoverableTranscriptError) {
          log(
            'WARN: Unrecoverable transcript error during truncation-continue, signaling reset',
          );
          writeOutput({
            status: 'error',
            result: null,
            error:
              'unrecoverable_transcript: 会话历史中包含无法处理的数据，会话需要重置。',
            newSessionId: sessionId,
          });
          process.exit(1);
        }
        if (contResult.interruptedDuringQuery) {
          log('WARN: Truncation-continue query was interrupted by user');
          resumeAt = undefined;
          try {
            fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
          } catch {
            /* ignore */
          }
          break;
        }
        // 续写本身又被截断 → 带新结尾再续，直到写完或触顶
        truncatedTail = contResult.suspectTruncatedTail;
      }
      if (closedDuringTruncationContinue) {
        log('Close sentinel during truncation-continue, exiting');
        writeOutput({ status: 'closed', result: null });
        break;
      }
      if (truncatedTail) {
        // 续写触顶仍被断流 / 会话恢复失败等无法继续 → 发出机器状态标记
        //（字面与主进程 src/index.ts 的 TRUNCATION_EXHAUSTED_STATUS 保持一致），
        // 主进程据此把挂起中的卡片收口，不再等一个不会来的 healthy result。
        log(
          'Truncation-continue exhausted, signaling host to finalize held card',
        );
        writeOutput({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'status',
            agentScope: 'system',
            statusText: 'truncation_continue_exhausted',
            queryRunId: containerInput.queryRunId,
            turnId: containerInput.turnId,
          },
        });
      }
      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(
        `Got new message (${nextMessage.text.length} chars, ${nextMessage.images?.length || 0} images), starting new query`,
      );
      prompt = nextMessage.text;
      promptImages = nextMessage.images;
      currentIpcMessages = nextMessage.messages;
      containerInput.queryRunId =
        latestIpcInputMessage(nextMessage.messages)?.queryRunId ??
        containerInput.queryRunId;
      containerInput.turnId = generateTurnId();
      mcpToolsConfig.currentInputTurnId =
        latestIpcDeliveryId(nextMessage.messages) ?? containerInput.turnId;
      // Clear per-turn task attribution: the previous query may have been a
      // scheduled-task turn, but this new IPC message is a regular follow-up
      // unless it explicitly carried a taskId (see nextMessage.taskId below).
      // Forgetting to clear would cause regular user replies to be broadcast
      // to the task's notify channels, hijacking later conversation.
      mcpToolsConfig.currentTaskId = nextMessage.taskId ?? null;
      containerInput.messageTaskId = mcpToolsConfig.currentTaskId ?? undefined;
      setCurrentChannelTurn(
        containerInput,
        nextMessage.sourceJid,
        nextMessage.channelContext,
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`Agent error stack:\n${err.stack}`);
    }
    // Log cause chain for SDK-wrapped errors (e.g. EPIPE from internal claude CLI)
    const cause =
      err instanceof Error
        ? (err as NodeJS.ErrnoException & { cause?: unknown }).cause
        : undefined;
    if (cause) {
      const causeMsg =
        cause instanceof Error ? cause.stack || cause.message : String(cause);
      log(`Agent error cause:\n${causeMsg}`);
    }
    log(
      `Agent error errno: ${(err as NodeJS.ErrnoException).code ?? 'none'} exitCode: ${process.exitCode ?? 'none'}`,
    );
    // 不在 error output 中携带 sessionId：
    // 流式输出已通过 onOutput 回调传递了有效的 session 更新。
    // 如果这里携带的是 throw 前的旧 sessionId，会覆盖中间成功产生的新 session。
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    forceExitWithSafetyNet(1);
  }

  // main() 正常结束后必须显式退出。
  // SDK 内部可能留有未关闭的异步资源（MCP 连接、定时器等），
  // 如果不调用 process.exit()，Node.js 事件循环不会自动退出，
  // 导致 agent-runner 进程以 0% CPU 挂起，阻塞队列。
  //
  // Safety net: 当 SDK 的后台 Task (run_in_background) 持有异步资源时，
  // process.exit() 可能无法终止进程。5 秒后强制 SIGKILL。
  // 参考 GitHub issue #236。
  forceExitWithSafetyNet(0);
}

// 处理管道断开（EPIPE）：父进程关闭管道后仍有写入时，静默退出避免 code 1 错误输出
(process.stdout as NodeJS.WriteStream & NodeJS.EventEmitter).on(
  'error',
  (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  },
);
(process.stderr as NodeJS.WriteStream & NodeJS.EventEmitter).on(
  'error',
  (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  },
);

/**
 * 某些 SDK/底层 socket 会在管道断开后触发未捕获 EPIPE。
 * 这类错误通常发生在结果已输出之后，属于"收尾写入失败"，
 * 不应把整个 host query 标记为启动失败（code 1）。
 */
process.on('SIGTERM', () => {
  log('Received SIGTERM, exiting gracefully');
  // Emit latest session ID so the host can persist it before we exit.
  // Without this, the host starts a fresh session on restart, losing context.
  if (latestSessionId) {
    try {
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: latestSessionId,
      });
    } catch {
      /* stdout may be closed */
    }
  }
  forceExitWithSafetyNet(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, exiting gracefully');
  forceExitWithSafetyNet(0);
});

process.on('uncaughtException', (err: unknown) => {
  const errno = err as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (isWithinInterruptGraceWindow() && isInterruptRelatedError(err)) {
    console.error('Suppressing interrupt-related uncaught exception:', err);
    process.exit(0);
  }
  console.error('Uncaught exception:', err);
  // 尝试输出结构化错误，让主进程能收到错误信息而非仅看到 exit code 1
  try {
    writeOutput({ status: 'error', result: null, error: String(err) });
  } catch {
    /* ignore */
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const errno = reason as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (isWithinInterruptGraceWindow()) {
    console.error('Unhandled rejection during interrupt (non-fatal):', reason);
    return;
  }
  // SDK throws this when streamInput() is called before the ProcessTransport is ready.
  // The sdkTransportReady guard in pollIpcDuringQuery should prevent this, but catch
  // it here as a safety net to avoid crashing the agent on any residual race windows.
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes('ProcessTransport is not ready for writing')) {
    console.error('Suppressing ProcessTransport race (non-fatal):', reason);
    return;
  }
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
main().catch((err) => {
  console.error('Fatal error in main():', err);
  process.exit(1);
});
