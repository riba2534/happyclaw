/**
 * Container Runner for happyclaw
 * Spawns agent execution in Docker container and handles IPC
 */
import {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  spawn,
} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import {
  buildEffectiveMcpManifest,
  loadPluginMcpDefinitions,
} from './effective-mcp-manifest.js';
import { resolveHostNodeBinary } from './node-resolver.js';
import {
  loadMountAllowlist,
  validateAdditionalMounts,
} from './mount-security.js';
import {
  buildContainerEnvLines,
  clearInheritedClaudeProviderEnv,
  getClaudeProviderConfig,
  getContainerEnvConfig,
  getEnabledProviders,
  getBalancingConfig,
  getSystemSettings,
  getEffectiveExternalDir,
  mergeClaudeEnvConfig,
  resolveProviderById,
  shellQuoteEnvLines,
  writeCredentialsFile,
} from './runtime-config.js';
import { providerPool } from './provider-pool.js';
import { resolveProviderFailureDisposition } from './provider-failure.js';
import {
  deleteSession,
  getUserById,
  getSessionProviderId,
  setSessionProviderId,
} from './db.js';
import { isApiError } from './agent-output-parser.js';
import type { ClaudeProviderConfig } from './runtime-config.js';
import {
  loadManagedMcpLayers,
  resolveManagedMcpPolicy,
  type ManagedMcpLayers,
} from './mcp-utils.js';
import {
  loadClaudeContextMcpServers,
  mergeMcpServerLayers,
} from './mcp-context.js';
import {
  getUserRuntimeRoot,
  loadUserPlugins,
  CONTAINER_PLUGINS_PATH,
  type SdkPluginConfig,
} from './plugin-utils.js';
import { materializeUserRuntime } from './plugin-materializer.js';
import { invalidateUserCommandIndex } from './plugin-command-index.js';
import {
  checkHostCapabilities,
  logCapabilityPreflight,
} from './agent-capabilities.js';
import {
  buildClaudeContextPlan,
  loadHostClaudeSettings,
  syncHostClaudeContext,
} from './claude-context-resolver.js';
import { pluginSkillLayers } from './effective-skill-resolver.js';
import { MessageSourceKind, RegisteredGroup, StreamEvent } from './types.js';
import type {
  AgentProfileRuntimePolicy,
  ChannelTurnContext,
  InteractionMode,
} from './types.js';
import { validateSkillId, validateSkillPath } from './skill-utils.js';
import type { ClaudeContextAudit } from './stream-event.types.js';
import {
  resolveHostSkillPolicy,
  type HostSkillPolicy,
} from './agent-profile-policy.js';
import {
  attachStderrHandler,
  attachStdoutHandler,
  createStderrState,
  createStdoutParserState,
  handleNonZeroExit,
  handleSuccessClose,
  handleTimeoutClose,
  writeRunLog,
  type CloseHandlerContext,
} from './agent-output-parser.js';

/**
 * 宿主机的 ~/.claude.json 路径。
 * 所有工作区共享此文件，确保 deviceId (userID) 一致。
 * 即使 HappyClaw 项目删除重建，此文件始终存在于宿主机上。
 */
function getHostClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * 确保宿主机 ~/.claude.json 存在。
 * 如不存在则创建空 JSON，Claude Code 首次运行时会自动生成 userID。
 */
function ensureHostClaudeJson(): string {
  const p = getHostClaudeJsonPath();
  try {
    fs.writeFileSync(p, '{}', { mode: 0o600, flag: 'wx' });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
  return p;
}

/**
 * 为 Docker 容器生成精简版 .claude.json。
 * 宿主机 ~/.claude.json 中的 cachedGrowthBookFeatures 含 tengu_bridge_repl_v2 等
 * feature flags，SDK 初始化时会据此尝试建立 bridge 连接，在容器网络环境中无法完成
 * 导致进程挂起。剥离该字段后其余内容原样保留（userID 等）。
 * 同时剥离 oauthAccount：容器内不走宿主机的 OAuth 登录态，认证完全由
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 环境变量控制，避免 SDK 误检
 * OAuth 凭据后跳过标准 Bearer header（第三方 provider 返回 404）。
 */
function getContainerClaudeJsonPath(): string {
  const containerJsonDir = path.join(DATA_DIR, 'config');
  fs.mkdirSync(containerJsonDir, { recursive: true });
  const containerJsonPath = path.join(
    containerJsonDir,
    'container-claude-json.json',
  );

  try {
    const hostJson = JSON.parse(
      fs.readFileSync(getHostClaudeJsonPath(), 'utf-8'),
    );
    const stripped = { ...hostJson };
    delete stripped.cachedGrowthBookFeatures;
    delete stripped.oauthAccount;
    stripped.autoUpdates = false;
    fs.writeFileSync(
      containerJsonPath,
      JSON.stringify(stripped, null, 2) + '\n',
      { mode: 0o644 },
    );
  } catch {
    fs.writeFileSync(
      containerJsonPath,
      '{"hasCompletedOnboarding":true,"autoUpdates":false}\n',
      { mode: 0o644 },
    );
  }

  return containerJsonPath;
}

/**
 * 确保 localPath 是指向 targetPath 的 symlink。
 * 如果 localPath 是普通文件或指向错误目标的 symlink，替换它。
 */
function ensureSymlinkTo(localPath: string, targetPath: string): void {
  try {
    const st = fs.lstatSync(localPath);
    if (st.isSymbolicLink() && fs.readlinkSync(localPath) === targetPath) {
      return; // 已经是正确的 symlink
    }
    fs.unlinkSync(localPath); // 普通文件或错误 symlink，删除
  } catch {
    // 文件不存在，继续创建
  }
  try {
    fs.symlinkSync(targetPath, localPath);
  } catch (err) {
    logger.warn(
      { err, localPath, targetPath },
      'Failed to create symlink for .claude.json, deviceId may differ',
    );
  }
}

/** Required env flags for settings.json — 每次启动时强制写入，不可被宿主机配置覆盖。 */
const REQUIRED_SETTINGS_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  // 禁用 SDK 附件注入（token_usage, changed_files, todo_reminders 等 20+ 种动态消息）。
  // 这些附件在每次 query() 时动态生成但不持久化到 JSONL，导致跨进程的消息数组
  // 前缀不匹配，prompt cache 永远失效（cache_read 始终 = 11224 静态 system prompt）。
  // 禁用后历史消息的缓存前缀跨 query() 保持一致，实现 1M 上下文下的增量缓存。
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
};

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeSettingsRecord(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key];
    merged[key] =
      isSettingsRecord(previous) && isSettingsRecord(value)
        ? mergeSettingsRecord(previous, value)
        : value;
  }
  return merged;
}

function removePreviousSettingsProjection(
  current: Record<string, unknown>,
  previousProjection: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...current };
  for (const [key, projectedValue] of Object.entries(previousProjection)) {
    const currentValue = cleaned[key];
    if (isSettingsRecord(currentValue) && isSettingsRecord(projectedValue)) {
      const nested = removePreviousSettingsProjection(
        currentValue,
        projectedValue,
      );
      if (Object.keys(nested).length === 0) delete cleaned[key];
      else cleaned[key] = nested;
      continue;
    }
    // Preserve a value edited after projection; it is now a session-owned
    // override rather than stale native state.
    if (JSON.stringify(currentValue) === JSON.stringify(projectedValue)) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

function readSettingsRecord(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isSettingsRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge the selected native layer into the isolated session settings. */
function ensureSettingsJson(
  settingsFile: string,
  mcpServers?: Record<string, Record<string, unknown>>,
  options?: {
    replaceMcpServers?: boolean;
    baseSettings?: Record<string, unknown>;
  },
): void {
  const projectionFile = path.join(
    path.dirname(settingsFile),
    '.happyclaw-native-settings.json',
  );
  const current = readSettingsRecord(settingsFile);
  const previousProjection = readSettingsRecord(projectionFile);
  const existing = mergeSettingsRecord(
    removePreviousSettingsProjection(current, previousProjection),
    options?.baseSettings ?? {},
  );

  const existingEnv = (existing.env as Record<string, string>) || {};
  const mergedEnv = { ...existingEnv, ...REQUIRED_SETTINGS_ENV };
  const merged: Record<string, unknown> = { ...existing, env: mergedEnv };

  // Merge user-configured MCP servers into settings by default. AgentProfile
  // policy uses replace mode so disabled/custom MCP does not leave stale
  // servers from an earlier run in the session settings.
  if (options?.replaceMcpServers) {
    merged.mcpServers = mcpServers ?? {};
  } else if (mcpServers && Object.keys(mcpServers).length > 0) {
    const existingMcp = (existing.mcpServers as Record<string, unknown>) || {};
    merged.mcpServers = { ...existingMcp, ...mcpServers };
  }

  const newContent = JSON.stringify(merged, null, 2) + '\n';

  let settingsChanged = true;
  try {
    if (fs.existsSync(settingsFile)) {
      const current = fs.readFileSync(settingsFile, 'utf8');
      settingsChanged = current !== newContent;
    }
  } catch {
    /* write anyway */
  }
  if (settingsChanged) {
    fs.writeFileSync(settingsFile, newContent, { mode: 0o644 });
  }

  const projectionContent = `${JSON.stringify(options?.baseSettings ?? {}, null, 2)}\n`;
  try {
    if (
      fs.existsSync(projectionFile) &&
      fs.readFileSync(projectionFile, 'utf8') === projectionContent
    ) {
      return;
    }
  } catch {
    /* write anyway */
  }
  fs.writeFileSync(projectionFile, projectionContent, { mode: 0o600 });
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  /** Exact GroupQueue query attempt for Web stream fencing. */
  queryRunId?: string;
  groupFolder: string;
  chatJid: string;
  /** Workspace-scoped interaction contract for this public Agent turn. */
  interactionMode?: InteractionMode;
  /** Source JID of the latest message that triggered this run (e.g. `discord:123…`).
   * Used by per-channel MCP tools (discord_*, etc.) to identify the current
   * incoming chat. Undefined when chatJid already encodes the IM source. */
  currentSourceJid?: string;
  /** Sanitized provider identity for the exact input turn. */
  channelContext?: ChannelTurnContext;
  /** @deprecated Use isHome + isAdminHome instead */
  isMain: boolean;
  turnId?: string;
  isHome?: boolean;
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** Isolated task run ID — determines IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  /** Claude session/provider namespace. Tasks use task:<id> while IPC still uses taskRunId. */
  sessionAgentId?: string;
  /** If the last unprocessed message was emitted by a scheduled task prompt,
   * this is that task's ID; propagated into agent-runner so MCP send_message
   * outputs can be attributed back to the task record. */
  messageTaskId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentProfile?: {
    id: string;
    name: string;
    version: number;
    identityHash: string;
    identityPrompt: string;
    includeClaudePreset: boolean;
    runtimePolicy?: AgentProfileRuntimePolicy;
  };
  /** Host-derived capability flag for main-HappyClaw interactive sessions. */
  agentBuilderEnabled?: boolean;
  agentId?: string;
  agentName?: string;
  /**
   * Claude Code plugins to inject into the SDK query (via `options.plugins`).
   * Populated just-in-time by runContainerAgent/runHostAgent from the owner's
   * plugins.json; never set by the caller.
   */
  plugins?: Array<{ type: 'local'; path: string }>;
  /** Runtime context audit bootstrap; agent-runner enriches it with SDK usage. */
  contextAudit?: ClaudeContextAudit;
  /** Canonical effective Skill set for SDK selection and run provenance. */
  skillManifest?: { hash: string; selectedSkillIds: string[] };
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  providerFailure?: boolean;
  /**
   * Host-derived terminal boundary. False means the durable input must be
   * replayed on another healthy provider; true means the pool is exhausted.
   */
  providerFailureTerminal?: boolean;
  /** Internal agent-runner marker: the failed turn is being retried in-process. */
  providerFailureRetrying?: boolean;
  /** Provider failed during a post-turn internal maintenance query. */
  providerFailureMaintenance?: boolean;
  streamEvent?: StreamEvent;
  /** Durable input-turn correlation emitted by agent-runner. */
  readonly inputTurnId?: string;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
  /** 'truncated'：上游断流截断的 partial（usage 双零指纹，runner 会自动续写） */
  finalizationReason?: 'completed' | 'interrupted' | 'error' | 'truncated';
  /** 本 result 发出时仍未 settle 的后台任务数（异步 Agent / backgrounded Bash）。
   * >0 时主进程把流式卡片保持在「后台任务运行中」而非定稿。 */
  pendingBgTasks?: number;
  inputTurnCompleted?: boolean;
  /** The streaming SDK query has no accepted user turn left to process. */
  queryIdle?: boolean;
  ipcReceipts?: Array<{
    deliveryId: string;
    chatJid: string;
    coveredCursors?: Array<{
      timestamp: string;
      id: string;
      sourceJid?: string;
    }>;
    cursor: { timestamp: string; id: string; sourceJid?: string };
  }>;
}

function applyProviderFailureDisposition(
  output: ContainerOutput,
  selectedProfileId: string | null,
): boolean {
  providerPool.refreshFromConfig(getEnabledProviders(), getBalancingConfig());
  providerPool.refreshRecoveryState();
  const disposition = resolveProviderFailureDisposition(
    selectedProfileId,
    providerPool.getHealthStatuses(),
  );
  applyKnownProviderFailureDisposition(output, disposition.terminal);
  return disposition.terminal;
}

function applyKnownProviderFailureDisposition(
  output: ContainerOutput,
  terminal: boolean,
): void {
  // Provider failures are control-plane signals. Chat/task callers synthesize
  // their own terminal projection only after the pool is exhausted.
  output.result = null;
  output.providerFailureTerminal = terminal;
  output.inputTurnCompleted = terminal;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Create directory with 0o777 permissions for container volume mounts.
 * Fixes uid mismatch between host user and container node user (uid 1000),
 * especially in rootless podman where uid remapping causes permission denied.
 */
function mkdirForContainer(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  try {
    fs.chmodSync(dirPath, 0o777);
  } catch {
    // Ignore — may fail on read-only filesystem or special mounts
  }
}

export function replaceHostMcpServersEnv(
  env: Record<string, string>,
  servers: Record<string, Record<string, unknown>>,
): void {
  delete env['HAPPYCLAW_USER_MCP_SERVERS_JSON'];
  if (Object.keys(servers).length > 0) {
    env['HAPPYCLAW_USER_MCP_SERVERS_JSON'] = JSON.stringify(servers);
  }
}

interface ResolvedProvider {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
}

type RunnerAgentProfile = NonNullable<ContainerInput['agentProfile']>;

function ownerCanUseAdminOnlySystemMcp(
  ownerId: string | null | undefined,
): boolean {
  if (!ownerId) return false;
  try {
    const owner = getUserById(ownerId);
    return owner?.role === 'admin' && owner.status === 'active';
  } catch {
    // Database initialization/test harness failures must never widen access.
    return false;
  }
}

function sanitizeRuntimePolicyPathSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || 'default'
  );
}

function shouldIncludeHostClaudeContext(
  agentProfile?: RunnerAgentProfile,
): boolean {
  return agentProfile?.runtimePolicy?.context?.source === 'host_claude';
}

function resolveAgentProfileHostSkillPolicy(
  agentProfile?: RunnerAgentProfile,
): HostSkillPolicy {
  const policy: HostSkillPolicy = agentProfile?.runtimePolicy
    ? resolveHostSkillPolicy(agentProfile.runtimePolicy)
    : { mode: 'disabled', ids: [] };
  if (!agentProfile || policy.mode !== 'custom') return policy;

  const sourceRoot = path.join(getEffectiveExternalDir(), 'skills');
  for (const id of policy.ids) {
    const source = path.join(sourceRoot, id);
    if (
      !validateSkillId(id) ||
      !validateSkillPath(sourceRoot, source) ||
      !fs.existsSync(path.join(source, 'SKILL.md'))
    ) {
      throw new Error(
        `agent_profile_unavailable: AgentProfile ${agentProfile.id} requires unavailable host skill ${id}`,
      );
    }
  }
  return policy;
}

function getAgentAutoCompactWindow(agentProfile?: RunnerAgentProfile): number {
  const value = agentProfile?.runtimePolicy?.context?.auto_compact_window ?? 0;
  return value === 0 || (value >= 100_000 && value <= 1_000_000) ? value : 0;
}

function getAgentAutoCompactPercentage(
  agentProfile?: RunnerAgentProfile,
): number {
  const value =
    agentProfile?.runtimePolicy?.context?.auto_compact_percentage ?? 0;
  return value === 0 || (value >= 50 && value <= 90) ? value : 0;
}

function resolveAgentProfileUserSkillsPolicy(
  ownerId: string | undefined,
  agentProfile?: RunnerAgentProfile,
): { mountUserSkills: boolean; userSkillsDirOverride?: string } {
  const policy = agentProfile?.runtimePolicy?.skills;
  if (!ownerId || !policy || policy.mode === 'inherit') {
    return { mountUserSkills: !!ownerId };
  }
  if (policy.mode === 'disabled') {
    return { mountUserSkills: false };
  }

  const sourceRoot = path.join(DATA_DIR, 'skills', ownerId);
  const selectedSkills = policy.ids.map((id) => {
    const source = path.join(sourceRoot, id);
    if (!validateSkillId(id) || !validateSkillPath(sourceRoot, source)) {
      throw new Error(
        `AgentProfile ${agentProfile.id} selects unsafe skill id ${id}`,
      );
    }
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(source).isDirectory();
    } catch {
      // Report the same policy failure for deleted and never-installed skills.
    }
    if (!isDirectory) {
      // Deterministic misconfiguration (deleted/disabled skill), never
      // transient — prefix lets index.ts fail fast instead of retrying with
      // exponential backoff (same pattern as context_overflow: / see below).
      throw new Error(
        `agent_profile_unavailable: AgentProfile ${agentProfile.id} requires unavailable skill ${id}`,
      );
    }
    let hasSkillDefinition = false;
    try {
      hasSkillDefinition = fs.statSync(path.join(source, 'SKILL.md')).isFile();
    } catch {
      // Disabled/deleted definitions must invalidate the exact-set policy.
    }
    if (!hasSkillDefinition) {
      throw new Error(
        `agent_profile_unavailable: AgentProfile ${agentProfile.id} requires unavailable skill definition ${id}/SKILL.md`,
      );
    }
    return { id, source };
  });
  const runtimeRoot = path.join(
    DATA_DIR,
    'agent-profile-runtime',
    ownerId,
    sanitizeRuntimePolicyPathSegment(agentProfile.id),
    `v${agentProfile.version}`,
    'skills',
  );
  if (!fs.existsSync(runtimeRoot)) {
    const stagingRoot = `${runtimeRoot}.tmp-${randomUUID()}`;
    fs.mkdirSync(stagingRoot, { recursive: true });
    try {
      for (const { id, source } of selectedSkills) {
        fs.symlinkSync(source, path.join(stagingRoot, id));
      }
      fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });
      try {
        fs.renameSync(stagingRoot, runtimeRoot);
      } catch (err) {
        // A concurrent runner may have published the same immutable version.
        if (!fs.existsSync(runtimeRoot)) throw err;
      }
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  return { mountUserSkills: true, userSkillsDirOverride: runtimeRoot };
}

function resolveAgentProfileMcpPolicy(
  layers: ManagedMcpLayers,
  agentProfile?: RunnerAgentProfile,
): {
  servers: Record<string, Record<string, unknown>>;
  replaceMcpServers: boolean;
} {
  const policy = agentProfile?.runtimePolicy?.mcp;
  const resolved = resolveManagedMcpPolicy(
    layers,
    policy ?? { mode: 'inherit', ids: [] },
  );
  if (resolved.missing.length > 0) {
    // Deterministic misconfiguration (deleted/disabled MCP server), never
    // transient — see agent_profile_unavailable: prefix note above.
    throw new Error(
      `agent_profile_unavailable: AgentProfile ${agentProfile?.id ?? 'unknown'} requires unavailable MCP server(s): ${resolved.missing.join(', ')}`,
    );
  }
  return {
    servers: resolved.servers,
    replaceMcpServers: policy?.mode !== 'inherit',
  };
}

function resolveRuntimeMcpServers(
  group: RegisteredGroup,
  agentProfile?: RunnerAgentProfile,
): Record<string, Record<string, unknown>> {
  const managedLayers = group.created_by
    ? loadManagedMcpLayers(group.created_by, {
        allowAdminOnlySystemMcp: ownerCanUseAdminOnlySystemMcp(
          group.created_by,
        ),
      })
    : { system: {}, user: {}, restrictedSystemIds: [] };
  const managed = resolveAgentProfileMcpPolicy(
    managedLayers,
    agentProfile,
  ).servers;
  const context = loadClaudeContextMcpServers({
    workspaceDir: path.join(GROUPS_DIR, group.folder),
    externalClaudeDir: getEffectiveExternalDir(),
    includeHostClaudeContext: shouldIncludeHostClaudeContext(agentProfile),
  });
  return mergeMcpServerLayers(context, managed);
}

function buildRuntimeMcpManifest(
  group: RegisteredGroup,
  agentProfile: RunnerAgentProfile | undefined,
  plugins: SdkPluginConfig[],
) {
  const pluginServers =
    getAgentProfileMcpPolicyMode(agentProfile) === 'inherit'
      ? loadPluginMcpDefinitions(plugins)
      : {};
  return buildEffectiveMcpManifest({
    ...resolveRuntimeMcpServers(group, agentProfile),
    ...pluginServers,
  });
}

function getAgentProfileMcpPolicyMode(
  agentProfile?: RunnerAgentProfile,
): 'inherit' | 'custom' | 'disabled' {
  return agentProfile?.runtimePolicy?.mcp.mode ?? 'inherit';
}

/**
 * One-time provider overrides per group folder.
 * Set by switchProvider(), consumed (and deleted) by trySelectPoolProvider().
 */
const providerOverrides = new Map<string, string>();

export function setProviderOverride(
  groupFolder: string,
  providerId: string,
): void {
  providerOverrides.set(groupFolder, providerId);
}

/**
 * Read-only prediction of whether the next provider selection will *clear* the
 * resumable Claude session because it has to switch away from the bound
 * provider (the binding is unhealthy or no longer enabled, or a one-time
 * override targets a different provider). Mirrors the `resetSession` conditions
 * in trySelectPoolProvider without mutating sticky bindings.
 *
 * The orchestration layer calls this *before* building the prompt so a
 * proactive provider switch injects recent conversation history into the fresh
 * session — matching the reactive (mid-stream provider-failure) path. Without
 * this, the first turn under the new provider would see an empty conversation.
 *
 * Conservative by design: a false positive only injects redundant history
 * (harmless), never the reverse.
 */
export function willClearSessionOnProviderSwitch(
  groupFolder: string,
  agentId?: string | null,
): boolean {
  // Env-level provider override means the pool is bypassed entirely — no
  // pool-driven switch, so the session is never cleared on this account.
  const override = getContainerEnvConfig(groupFolder);
  if (
    override.anthropicApiKey ||
    override.anthropicAuthToken ||
    override.anthropicBaseUrl
  ) {
    return false;
  }

  const boundId = getSessionProviderId(groupFolder, agentId);
  if (!boundId) return false;

  // One-time override (from switchProvider) targeting a different provider will
  // reset. Peek without consuming — trySelectPoolProvider consumes it later.
  const overrideProviderId = providerOverrides.get(groupFolder);
  if (overrideProviderId) {
    return overrideProviderId !== boundId;
  }

  const enabledProviders = getEnabledProviders();
  if (enabledProviders.length === 0) return false;

  // Bound provider removed/disabled → a fresh one gets picked → reset.
  const stillEnabled = enabledProviders.some((p) => p.id === boundId);
  if (!stillEnabled) return true;

  // Single enabled provider equal to the binding → sticky, no reset.
  if (enabledProviders.length === 1) {
    return enabledProviders[0].id !== boundId;
  }

  // Multiple providers: sticky reuse only when the binding is still healthy.
  // Unhealthy binding falls through to pool selection, which prefers a
  // different healthy provider → reset.
  const balancing = getBalancingConfig();
  providerPool.refreshFromConfig(enabledProviders, balancing);
  return !providerPool.getHealthStatus(boundId).healthy;
}

/**
 * Try to select a provider from the pool. Returns profileId + resolved config,
 * or null if no providers are enabled / group has env-level provider override / selection fails.
 * For single-provider setups, returns the provider for display without pool balancing.
 * One-time overrides (from switchProvider) are consumed on use.
 *
 * Session-sticky binding (when groupFolder + agentId identifies a resumable Claude
 * session): if the session has a previously-bound provider that is still enabled,
 * prefer it over load-balancing. This prevents "Invalid signature in thinking
 * block" 400 errors when a conversation that produced thinking blocks under
 * provider A gets resumed in a fresh container that the pool routes to provider B
 * (different OAuth account / API key). Each successful selection updates the
 * binding via setSessionProviderId().
 */
export function trySelectPoolProvider(
  groupFolder: string,
  agentId?: string | null,
): {
  profileId: string;
  resolved: ResolvedProvider;
  previousProviderId?: string;
  resetSession?: boolean;
} | null {
  const override = getContainerEnvConfig(groupFolder);
  const hasOverride = !!(
    override.anthropicApiKey ||
    override.anthropicAuthToken ||
    override.anthropicBaseUrl
  );
  const existingBoundId = getSessionProviderId(groupFolder, agentId);
  if (hasOverride) return null;

  // Check one-time override (consumed on use)
  const overrideProviderId = providerOverrides.get(groupFolder);
  if (overrideProviderId) {
    providerOverrides.delete(groupFolder);
    try {
      const resolved = resolveProviderById(overrideProviderId);
      providerPool.acquireSession(overrideProviderId);
      // Override path also updates sticky binding so subsequent runs follow.
      setSessionProviderId(groupFolder, agentId, overrideProviderId);
      logger.info(
        { groupFolder, providerId: overrideProviderId },
        'Using one-time provider override',
      );
      return {
        profileId: overrideProviderId,
        resolved: { config: resolved.config, customEnv: resolved.customEnv },
        previousProviderId: existingBoundId,
        resetSession:
          !!existingBoundId && existingBoundId !== overrideProviderId,
      };
    } catch (err) {
      logger.warn(
        { err, providerId: overrideProviderId },
        'Provider override failed, falling back to pool',
      );
    }
  }

  // Refresh pool state from V4 config
  const enabledProviders = getEnabledProviders();
  if (enabledProviders.length === 0) return null;
  const balancing = getBalancingConfig();
  providerPool.refreshFromConfig(enabledProviders, balancing);
  const boundId = existingBoundId;

  // Sticky path: respect previous session→provider binding when the bound
  // provider is still enabled. Skip when only one provider exists (single
  // provider already gives stickiness implicitly).
  if (enabledProviders.length > 1) {
    if (boundId && enabledProviders.some((p) => p.id === boundId)) {
      const boundHealth = providerPool.getHealthStatus(boundId);
      if (!boundHealth.healthy) {
        logger.info(
          { groupFolder, agentId: agentId || null, providerId: boundId },
          'Sticky provider is unhealthy, falling back to pool selection',
        );
      } else {
        try {
          const resolved = resolveProviderById(boundId);
          providerPool.acquireSession(boundId);
          logger.debug(
            { groupFolder, agentId: agentId || null, providerId: boundId },
            'Reusing sticky provider binding for resumed session',
          );
          return {
            profileId: boundId,
            resolved: {
              config: resolved.config,
              customEnv: resolved.customEnv,
            },
          };
        } catch (err) {
          logger.warn(
            { err, providerId: boundId },
            'Sticky provider resolution failed, falling back to pool selection',
          );
        }
      }
    } else if (boundId) {
      // Bound provider was disabled or removed — fall through and pick a fresh one.
      logger.info(
        { groupFolder, agentId: agentId || null, providerId: boundId },
        'Sticky provider no longer enabled, falling back to pool selection',
      );
    }
  }

  // Single provider: return its ID for display, acquire session for consistency
  if (enabledProviders.length === 1) {
    try {
      const resolved = resolveProviderById(enabledProviders[0].id);
      providerPool.acquireSession(enabledProviders[0].id);
      setSessionProviderId(groupFolder, agentId, enabledProviders[0].id);
      return {
        profileId: enabledProviders[0].id,
        resolved: { config: resolved.config, customEnv: resolved.customEnv },
        previousProviderId: boundId,
        resetSession: !!boundId && boundId !== enabledProviders[0].id,
      };
    } catch {
      return null;
    }
  }

  try {
    const profileId = providerPool.selectProvider();
    const resolved = resolveProviderById(profileId);
    providerPool.acquireSession(profileId);
    setSessionProviderId(groupFolder, agentId, profileId);
    return {
      profileId,
      resolved: { config: resolved.config, customEnv: resolved.customEnv },
      previousProviderId: boundId,
      resetSession: !!boundId && boundId !== profileId,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Provider pool selection failed, falling back to active profile',
    );
    return null;
  }
}

/**
 * Best-effort pre-spawn materialize for host-mode plugins. Mirrors the docker
 * path's behaviour in `buildVolumeMounts`: v2 config can exist before the
 * runtime/ tree is built (first enable, or after orphan GC), and
 * `loadUserPlugins({runtime:'host'})` only emits paths whose manifests exist
 * on disk. Without this call host agents would silently start with 0 plugins
 * even when the user has plugins enabled. Failure is logged, never thrown —
 * the agent simply starts with whatever subset is already materialized.
 */
export function prepareHostPlugins(
  ownerId: string | null | undefined,
): SdkPluginConfig[] {
  if (!ownerId) return [];
  try {
    materializeUserRuntime(ownerId);
  } catch (err) {
    logger.warn(
      { ownerId, err },
      'prepareHostPlugins: materializeUserRuntime failed; host agent will see no plugins',
    );
  }
  // Drop the user's command index cache so a stale empty entry (e.g. a prior
  // /commands hit before runtime existed, see plugin-command-index.ts:235) is
  // rebuilt against the now-materialized tree. Invalidate on both success and
  // failure paths: a partial materialize still wants the cache rebuilt.
  invalidateUserCommandIndex(ownerId);
  return loadUserPlugins(ownerId, { runtime: 'host' });
}

/** Inject the globally configured same-turn fallback into the agent runner. */
export function applyFallbackModelToEnvLines(
  envLines: string[],
  configuredFallbackModel = getSystemSettings().fallbackModel,
): void {
  for (let i = envLines.length - 1; i >= 0; i--) {
    if (envLines[i].startsWith('HAPPYCLAW_FALLBACK_MODEL=')) {
      envLines.splice(i, 1);
    }
  }
  const fallbackModel = configuredFallbackModel?.trim();
  if (!fallbackModel) return;
  envLines.push(`HAPPYCLAW_FALLBACK_MODEL=${fallbackModel}`);
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isAdminHome: boolean,
  mountUserSkills = true,
  sessionAgentId?: string,
  ownerHomeFolder?: string,
  taskRunId?: string,
  resolvedProvider?: ResolvedProvider,
  ipcAgentId?: string,
  agentProfile?: RunnerAgentProfile,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = path.join(GROUPS_DIR, group.folder);

  // Per-user global memory directory:
  // Each user gets their own user-global/{userId}/ mounted as /workspace/global
  const ownerId = group.created_by;
  if (ownerId) {
    const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
    mkdirForContainer(userGlobalDir);
    mounts.push({
      hostPath: userGlobalDir,
      containerPath: '/workspace/global',
      readonly: !group.is_home,
    });
  } else {
    // Legacy fallback for rows without created_by.
    const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
    mkdirForContainer(legacyGlobalDir);
    mounts.push({
      hostPath: legacyGlobalDir,
      containerPath: '/workspace/global',
      readonly: !isAdminHome,
    });
  }

  if (isAdminHome) {
    // Admin home gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Admin home also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Member home and non-home groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Memory directory: home containers write their own; non-home containers read owner's home memory
  const memoryFolder = group.is_home
    ? group.folder
    : ownerHomeFolder || group.folder;
  const memoryDir = path.join(DATA_DIR, 'memory', memoryFolder);
  mkdirForContainer(memoryDir);
  mounts.push({
    hostPath: memoryDir,
    containerPath: '/workspace/memory',
    readonly: !group.is_home,
  });

  // Per-group Claude sessions directory (isolated from other groups)
  // Sub-agents and task sessions get their own session dir under agents/{id}/.claude/
  const groupSessionsDir = sessionAgentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        sessionAgentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  mkdirForContainer(groupSessionsDir);
  const userSkillsPolicy = resolveAgentProfileUserSkillsPolicy(
    ownerId,
    agentProfile,
  );
  const pluginSkills = ownerId ? prepareHostPlugins(ownerId) : [];
  const claudeContextPlan = buildClaudeContextPlan({
    executionMode: 'container',
    group,
    ownerHomeFolder,
    externalClaudeDir: getEffectiveExternalDir(),
    projectRoot,
    dataDir: DATA_DIR,
    groupSessionsDir,
    includeHostClaudeContext: shouldIncludeHostClaudeContext(agentProfile),
    hostSkillPolicy: resolveAgentProfileHostSkillPolicy(agentProfile),
    mountUserSkills: mountUserSkills && userSkillsPolicy.mountUserSkills,
    userSkillsDirOverride: userSkillsPolicy.userSkillsDirOverride,
    managedSkillPolicy: agentProfile?.runtimePolicy?.skills,
    pluginSkillLayers: pluginSkillLayers(pluginSkills),
  });
  syncHostClaudeContext(claudeContextPlan, groupSessionsDir, {
    materializeLinks: false,
  });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  ensureSettingsJson(
    settingsFile,
    resolveRuntimeMcpServers(group, agentProfile),
    {
      // The session settings file is HappyClaw-owned. Always replace this map
      // with the resolved layers so removed/unselected managed MCP cannot
      // survive from a previous Agent run.
      replaceMcpServers: true,
      baseSettings: loadHostClaudeSettings(claudeContextPlan),
    },
  );

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // 清理 session 目录中 SDK 遗留的 .claude.json（含 cachedGrowthBookFeatures，会导致初始化挂起）。
  // 精简版（不含 feature flags）约 200-400B，SDK 写回的完整版通常 > 10KB。
  const STRIPPED_CLAUDE_JSON_MAX_SIZE = 500;
  const sessionClaudeJson = path.join(groupSessionsDir, '.claude.json');
  try {
    const st = fs.lstatSync(sessionClaudeJson);
    if (!st.isSymbolicLink() && st.size > STRIPPED_CLAUDE_JSON_MAX_SIZE) {
      fs.unlinkSync(sessionClaudeJson);
    }
  } catch {
    /* not found, ok */
  }

  // 挂载精简版 .claude.json（剥离 cachedGrowthBookFeatures），保留 deviceId 一致性
  const containerJson = getContainerClaudeJsonPath();
  mounts.push({
    hostPath: containerJson,
    containerPath: '/home/node/.claude.json',
    readonly: true,
  });

  // Skills are exposed only through explicit per-Skill read-only mounts below.
  const userSkillsDir = claudeContextPlan.userSkillsDir ?? null;

  // Ensure user skills directory exists so it can always be mounted.
  // Skills may be installed after the group is created; without pre-creating,
  // the existsSync check would skip mounting and the container would never see them.
  if (userSkillsDir) {
    fs.mkdirSync(userSkillsDir, { recursive: true });
  }

  // Every selected Skill gets an explicit read-only mount. entrypoint rebuilds
  // /home/node/.claude/skills exclusively from this directory, so a real
  // directory persisted by an earlier container can never survive a restart.
  for (const skill of claudeContextPlan.effectiveSkills.selected) {
    if (skill.source === 'plugin') continue;
    let hostPath = skill.path;
    try {
      hostPath = fs.realpathSync(hostPath);
    } catch {
      // The resolver already validated SKILL.md. Keep the original path so
      // Docker reports a deterministic mount error if it vanished afterward.
    }
    mounts.push({
      hostPath,
      containerPath: `/workspace/effective-skills/${skill.id}`,
      readonly: true,
    });
  }

  // Per-user feishu-cli OAuth state (token.json + config.yaml).
  // Without this mount, every container restart loses the user's feishu OAuth
  // authorization, forcing re-auth every IDLE_TIMEOUT (#477).
  if (ownerId) {
    const userFeishuCliDir = path.join(
      DATA_DIR,
      'config',
      'user-cli',
      ownerId,
      'feishu-cli',
    );
    mkdirForContainer(userFeishuCliDir);
    mounts.push({
      hostPath: userFeishuCliDir,
      containerPath: '/home/node/.feishu-cli',
      readonly: false,
    });
  }

  // Claude Code plugins (per-user runtime): read-only mount so the CLI inside
  // the container can load the same plugin directories referenced by
  // ContainerInput.plugins.
  //
  // Admin home runs in `host` mode and bypasses container mounts entirely,
  // so plugin materialization for that path happens inside runHostAgent's
  // host-runtime loadUserPlugins. Here we only handle docker-mode containers.
  //
  // Materialize is synchronous so the runtime tree is on disk before the mount
  // source is picked — loadUserPlugins(docker) returns paths shaped like
  // /workspace/plugins/snapshots/{snap}/{mp}/{plugin}, which only resolve when
  // runtime/{userId}/ is mounted at /workspace/plugins. The runtime root is
  // mkdir'd unconditionally so the bind mount target exists even for users
  // with no enabled plugins yet (an empty mount surfaces nothing to the CLI,
  // matching their config).
  if (ownerId) {
    const runtimeRoot = getUserRuntimeRoot(ownerId);
    fs.mkdirSync(runtimeRoot, { recursive: true });
    try {
      materializeUserRuntime(ownerId);
    } catch (err) {
      logger.warn(
        { ownerId, err },
        'buildVolumeMounts: materializeUserRuntime failed; container will see no plugins',
      );
    }
    // Mirror prepareHostPlugins: drop a stale empty command index that may
    // have been cached before this runtime tree existed (plugin-command-index.ts:235).
    invalidateUserCommandIndex(ownerId);
    mounts.push({
      hostPath: runtimeRoot,
      containerPath: CONTAINER_PLUGINS_PATH,
      readonly: true,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // Sub-agents get their own IPC subdirectory under agents/{agentId}/
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  // Use 0o777 so container (node/1000) and host (agent/1002) can both read/write.
  const groupIpcDir = ipcAgentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', ipcAgentId)
    : taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  mkdirForContainer(groupIpcDir);
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  // Use chmod 777 so both host (agent/1002) and container (node/1000) can write
  for (const sub of ['messages', 'tasks', 'input', 'agents'] as const) {
    const subDir = path.join(groupIpcDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    try {
      fs.chmodSync(subDir, 0o777);
    } catch {
      /* ignore if already correct */
    }
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-container environment file (keeps credentials out of process listings)
  // Global config merged with per-container overrides.
  const envDir = path.join(DATA_DIR, 'env', group.folder);
  fs.mkdirSync(envDir, { recursive: true });
  const globalConfig = resolvedProvider?.config ?? getClaudeProviderConfig();
  const containerOverride = getContainerEnvConfig(group.folder);
  const envLines = buildContainerEnvLines(
    globalConfig,
    containerOverride,
    resolvedProvider?.customEnv,
  );
  // Agent policy is authoritative; do not inherit global/custom runtime env.
  for (let index = envLines.length - 1; index >= 0; index -= 1) {
    if (
      envLines[index]?.startsWith('AUTO_COMPACT_WINDOW=') ||
      envLines[index]?.startsWith('AUTO_COMPACT_PERCENTAGE=') ||
      envLines[index]?.startsWith('HAPPYCLAW_AGENT_TOOL_POLICY=') ||
      envLines[index]?.startsWith('HAPPYCLAW_AGENT_DISALLOWED_TOOLS=') ||
      envLines[index]?.startsWith('HAPPYCLAW_AGENT_MCP_POLICY=')
    ) {
      envLines.splice(index, 1);
    }
  }
  const autoCompactPercentage = getAgentAutoCompactPercentage(agentProfile);
  const autoCompactWindow = getAgentAutoCompactWindow(agentProfile);
  if (autoCompactPercentage > 0) {
    envLines.push(`AUTO_COMPACT_PERCENTAGE=${autoCompactPercentage}`);
  } else if (autoCompactWindow > 0) {
    envLines.push(`AUTO_COMPACT_WINDOW=${autoCompactWindow}`);
  }
  const mcpPolicyMode = getAgentProfileMcpPolicyMode(agentProfile);
  if (mcpPolicyMode !== 'inherit') {
    envLines.push(`HAPPYCLAW_AGENT_MCP_POLICY=${mcpPolicyMode}`);
  }
  applyFallbackModelToEnvLines(envLines);
  if (envLines.length > 0) {
    const envFilePath = path.join(envDir, 'env');
    const quotedLines = shellQuoteEnvLines(envLines);
    fs.writeFileSync(envFilePath, quotedLines.join('\n') + '\n', {
      mode: 0o600,
    });
    try {
      fs.chmodSync(envFilePath, 0o600);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to enforce env file permissions',
      );
    }
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true,
    });
  }

  // Write .credentials.json for OAuth credentials (session dir is already mounted)
  const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
  if (mergedConfig.claudeOAuthCredentials) {
    try {
      writeCredentialsFile(groupSessionsDir, mergedConfig);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to write .credentials.json',
      );
    }
  }

  // Third-party provider: remove any stale .credentials.json so the SDK
  // does not detect OAuth credentials from a previous official-provider run.
  if (mergedConfig.anthropicBaseUrl) {
    try {
      const staleCreds = path.join(groupSessionsDir, '.credentials.json');
      if (fs.existsSync(staleCreds)) fs.unlinkSync(staleCreds);
    } catch {
      /* ignore */
    }
  }

  // Mount agent-runner source from host — recompiled on container startup.
  // Bypasses Docker 镜像构建缓存，确保代码变更生效。
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Native Claude user config overlays the isolated session config. Workspace
  // remains the SDK cwd; these read-only mounts provide the same user-level
  // capabilities without redirecting file and shell operations into ~/.claude.
  if (claudeContextPlan.isAdminOwned) {
    if (
      claudeContextPlan.claudeMdSource &&
      fs.existsSync(claudeContextPlan.claudeMdSource)
    ) {
      mounts.push({
        hostPath: claudeContextPlan.claudeMdSource,
        containerPath: '/home/node/.claude/CLAUDE.md',
        readonly: true,
      });
    }
    if (
      claudeContextPlan.rulesSourceDir &&
      fs.existsSync(claudeContextPlan.rulesSourceDir)
    ) {
      mounts.push({
        hostPath: claudeContextPlan.rulesSourceDir,
        containerPath: '/home/node/.claude/rules',
        readonly: true,
      });
    }
    for (const entry of claudeContextPlan.nativeConfigEntries) {
      if (!fs.existsSync(entry.sourcePath)) continue;
      mounts.push({
        hostPath: entry.sourcePath,
        containerPath: entry.runtimePath,
        readonly: true,
      });
    }
  }

  // Per-group persistent extra directory: provides a durable /workspace/extra/ even when
  // no additionalMounts are configured. User-configured additionalMounts from the allowlist
  // are mounted as subdirectories (/workspace/extra/{name}) and overlay on top.
  const extraDir = path.join(DATA_DIR, 'extra', group.folder);
  mkdirForContainer(extraDir);
  mounts.push({
    hostPath: extraDir,
    containerPath: '/workspace/extra',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isAdminHome,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  tz: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Set timezone so container Node.js processes use local time (Asia/Shanghai)
  args.push('-e', `TZ=${tz}`);

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (
    proc: ChildProcess,
    containerName: string,
    selectedProviderId: string | null,
  ) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const sessionAgentId = input.sessionAgentId ?? input.agentId;

  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);

  // ─── Provider Pool selection ───
  const poolResult = trySelectPoolProvider(group.folder, sessionAgentId);
  const selectedProfileId = poolResult?.profileId ?? null;
  const resolvedProvider = poolResult?.resolved;
  let providerFailureReported = false;
  let providerFailureTerminal: boolean | undefined;
  let providerFailureMaintenance = false;
  let healthyInputTurnCompleted = false;
  if (poolResult?.resetSession && input.sessionId) {
    logger.info(
      {
        groupFolder: group.folder,
        agentId: sessionAgentId || null,
        previousProviderId: poolResult.previousProviderId,
        providerId: selectedProfileId,
      },
      'Clearing Claude session after switching providers',
    );
    // deleteSession removes the whole sessions row, including the provider_id
    // binding trySelectPoolProvider just wrote. Re-bind the freshly-selected
    // provider so the next turn stays sticky to it instead of degrading to a
    // fresh pool pick.
    deleteSession(group.folder, sessionAgentId);
    if (selectedProfileId) {
      setSessionProviderId(group.folder, sessionAgentId, selectedProfileId);
    }
    input = { ...input, sessionId: undefined };
  }

  try {
    const isAdminHome = !!input.isAdminHome;
    // Per-user skills: always mount if the group has an owner
    const shouldMountUserSkills = !!group.created_by;
    const mounts = buildVolumeMounts(
      group,
      isAdminHome,
      shouldMountUserSkills,
      sessionAgentId,
      ownerHomeFolder,
      input.taskRunId,
      resolvedProvider,
      input.agentId,
      input.agentProfile,
    );
    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const agentSuffix = sessionAgentId
      ? `-${sessionAgentId.replace(/[^a-zA-Z0-9-]/g, '-')}`
      : '';
    const containerName = `happyclaw-${safeName}${agentSuffix}-${Date.now()}`;
    const containerArgs = buildContainerArgs(mounts, containerName, TIMEZONE);

    logger.debug(
      {
        group: group.name,
        containerName,
        mounts: mounts.map(
          (m) =>
            `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
        ),
        containerArgs: containerArgs.join(' '),
      },
      'Container mount configuration',
    );

    logger.info(
      {
        group: group.name,
        containerName,
        mountCount: mounts.length,
        isMain: input.isMain,
      },
      'Spawning container agent',
    );

    const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const result = await new Promise<ContainerOutput>((resolve) => {
      const container = spawn('docker', containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      onProcess(container, containerName, selectedProfileId);

      const stdoutState = createStdoutParserState();
      const stderrState = createStderrState();

      // Write input and close stdin (容器需要 EOF 来刷新 stdin 管道)
      container.stdin.on('error', (err) => {
        logger.error(
          { group: group.name, err },
          'Container stdin write failed',
        );
        container.kill();
      });
      // Derive a new input with docker-runtime plugins injected; never mutate
      // the caller's `input` object (queue/log/retry paths reuse the same ref).
      const dockerInput: ContainerInput = {
        ...input,
        plugins: group.created_by
          ? loadUserPlugins(group.created_by, { runtime: 'docker' })
          : [],
        contextAudit: (() => {
          const skillsPolicy = resolveAgentProfileUserSkillsPolicy(
            group.created_by,
            input.agentProfile,
          );
          const audit = buildClaudeContextPlan({
            executionMode: 'container',
            group,
            ownerHomeFolder,
            externalClaudeDir: getEffectiveExternalDir(),
            projectRoot: process.cwd(),
            dataDir: DATA_DIR,
            groupSessionsDir: sessionAgentId
              ? path.join(
                  DATA_DIR,
                  'sessions',
                  group.folder,
                  'agents',
                  sessionAgentId,
                  '.claude',
                )
              : path.join(DATA_DIR, 'sessions', group.folder, '.claude'),
            includeHostClaudeContext: shouldIncludeHostClaudeContext(
              input.agentProfile,
            ),
            hostSkillPolicy: resolveAgentProfileHostSkillPolicy(
              input.agentProfile,
            ),
            mountUserSkills:
              shouldMountUserSkills && skillsPolicy.mountUserSkills,
            userSkillsDirOverride: skillsPolicy.userSkillsDirOverride,
            managedSkillPolicy: input.agentProfile?.runtimePolicy?.skills,
            pluginSkillLayers: pluginSkillLayers(
              group.created_by
                ? loadUserPlugins(group.created_by, { runtime: 'host' })
                : [],
            ),
          }).audit;
          const mcpManifest = buildRuntimeMcpManifest(
            group,
            input.agentProfile,
            group.created_by
              ? loadUserPlugins(group.created_by, { runtime: 'host' })
              : [],
          );
          audit.mcp = {
            manifestHash: mcpManifest.hash,
            serverIds: mcpManifest.serverIds,
          };
          return audit;
        })(),
        skillManifest: (() => {
          const skillsPolicy = resolveAgentProfileUserSkillsPolicy(
            group.created_by,
            input.agentProfile,
          );
          const manifest = buildClaudeContextPlan({
            executionMode: 'container',
            group,
            ownerHomeFolder,
            externalClaudeDir: getEffectiveExternalDir(),
            projectRoot: process.cwd(),
            dataDir: DATA_DIR,
            groupSessionsDir: sessionAgentId
              ? path.join(
                  DATA_DIR,
                  'sessions',
                  group.folder,
                  'agents',
                  sessionAgentId,
                  '.claude',
                )
              : path.join(DATA_DIR, 'sessions', group.folder, '.claude'),
            includeHostClaudeContext: shouldIncludeHostClaudeContext(
              input.agentProfile,
            ),
            hostSkillPolicy: resolveAgentProfileHostSkillPolicy(
              input.agentProfile,
            ),
            mountUserSkills:
              shouldMountUserSkills && skillsPolicy.mountUserSkills,
            userSkillsDirOverride: skillsPolicy.userSkillsDirOverride,
            managedSkillPolicy: input.agentProfile?.runtimePolicy?.skills,
            pluginSkillLayers: pluginSkillLayers(
              group.created_by
                ? loadUserPlugins(group.created_by, { runtime: 'host' })
                : [],
            ),
          }).effectiveSkills;
          return {
            hash: manifest.hash,
            selectedSkillIds: manifest.selected.map((skill) => skill.id),
          };
        })(),
      };
      container.stdin.write(JSON.stringify(dockerInput));
      container.stdin.end();

      let timedOut = false;
      const timeoutMs =
        group.containerConfig?.timeout || getSystemSettings().containerTimeout;

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, containerName },
          'Container timeout, stopping gracefully',
        );
        execFile(
          'docker',
          ['stop', containerName],
          { timeout: 15000 },
          (err) => {
            if (err) {
              logger.warn(
                { group: group.name, containerName, err },
                'Graceful stop failed, force killing',
              );
              container.kill('SIGKILL');
            }
          },
        );
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };
      const handleOutput = onOutput
        ? async (output: ContainerOutput): Promise<void> => {
            if (
              !output.providerFailure &&
              output.inputTurnCompleted !== undefined
            ) {
              healthyInputTurnCompleted = output.inputTurnCompleted;
            }
            if (output.providerFailureRetrying) {
              if (output.providerFailure && selectedProfileId) {
                if (!providerFailureReported) {
                  providerFailureReported = true;
                  providerPool.reportFailure(selectedProfileId, true);
                  logger.warn(
                    {
                      group: group.name,
                      containerName,
                      providerId: selectedProfileId,
                    },
                    'Provider failure detected; agent runner is retrying the failed turn with fallback model',
                  );
                }
              }
              // This is host-control metadata, never a user-visible output.
              return;
            }
            if (output.providerFailure && selectedProfileId) {
              if (!providerFailureReported) {
                providerFailureReported = true;
                providerPool.reportFailure(selectedProfileId, true);
                logger.warn(
                  {
                    group: group.name,
                    containerName,
                    providerId: selectedProfileId,
                    result: output.result,
                  },
                  'Provider failure detected from streamed output, stopping container',
                );
              }
            }
            if (
              output.providerFailureMaintenance &&
              healthyInputTurnCompleted
            ) {
              providerFailureMaintenance = true;
              logger.warn(
                {
                  group: group.name,
                  containerName,
                  providerId: selectedProfileId,
                },
                'Provider failed during internal maintenance; quarantining without user projection or replay',
              );
              exec(`docker stop ${containerName}`, (err) => {
                if (err) {
                  logger.warn(
                    { group: group.name, containerName, err },
                    'Failed to stop container after maintenance provider failure',
                  );
                  container.kill('SIGTERM');
                }
              });
              return;
            }
            if (output.providerFailureMaintenance) {
              logger.warn(
                {
                  group: group.name,
                  containerName,
                  providerId: selectedProfileId,
                },
                'Maintenance query failed before durable input completion; treating as replayable provider failure',
              );
            }
            if (output.providerFailure) {
              const terminal = applyProviderFailureDisposition(
                output,
                selectedProfileId,
              );
              providerFailureTerminal = terminal;
              logger.warn(
                {
                  group: group.name,
                  containerName,
                  providerId: selectedProfileId,
                  terminal,
                },
                terminal
                  ? 'Provider pool exhausted; surfacing terminal failure'
                  : 'Provider quarantined; preserving input for failover replay',
              );
            }
            // Quarantine and classify before awaiting any IM/card projection so
            // concurrent sessions cannot keep selecting a provider that just
            // returned an account-level failure.
            await onOutput(output);
            if (output.providerFailure) {
              exec(`docker stop ${containerName}`, (err) => {
                if (err) {
                  logger.warn(
                    { group: group.name, containerName, err },
                    'Failed to stop container after provider failure',
                  );
                  container.kill('SIGTERM');
                }
              });
            }
          }
        : undefined;

      // Attach stdout/stderr handlers using shared parser
      attachStdoutHandler(container.stdout, stdoutState, {
        groupName: group.name,
        label: 'Container',
        onOutput: handleOutput,
        resetTimeout,
      });
      attachStderrHandler(container.stderr, stderrState, group.name, {
        container: group.folder,
      });

      container.on('close', (code, signal) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        const closeCtx: CloseHandlerContext = {
          groupName: group.name,
          label: 'Container',
          filePrefix: 'container',
          identifier: containerName,
          logsDir,
          input,
          stdoutState,
          stderrState,
          onOutput,
          resolvePromise: resolve,
          startTime,
          timeoutMs,
          extraSummaryLines: [
            ``,
            `=== Mounts ===`,
            mounts
              .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
              .join('\n'),
          ],
          extraVerboseLines: [
            `=== Container Args ===`,
            containerArgs.join(' '),
            ``,
            `=== Mounts (detailed) ===`,
            mounts
              .map(
                (m) =>
                  `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
              )
              .join('\n'),
          ],
        };

        if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
        const logFile = writeRunLog(closeCtx, code, duration);
        if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
          return;
        handleSuccessClose(closeCtx, duration);
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(
          { group: group.name, containerName, error: err },
          'Container spawn error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container spawn error: ${err.message}`,
        });
      });
    });

    // ─── Provider Pool health reporting ───
    if (selectedProfileId) {
      if (result.providerFailure) {
        if (!providerFailureReported) {
          providerPool.reportFailure(selectedProfileId, true);
          providerFailureReported = true;
        }
      } else if (
        !providerFailureReported &&
        (result.status === 'success' || result.status === 'closed')
      ) {
        providerPool.reportSuccess(selectedProfileId);
      } else if (result.status === 'error' && isApiError(result.error || '')) {
        providerPool.reportFailure(selectedProfileId);
      }
    }
    if (providerFailureMaintenance) {
      return {
        ...result,
        status: 'success',
        result: null,
        providerFailure: false,
        providerFailureTerminal: undefined,
        providerFailureMaintenance: true,
        inputTurnCompleted: true,
      };
    }
    if (result.providerFailure) {
      if (providerFailureTerminal === undefined) {
        providerFailureTerminal = applyProviderFailureDisposition(
          result,
          selectedProfileId,
        );
      } else {
        applyKnownProviderFailureDisposition(result, providerFailureTerminal);
      }
    }

    return result;
  } finally {
    // Guarantee session release even if buildVolumeMounts/spawn throws
    if (selectedProfileId) {
      providerPool.releaseSession(selectedProfileId);
    }
  }
}

export function writeTasksSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all tasks, others only see their own
  const filteredTasks = isAdminHome
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  // 删除后重建：容器创建的文件归属 node(1000) 用户，宿主机进程无法覆写
  try {
    fs.unlinkSync(tasksFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only admin home can see all available groups (for activation).
 * Other groups see nothing (they can't activate groups).
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isAdminHome ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  try {
    fs.unlinkSync(groupsFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * 杀死进程及其所有子进程。
 * 如果进程以 detached 模式启动（独立进程组），使用负 PID 杀整个进程组。
 */
export function killProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
      return true;
    }
  } catch {
    try {
      proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Run agent directly on the host machine (no Docker container).
 * Used for host execution mode — the agent gets full access to the host filesystem.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (
    proc: ChildProcess,
    identifier: string,
    selectedProviderId: string | null,
  ) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const sessionAgentId = input.sessionAgentId ?? input.agentId;
  const setupInstallHint = 'npm --prefix container/agent-runner install';
  const setupBuildHint = 'npm --prefix container/agent-runner run build';
  const hostModeSetupError = (message: string): ContainerOutput => ({
    status: 'error',
    result: `宿主机模式启动失败：${message}`,
    error: message,
  });

  // 1. 确定工作目录
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  if (!group.customCwd) {
    fs.mkdirSync(defaultGroupDir, { recursive: true });
    // 确保 group 目录是独立 git root，防止 Claude Code 向上找到父项目的 .git
    const gitDir = path.join(defaultGroupDir, '.git');
    if (!fs.existsSync(gitDir)) {
      try {
        execFileSync('git', ['init'], {
          cwd: defaultGroupDir,
          stdio: 'ignore',
        });
        logger.info(
          { folder: group.folder },
          'Initialized git repository for group',
        );
      } catch (err) {
        // Non-fatal: agent still works, just reports wrong working directory
        logger.warn(
          { folder: group.folder, err },
          'Failed to initialize git repository',
        );
      }
    }
  }
  let groupDir = group.customCwd || defaultGroupDir;
  if (!path.isAbsolute(groupDir)) {
    return hostModeSetupError(`工作目录必须是绝对路径：${groupDir}`);
  }
  // Resolve symlinks to prevent TOCTOU attacks
  try {
    groupDir = fs.realpathSync(groupDir);
  } catch {
    return hostModeSetupError(`工作目录不存在或无法解析：${groupDir}`);
  }
  if (!fs.statSync(groupDir).isDirectory()) {
    return hostModeSetupError(`工作目录不是目录：${groupDir}`);
  }

  // Runtime allowlist validation for custom CWD (defense-in-depth: web.ts validates at creation,
  // but re-check here in case allowlist was tightened or path was injected via DB)
  if (group.customCwd) {
    const allowlist = loadMountAllowlist();
    if (
      allowlist &&
      allowlist.allowedRoots &&
      allowlist.allowedRoots.length > 0
    ) {
      let allowed = false;
      for (const root of allowlist.allowedRoots) {
        const expandedRoot = root.path.startsWith('~')
          ? path.join(
              process.env.HOME || os.homedir(),
              root.path.slice(root.path.startsWith('~/') ? 2 : 1),
            )
          : path.resolve(root.path);

        let realRoot: string;
        try {
          realRoot = fs.realpathSync(expandedRoot);
        } catch {
          continue;
        }

        const relative = path.relative(realRoot, groupDir);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        return hostModeSetupError(
          `工作目录 ${groupDir} 不在允许的根目录下，请检查 mount-allowlist.json`,
        );
      }
    }
  }

  // Always store logs in data/groups/{folder}/logs/, not in customCwd
  const logsBaseDir = path.join(defaultGroupDir, 'logs');
  fs.mkdirSync(logsBaseDir, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'memory', group.folder), {
    recursive: true,
  });

  // 2. 确保目录结构（宿主机模式下限制目录权限）
  // Sub-agents get their own IPC and session directories
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  const groupIpcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', input.agentId)
    : input.taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', input.taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), {
    recursive: true,
    mode: 0o700,
  });
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  fs.mkdirSync(path.join(groupIpcDir, 'agents'), {
    recursive: true,
    mode: 0o700,
  });

  const groupSessionsDir = sessionAgentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        sessionAgentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Symlink .claude.json 到宿主机 ~/.claude.json，确保 deviceId 一致
  const localJson = path.join(groupSessionsDir, '.claude.json');
  ensureSymlinkTo(localJson, ensureHostClaudeJson());

  // 3. Resolve the selected native Claude user layer. Workspace remains cwd.
  // 4. Skills / Rules / CLAUDE.md / native capabilities project into session.
  // 宿主 Claude 配置与 HappyClaw 记忆层始终叠加，冲突通过 audit 明示。
  const hostUserSkillsPolicy = resolveAgentProfileUserSkillsPolicy(
    group.created_by,
    input.agentProfile,
  );
  const preparedHostPlugins = prepareHostPlugins(group.created_by);
  const hostClaudeContextPlan = buildClaudeContextPlan({
    executionMode: 'host',
    group,
    ownerHomeFolder,
    externalClaudeDir: getEffectiveExternalDir(),
    projectRoot: process.cwd(),
    dataDir: DATA_DIR,
    groupSessionsDir,
    includeHostClaudeContext: shouldIncludeHostClaudeContext(
      input.agentProfile,
    ),
    hostSkillPolicy: resolveAgentProfileHostSkillPolicy(input.agentProfile),
    mountUserSkills: hostUserSkillsPolicy.mountUserSkills,
    userSkillsDirOverride: hostUserSkillsPolicy.userSkillsDirOverride,
    managedSkillPolicy: input.agentProfile?.runtimePolicy?.skills,
    pluginSkillLayers: pluginSkillLayers(preparedHostPlugins),
    happyclawMemoryActive: true,
  });
  const hostClaudeContextSync = syncHostClaudeContext(
    hostClaudeContextPlan,
    groupSessionsDir,
  );
  hostClaudeContextPlan.audit.claudeMd.status =
    hostClaudeContextSync.claudeMdStatus;
  hostClaudeContextPlan.audit.warnings = hostClaudeContextSync.warnings;
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  ensureSettingsJson(
    settingsFile,
    resolveRuntimeMcpServers(group, input.agentProfile),
    {
      replaceMcpServers: true,
      baseSettings: loadHostClaudeSettings(hostClaudeContextPlan),
    },
  );
  const hostMcpManifest = buildRuntimeMcpManifest(
    group,
    input.agentProfile,
    preparedHostPlugins,
  );
  hostClaudeContextPlan.audit.mcp = {
    manifestHash: hostMcpManifest.hash,
    serverIds: hostMcpManifest.serverIds,
  };

  // 5. 构建环境变量
  const hostEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  // Per-run policy must replace, never merge with, a parent process value.
  // Otherwise disabled/custom MCP can inherit servers from an earlier wrapper
  // environment even when this run intentionally resolves to an empty set.
  delete hostEnv['HAPPYCLAW_USER_MCP_SERVERS_JSON'];
  // Provider selection is authoritative. Do not let API settings inherited
  // from the HappyClaw parent process leak into a host-mode child after the
  // user switches providers (especially third-party -> official OAuth).
  clearInheritedClaudeProviderEnv(hostEnv);

  // Strip macOS launch-context vars that must not be inherited by child
  // processes. When happyclaw is started by a background process manager
  // (launchd / ssh / cron) outside a normal login session, XPC_FLAGS=0x2
  // leaks into the environment. The bundled bun/CFNetwork-based claude CLI then
  // can't reach mDNSResponder/securityd through XPC, so DNS resolution and the
  // system CA store fail and every model request dies with FailedToOpenSocket.
  // Plain Node uses its own resolver/TLS stack and is unaffected, which is why
  // this only breaks the host agent. The var is meaningless to a child spawned
  // in a different way, so dropping it restores normal name resolution. No-op
  // on non-macOS hosts (the var does not exist there).
  delete hostEnv['XPC_FLAGS'];

  // ─── Provider Pool selection (host mode) ───
  const containerOverride = getContainerEnvConfig(group.folder);
  const hostPoolResult = trySelectPoolProvider(group.folder, sessionAgentId);
  const hostSelectedProfileId = hostPoolResult?.profileId ?? null;
  const globalConfig =
    hostPoolResult?.resolved.config ?? getClaudeProviderConfig();
  let hostProviderFailureReported = false;
  let hostProviderFailureTerminal: boolean | undefined;
  let hostProviderFailureMaintenance = false;
  let hostHealthyInputTurnCompleted = false;
  if (hostPoolResult?.resetSession && input.sessionId) {
    logger.info(
      {
        groupFolder: group.folder,
        agentId: sessionAgentId || null,
        previousProviderId: hostPoolResult.previousProviderId,
        providerId: hostSelectedProfileId,
      },
      'Clearing Claude session after switching providers',
    );
    // deleteSession removes the whole sessions row, including the provider_id
    // binding trySelectPoolProvider just wrote. Re-bind so the next turn stays
    // sticky to the freshly-selected provider (mirrors the container path).
    deleteSession(group.folder, sessionAgentId);
    if (hostSelectedProfileId) {
      setSessionProviderId(group.folder, sessionAgentId, hostSelectedProfileId);
    }
    input = { ...input, sessionId: undefined };
  }

  try {
    // 配置层环境变量
    const envLines = buildContainerEnvLines(
      globalConfig,
      containerOverride,
      hostPoolResult?.resolved.customEnv,
    );
    const injectsAnthropicAuthToken = envLines.some((line) =>
      line.startsWith('ANTHROPIC_AUTH_TOKEN='),
    );
    for (const line of envLines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        hostEnv[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
      }
    }
    const fallbackModel = getSystemSettings().fallbackModel?.trim();
    if (fallbackModel) {
      hostEnv['HAPPYCLAW_FALLBACK_MODEL'] = fallbackModel;
    } else {
      delete hostEnv['HAPPYCLAW_FALLBACK_MODEL'];
    }

    // Third-party provider: unless this provider explicitly injects
    // ANTHROPIC_AUTH_TOKEN (Bearer proxy mode), remove any inherited host token
    // so API-key mode can take effect.
    if (hostEnv['ANTHROPIC_BASE_URL']) {
      if (!injectsAnthropicAuthToken) {
        delete hostEnv['ANTHROPIC_AUTH_TOKEN'];
      }

      // Also strip oauthAccount from session .claude.json: the SDK detects
      // OAuth credentials in .claude.json and takes the OAuth code path even
      // when ANTHROPIC_AUTH_TOKEN is absent. This causes the same 404 on
      // third-party endpoints. Remove the symlink and write a standalone
      // .claude.json without oauthAccount so the SDK falls back to API key mode.
      try {
        const sessionClaudeJson = path.join(groupSessionsDir, '.claude.json');
        try {
          fs.unlinkSync(sessionClaudeJson);
        } catch {
          /* ignore */
        }
        let claudeJson: Record<string, unknown> = {};
        try {
          claudeJson = JSON.parse(
            fs.readFileSync(getHostClaudeJsonPath(), 'utf-8'),
          );
        } catch {
          /* ignore */
        }
        delete claudeJson.oauthAccount;
        fs.writeFileSync(
          sessionClaudeJson,
          JSON.stringify(claudeJson, null, 2) + '\n',
          { mode: 0o600 },
        );
      } catch (err) {
        logger.warn(
          { folder: group.folder, err },
          'Failed to strip oauthAccount from session .claude.json',
        );
      }

      // Also remove .credentials.json: it contains valid OAuth tokens that the
      // SDK uses regardless of env vars, forcing the OAuth auth path.
      try {
        const credsPath = path.join(groupSessionsDir, '.credentials.json');
        if (fs.existsSync(credsPath)) fs.unlinkSync(credsPath);
      } catch (err) {
        logger.warn(
          { folder: group.folder, err },
          'Failed to remove .credentials.json for third-party provider',
        );
      }
    }

    // Write .credentials.json for OAuth credentials
    const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
    if (mergedConfig.claudeOAuthCredentials) {
      try {
        writeCredentialsFile(groupSessionsDir, mergedConfig);
      } catch (err) {
        logger.warn(
          { folder: group.folder, err },
          'Failed to write .credentials.json for host agent',
        );
      }
    }

    // Agent policy is authoritative; clear inherited legacy process env first.
    delete hostEnv['AUTO_COMPACT_WINDOW'];
    delete hostEnv['AUTO_COMPACT_PERCENTAGE'];
    const autoCompactPercentage = getAgentAutoCompactPercentage(
      input.agentProfile,
    );
    const autoCompactWindow = getAgentAutoCompactWindow(input.agentProfile);
    if (autoCompactPercentage > 0) {
      hostEnv['AUTO_COMPACT_PERCENTAGE'] = String(autoCompactPercentage);
    } else if (autoCompactWindow > 0) {
      hostEnv['AUTO_COMPACT_WINDOW'] = String(autoCompactWindow);
    }
    const hostMcpPolicyMode = getAgentProfileMcpPolicyMode(input.agentProfile);
    delete hostEnv['HAPPYCLAW_AGENT_TOOL_POLICY'];
    delete hostEnv['HAPPYCLAW_AGENT_DISALLOWED_TOOLS'];
    delete hostEnv['HAPPYCLAW_AGENT_MCP_POLICY'];
    if (hostMcpPolicyMode !== 'inherit') {
      hostEnv['HAPPYCLAW_AGENT_MCP_POLICY'] = hostMcpPolicyMode;
    }

    // 路径映射
    hostEnv['HAPPYCLAW_WORKSPACE_GROUP'] = groupDir;
    hostEnv['HAPPYCLAW_WORKSPACE_IPC'] = groupIpcDir;

    // Per-user global memory（HappyClaw 自带 memory 层）
    const ownerId = group.created_by;
    if (ownerId) {
      const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
      fs.mkdirSync(userGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = userGlobalDir;
    } else {
      const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
      fs.mkdirSync(legacyGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = legacyGlobalDir;
    }
    const memoryFolder = group.is_home
      ? group.folder
      : ownerHomeFolder || group.folder;
    hostEnv['HAPPYCLAW_WORKSPACE_MEMORY'] = path.join(
      DATA_DIR,
      'memory',
      memoryFolder,
    );

    // Resolve symlinks so CLAUDE_CONFIG_DIR ends up as the real on-disk path.
    // Host mode also goes through the synchronized session .claude directory so
    // explicit externalClaudeDir is authoritative for CLAUDE.md/rules/skills.
    let resolvedSessionsDir = groupSessionsDir;
    try {
      resolvedSessionsDir = fs.realpathSync(groupSessionsDir);
    } catch {
      // Path may not exist yet on first spawn; fall back to the literal path.
    }
    hostEnv['CLAUDE_CONFIG_DIR'] = resolvedSessionsDir;

    // 让 SDK 捕获 CLI 的 stderr 输出，便于排查启动失败
    hostEnv['DEBUG_CLAUDE_AGENT_SDK'] = '1';
    // Claude Code 2.1.114+ 禁止 root 使用 --dangerously-skip-permissions，
    // IS_SANDBOX=1 告知 CLI 当前运行在受控环境中以绕过此限制。
    // host 模式由 happyclaw 主进程托管（见 permissionMode: 'bypassPermissions'），
    // 相当于显式沙箱，故无条件声明而不再仅限 root —— 非 root 部署也保留语义对齐。
    hostEnv['IS_SANDBOX'] = '1';

    // 5b. Host capability preflight — detect external tools & inject env vars
    const capResult = await checkHostCapabilities();
    logCapabilityPreflight(group.name, capResult);
    for (const [key, value] of Object.entries(capResult.envVars)) {
      if (!hostEnv[key]) hostEnv[key] = value;
    }

    // Prepend the resolved claude binary directory to PATH so SDK subprocesses
    // (which look up `claude` via PATH) hit the correct binary first. agent-capabilities
    // prefers the SDK-bundled binary over `which` to avoid third-party wrappers
    // (e.g. cmux) that hijack `claude` in PATH and break subprocess invocation.
    if (capResult.resolvedPaths['claude']) {
      const resolvedClaudeDir = path.dirname(capResult.resolvedPaths['claude']);
      const currentPath = hostEnv['PATH'] || process.env.PATH || '';
      // path.delimiter（Windows ';'，POSIX ':'）——硬编码 ':' 会在 Windows 上
      // 把盘符（E:）也当分隔符，PATH 被拼烂导致 claude 目录无法生效。
      hostEnv['PATH'] = `${resolvedClaudeDir}${path.delimiter}${currentPath}`;
      logger.info(
        {
          group: group.name,
          resolvedClaudeDir,
          resolvedPath: capResult.resolvedPaths['claude'],
        },
        'Host preflight: claude binary resolved',
      );
    }

    // 6. 编译检查
    const projectRoot = process.cwd();
    const agentRunnerRoot = path.join(projectRoot, 'container', 'agent-runner');
    const agentRunnerNodeModules = path.join(agentRunnerRoot, 'node_modules');
    const agentRunnerDist = path.join(agentRunnerRoot, 'dist', 'index.js');
    const requiredDeps = ['@anthropic-ai/claude-agent-sdk'];
    const missingDeps = requiredDeps.filter((dep) => {
      const depJson = path.join(
        agentRunnerNodeModules,
        ...dep.split('/'),
        'package.json',
      );
      return !fs.existsSync(depJson);
    });
    if (missingDeps.length > 0) {
      const missing = missingDeps.join(', ');
      logger.error(
        { group: group.name, missingDeps },
        'Host agent preflight failed: dependencies missing',
      );
      return hostModeSetupError(
        `缺少 agent-runner 依赖（${missing}）。请先执行：${setupInstallHint}`,
      );
    }
    if (!fs.existsSync(agentRunnerDist)) {
      logger.error(
        { group: group.name, agentRunnerDist },
        'Host agent preflight failed: dist not found',
      );
      return hostModeSetupError(
        `agent-runner 未编译。请先执行：${setupBuildHint}`,
      );
    }

    // Auto-rebuild if dist is stale (src newer than dist)
    try {
      const distMtime = fs.statSync(agentRunnerDist).mtimeMs;
      const srcDir = path.join(agentRunnerRoot, 'src');
      const srcFiles = fs.readdirSync(srcDir);
      const newestSrc = Math.max(
        ...srcFiles.map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs),
      );
      if (newestSrc > distMtime) {
        logger.info(
          { group: group.name },
          'agent-runner dist 已过期，自动重新编译...',
        );
        try {
          const { execSync } = await import('child_process');
          execSync('npm run build', {
            cwd: agentRunnerRoot,
            stdio: 'pipe',
            timeout: 30_000,
          });
          logger.info({ group: group.name }, 'agent-runner 自动编译完成');
        } catch (buildErr) {
          logger.warn(
            { group: group.name, err: buildErr },
            `agent-runner 自动编译失败，使用旧版 dist。手动执行：${setupBuildHint}`,
          );
        }
      }
    } catch {
      // Best effort, don't block execution
    }

    logger.info(
      {
        group: group.name,
        workingDir: groupDir,
        isMain: input.isMain,
      },
      'Spawning host agent',
    );

    const logsDir = logsBaseDir;

    const hostResult = await new Promise<ContainerOutput>((resolve) => {
      let settled = false;
      const resolveOnce = (output: ContainerOutput): void => {
        if (settled) return;
        settled = true;
        resolve(output);
      };

      // 7. 启动进程
      // Resolve absolute node path: bare 'node' fails with ENOENT under
      // Process managers / launchd / GUI launchers where PATH lacks nvm/fnm dirs.
      const hostNodeBinary = resolveHostNodeBinary(hostEnv);
      const proc = spawn(hostNodeBinary, [agentRunnerDist], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: hostEnv,
        cwd: groupDir,
        detached: true,
      });

      const processId = `host-${group.folder}-${Date.now()}`;
      onProcess(proc, processId, hostSelectedProfileId);

      const stdoutState = createStdoutParserState();
      const stderrState = createStderrState();

      // 8. stdin 输入
      proc.stdin.on('error', (err) => {
        logger.error(
          { group: group.name, err },
          'Host agent stdin write failed',
        );
        killProcessTree(proc);
      });
      // Derive a new input with host-runtime plugins injected; never mutate
      // the caller's `input` object (queue/log/retry paths reuse the same ref).
      // prepareHostPlugins mirrors the docker path's pre-spawn materialize so
      // a freshly-enabled v2 user (no runtime/ on disk yet) doesn't see 0
      // plugins.
      const hostInput: ContainerInput = {
        ...input,
        plugins: preparedHostPlugins,
        contextAudit: hostClaudeContextPlan.audit,
        skillManifest: {
          hash: hostClaudeContextPlan.effectiveSkills.hash,
          selectedSkillIds: hostClaudeContextPlan.effectiveSkills.selected.map(
            (skill) => skill.id,
          ),
        },
      };
      proc.stdin.write(JSON.stringify(hostInput));
      proc.stdin.end();

      // 9. 超时管理
      let timedOut = false;
      const timeoutMs =
        group.containerConfig?.timeout || getSystemSettings().containerTimeout;

      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, processId },
          'Host agent timeout, killing',
        );
        killProcessTree(proc, 'SIGTERM');
        killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            killProcessTree(proc, 'SIGKILL');
          }
        }, 5000);
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };
      const handleOutput = onOutput
        ? async (output: ContainerOutput): Promise<void> => {
            if (
              !output.providerFailure &&
              output.inputTurnCompleted !== undefined
            ) {
              hostHealthyInputTurnCompleted = output.inputTurnCompleted;
            }
            if (output.providerFailureRetrying) {
              if (output.providerFailure && hostSelectedProfileId) {
                if (!hostProviderFailureReported) {
                  hostProviderFailureReported = true;
                  providerPool.reportFailure(hostSelectedProfileId, true);
                  logger.warn(
                    {
                      group: group.name,
                      processId,
                      providerId: hostSelectedProfileId,
                    },
                    'Provider failure detected; agent runner is retrying the failed turn with fallback model',
                  );
                }
              }
              // This is host-control metadata, never a user-visible output.
              return;
            }
            if (output.providerFailure && hostSelectedProfileId) {
              if (!hostProviderFailureReported) {
                hostProviderFailureReported = true;
                providerPool.reportFailure(hostSelectedProfileId, true);
                logger.warn(
                  {
                    group: group.name,
                    processId,
                    providerId: hostSelectedProfileId,
                    result: output.result,
                  },
                  'Provider failure detected from streamed output, stopping host agent',
                );
              }
            }
            if (
              output.providerFailureMaintenance &&
              hostHealthyInputTurnCompleted
            ) {
              hostProviderFailureMaintenance = true;
              logger.warn(
                {
                  group: group.name,
                  processId,
                  providerId: hostSelectedProfileId,
                },
                'Provider failed during internal maintenance; quarantining without user projection or replay',
              );
              killProcessTree(proc, 'SIGTERM');
              return;
            }
            if (output.providerFailureMaintenance) {
              logger.warn(
                {
                  group: group.name,
                  processId,
                  providerId: hostSelectedProfileId,
                },
                'Maintenance query failed before durable input completion; treating as replayable provider failure',
              );
            }
            if (output.providerFailure) {
              const terminal = applyProviderFailureDisposition(
                output,
                hostSelectedProfileId,
              );
              hostProviderFailureTerminal = terminal;
              logger.warn(
                {
                  group: group.name,
                  processId,
                  providerId: hostSelectedProfileId,
                  terminal,
                },
                terminal
                  ? 'Provider pool exhausted; surfacing terminal failure'
                  : 'Provider quarantined; preserving input for failover replay',
              );
            }
            // Keep provider selection safe while the user-facing projection is
            // awaiting a network ACK.
            await onOutput(output);
            if (output.providerFailure) {
              killProcessTree(proc, 'SIGTERM');
            }
          }
        : undefined;

      // 10. stdout/stderr 解析
      attachStdoutHandler(proc.stdout, stdoutState, {
        groupName: group.name,
        label: 'Host agent',
        onOutput: handleOutput,
        resetTimeout,
      });
      attachStderrHandler(proc.stderr, stderrState, group.name, {
        host: group.folder,
      });

      // 11. close 事件处理
      proc.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const duration = Date.now() - startTime;

        const closeCtx: CloseHandlerContext = {
          groupName: group.name,
          label: 'Host Agent',
          filePrefix: 'host',
          identifier: processId,
          logsDir,
          input,
          stdoutState,
          stderrState,
          onOutput,
          resolvePromise: resolveOnce,
          startTime,
          timeoutMs,
          extraSummaryLines: [`Working Directory: ${groupDir}`],
          enrichError: (stderrContent, exitLabel) => {
            const missingPackageMatch = stderrContent.match(
              /Cannot find package '([^']+)' imported from/u,
            );
            const userFacingError = missingPackageMatch
              ? `宿主机模式启动失败：缺少依赖 ${missingPackageMatch[1]}。请先执行：${setupInstallHint}`
              : null;
            return {
              result: userFacingError,
              error: `Host agent exited with ${exitLabel}: ${stderrContent.slice(-200)}`,
            };
          },
        };

        if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
        const logFile = writeRunLog(closeCtx, code, duration);
        if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
          return;
        handleSuccessClose(closeCtx, duration);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(
          { group: group.name, processId, error: err },
          'Host agent spawn error',
        );
        resolveOnce({
          status: 'error',
          result: null,
          error: `Host agent spawn error: ${err.message}`,
        });
      });
    });

    // ─── Provider Pool health reporting (host mode) ───
    if (hostSelectedProfileId) {
      if (hostResult.providerFailure) {
        if (!hostProviderFailureReported) {
          providerPool.reportFailure(hostSelectedProfileId, true);
          hostProviderFailureReported = true;
        }
      } else if (
        !hostProviderFailureReported &&
        (hostResult.status === 'success' || hostResult.status === 'closed')
      ) {
        providerPool.reportSuccess(hostSelectedProfileId);
      } else if (
        hostResult.status === 'error' &&
        isApiError(hostResult.error || '')
      ) {
        providerPool.reportFailure(hostSelectedProfileId);
      }
    }
    if (hostProviderFailureMaintenance) {
      return {
        ...hostResult,
        status: 'success',
        result: null,
        providerFailure: false,
        providerFailureTerminal: undefined,
        providerFailureMaintenance: true,
        inputTurnCompleted: true,
      };
    }
    if (hostResult.providerFailure) {
      if (hostProviderFailureTerminal === undefined) {
        hostProviderFailureTerminal = applyProviderFailureDisposition(
          hostResult,
          hostSelectedProfileId,
        );
      } else {
        applyKnownProviderFailureDisposition(
          hostResult,
          hostProviderFailureTerminal,
        );
      }
    }

    return hostResult;
  } finally {
    // Guarantee session release even if spawn/setup throws
    if (hostSelectedProfileId) {
      providerPool.releaseSession(hostSelectedProfileId);
    }
  }
}

/** A concrete agent runner (Docker or host) — both share this signature. */
export type AgentRunner = typeof runContainerAgent | typeof runHostAgent;

/**
 * Model-tier fallback lives inside agent-runner. Scheduled tasks have no warm
 * user-turn stream, so they can also retry the same immutable prompt across
 * healthy provider profiles here. Interactive conversations keep failover in
 * GroupQueue/IPC recovery so a late warm-turn failure never replays the
 * process's original cold-start prompt.
 */
export async function runAgentWithModelFallback(
  runFn: AgentRunner,
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (
    proc: ChildProcess,
    identifier: string,
    selectedProviderId: string | null,
  ) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const maxAttempts = input.isScheduledTask
    ? Math.max(1, getEnabledProviders().length)
    : 1;
  let lastOutput: ContainerOutput | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let completedInputBeforeProviderFailure = false;
    const gatedOnOutput = onOutput
      ? async (output: ContainerOutput): Promise<void> => {
          if (!output.providerFailure && output.inputTurnCompleted) {
            completedInputBeforeProviderFailure = true;
          }
          if (
            input.isScheduledTask &&
            output.providerFailure &&
            (completedInputBeforeProviderFailure ||
              output.providerFailureTerminal !== true)
          ) {
            return;
          }
          await onOutput(output);
        }
      : undefined;

    lastOutput = await runFn(
      group,
      input,
      onProcess,
      gatedOnOutput,
      ownerHomeFolder,
    );
    if (
      input.isScheduledTask &&
      lastOutput.providerFailure &&
      completedInputBeforeProviderFailure
    ) {
      logger.warn(
        {
          group: group.name,
          attempt: attempt + 1,
        },
        'Provider failed after scheduled input completed; suppressing replay to avoid duplicate side effects',
      );
      return {
        ...lastOutput,
        status: 'success',
        result: null,
        providerFailure: false,
        providerFailureTerminal: undefined,
        inputTurnCompleted: true,
      };
    }
    if (
      !input.isScheduledTask ||
      !lastOutput.providerFailure ||
      lastOutput.providerFailureTerminal === true
    ) {
      return lastOutput;
    }

    logger.warn(
      {
        group: group.name,
        attempt: attempt + 1,
        maxAttempts,
      },
      'Scheduled task provider failed; retrying the same prompt on another provider',
    );
  }

  return (
    lastOutput ?? {
      status: 'error',
      result: null,
      error: 'No provider attempt was executed',
    }
  );
}
