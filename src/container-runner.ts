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

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import {
  loadMountAllowlist,
  validateAdditionalMounts,
} from './mount-security.js';
import {
  buildContainerEnvLines,
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
import { getSessionProviderId, setSessionProviderId } from './db.js';
import { isApiError } from './agent-output-parser.js';
import type { ClaudeProviderConfig } from './runtime-config.js';
import { loadUserMcpServers } from './mcp-utils.js';
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
import { MessageSourceKind, RegisteredGroup, StreamEvent } from './types.js';
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
  const containerJsonPath = path.join(containerJsonDir, 'container-claude-json.json');

  try {
    const hostJson = JSON.parse(fs.readFileSync(getHostClaudeJsonPath(), 'utf-8'));
    const stripped = { ...hostJson };
    delete stripped.cachedGrowthBookFeatures;
    delete stripped.oauthAccount;
    stripped.autoUpdates = false;
    fs.writeFileSync(containerJsonPath, JSON.stringify(stripped, null, 2) + '\n', { mode: 0o644 });
  } catch {
    fs.writeFileSync(containerJsonPath, '{"hasCompletedOnboarding":true,"autoUpdates":false}\n', { mode: 0o644 });
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
    logger.warn({ err, localPath, targetPath }, 'Failed to create symlink for .claude.json, deviceId may differ');
  }
}

/**
 * Required env flags for settings.json — 每次容器/进程启动时强制写入，不可被用户覆盖。
 * 合并模式：仅覆盖这些 key，保留用户自定义的其他 key。
 */
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

/** Read existing settings.json, deep-merge required env keys and mcpServers, write only if changed */
function ensureSettingsJson(
  settingsFile: string,
  mcpServers?: Record<string, Record<string, unknown>>,
): void {
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsFile)) {
      existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch {
    /* ignore parse errors, overwrite */
  }

  const existingEnv = (existing.env as Record<string, string>) || {};
  const mergedEnv = { ...existingEnv, ...REQUIRED_SETTINGS_ENV };
  const merged: Record<string, unknown> = { ...existing, env: mergedEnv };

  // Merge user-configured MCP servers into settings
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    const existingMcp = (existing.mcpServers as Record<string, unknown>) || {};
    merged.mcpServers = { ...existingMcp, ...mcpServers };
  }

  const newContent = JSON.stringify(merged, null, 2) + '\n';

  // Only write when content actually changed
  try {
    if (fs.existsSync(settingsFile)) {
      const current = fs.readFileSync(settingsFile, 'utf8');
      if (current === newContent) return;
    }
  } catch {
    /* write anyway */
  }

  fs.writeFileSync(settingsFile, newContent, { mode: 0o644 });
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  /** Source JID of the latest message that triggered this run (e.g. `discord:123…`).
   * Used by per-channel MCP tools (discord_*, etc.) to identify the current
   * incoming chat. Undefined when chatJid already encodes the IM source. */
  currentSourceJid?: string;
  /** @deprecated Use isHome + isAdminHome instead */
  isMain: boolean;
  turnId?: string;
  isHome?: boolean;
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** Isolated task run ID — determines IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  /** If the last unprocessed message was emitted by a scheduled task prompt,
   * this is that task's ID; propagated into agent-runner so MCP send_message
   * outputs can be attributed back to the task record. */
  messageTaskId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  /**
   * Claude Code plugins to inject into the SDK query (via `options.plugins`).
   * Populated just-in-time by runContainerAgent/runHostAgent from the owner's
   * plugins.json; never set by the caller.
   */
  plugins?: Array<{ type: 'local'; path: string }>;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
  finalizationReason?: 'completed' | 'interrupted' | 'error';
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

interface ResolvedProvider {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
}

/**
 * One-time provider overrides per group folder.
 * Set by switchProvider(), consumed (and deleted) by trySelectPoolProvider().
 */
const providerOverrides = new Map<string, string>();

export function setProviderOverride(groupFolder: string, providerId: string): void {
  providerOverrides.set(groupFolder, providerId);
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
function trySelectPoolProvider(
  groupFolder: string,
  agentId?: string | null,
): { profileId: string; resolved: ResolvedProvider } | null {
  const override = getContainerEnvConfig(groupFolder);
  const hasOverride = !!(
    override.anthropicApiKey ||
    override.anthropicAuthToken ||
    override.anthropicBaseUrl
  );
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
      };
    } catch (err) {
      logger.warn({ err, providerId: overrideProviderId }, 'Provider override failed, falling back to pool');
    }
  }

  // Refresh pool state from V4 config
  const enabledProviders = getEnabledProviders();
  if (enabledProviders.length === 0) return null;

  // Sticky path: respect previous session→provider binding when the bound
  // provider is still enabled. Skip when only one provider exists (single
  // provider already gives stickiness implicitly).
  if (enabledProviders.length > 1) {
    const boundId = getSessionProviderId(groupFolder, agentId);
    if (boundId && enabledProviders.some((p) => p.id === boundId)) {
      try {
        const resolved = resolveProviderById(boundId);
        providerPool.acquireSession(boundId);
        logger.debug(
          { groupFolder, agentId: agentId || null, providerId: boundId },
          'Reusing sticky provider binding for resumed session',
        );
        return {
          profileId: boundId,
          resolved: { config: resolved.config, customEnv: resolved.customEnv },
        };
      } catch (err) {
        logger.warn(
          { err, providerId: boundId },
          'Sticky provider resolution failed, falling back to pool selection',
        );
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
      };
    } catch {
      return null;
    }
  }

  const balancing = getBalancingConfig();
  providerPool.refreshFromConfig(enabledProviders, balancing);

  try {
    const profileId = providerPool.selectProvider();
    const resolved = resolveProviderById(profileId);
    providerPool.acquireSession(profileId);
    setSessionProviderId(groupFolder, agentId, profileId);
    return {
      profileId,
      resolved: { config: resolved.config, customEnv: resolved.customEnv },
    };
  } catch (err) {
    logger.warn({ err }, 'Provider pool selection failed, falling back to active profile');
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
export function prepareHostPlugins(ownerId: string | null | undefined): SdkPluginConfig[] {
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

export function buildVolumeMounts(
  group: RegisteredGroup,
  isAdminHome: boolean,
  mountUserSkills = true,
  agentId?: string,
  ownerHomeFolder?: string,
  taskRunId?: string,
  resolvedProvider?: ResolvedProvider,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

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
  // Sub-agents get their own session dir under agents/{agentId}/.claude/
  const groupSessionsDir = agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        agentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  mkdirForContainer(groupSessionsDir);
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const mcpServers = ownerId ? loadUserMcpServers(ownerId) : {};
  ensureSettingsJson(settingsFile, mcpServers);

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
  } catch { /* not found, ok */ }

  // 挂载精简版 .claude.json（剥离 cachedGrowthBookFeatures），保留 deviceId 一致性
  const containerJson = getContainerClaudeJsonPath();
  mounts.push({
    hostPath: containerJson,
    containerPath: '/home/node/.claude.json',
    readonly: true,
  });

  // Skills：以只读卷挂载宿主机目录（由 entrypoint 创建符号链接）
  // 用户的所有 skills 在其所有工作区中全量生效
  const projectSkillsDir = path.join(projectRoot, 'container', 'skills');
  const userSkillsDir =
    mountUserSkills && ownerId ? path.join(DATA_DIR, 'skills', ownerId) : null;

  // Ensure user skills directory exists so it can always be mounted.
  // Skills may be installed after the group is created; without pre-creating,
  // the existsSync check would skip mounting and the container would never see them.
  if (userSkillsDir) {
    fs.mkdirSync(userSkillsDir, { recursive: true });
  }

  // 全量挂载：用户的所有 skills 在所有工作区中生效
  if (fs.existsSync(projectSkillsDir)) {
    mounts.push({
      hostPath: projectSkillsDir,
      containerPath: '/workspace/project-skills',
      readonly: true,
    });
  }
  if (userSkillsDir) {
    mounts.push({
      hostPath: userSkillsDir,
      containerPath: '/workspace/user-skills',
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
  const groupIpcDir = agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', agentId)
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
  // SystemSettings.autoCompactWindow > 0 时注入到容器，让 agent-runner 通过 query() settings 传给 SDK
  const sysAutoCompact = getSystemSettings().autoCompactWindow;
  if (sysAutoCompact > 0) {
    envLines.push(`AUTO_COMPACT_WINDOW=${sysAutoCompact}`);
  }
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
    } catch { /* ignore */ }
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

  // Admin's ~/.claude/ config: mount CLAUDE.md and rules/ into /workspace/
  // so the SDK's directory traversal (cwd → root) discovers them at /workspace/ level.
  // Only for admin-created workspaces (ownerHomeFolder === 'main').
  const isCreatorAdmin = ownerHomeFolder === 'main';
  if (isCreatorAdmin) {
    const hostClaudeDir = path.join(os.homedir(), '.claude');
    const hostClaudeMd = path.join(hostClaudeDir, 'CLAUDE.md');
    const hostRulesDir = path.join(hostClaudeDir, 'rules');

    if (fs.existsSync(hostClaudeMd)) {
      mounts.push({
        hostPath: hostClaudeMd,
        containerPath: '/workspace/CLAUDE.md',
        readonly: true,
      });
    }
    if (fs.existsSync(hostRulesDir)) {
      mounts.push({
        hostPath: hostRulesDir,
        containerPath: '/workspace/.claude/rules',
        readonly: true,
      });
    }

    // External Claude dir: mount skills (admin only, fallback to ~/.claude)
    const effectiveExtDir = getEffectiveExternalDir();
    {
      const extSkillsDir = path.join(effectiveExtDir, 'skills');
      if (fs.existsSync(extSkillsDir)) {
        mounts.push({
          hostPath: extSkillsDir,
          containerPath: '/workspace/external-skills',
          readonly: true,
        });
      }
      // rules 和 CLAUDE.md 已在上方通过 hostRulesDir/hostClaudeMd 挂载（当 effectiveExtDir === hostClaudeDir 时）
      // 仅在 externalClaudeDir 显式设置且不同于 ~/.claude 时才额外挂载
      if (effectiveExtDir !== hostClaudeDir) {
        const extRulesDir = path.join(effectiveExtDir, 'rules');
        if (fs.existsSync(extRulesDir) && !fs.existsSync(hostRulesDir)) {
          mounts.push({
            hostPath: extRulesDir,
            containerPath: '/workspace/.claude/rules',
            readonly: true,
          });
        }
        const extClaudeMd = path.join(effectiveExtDir, 'CLAUDE.md');
        if (fs.existsSync(extClaudeMd) && !fs.existsSync(hostClaudeMd)) {
          mounts.push({
            hostPath: extClaudeMd,
            containerPath: '/workspace/CLAUDE.md',
            readonly: true,
          });
        }
      }
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
  onProcess: (proc: ChildProcess, containerName: string, selectedProviderId: string | null) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);

  // ─── Provider Pool selection ───
  const poolResult = trySelectPoolProvider(group.folder, input.agentId);
  const selectedProfileId = poolResult?.profileId ?? null;
  const resolvedProvider = poolResult?.resolved;

  try {
    // Determine if this is an admin home container (full privileges)
    const isAdminHome = !!group.is_home && group.folder === 'main';
    // Per-user skills: always mount if the group has an owner
    const shouldMountUserSkills = !!group.created_by;
    const mounts = buildVolumeMounts(
      group,
      isAdminHome,
      shouldMountUserSkills,
      input.agentId,
      ownerHomeFolder,
      input.taskRunId,
      resolvedProvider,
    );
    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const agentSuffix = input.agentId
      ? `-${input.agentId.replace(/[^a-zA-Z0-9-]/g, '-')}`
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

      // Attach stdout/stderr handlers using shared parser
      attachStdoutHandler(container.stdout, stdoutState, {
        groupName: group.name,
        label: 'Container',
        onOutput,
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
      if (result.status === 'success' || result.status === 'closed') {
        providerPool.reportSuccess(selectedProfileId);
      } else if (result.status === 'error' && isApiError(result.error || '')) {
        providerPool.reportFailure(selectedProfileId);
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
  onProcess: (proc: ChildProcess, identifier: string, selectedProviderId: string | null) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
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
              process.env.HOME || '/Users/user',
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

  const groupSessionsDir = input.agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        input.agentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Symlink .claude.json 到宿主机 ~/.claude.json，确保 deviceId 一致
  const localJson = path.join(groupSessionsDir, '.claude.json');
  ensureSymlinkTo(localJson, ensureHostClaudeJson());

  // 3. 写入 settings.json（合并模式，不覆盖已有用户配置）
  // Load user's global MCP servers (same logic as Docker mode).
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const hostMcpServers = group.created_by ? loadUserMcpServers(group.created_by) : {};
  ensureSettingsJson(settingsFile, hostMcpServers);

  // 4. Skills / Rules / CLAUDE.md 自动链接到 session 目录
  const effectiveExtDir = getEffectiveExternalDir();

  // 4a. Skills 链接（外部→项目级→用户级，后者覆盖前者）
  try {
    const skillsDir = path.join(groupSessionsDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    // 清空已有符号链接
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      const entryPath = path.join(skillsDir, entry.name);
      try {
        if (entry.isSymbolicLink() || entry.isDirectory()) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }

    const linkSkillEntries = (sourceDir: string) => {
      if (!fs.existsSync(sourceDir)) return;
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const linkPath = path.join(skillsDir, entry.name);
        try {
          // 移除已有符号链接（高优先级覆盖低优先级）
          if (fs.existsSync(linkPath)) {
            fs.rmSync(linkPath, { recursive: true, force: true });
          }
          fs.symlinkSync(path.join(sourceDir, entry.name), linkPath);
        } catch {
          /* ignore */
        }
      }
    };

    // 外部 skills（最低优先级）
    // 宿主机 skills（最低优先级）
    // Builtin skills (lowest priority, e.g. feishu-cli builtin — mirrors /opt/builtin-skills in container)
    const builtinSkillsDir = path.join(DATA_DIR, 'builtin-skills');
    linkSkillEntries(builtinSkillsDir);
    linkSkillEntries(path.join(effectiveExtDir, 'skills'));
    // 项目级 skills
    const projectRoot = process.cwd();
    linkSkillEntries(path.join(projectRoot, 'container', 'skills'));
    // 用户级 skills（覆盖同名项目级）
    const ownerId = group.created_by;
    if (ownerId) {
      linkSkillEntries(path.join(DATA_DIR, 'skills', ownerId));
    }
  } catch (err) {
    logger.warn(
      { folder: group.folder, err },
      '宿主机模式 skills 符号链接失败',
    );
  }

  // 4b. Rules 自动链接到 session 目录
  try {
    const rulesDir = path.join(groupSessionsDir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    // 清空已有符号链接
    for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
      const p = path.join(rulesDir, entry.name);
      try {
        if (entry.isSymbolicLink() || entry.isFile()) {
          fs.rmSync(p, { force: true });
        }
      } catch { /* ignore */ }
    }
    const linkRuleEntries = (sourceDir: string) => {
      if (!fs.existsSync(sourceDir)) return;
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const linkPath = path.join(rulesDir, entry.name);
        try {
          if (fs.existsSync(linkPath)) {
            fs.rmSync(linkPath, { recursive: true, force: true });
          }
          fs.symlinkSync(path.join(sourceDir, entry.name), linkPath);
        } catch { /* ignore */ }
      }
    };
    // 外部 rules（最低优先级）
    linkRuleEntries(path.join(effectiveExtDir, 'rules'));
  } catch (err) {
    logger.warn(
      { folder: group.folder, err },
      '宿主机模式 rules 符号链接失败',
    );
  }

  // 4c. 全局 CLAUDE.md ���接（用户级，不覆盖已有文件）
  {
    const extClaudeMd = path.join(effectiveExtDir, 'CLAUDE.md');
    const sessionClaudeMd = path.join(groupSessionsDir, 'CLAUDE.md');
    try {
      if (fs.existsSync(extClaudeMd) && !fs.existsSync(sessionClaudeMd)) {
        fs.symlinkSync(extClaudeMd, sessionClaudeMd);
      }
    } catch { /* ignore */ }
  }

  // 5. 构建环境变量
  const hostEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  // ─── Provider Pool selection (host mode) ───
  const containerOverride = getContainerEnvConfig(group.folder);
  const hostPoolResult = trySelectPoolProvider(group.folder, input.agentId);
  const hostSelectedProfileId = hostPoolResult?.profileId ?? null;
  const globalConfig = hostPoolResult?.resolved.config ?? getClaudeProviderConfig();

  try {
    // 配置层环境变量
    const envLines = buildContainerEnvLines(
      globalConfig,
      containerOverride,
      hostPoolResult?.resolved.customEnv,
    );
    for (const line of envLines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        hostEnv[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
      }
    }

    // Third-party provider: ANTHROPIC_AUTH_TOKEN inherited from the host
    // (~/.claude/settings.json) forces the SDK down the OAuth code path,
    // which skips the standard Bearer header and causes 404 on non-Anthropic
    // endpoints. Unset it so the injected ANTHROPIC_API_KEY takes effect.
    if (hostEnv['ANTHROPIC_BASE_URL']) {
      delete hostEnv['ANTHROPIC_AUTH_TOKEN'];

      // Also strip oauthAccount from session .claude.json: the SDK detects
      // OAuth credentials in .claude.json and takes the OAuth code path even
      // when ANTHROPIC_AUTH_TOKEN is absent. This causes the same 404 on
      // third-party endpoints. Remove the symlink and write a standalone
      // .claude.json without oauthAccount so the SDK falls back to API key mode.
      try {
        const sessionClaudeJson = path.join(groupSessionsDir, '.claude.json');
        try { fs.unlinkSync(sessionClaudeJson); } catch { /* ignore */ }
        let claudeJson: Record<string, unknown> = {};
        try {
          claudeJson = JSON.parse(fs.readFileSync(getHostClaudeJsonPath(), 'utf-8'));
        } catch { /* ignore */ }
        delete claudeJson.oauthAccount;
        fs.writeFileSync(sessionClaudeJson, JSON.stringify(claudeJson, null, 2) + '\n', { mode: 0o600 });
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

    // SystemSettings.autoCompactWindow > 0 时注入到 host 进程，agent-runner 通过 query() settings 传给 SDK
    const hostAutoCompact = getSystemSettings().autoCompactWindow;
    if (hostAutoCompact > 0) {
      hostEnv['AUTO_COMPACT_WINDOW'] = String(hostAutoCompact);
    }

    // admin 主容器 + 系统设置 disableMemoryLayerForAdminHost 时禁用 HappyClaw 记忆层：
    // 不注入 memory MCP 工具 / WORKSPACE_GLOBAL/MEMORY env / 记忆提示，
    // 让 Agent 完全按用户本机 ~/.claude/ 的 Playbook 工作。
    // 仅作用于 admin 主容器（is_home=1, folder=main），不影响 admin 创建的其他子群组。
    const isCreatorAdmin = ownerHomeFolder === 'main';
    const disableMemoryLayer =
      isCreatorAdmin &&
      !!group.is_home &&
      getSystemSettings().disableMemoryLayerForAdminHost;

    // 路径映射
    hostEnv['HAPPYCLAW_WORKSPACE_GROUP'] = groupDir;
    hostEnv['HAPPYCLAW_WORKSPACE_IPC'] = groupIpcDir;

    if (!disableMemoryLayer) {
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
    }

    // 禁用记忆层且配置了 customCwd 时不覆盖 CLAUDE_CONFIG_DIR，让 SDK 使用用户真实 $HOME/.claude/
    // 未配 customCwd 时保留 override，避免 HappyClaw 的 cwd 污染 ~/.claude/projects/
    if (!disableMemoryLayer || !group.customCwd) {
      // Resolve symlinks so CLAUDE_CONFIG_DIR ends up as the real on-disk path.
      // Some external layer (suspected backend rate-limiter) has been observed to
      // pin failure state to specific CLAUDE_CONFIG_DIR path strings; allowing
      // operators to redirect the literal path via a symlink (e.g. mv main main-v2
      // && ln -s main-v2 main) is a cheap escape hatch when a path gets "tainted".
      let resolvedSessionsDir = groupSessionsDir;
      try {
        resolvedSessionsDir = fs.realpathSync(groupSessionsDir);
      } catch {
        // Path may not exist yet on first spawn; fall back to the literal path.
      }
      hostEnv['CLAUDE_CONFIG_DIR'] = resolvedSessionsDir;
    }

    if (disableMemoryLayer) {
      hostEnv['HAPPYCLAW_DISABLE_MEMORY_LAYER'] = 'true';
      // SDK 读的是 $CLAUDE_CONFIG_DIR/settings.json（此时指向 ~/.claude/），
      // HappyClaw 写在 groupSessionsDir/settings.json 的 REQUIRED_SETTINGS_ENV 会丢。
      // 直接注入到进程 env，SDK 按 process.env 读，绕开 settings.json 路径。
      for (const [key, value] of Object.entries(REQUIRED_SETTINGS_ENV)) {
        hostEnv[key] = value;
      }
      // 同样，per-user MCP servers 在 ~/.claude/settings.json 里没有，
      // 通过 env 透传，agent-runner 合并进 SDK mcpServers 参数。
      if (hostMcpServers && Object.keys(hostMcpServers).length > 0) {
        hostEnv['HAPPYCLAW_USER_MCP_SERVERS_JSON'] =
          JSON.stringify(hostMcpServers);
      }
    }
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
      hostEnv['PATH'] = `${resolvedClaudeDir}:${currentPath}`;
      logger.info(
        { group: group.name, resolvedClaudeDir, resolvedPath: capResult.resolvedPaths['claude'] },
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
      const proc = spawn('node', [agentRunnerDist], {
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
        plugins: prepareHostPlugins(group.created_by),
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

      // 10. stdout/stderr 解析
      attachStdoutHandler(proc.stdout, stdoutState, {
        groupName: group.name,
        label: 'Host agent',
        onOutput,
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
      if (hostResult.status === 'success' || hostResult.status === 'closed') {
        providerPool.reportSuccess(hostSelectedProfileId);
      } else if (
        hostResult.status === 'error' &&
        isApiError(hostResult.error || '')
      ) {
        providerPool.reportFailure(hostSelectedProfileId);
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
