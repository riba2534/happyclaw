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

import {
  fileSignatureSettled,
  sameFileSignature,
  statFileSignature,
  type FileSignature,
} from './file-signature.js';
import {
  CONTAINER_HTTP_PROXY,
  CONTAINER_HTTPS_PROXY,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_HEADROOM,
  CONTAINER_MEMORY_LIMIT,
  CONTAINER_NO_PROXY,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
  type ContainerProxyConfig,
} from './config.js';
import { logger } from './logger.js';
import { isCodexGatewayBaseUrl } from './codex-gateway/resolve-gateway-url.js';
import {
  CodexGatewayRunnerLease,
  applyCodexGatewayNoProxy,
  resolveCodexGatewayLaunchConfig,
} from './codex-gateway/runner-tokens.js';
import {
  buildEffectiveMcpManifest,
  loadPluginMcpDefinitions,
} from './effective-mcp-manifest.js';
import { resolveHostNodeBinary } from './node-resolver.js';
import {
  AdditionalMountValidationError,
  loadMountAllowlist,
  parseContainerConfig,
  validateAdditionalMounts,
} from './mount-security.js';
import { canExecuteOnHost } from './host-execution-policy.js';
import {
  buildContainerEnvLines,
  clearInheritedClaudeProviderEnv,
  getClaudeProviderConfig,
  getContainerEnvConfig,
  getProviders,
  providerHasCredentials,
  getSystemSettings,
  getEffectiveExternalDir,
  hasExplicitWorkspaceClaudeAuth,
  mergeClaudeEnvConfig,
  resolveProviderById,
  shellQuoteEnvLines,
  writeCredentialsFile,
  buildClaudeAiOauthPayload,
  providerToConfig,
  updateProviderOAuthCredentialsIfCurrent,
} from './runtime-config.js';
import { updateProviderSessionCredentials } from './provider-session-credentials.js';
import {
  removeClaudeKeychainOAuth,
  syncClaudeKeychainOAuth,
} from './macos-keychain-credentials.js';
import {
  issueWorkspaceMemoryWriteCapability,
  revokeWorkspaceMemoryWriteCapability,
  type WorkspaceMemoryCapabilityScope,
} from './workspace-memory-capability.js';
import { releaseHappyClawOwnerIntroductionLease } from './owner-profile-store.js';
import { applyProviderSwitchToInput } from './provider-switch-context.js';
import {
  getUserById,
  isDatabaseInitialized,
  getSessionModelSelection,
  getSessionProviderId,
  peekDefaultAgentProfile,
  peekSystemMainAgentProfile,
  peekWorkspaceOwnerMainAgentProfile,
  setSessionModel,
  setSessionProviderId,
} from './db.js';
import {
  effectiveProviderModels,
  findModelEntry,
  launchModelName,
  windowOf,
  type ModelEffort,
} from './model-providers.js';
import { recordUsageEventConnection } from './runtime-state-store.js';
import {
  normalizeUsageLimitResetAt,
  reserveUsageLimitWaitFor,
  settleUsageLimitWaitAfterSuccess,
  usageLimitWaitScopeKey,
} from './usage-limit-wait.js';
import {
  chatGptDefaultModel,
  chatGptLaunchModel,
  resolveAgentLaunchModel,
  resolveLaunchEffort,
  resolveSessionLaunchOverrides,
  sessionModelHasChanged,
  type SessionLaunchOverrides,
} from './session-model-overrides.js';
import {
  CODEX_REAUTH_REQUIRED_USER_NOTICE,
  TransientRetryLedger,
  resolveProviderFailureClass,
  resolveTerminalProviderFailureNotice,
  resolveTransientRetryKey,
} from './provider-failure.js';
import type {
  ClaudeOAuthCredentials,
  ClaudeProviderConfig,
  UnifiedProvider,
} from './runtime-config.js';
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
import {
  resolveSessionWorkingDirectory,
  resolveWorkspaceSkillRoots,
  sessionWorktreeRunError,
} from './session-worktree.js';
import { getSessionWorktree } from './session-worktree-store.js';
import { RegisteredGroup } from './types.js';
import type {
  AgentProfile,
  AgentProfileRuntimePolicy,
  ChannelTurnContext,
  InteractionMode,
} from './types.js';
import type { TeamRole } from './work-items.js';
import { validateSkillId, validateSkillPath } from './skill-utils.js';
import type { ClaudeContextAudit } from './stream-event.types.js';
import type { ContainerOutput } from './agent-runtime-contracts.js';
export type { ContainerOutput } from './agent-runtime-contracts.js';
import {
  captureProviderQuotaObservationEpoch,
  consumeProviderQuotaControlOutput,
} from './provider-quota-observation.js';
import {
  dockerOAuthCredentialsEqual,
  readDockerClaudeOAuthCredentials,
  reconcileDockerOAuthCredentials,
  type DockerOAuthReconcileOutcome,
} from './docker-oauth-credentials.js';
import {
  isClaudeOAuthRefreshDue,
  refreshClaudeProviderOAuth,
  type ClaudeOAuthRefreshOutcome,
} from './claude-oauth-refresh.js';
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
import {
  applyFeishuCliBindingToEnvLines,
  resolveFeishuCliRuntimeBinding,
  type FeishuCliRuntimeBinding,
} from './feishu-cli-runtime.js';
import { assertValidWorkspaceFolderName } from './workspace-folder.js';
import { resolveRunnerLivenessTimeouts } from './runner-liveness.js';
import {
  applyLaunchEffortEnv,
  resolveAgentSdkEffort,
  type SdkAgentEffort,
} from './agent-effort.js';

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

const CONTAINER_CLAUDE_JSON_FALLBACK =
  '{"hasCompletedOnboarding":true,"autoUpdates":false}\n';

function deriveContainerClaudeJson(hostJsonPath: string): string {
  try {
    const hostJson = JSON.parse(fs.readFileSync(hostJsonPath, 'utf-8'));
    const stripped = { ...hostJson };
    delete stripped.cachedGrowthBookFeatures;
    delete stripped.oauthAccount;
    stripped.hasCompletedOnboarding = true;
    stripped.autoUpdates = false;
    return JSON.stringify(stripped, null, 2) + '\n';
  } catch {
    return CONTAINER_CLAUDE_JSON_FALLBACK;
  }
}

let containerClaudeJsonSource: {
  path: string;
  sig: FileSignature | null;
  observedAt: number;
  content: string;
} | null = null;
let containerClaudeJsonTarget: {
  path: string;
  sig: FileSignature;
  observedAt: number;
  content: string;
} | null = null;

function writeContainerClaudeJsonIfChanged(
  targetPath: string,
  content: string,
): void {
  const observedAt = Date.now();
  const sig = statFileSignature(targetPath);
  const known = containerClaudeJsonTarget;
  if (
    known &&
    known.path === targetPath &&
    known.content === content &&
    sameFileSignature(known.sig, sig) &&
    fileSignatureSettled(known.sig, known.observedAt)
  ) {
    return;
  }
  containerClaudeJsonTarget = null;

  let onDisk: string | null = null;
  try {
    onDisk = fs.readFileSync(targetPath, 'utf-8');
  } catch {
    /* missing: write it */
  }
  if (onDisk === content) {
    if (sig) {
      containerClaudeJsonTarget = {
        path: targetPath,
        sig,
        observedAt,
        content,
      };
    }
    return;
  }

  // Running containers bind-mount this file read-only. Replacing it by rename
  // leaves them a whole snapshot instead of a truncated, half-written file.
  writeAtomicFile(targetPath, content, 0o644);
  const writtenSig = statFileSignature(targetPath);
  if (writtenSig) {
    containerClaudeJsonTarget = {
      path: targetPath,
      sig: writtenSig,
      observedAt: Date.now(),
      content,
    };
  }
}

/**
 * 为 Docker 容器生成精简版 .claude.json。
 * 宿主机 ~/.claude.json 中的 cachedGrowthBookFeatures 含 tengu_bridge_repl_v2 等
 * feature flags，SDK 初始化时会据此尝试建立 bridge 连接，在容器网络环境中无法完成
 * 导致进程挂起。剥离该字段后其余内容原样保留（userID 等）。
 * 同时剥离 oauthAccount：容器内不走宿主机的 OAuth 登录态，认证完全由
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 环境变量控制，避免 SDK 误检
 * OAuth 凭据后跳过标准 Bearer header（第三方 provider 返回 404）。
 * Runner 进程经 entrypoint 的 CLAUDE_CONFIG_DIR 读写会话目录下的 .claude.json，
 * 不读取这份副本；它只服务于不继承该变量的容器进程，例如 Web 终端经
 * docker exec 启动的 shell 里交互运行的 claude。副本以只读挂载，引导结果
 * 写不回去，所以固定标记为已完成引导，免得这类进程每次都停在 Welcome 页，
 * 无论宿主机是否登录过。
 *
 * ~/.claude.json can be megabytes, so the copy is re-derived only when the
 * host file's stats change and rewritten only when its bytes would change.
 */
export function getContainerClaudeJsonPath(): string {
  const containerJsonDir = path.join(DATA_DIR, 'config');
  fs.mkdirSync(containerJsonDir, { recursive: true });
  const containerJsonPath = path.join(
    containerJsonDir,
    'container-claude-json.json',
  );

  const hostJsonPath = getHostClaudeJsonPath();
  const observedAt = Date.now();
  const sourceSig = statFileSignature(hostJsonPath);
  const cached = containerClaudeJsonSource;
  let content: string;
  if (
    cached &&
    cached.path === hostJsonPath &&
    sameFileSignature(cached.sig, sourceSig) &&
    fileSignatureSettled(cached.sig, cached.observedAt)
  ) {
    content = cached.content;
  } else {
    content = deriveContainerClaudeJson(hostJsonPath);
    containerClaudeJsonSource = {
      path: hostJsonPath,
      sig: sourceSig,
      observedAt,
      content,
    };
  }

  try {
    writeContainerClaudeJsonIfChanged(containerJsonPath, content);
  } catch {
    // As before, a copy that cannot be written falls back to the stub.
    writeContainerClaudeJsonIfChanged(
      containerJsonPath,
      CONTAINER_CLAUDE_JSON_FALLBACK,
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

/**
 * Remove every session-file signal that can make Claude Code prefer OAuth.
 * Host mode supplies a template because its session file normally symlinks to
 * the user's global .claude.json; Docker edits only its isolated session copy.
 */
export function clearSessionClaudeOAuthFiles(
  sessionDir: string,
  claudeJsonTemplatePath?: string,
): void {
  const sessionClaudeJson = path.join(sessionDir, '.claude.json');
  let sourceExists = false;
  let hasSyntaxError = false;
  let claudeJson: Record<string, unknown> = {};
  try {
    const sourcePath = claudeJsonTemplatePath ?? sessionClaudeJson;
    sourceExists = fs.existsSync(sourcePath);
    if (sourceExists) {
      const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Claude session metadata is not a JSON object');
      }
      claudeJson = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      hasSyntaxError = true;
    } else if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      sourceExists = false;
      claudeJson = {};
    } else {
      // Invalid session metadata must not survive as an opaque OAuth signal.
      sourceExists = true;
      claudeJson = {};
    }
  }

  if (!hasSyntaxError) {
    try {
      const stat = fs.lstatSync(sessionClaudeJson);
      if (stat.isSymbolicLink()) fs.unlinkSync(sessionClaudeJson);
    } catch {
      /* not found, ok */
    }
    const hadOauthAccount = 'oauthAccount' in claudeJson;
    delete claudeJson.oauthAccount;
    if (claudeJsonTemplatePath || sourceExists || hadOauthAccount) {
      writeAtomicFile(
        sessionClaudeJson,
        JSON.stringify(claudeJson, null, 2) + '\n',
        0o600,
      );
    }
  }

  const credentialsPath = path.join(sessionDir, '.credentials.json');
  if (fs.existsSync(credentialsPath)) fs.unlinkSync(credentialsPath);
}

/** Stable, non-secret Keychain ownership for workspace-selected credentials. */
export function workspaceRuntimeCredentialOwnerId(folder: string): string {
  assertValidWorkspaceFolderName(folder);
  return `runtime-workspace-auth:${folder}`;
}

/** Required env flags for settings.json — 每次启动时强制写入，不可被宿主机配置覆盖。 */
const REQUIRED_SETTINGS_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
  // Workspace Memory is the sole managed long-term store. Additional
  // directories must not smuggle user-global/date files into SDK context,
  // and Claude's native auto-memory must not create a second truth source.
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
};

/**
 * Keys an older HappyClaw forced into session settings.json and must now be
 * removed from it, unless the selected native layer sets them itself.
 *
 * CLAUDE_CODE_DISABLE_ATTACHMENTS was forced to keep the prompt-cache prefix
 * stable across query() processes. Claude Code 2.1.296 treats it like bare
 * mode: the turn-start attachment pass is skipped, so the skill listing,
 * nested CLAUDE.md and todo reminders never reach the model and every
 * selected Skill is invisible. A resumed process now replays the same message
 * prefix with attachments on, so the old cache rationale no longer applies.
 */
const RETIRED_SETTINGS_ENV_KEYS = ['CLAUDE_CODE_DISABLE_ATTACHMENTS'] as const;

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

function writeAtomicFile(
  filePath: string,
  contents: string,
  mode: number,
): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, contents, { flag: 'wx', mode });
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

function readSettingsRecord(
  filePath: string,
  options?: { ignoreSyntaxError?: boolean },
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isSettingsRecord(parsed) ? parsed : {};
  } catch (error) {
    if (
      !options?.ignoreSyntaxError &&
      (error instanceof SyntaxError || (error as Error)?.name === 'SyntaxError')
    ) {
      throw error;
    }
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
  let current: Record<string, unknown>;
  try {
    current = readSettingsRecord(settingsFile);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as Error)?.name === 'SyntaxError'
    ) {
      return;
    }
    throw error;
  }
  let previousProjection: Record<string, unknown>;
  try {
    previousProjection = readSettingsRecord(projectionFile, {
      ignoreSyntaxError: true,
    });
  } catch {
    previousProjection = {};
  }
  const existing = mergeSettingsRecord(
    removePreviousSettingsProjection(current, previousProjection),
    options?.baseSettings ?? {},
  );

  const existingEnv = (existing.env as Record<string, string>) || {};
  const mergedEnv = { ...existingEnv, ...REQUIRED_SETTINGS_ENV };
  const baseEnv = isSettingsRecord(options?.baseSettings?.env)
    ? options.baseSettings.env
    : {};
  for (const key of RETIRED_SETTINGS_ENV_KEYS) {
    if (!Object.hasOwn(baseEnv, key)) delete mergedEnv[key];
  }
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
    writeAtomicFile(settingsFile, newContent, 0o644);
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
  writeAtomicFile(projectionFile, projectionContent, 0o600);
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  /**
   * The effort the host resolved for this launch: Claude Code runs at it, and
   * null means none is sent at all, not even the Agent's own effort as the
   * SDK option. Absent without a connection (the Workspace's own
   * environment) or on a ChatGPT subscription, whose gateway applies it:
   * the Agent's effort then goes as before.
   */
  launchEffort?: string | null;
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
  /** Persisted message IDs already represented by this cold-run prompt. */
  readonly currentBatchMessageIds?: readonly string[];
  isHome?: boolean;
  isAdminHome?: boolean;
  /**
   * Internal per-runner HMAC secret delivered only in the stdin bootstrap.
   * Never expose this in environment variables, files, logs, prompts, or IPC.
   */
  workspaceMemoryMutationSigningSecret?: string;
  /** Public identity paired with the runner-private signing secret. */
  workspaceMemoryRunnerInstanceId?: string;
  /** Claude session/provider namespace when it differs from agentId. */
  sessionAgentId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentProfile?: {
    id: string;
    name: string;
    version: number;
    /** Host-authoritative marker for the built-in HappyClaw AgentProfile. */
    isDefault: boolean;
    identityHash: string;
    identityPrompt: string;
    includeClaudePreset: boolean;
    /** Null means inherit the system default model configuration. */
    modelConfigId?: string | null;
    /**
     * A model of `modelConfigId`'s list; null runs that configuration's
     * default. Applies only when this binding is what pins the launch.
     */
    model?: string | null;
    runtimePolicy?: AgentProfileRuntimePolicy;
  };
  /**
   * True only for an interactive turn in the built-in HappyClaw Home
   * Workspace before the owner-preferred-address memory has been established.
   */
  happyClawBootstrapPending?: boolean;
  /**
   * Host-authoritative initial Owner Profile projection. Present only for an
   * actual-owner interactive turn of built-in HappyClaw in Home. The runner
   * refreshes it over dedicated IPC before every cold/warm model turn.
   */
  happyClawOwnerProfile?: {
    workspaceJid: string;
    preferredAddress: string | null;
    revision: number | null;
    onboarding: {
      state: 'pending' | 'claimed' | 'completed' | 'skipped';
      revision: number;
      leaseOwner: string | null;
      leaseToken: number | null;
      leaseExpiresAt: string | null;
    };
  };
  /** Structural capability only; exact owner authorization is re-evaluated by
   * the host for every dedicated IPC request, including warm turns. */
  happyClawOwnerProfileEnabled?: boolean;
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
  /**
   * Team mode (团队模式): the session routes a group's requests or does one
   * work item. The Runner picks tools, prompt section and disallowed tools
   * from it. Absent for every other session.
   */
  teamRole?: TeamRole;
}

/**
 * Reconcile a runner's provider-failure verdict with what the embedded Codex
 * gateway last answered it. Claude Code reports every exhausted 429 as an
 * account-wide limit, but a throttle the gateway applied itself (its local
 * per-runner window, a token refresh in backoff) says nothing about the
 * ChatGPT account and must not quarantine the provider. A rejected refresh
 * grant stays an account verdict, with a notice naming the remedy.
 */
export function applyCodexGatewayVerdict(
  output: ContainerOutput,
  lease: Pick<CodexGatewayRunnerLease, 'lastVerdict'>,
): void {
  if (!output.providerFailure) return;
  if (resolveProviderFailureClass(output) !== 'account') return;
  switch (lease.lastVerdict) {
    case 'local_transient':
      output.providerFailureClass = 'transient';
      break;
    case 'reauth_required':
      output.providerFailureNotice ??= CODEX_REAUTH_REQUIRED_USER_NOTICE;
      output.providerRateLimitResetsAt = undefined;
      break;
  }
}

/** Host-process replay budget; each transient retry runs a fresh runner. */
const transientRetries = new TransientRetryLedger();

/**
 * Decide whether a provider failure ends the input. A run's connection is
 * authoritative, so nothing fails over: a transient failure gets its one
 * same-connection replay, a usage limit with a known reset waits for it, and
 * everything else ends the input visibly. Exported for tests.
 */
export function applyProviderFailureDisposition(
  output: ContainerOutput,
  selectedProfileId: string | null,
  waitScope?: UsageLimitWaitScope,
): boolean {
  const failureClass = resolveProviderFailureClass(output);
  if (failureClass === 'transient') {
    if (
      transientRetries.consume(
        resolveTransientRetryKey(output),
        selectedProfileId,
      )
    ) {
      applyKnownProviderFailureDisposition(output, false);
      return false;
    }
    // Repetition does not turn a 529/5xx or a silent transport stall into
    // evidence about the account: end this input visibly.
    logger.warn(
      {
        providerId: selectedProfileId,
        livenessTimeout: output.providerLivenessTimeout === true,
      },
      'Transient provider failure repeated after its replay; ending the input',
    );
    applyKnownProviderFailureDisposition(output, true);
    return true;
  }
  const terminal =
    failureClass === 'config' ||
    !deferUsageLimitFailure(output, selectedProfileId, waitScope);
  applyKnownProviderFailureDisposition(output, terminal);
  return terminal;
}

/** The lane and durable input a provider failure belongs to. */
export interface UsageLimitWaitScope {
  scopeKey: string;
  inputKey?: string;
}

export function usageLimitWaitScopeFor(
  input: ContainerInput,
): UsageLimitWaitScope {
  return {
    scopeKey: usageLimitWaitScopeKey(input),
    inputKey: input.turnId,
  };
}

/**
 * When the run's connection hit its usage limit and the upstream named a
 * reset time, keep the input for after the reset: mark the failure with the
 * resume time and report it non-terminal. Bounded per lane by
 * usage-limit-wait.ts.
 */
function deferUsageLimitFailure(
  output: ContainerOutput,
  selectedProfileId: string | null,
  waitScope: UsageLimitWaitScope | undefined,
): boolean {
  if (!waitScope || !isDatabaseInitialized()) return false;
  if (output.providerFailureNotice === CODEX_REAUTH_REQUIRED_USER_NOTICE) {
    return false;
  }
  const resetAt = normalizeUsageLimitResetAt(output.providerRateLimitResetsAt);
  if (resetAt === null) return false;
  const inputKey = resolveTransientRetryKey(output) || waitScope.inputKey;
  if (!inputKey) return false;
  try {
    const wait = reserveUsageLimitWaitFor({
      scopeKey: waitScope.scopeKey,
      inputKey,
      resetAtMs: resetAt,
      nowMs: Date.now(),
    });
    if (!wait) return false;
    output.providerUsageLimitResumeAt = Date.parse(wait.resumeAt);
    logger.warn(
      {
        scopeKey: waitScope.scopeKey,
        providerId: selectedProfileId,
        resumeAt: wait.resumeAt,
        waitCount: wait.waitCount,
      },
      'Usage limit reached on the connection; input waits for the reset',
    );
    return true;
  } catch (err) {
    logger.error(
      { err, scopeKey: waitScope.scopeKey },
      'Failed to record a usage-limit wait; ending the input instead',
    );
    return false;
  }
}

/** A healthy turn ends the lane's run of consecutive usage-limit waits. */
function settleUsageLimitWaitForOutput(
  output: ContainerOutput,
  input: ContainerInput,
): void {
  if (
    output.providerFailure ||
    output.inputTurnCompleted !== true ||
    !isDatabaseInitialized()
  ) {
    return;
  }
  try {
    settleUsageLimitWaitAfterSuccess(usageLimitWaitScopeKey(input));
  } catch (err) {
    logger.warn({ err }, 'Failed to settle the usage-limit wait of a lane');
  }
}

/** The final output repeats the streamed failure; keep its wait with it. */
function carryUsageLimitWait(
  decided: ContainerOutput | undefined,
  output: ContainerOutput,
): void {
  if (decided?.providerUsageLimitResumeAt === undefined) return;
  output.providerUsageLimitResumeAt = decided.providerUsageLimitResumeAt;
}

function applyKnownProviderFailureDisposition(
  output: ContainerOutput,
  terminal: boolean,
): void {
  // Provider failures are control-plane signals. Chat/task callers synthesize
  // their own terminal projection only once the failure is terminal.
  output.result = null;
  output.providerFailureTerminal = terminal;
  output.inputTurnCompleted = terminal;
  // Set here rather than in the disposition helper so every path that forces a
  // non-account failure terminal — including the scheduled replay loop's
  // no-progress bail-out — names the real cause instead of a quota verdict.
  if (terminal) {
    const notice = resolveTerminalProviderFailureNotice(output);
    if (notice) output.providerFailureNotice = notice;
  }
}

/**
 * Remember which connection served a usage event, so cache hit rates can be
 * read per connection. The usage row itself is written by the caller under
 * the same event id. Exported for tests.
 */
export function recordUsageConnection(
  output: ContainerOutput,
  profileId: string | null,
): void {
  const eventId =
    output.streamEvent?.eventType === 'usage'
      ? output.streamEvent.usage?.eventId
      : undefined;
  if (!profileId || !eventId || !isDatabaseInitialized()) return;
  try {
    recordUsageEventConnection(eventId, profileId);
  } catch (err) {
    logger.warn({ err, eventId }, 'Failed to record the usage connection');
  }
}

function providerFailureDispositionLogMessage(
  output: ContainerOutput,
  terminal: boolean,
): string {
  if (terminal) return 'Provider failure is terminal; surfacing it';
  return resolveProviderFailureClass(output) === 'transient'
    ? 'Transient provider failure; preserving input for bounded same-provider replay'
    : 'Usage limit reached; preserving input until the reset';
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export type AgentRunnerMode = 'image' | 'development';

export function resolveAgentRunnerMode(
  value = process.env.HAPPYCLAW_AGENT_RUNNER_MODE,
): AgentRunnerMode {
  if (!value || value === 'image') return 'image';
  if (value === 'development') return 'development';
  throw new Error('HAPPYCLAW_AGENT_RUNNER_MODE must be image or development');
}

/**
 * Create an owner-only directory for a writable container mount. The container
 * entrypoint applies the selected identity bridge; host code must never make
 * these data roots world-accessible as a uid-mismatch workaround.
 */
function mkdirForContainer(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  try {
    fs.chmodSync(dirPath, 0o700);
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
  /**
   * The effort the launch runs at (resolveModelLaunch), written as
   * CLAUDE_CODE_EFFORT_LEVEL: Claude Code ranks that variable above the SDK
   * `effort` option the runner passes for the Agent, so the Agent profile
   * the runner sees (and hashes) stays as stored.
   */
  launchEffort?: string;
  /** The runner's same-turn fallback model, named for this connection. */
  fallbackModel?: string;
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
  /** The run's project root; see resolveWorkspaceProjectRoot. */
  workspaceDir = path.join(GROUPS_DIR, group.folder),
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
    workspaceDir,
    externalClaudeDir: getEffectiveExternalDir(),
    includeHostClaudeContext: shouldIncludeHostClaudeContext(agentProfile),
  });
  return mergeMcpServerLayers(context, managed);
}

function buildRuntimeMcpManifest(
  servers: Record<string, Record<string, unknown>>,
  agentProfile: RunnerAgentProfile | undefined,
  plugins: SdkPluginConfig[],
) {
  const pluginServers =
    getAgentProfileMcpPolicyMode(agentProfile) === 'inherit'
      ? loadPluginMcpDefinitions(plugins)
      : {};
  return buildEffectiveMcpManifest({
    ...servers,
    ...pluginServers,
  });
}

export function runtimeMcpServersRequireHeadroom(
  servers: Record<string, Record<string, unknown>>,
): boolean {
  return Object.values(servers).some((definition) => {
    const command = definition.command;
    if (typeof command !== 'string') return false;
    const executable = path.basename(command.trim()).toLowerCase();
    return executable === 'headroom' || executable === 'headroom.exe';
  });
}

function getAgentProfileMcpPolicyMode(
  agentProfile?: RunnerAgentProfile,
): 'inherit' | 'custom' | 'disabled' {
  return agentProfile?.runtimePolicy?.mcp.mode ?? 'inherit';
}

/** Where a run's connection comes from; see resolveModelBinding. */
export type ModelBindingSource =
  | 'session'
  | 'agent'
  | 'workspace_env'
  | 'owner_main'
  | 'system_main'
  | 'none';

/** The run's own Agent, as far as its model goes. */
export interface AgentModelBinding {
  modelConfigId?: string | null;
  model?: string | null;
}

export interface ModelBinding {
  source: ModelBindingSource;
  /**
   * The connection the run uses; null for `workspace_env` and `none`, and
   * for a binding whose connection is gone (connectionMissing).
   */
  provider: UnifiedProvider | null;
  /** The connection the step names, also when it is missing. */
  modelConfigId: string | null;
  /**
   * The step's binding names a connection that was deleted or has no
   * credential. A set binding is authoritative: the run fails rather than
   * moving to another connection.
   */
  connectionMissing?: boolean;
  /**
   * The model the profile that supplied the connection names in it. For a
   * conversation pick, the Agent's own model when the pick is on the
   * Agent's connection: it runs when the pick names no model.
   */
  model: string | null;
  /** The explicit effort of the main Agent the connection was inherited from. */
  inheritedEffort?: SdkAgentEffort;
}

/** A saved connection that can serve a launch now, or null. */
export function usableProvider(
  id: string | null | undefined,
  providers: readonly UnifiedProvider[] = getProviders(),
): UnifiedProvider | null {
  if (!id) return null;
  const provider = providers.find((item) => item.id === id);
  return provider && providerHasCredentials(provider) ? provider : null;
}

/** A set binding: its connection if usable, else marked missing. */
function boundStep(
  source: ModelBindingSource,
  modelConfigId: string,
  model: string | null,
  providers: readonly UnifiedProvider[],
): ModelBinding {
  const provider = usableProvider(modelConfigId, providers);
  return provider
    ? { source, provider, modelConfigId, model }
    : {
        source,
        provider: null,
        modelConfigId,
        model: null,
        connectionMissing: true,
      };
}

/**
 * The binding a main Agent hands down to Agents without their own: its
 * connection, its model, its explicit effort. Null when it binds nothing.
 */
export function bindingFromMainProfile(
  source: 'owner_main' | 'system_main',
  profile: AgentProfile | undefined,
  providers: readonly UnifiedProvider[] = getProviders(),
): ModelBinding | null {
  if (!profile?.model_config_id) return null;
  const binding = boundStep(
    source,
    profile.model_config_id,
    profile.model,
    providers,
  );
  const inheritedEffort = resolveAgentSdkEffort(profile.runtime_policy);
  return binding.provider && inheritedEffort
    ? { ...binding, inheritedEffort }
    : binding;
}

/**
 * The connection a run uses, most specific first: the conversation's pick,
 * the Agent's own binding, the Workspace's own provider environment, the
 * owner's main Agent, the system main HappyClaw (main Agent of the earliest
 * admin), none. A step that binds nothing is skipped. A conversation pick
 * whose connection is gone reads as no pick; any other binding is
 * authoritative, so a deleted or credential-less connection stops there
 * (connectionMissing) instead of running on another account. An inherited
 * connection brings the model its profile names in it.
 *
 * Every launch, the chat picker's default and the Agent page call this, so
 * what they show is what runs. `includeSession: false` asks what runs when
 * the conversation picks nothing.
 */
export function resolveModelBinding(
  agent: AgentModelBinding | null | undefined,
  session?: { groupFolder: string; agentId?: string | null } | null,
  options: { includeSession?: boolean; ownerUserId?: string | null } = {},
): ModelBinding {
  const providers = getProviders();
  if (session && options.includeSession !== false) {
    const picked = usableProvider(
      getSessionModelSelection(session.groupFolder, session.agentId),
      providers,
    );
    if (picked) {
      return {
        source: 'session',
        provider: picked,
        modelConfigId: picked.id,
        model:
          agent?.modelConfigId === picked.id ? (agent.model ?? null) : null,
      };
    }
  }
  if (agent?.modelConfigId) {
    return boundStep(
      'agent',
      agent.modelConfigId,
      agent.model ?? null,
      providers,
    );
  }
  if (session && workspaceHasProviderEnv(session.groupFolder)) {
    return {
      source: 'workspace_env',
      provider: null,
      modelConfigId: null,
      model: null,
    };
  }
  if (isDatabaseInitialized()) {
    const ownerMain = options.ownerUserId
      ? peekDefaultAgentProfile(options.ownerUserId)
      : session
        ? peekWorkspaceOwnerMainAgentProfile(session.groupFolder)
        : undefined;
    const inherited =
      bindingFromMainProfile('owner_main', ownerMain, providers) ??
      bindingFromMainProfile(
        'system_main',
        peekSystemMainAgentProfile(),
        providers,
      );
    if (inherited) return inherited;
  }
  return { source: 'none', provider: null, modelConfigId: null, model: null };
}

/**
 * Why a launch cannot run, or null: a set binding whose connection is gone,
 * or no binding anywhere while connections exist. Prefixed so the host
 * treats it as a deterministic configuration error, not a retry.
 */
export function modelBindingError(binding: ModelBinding): string | null {
  if (binding.connectionMissing) {
    const whose =
      binding.source === 'agent'
        ? '智能体'
        : binding.source === 'owner_main'
          ? '主智能体'
          : '主 HappyClaw';
    return `agent_profile_unavailable: ${whose}绑定的模型连接已删除或缺少凭据，请在智能体页重新选择`;
  }
  if (binding.source === 'none' && getProviders().length > 0) {
    return 'agent_profile_unavailable: 还没有为主 HappyClaw 选择模型，请在设置或智能体页选择';
  }
  return null;
}

/** Whether the Workspace brings its own provider environment. */
function workspaceHasProviderEnv(groupFolder: string): boolean {
  const override = getContainerEnvConfig(groupFolder);
  return !!(
    override.anthropicApiKey ||
    override.anthropicAuthToken ||
    override.anthropicBaseUrl
  );
}

/**
 * The model configuration the user picked for this conversation in the chat
 * composer. A selection whose configuration has since been deleted or lost
 * its credential reads as none, so the order moves on instead of failing the
 * turn.
 */
export function resolveSessionModelSelection(
  groupFolder: string,
  agentId?: string | null,
): string | null {
  const selected = getSessionModelSelection(groupFolder, agentId);
  return usableProvider(selected) ? selected : null;
}

/** What a launch on a resolved binding runs within its connection. */
export interface ModelLaunch {
  /** The model to run instead of the connection's own, never with `[1m]`. */
  model?: string;
  /**
   * The effort Claude Code runs at, or null when the model takes none (and
   * on a ChatGPT subscription, whose gateway applies the effort).
   */
  effort: ModelEffort | null;
  /** ChatGPT only: the conversation's own effort pick. */
  sessionEffort?: string;
  /** ChatGPT only: the Agent's effort, else the inherited main Agent's. */
  gatewayAgentEffort?: string;
}

/**
 * The model and effort a launch runs on within the binding's connection.
 * Model: the conversation's pick (or the connection's own when the pick
 * names none), else the model the supplying profile names, else the
 * connection's own. Effort: the conversation's pick, the Agent's explicit
 * effort, the inherited main Agent's, each only if the model takes it, else
 * the model's default; nothing for a model without efforts. With no model
 * at all (a pass-through relay) the Agent's explicit effort.
 */
export function resolveModelLaunch(
  binding: ModelBinding & { provider: UnifiedProvider },
  groupFolder: string,
  agentId: string | null | undefined,
  agentEffort: SdkAgentEffort | undefined,
  options: { warn?: boolean } = {},
): ModelLaunch {
  const { provider } = binding;
  // The profile's model; for a pick without a model on the Agent's own
  // connection, the Agent's. A name saved with `[1m]` stays as it is: the
  // launch reads it as 1M.
  const profileModel = resolveAgentLaunchModel(provider, binding.model, {
    groupFolder,
    agentId,
    // Only when the Agent's own binding decides is a dropped model news.
    warn: binding.source === 'agent' && options.warn !== false,
  });
  const overrides: SessionLaunchOverrides =
    binding.source === 'session'
      ? resolveSessionLaunchOverrides(groupFolder, agentId, provider, {
          ...options,
          unpickedModel: profileModel ?? provider.anthropicModel,
        })
      : {};
  const model = overrides.model ?? profileModel;
  if (provider.codexOAuthCredentials) {
    const gatewayAgentEffort = agentEffort ?? binding.inheritedEffort;
    return {
      ...(model ? { model } : {}),
      effort: null,
      ...(overrides.effort ? { sessionEffort: overrides.effort } : {}),
      ...(gatewayAgentEffort ? { gatewayAgentEffort } : {}),
    };
  }
  const runs = model ?? provider.anthropicModel;
  return {
    ...(model ? { model } : {}),
    // A pass-through relay names no model: nothing is known to rule the
    // Agent's explicit effort out, so it goes as set.
    effort: runs
      ? resolveLaunchEffort(provider, runs, [
          overrides.effort,
          agentEffort,
          binding.inheritedEffort,
        ])
      : (agentEffort ?? null),
  };
}

/** A binding and what it runs, as the picker and the Agent page show it. */
export interface ModelBindingSummary {
  source: ModelBindingSource;
  provider: UnifiedProvider | null;
  /** The connection the binding names, also when it is missing. */
  modelConfigId: string | null;
  /** The binding is set but its connection is gone: the run fails. */
  connectionMissing: boolean;
  /** The model a launch runs; null for a pass-through relay or no connection. */
  model: string | null;
  /** Null when the model takes no effort or the gateway decides (ChatGPT). */
  effort: ModelEffort | null;
}

export function summarizeModelBinding(
  binding: ModelBinding,
  groupFolder: string,
  agentId: string | null | undefined,
  agentEffort: SdkAgentEffort | undefined,
): ModelBindingSummary {
  const { provider, source, modelConfigId } = binding;
  const connectionMissing = !!binding.connectionMissing;
  if (!provider) {
    return {
      source,
      provider,
      modelConfigId,
      connectionMissing,
      model: null,
      effort: null,
    };
  }
  const launch = resolveModelLaunch(
    { ...binding, provider },
    groupFolder,
    agentId,
    agentEffort,
    { warn: false },
  );
  return {
    source,
    provider,
    modelConfigId,
    connectionMissing,
    model: provider.codexOAuthCredentials
      ? chatGptLaunchModel(launch.model, provider)
      : launch.model || provider.anthropicModel || null,
    effort: launch.effort,
  };
}

/**
 * Read-only prediction of whether the next launch will *clear* the resumable
 * Claude session: it runs on another connection than the session is bound
 * to, or on another model. Mirrors trySelectPoolProvider without writing.
 *
 * The orchestration layer calls this *before* building the prompt so the
 * switch injects recent conversation history into the fresh session.
 */
export function willClearSessionOnProviderSwitch(
  groupFolder: string,
  agentId?: string | null,
  modelConfigId?: string | null,
  agentModel?: string | null,
): boolean {
  const binding = resolveModelBinding(
    { modelConfigId, model: agentModel },
    { groupFolder, agentId },
  );
  const boundId = getSessionProviderId(groupFolder, agentId);
  // Without a connection the launch fails, or runs the Workspace's own
  // environment, which is another account than a bound session's.
  if (!binding.provider) return !modelBindingError(binding) && !!boundId;
  if (boundId && boundId !== binding.provider.id) return true;
  return launchModelWillChange(groupFolder, agentId, {
    ...binding,
    provider: binding.provider,
  });
}

/** Whether a launch on `binding` changes the model of a resumable session. */
function launchModelWillChange(
  groupFolder: string,
  agentId: string | null | undefined,
  binding: ModelBinding & { provider: UnifiedProvider },
): boolean {
  const { provider } = binding;
  const launch = resolveModelLaunch(binding, groupFolder, agentId, undefined, {
    warn: false,
  });
  if (!provider.codexOAuthCredentials) {
    return sessionModelHasChanged(
      groupFolder,
      agentId,
      launch.model ?? provider.anthropicModel,
      provider.anthropicModel,
    );
  }
  return sessionModelHasChanged(
    groupFolder,
    agentId,
    chatGptLaunchModel(launch.model, provider),
    chatGptDefaultModel(provider),
  );
}

/**
 * The connections the next launch of this session may use, among those
 * holding Claude OAuth credentials.
 */
export function launchOAuthRefreshCandidates(
  groupFolder: string,
  agentId?: string | null,
  modelConfigId?: string | null,
): string[] {
  const { provider } = resolveModelBinding(
    { modelConfigId },
    { groupFolder, agentId },
  );
  return provider?.claudeOAuthCredentials ? [provider.id] : [];
}

/**
 * When the access token is this close to expiry, a launch waits for the
 * host refresh however long it takes (bounded by its own timeout):
 * otherwise the runner's Claude Code would refresh the same token itself.
 */
const LAUNCH_REFRESH_BLOCKING_WINDOW_MS = 10 * 60_000;
/** Otherwise a launch waits at most this long; the refresh keeps going. */
const LAUNCH_REFRESH_WAIT_MS = 5_000;

/**
 * Renew the OAuth credentials a launch may use before the provider is
 * selected, so the runner starts from host-refreshed credentials and the
 * selection-to-spawn path stays synchronous. Never throws: a failed renewal
 * leaves the stored credential, which Claude Code can still refresh.
 */
export async function refreshLaunchOAuthCredentials(
  groupFolder: string,
  agentId?: string | null,
  modelConfigId?: string | null,
  refresh: (
    providerId: string,
  ) => Promise<ClaudeOAuthRefreshOutcome> = refreshClaudeProviderOAuth,
): Promise<void> {
  let candidates: string[];
  try {
    candidates = launchOAuthRefreshCandidates(
      groupFolder,
      agentId,
      modelConfigId,
    );
  } catch {
    // Selection reports configuration errors with full context.
    return;
  }
  const now = Date.now();
  await Promise.all(
    candidates.map(async (providerId) => {
      const credentials = getProviders().find(
        (provider) => provider.id === providerId,
      )?.claudeOAuthCredentials;
      if (
        !credentials ||
        !isClaudeOAuthRefreshDue(providerId, credentials, now)
      ) {
        return;
      }
      const refreshing = refresh(providerId).then(
        (outcome) => {
          if (outcome.status === 'failed' || outcome.status === 'backoff') {
            logger.warn(
              { groupFolder, providerId, outcome },
              'Launch-time Claude OAuth refresh did not complete',
            );
          }
        },
        (err) => {
          logger.warn(
            { err, groupFolder, providerId },
            'Launch-time Claude OAuth refresh failed',
          );
        },
      );
      if (credentials.expiresAt - now <= LAUNCH_REFRESH_BLOCKING_WINDOW_MS) {
        await refreshing;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        refreshing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, LAUNCH_REFRESH_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }),
  );
}

/**
 * Pick the connection, model and effort for a launch (resolveModelBinding),
 * or null when none applies (the Workspace's own environment, or nothing
 * configured). Records the connection and model on the Session so a later
 * launch can tell that either changed: a Claude SDK session is bound to one
 * account, and a ChatGPT session's encrypted reasoning to one model, so a
 * change starts a new session (resetSession) that is seeded with history.
 */
export function trySelectPoolProvider(
  groupFolder: string,
  agentId?: string | null,
  modelConfigId?: string | null,
  agentModel?: string | null,
  agentEffort?: SdkAgentEffort,
): PoolProviderSelection | null {
  const binding = resolveModelBinding(
    { modelConfigId, model: agentModel },
    { groupFolder, agentId },
  );
  const error = modelBindingError(binding);
  if (error) throw new Error(error);
  const { provider } = binding;
  if (!provider) return null;
  const existingBoundId = getSessionProviderId(groupFolder, agentId);
  const resolved = resolveProviderById(provider.id);
  setSessionProviderId(groupFolder, agentId, provider.id);
  // Only the main model is replaced: the tiers, the sub-agent model and the
  // compaction window follow it when the environment is built.
  const launch = resolveModelLaunch(
    { ...binding, provider },
    groupFolder,
    agentId,
    agentEffort,
  );
  const fallbackModel = fallbackLaunchModel(
    getSystemSettings().fallbackModel,
    provider,
  );
  return withSessionModel(
    {
      profileId: provider.id,
      resolved: {
        config: launch.model
          ? { ...resolved.config, anthropicModel: launch.model }
          : resolved.config,
        customEnv: resolved.customEnv,
        ...(launch.effort ? { launchEffort: launch.effort } : {}),
        ...(fallbackModel ? { fallbackModel } : {}),
      },
      previousProviderId: existingBoundId,
      resetSession: !!existingBoundId && existingBoundId !== provider.id,
      ...(launch.model ? { chosenModel: launch.model } : {}),
      ...(launch.sessionEffort ? { sessionEffort: launch.sessionEffort } : {}),
      ...(launch.gatewayAgentEffort
        ? { gatewayAgentEffort: launch.gatewayAgentEffort }
        : {}),
      ...(provider.codexOAuthCredentials
        ? {}
        : { launchEffort: launch.effort }),
    },
    groupFolder,
    agentId,
  );
}

export interface PoolProviderSelection {
  profileId: string;
  resolved: ResolvedProvider;
  previousProviderId?: string;
  resetSession?: boolean;
  /**
   * The model the conversation's pick or the supplying profile chose within
   * the connection, run instead of the connection's own.
   */
  chosenModel?: string;
  /**
   * The model the Session's SDK session runs on, recorded so that a later
   * launch can tell the model changed. Empty for a pass-through relay that
   * names no model.
   */
  sessionModel?: string;
  /** ChatGPT: the conversation's effort, minted into the gateway grant. */
  sessionEffort?: string;
  /** ChatGPT: the Agent-level effort the gateway applies without a pick. */
  gatewayAgentEffort?: string;
  /** ContainerInput.launchEffort for this launch; absent on ChatGPT. */
  launchEffort?: string | null;
}

/**
 * A launch that runs without a connection (the Workspace's own environment)
 * on a Session whose SDK session ran on one: that session belongs to another
 * account, so it starts over, seeded with history, and the binding is
 * dropped so the switch happens once.
 */
export function leaveSessionConnection(
  groupFolder: string,
  agentId: string | null | undefined,
): {
  profileId: string;
  previousProviderId: string;
  resetSession: true;
} | null {
  const boundId = getSessionProviderId(groupFolder, agentId);
  if (!boundId) return null;
  setSessionProviderId(groupFolder, agentId, null);
  return { profileId: '', previousProviderId: boundId, resetSession: true };
}

/** The input a launch starts with: a connection switch, its effort. */
export function prepareLaunchInput(
  input: ContainerInput,
  selection: PoolProviderSelection | null,
  sessionAgentId: string | undefined,
): ContainerInput {
  const switched = applyProviderSwitchToInput(
    input,
    selection ?? leaveSessionConnection(input.groupFolder, sessionAgentId),
    sessionAgentId,
  );
  return selection?.launchEffort !== undefined
    ? { ...switched, launchEffort: selection.launchEffort }
    : switched;
}

/**
 * Record the model this launch runs on and flag the reset when it differs
 * from the recorded one. Only the upstream model counts: `[1m]` (a window)
 * is not a model change.
 */
function withSessionModel(
  selection: PoolProviderSelection,
  groupFolder: string,
  agentId: string | null | undefined,
): PoolProviderSelection {
  const { config } = selection.resolved;
  const provider = getProviders().find(
    (item) => item.id === selection.profileId,
  );
  if (!provider) return selection;
  const chatGpt = isCodexGatewayBaseUrl(config.anthropicBaseUrl);
  const sessionModel = chatGpt
    ? chatGptLaunchModel(config.anthropicModel, provider)
    : (selection.chosenModel ?? provider.anthropicModel);
  const modelChanged =
    !selection.resetSession &&
    sessionModelHasChanged(
      groupFolder,
      agentId,
      sessionModel,
      chatGpt ? chatGptDefaultModel(provider) : provider.anthropicModel,
    );
  if (modelChanged) {
    logger.info(
      { groupFolder, agentId: agentId || null, providerId: provider.id },
      'Conversation model changed; starting a new session',
    );
  }
  setSessionModel(groupFolder, agentId, sessionModel);
  return {
    ...selection,
    sessionModel,
    ...(modelChanged ? { resetSession: true } : {}),
  };
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

/**
 * The name the runner's same-turn fallback model is handed under: like the
 * turn's model, with `[1m]` when the connection gives it a window above
 * Claude Code's default. On an official connection only a declared window
 * counts (`[1m]` there is the billed 1M opt-in); ChatGPT maps names itself.
 */
export function fallbackLaunchModel(
  fallbackModel: string | null | undefined,
  provider: UnifiedProvider | null | undefined,
): string | undefined {
  const model = fallbackModel?.trim();
  if (!model) return undefined;
  if (!provider || provider.codexOAuthCredentials) return model;
  const models = effectiveProviderModels(provider);
  return launchModelName(
    model,
    provider.anthropicBaseUrl
      ? windowOf(models, model)
      : findModelEntry(models, model)?.contextWindow,
  );
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

function assertRuntimeEnvPathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`Invalid ${label} for container environment isolation`);
  }
  return value;
}

/**
 * Keep generated env files isolated by both runtime and Feishu Bot identity.
 *
 * The main session and conversation agents can execute concurrently inside
 * one workspace. A bound channel account is also included so two Bots routed to
 * the same main workspace can never overwrite each other's credentials.
 */
export function getContainerRuntimeEnvDir(
  groupFolder: string,
  ipcAgentId?: string,
  feishuChannelAccountId?: string | null,
): string {
  const safeGroupFolder = assertValidWorkspaceFolderName(
    groupFolder,
    'group folder',
  );
  const identityPath = feishuChannelAccountId
    ? [
        'channel-accounts',
        assertRuntimeEnvPathSegment(
          feishuChannelAccountId,
          'Feishu channel account id',
        ),
      ]
    : ['default'];
  const runtimePath = ipcAgentId
    ? ['agents', assertRuntimeEnvPathSegment(ipcAgentId, 'agent id')]
    : ['main'];
  return path.join(
    DATA_DIR,
    'env',
    safeGroupFolder,
    ...identityPath,
    ...runtimePath,
  );
}

export interface OAuthLaunchSnapshot {
  credentialsFilePath: string;
  launchCredentials: ClaudeOAuthCredentials;
}

interface PreparedVolumeMounts {
  mounts: VolumeMount[];
  claudeContextPlan: ReturnType<typeof buildClaudeContextPlan>;
  runtimeMcpServers: Record<string, Record<string, unknown>>;
  hostPlugins: SdkPluginConfig[];
  dockerOauthLaunch: OAuthLaunchSnapshot | null;
  /** Selected provider routes through the ChatGPT/Codex 订阅网关; docker run needs host.docker.internal. */
  usesCodexGateway: boolean;
  /** Selected provider endpoint was rewritten from host loopback to host.docker.internal. */
  providerNeedsHostGateway: boolean;
}

function prepareVolumeMounts(
  group: RegisteredGroup,
  isAdminHome: boolean,
  mountUserSkills = true,
  sessionAgentId?: string,
  ownerHomeFolder?: string,
  resolvedProvider?: ResolvedProvider,
  ipcAgentId?: string,
  agentProfile?: RunnerAgentProfile,
  channelContext?: ChannelTurnContext,
  containerProxy: ResolvedContainerProxyConfig = {
    envLines: [],
    addHostGateway: false,
  },
  /** Mints this runner's Codex gateway token; revoked when the runner exits. */
  codexGatewayLease?: CodexGatewayRunnerLease,
): PreparedVolumeMounts {
  if (group.containerConfigError) {
    throw new AdditionalMountValidationError([
      `Persisted container configuration is invalid: ${group.containerConfigError}`,
    ]);
  }
  const parsedContainerConfig = parseContainerConfig(group.containerConfig);
  if (parsedContainerConfig.error) {
    throw new AdditionalMountValidationError([parsedContainerConfig.error]);
  }
  const configuredAdditionalMounts =
    parsedContainerConfig.config?.additionalMounts;
  if (configuredAdditionalMounts && configuredAdditionalMounts.length > 0) {
    let currentOwner;
    try {
      currentOwner = group.created_by
        ? getUserById(group.created_by)
        : undefined;
    } catch {
      currentOwner = undefined;
    }
    if (!canExecuteOnHost(currentOwner)) {
      throw new Error(
        'Host directory mounts require a currently active administrator owner',
      );
    }
  }

  const mounts: VolumeMount[] = [];
  let feishuCliBinding: FeishuCliRuntimeBinding | null = null;
  let dockerOauthLaunch: PreparedVolumeMounts['dockerOauthLaunch'] = null;
  const projectRoot = process.cwd();
  const ownerId = group.created_by;

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
  const runtimeMcpServers = resolveRuntimeMcpServers(group, agentProfile);
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
  ensureSettingsJson(settingsFile, runtimeMcpServers, {
    // The session settings file is HappyClaw-owned. Always replace this map
    // with the resolved layers so removed/unselected managed MCP cannot
    // survive from a previous Agent run.
    replaceMcpServers: true,
    baseSettings: loadHostClaudeSettings(claudeContextPlan),
  });

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
  // Workspace skills dir sits inside the RW /workspace/group bind and
  // scanSkillDirectory accepts symlinks intentionally for host/user layers, so
  // confine workspace skills to the group's real .claude/skills root (not
  // realpath(skillsDir), which would follow a planted symlink).
  let groupReal: string | null = null;
  try {
    groupReal = fs.realpathSync(path.join(GROUPS_DIR, group.folder));
  } catch {
    groupReal = null;
  }
  const workspaceSkillsRoot = groupReal
    ? path.join(groupReal, '.claude', 'skills')
    : null;
  for (const skill of claudeContextPlan.effectiveSkills.selected) {
    if (skill.source === 'plugin') continue;
    let hostPath = skill.path;
    let realpathOk = true;
    try {
      hostPath = fs.realpathSync(hostPath);
    } catch {
      // The resolver already validated SKILL.md. Keep the original path so
      // Docker reports a deterministic mount error if it vanished afterward.
      realpathOk = false;
    }
    if (skill.source === 'workspace') {
      const rel = workspaceSkillsRoot
        ? path.relative(workspaceSkillsRoot, hostPath)
        : '';
      if (
        !realpathOk ||
        !workspaceSkillsRoot ||
        rel === '' ||
        rel === '..' ||
        rel.startsWith('..' + path.sep) ||
        path.isAbsolute(rel)
      ) {
        logger.warn(
          {
            group: group.folder,
            skillId: skill.id,
            skillPath: skill.path,
            resolvedPath: hostPath,
          },
          'Skipping workspace skill outside workspace skills root',
        );
        continue;
      }
    }
    mounts.push({
      hostPath,
      containerPath: `/workspace/effective-skills/${skill.id}`,
      readonly: true,
    });
  }

  // Per-user native feishu-cli state (profiles, token.json, config.yaml).
  // Without this mount, every container restart loses the user's feishu OAuth
  // authorization, forcing re-auth every IDLE_TIMEOUT (#477). HappyClaw never
  // creates or switches profiles here: the CLI keeps ownership of its native
  // config, while a bound Bot's App credentials are overlaid via env below.
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
    feishuCliBinding = resolveFeishuCliRuntimeBinding({
      ownerUserId: ownerId,
      channelContext,
      workspaceChannelAccountId: group.channel_account_id,
    });
  } else {
    feishuCliBinding = resolveFeishuCliRuntimeBinding({
      ownerUserId: ownerId,
      channelContext,
      workspaceChannelAccountId: group.channel_account_id,
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
  // Keep host IPC roots owner-only; the entrypoint applies the selected bridge.
  const groupIpcDir = ipcAgentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', ipcAgentId)
    : path.join(DATA_DIR, 'ipc', group.folder);
  mkdirForContainer(groupIpcDir);
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  for (const sub of ['messages', 'tasks', 'input', 'agents'] as const) {
    const subDir = path.join(groupIpcDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    try {
      fs.chmodSync(subDir, 0o700);
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
  const envDir = getContainerRuntimeEnvDir(
    group.folder,
    ipcAgentId,
    feishuCliBinding?.source === 'channel_account'
      ? feishuCliBinding.accountId
      : null,
  );
  fs.mkdirSync(envDir, { recursive: true });
  const rawGlobalConfig = resolvedProvider?.config ?? getClaudeProviderConfig();
  const codexLaunchConfig = resolveCodexGatewayLaunchConfig(
    rawGlobalConfig,
    'container',
    codexGatewayLease,
  );
  // The gateway already resolves to host.docker.internal; this only rewrites
  // a third-party relay configured on the host's loopback.
  const containerBaseUrl = resolveContainerProviderBaseUrl(
    codexLaunchConfig.anthropicBaseUrl,
  );
  const globalConfig = {
    ...codexLaunchConfig,
    anthropicBaseUrl: containerBaseUrl.baseUrl,
  };
  const usesCodexGateway = isCodexGatewayBaseUrl(
    rawGlobalConfig.anthropicBaseUrl,
  );
  const providerNeedsHostGateway = containerBaseUrl.addHostGateway;
  const providerRoutedToHost =
    containerBaseUrl.baseUrl !== codexLaunchConfig.anthropicBaseUrl;
  const containerOverride = getContainerEnvConfig(group.folder);
  const effectiveContainerOverride = resolvedProvider
    ? { customEnv: containerOverride.customEnv }
    : containerOverride;
  const envLines = buildContainerEnvLines(
    globalConfig,
    effectiveContainerOverride,
    resolvedProvider?.customEnv,
  );
  applyLaunchEffortEnv(
    envLines,
    resolveAgentSdkEffort(agentProfile?.runtimePolicy),
    resolvedProvider ? (resolvedProvider.launchEffort ?? null) : undefined,
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
  applyFallbackModelToEnvLines(
    envLines,
    resolvedProvider?.fallbackModel ?? getSystemSettings().fallbackModel,
  );
  applyFeishuCliBindingToEnvLines(envLines, feishuCliBinding);
  applyContainerProxyEnvLines(envLines, containerProxy.envLines);
  // Both the gateway and a rewritten loopback relay live on
  // host.docker.internal, which a forwarded host proxy cannot resolve.
  if (usesCodexGateway || providerRoutedToHost) {
    applyCodexGatewayNoProxyToEnvLines(envLines);
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
  const clearSessionOAuth =
    !!mergedConfig.anthropicBaseUrl ||
    hasExplicitWorkspaceClaudeAuth(containerOverride);
  if (clearSessionOAuth) {
    // An explicit workspace key/token is authoritative even when the endpoint
    // remains Anthropic's official URL. A prior OAuth session must not win.
    clearSessionClaudeOAuthFiles(groupSessionsDir);
  }
  if (mergedConfig.claudeOAuthCredentials) {
    try {
      writeCredentialsFile(groupSessionsDir, mergedConfig);
      const launchCredentials = buildClaudeAiOauthPayload(mergedConfig);
      if (launchCredentials) {
        dockerOauthLaunch = {
          credentialsFilePath: path.join(groupSessionsDir, '.credentials.json'),
          launchCredentials,
        };
      }
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to write .credentials.json',
      );
    }
  }

  if (resolveAgentRunnerMode() === 'development') {
    // Explicit hot-reload mode compiles the checked-out source at startup.
    mounts.push({
      hostPath: path.join(projectRoot, 'container', 'agent-runner', 'src'),
      containerPath: '/app/src',
      readonly: true,
    });
    mounts.push({
      hostPath: path.join(projectRoot, 'container', 'agent-runner', 'prompts'),
      containerPath: '/app/prompts',
      readonly: true,
    });
  }

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
  if (configuredAdditionalMounts && configuredAdditionalMounts.length > 0) {
    const validatedMounts = validateAdditionalMounts(
      configuredAdditionalMounts,
      group.name,
      group.is_home === true,
    );
    mounts.push(...validatedMounts);
  }

  return {
    mounts,
    claudeContextPlan,
    runtimeMcpServers,
    hostPlugins: pluginSkills,
    dockerOauthLaunch,
    usesCodexGateway,
    providerNeedsHostGateway,
  };
}

export function buildVolumeMounts(
  ...args: Parameters<typeof prepareVolumeMounts>
): VolumeMount[] {
  return prepareVolumeMounts(...args).mounts;
}

export type ContainerHostIdentityMode =
  | 'direct'
  | 'rootless'
  | 'userns'
  | 'virtualized'
  | 'host-root'
  | 'unknown';

export interface ContainerHostIdentity {
  mode: ContainerHostIdentityMode;
  uid?: number;
  gid?: number;
}

export interface ContainerHostIdentityProbe {
  platform: NodeJS.Platform;
  uid?: number;
  gid?: number;
  securityOptions: readonly string[] | null;
}

function isPositiveUnixId(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0;
}

/**
 * Decide whether container ids share the host's numeric id namespace.
 *
 * Numeric remapping is safe only for a rootful Linux daemon without userns.
 * Rootless Docker/Podman and userns-remap deliberately translate ids, while
 * Docker Desktop virtualizes bind-mount ownership. Unknown probes fail closed
 * to the entrypoint's permission reconciler instead of guessing.
 */
export function resolveContainerHostIdentity(
  probe: ContainerHostIdentityProbe,
): ContainerHostIdentity {
  if (probe.platform === 'darwin' || probe.platform === 'win32') {
    return { mode: 'virtualized' };
  }
  if (probe.platform !== 'linux') return { mode: 'unknown' };

  if (probe.securityOptions === null) return { mode: 'unknown' };

  const normalizedSecurityOptions = probe.securityOptions.map((option) =>
    option.toLowerCase(),
  );
  if (normalizedSecurityOptions.some((option) => option.includes('rootless'))) {
    return { mode: 'rootless' };
  }
  if (normalizedSecurityOptions.some((option) => option.includes('userns'))) {
    return { mode: 'userns' };
  }

  if (probe.uid === 0) return { mode: 'host-root' };
  if (!isPositiveUnixId(probe.uid)) return { mode: 'unknown' };

  return {
    mode: 'direct',
    uid: probe.uid,
    ...(isPositiveUnixId(probe.gid) ? { gid: probe.gid } : {}),
  };
}

const SECURITY_OPTIONS_PROBE_ARGS = [
  'info',
  '--format',
  '{{json .SecurityOptions}}',
];
const SECURITY_OPTIONS_PROBE_TIMEOUT_MS = 3_000;

function parseSecurityOptions(raw: string): readonly string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (
      Array.isArray(parsed) &&
      parsed.every((option) => typeof option === 'string')
    ) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function probeContainerSecurityOptions(): readonly string[] | null {
  try {
    return parseSecurityOptions(
      execFileSync('docker', SECURITY_OPTIONS_PROBE_ARGS, {
        encoding: 'utf8',
        timeout: SECURITY_OPTIONS_PROBE_TIMEOUT_MS,
      }),
    );
  } catch {
    // A missing/unsupported probe must not enable numeric id remapping.
    return null;
  }
}

/**
 * The same probe without holding the event loop for the docker CLI round
 * trip (55-80 ms measured on Linux) on every launch.
 */
export function probeContainerSecurityOptionsAsync(): Promise<
  readonly string[] | null
> {
  return new Promise((resolve) => {
    try {
      execFile(
        'docker',
        SECURITY_OPTIONS_PROBE_ARGS,
        { encoding: 'utf8', timeout: SECURITY_OPTIONS_PROBE_TIMEOUT_MS },
        (err, stdout) => {
          // A missing/unsupported probe must not enable numeric id remapping.
          resolve(err ? null : parseSecurityOptions(stdout));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/** Only a Linux daemon's security options affect the identity decision. */
function securityOptionsMatter(): boolean {
  return process.platform === 'linux';
}

export function detectContainerHostIdentity(
  readSecurityOptions: () =>
    | readonly string[]
    | null = probeContainerSecurityOptions,
): ContainerHostIdentity {
  // Probe every launch. Docker context/daemon security options can change
  // while HappyClaw is running; reusing an earlier direct result could bypass
  // rootless/userns fail-closed handling, while caching unknown blocks recovery.
  const securityOptions = securityOptionsMatter()
    ? readSecurityOptions()
    : null;
  return resolveContainerHostIdentity({
    platform: process.platform,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    securityOptions,
  });
}

/** detectContainerHostIdentity() for launches: still probed every time. */
export async function detectContainerHostIdentityAsync(
  readSecurityOptions: () => Promise<
    readonly string[] | null
  > = probeContainerSecurityOptionsAsync,
): Promise<ContainerHostIdentity> {
  let securityOptions: readonly string[] | null = null;
  if (securityOptionsMatter()) {
    try {
      securityOptions = await readSecurityOptions();
    } catch {
      securityOptions = null;
    }
  }
  return resolveContainerHostIdentity({
    platform: process.platform,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    securityOptions,
  });
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * A provider endpoint on the host's loopback (a local relay such as
 * CLIProxyAPI) is unreachable from inside a bridge container. Route it through
 * host.docker.internal, as the proxy settings do; on Linux that name needs the
 * host-gateway mapping and the relay must listen on an address the Docker
 * bridge reaches.
 */
export function resolveContainerProviderBaseUrl(
  baseUrl: string,
  platform: NodeJS.Platform = process.platform,
): { baseUrl: string; addHostGateway: boolean } {
  if (!baseUrl) return { baseUrl, addHostGateway: false };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { baseUrl, addHostGateway: false };
  }
  if (!LOOPBACK_HOSTNAMES.has(normalizedProxyHostname(parsed))) {
    return { baseUrl, addHostGateway: false };
  }
  parsed.hostname = 'host.docker.internal';
  return {
    // URL serialization adds a trailing slash to a bare origin; keep the
    // admin's path shape so the SDK joins `/v1/messages` the same way.
    baseUrl: baseUrl.endsWith('/')
      ? parsed.toString()
      : parsed.toString().replace(/\/$/, ''),
    addHostGateway: platform === 'linux',
  };
}

export interface ResolvedContainerProxyConfig {
  /** Shell env assignments written to the per-container 0600 runtime file. */
  envLines: string[];
  /** Non-sensitive Docker networking option; proxy URLs never enter argv. */
  addHostGateway: boolean;
}

export interface ContainerNetworkConfig {
  addHostGateway: boolean;
}

function defaultContainerProxyConfig(): ContainerProxyConfig {
  return {
    httpsProxy: CONTAINER_HTTPS_PROXY,
    httpProxy: CONTAINER_HTTP_PROXY,
    noProxy: CONTAINER_NO_PROXY,
  };
}

function parseContainerProxyUrl(name: string, value: string): URL {
  try {
    const parsed = new URL(value);
    if (parsed.hostname) return parsed;
  } catch {
    // Use the deterministic error below without echoing credentials.
  }
  throw new Error(
    `${name} must be an absolute proxy URL (for example, http://proxy.example:8080)`,
  );
}

function normalizedProxyHostname(parsed: URL): string {
  return parsed.hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

export function resolveContainerProxyConfig(
  proxyConfig: ContainerProxyConfig = defaultContainerProxyConfig(),
  platform: NodeJS.Platform = process.platform,
): ResolvedContainerProxyConfig {
  const envLines: string[] = [];
  let addHostGateway = false;
  const supportsDesktopHost = platform === 'darwin' || platform === 'win32';

  for (const [name, value] of [
    ['HTTPS_PROXY', proxyConfig.httpsProxy],
    ['HTTP_PROXY', proxyConfig.httpProxy],
  ] as const) {
    if (!value) continue;
    const parsed = parseContainerProxyUrl(name, value);
    const hostname = normalizedProxyHostname(parsed);
    let containerValue = value;

    if (LOOPBACK_HOSTNAMES.has(hostname)) {
      if (!supportsDesktopHost) {
        throw new Error(
          `${name} points to host loopback (${hostname}), which Linux bridge containers cannot reach. Bind the proxy to an interface reachable from the Docker bridge and configure that address instead.`,
        );
      }
      parsed.hostname = 'host.docker.internal';
      containerValue = parsed.toString();
    } else if (platform === 'linux' && hostname === 'host.docker.internal') {
      addHostGateway = true;
    }

    envLines.push(`${name}=${containerValue}`);
  }

  if (proxyConfig.noProxy) {
    envLines.push(`NO_PROXY=${proxyConfig.noProxy}`);
  }

  return { envLines, addHostGateway };
}

/** Apply proxy assignments last so host proxy configuration is authoritative. */
export function applyContainerProxyEnvLines(
  envLines: string[],
  proxyEnvLines: readonly string[],
): void {
  for (const proxyLine of proxyEnvLines) {
    const separator = proxyLine.indexOf('=');
    if (separator <= 0) continue;
    const key = proxyLine.slice(0, separator);
    const lowerKey = key.toLowerCase();
    for (let index = envLines.length - 1; index >= 0; index -= 1) {
      const existingLine = envLines[index] ?? '';
      const existingSeparator = existingLine.indexOf('=');
      const existingKey =
        existingSeparator > 0
          ? existingLine.slice(0, existingSeparator)
          : existingLine;
      if (existingKey?.toLowerCase() === lowerKey) envLines.splice(index, 1);
    }
    envLines.push(proxyLine);
  }
}

/** Keep the local gateway hop out of any proxy configured for the runner. */
function applyCodexGatewayNoProxyToEnvLines(envLines: string[]): void {
  const env: Record<string, string | undefined> = {};
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const index = envLines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) {
      env[key] = envLines[index].slice(key.length + 1);
      envLines.splice(index, 1);
    }
  }
  applyCodexGatewayNoProxy(env, 'container');
  envLines.push(`NO_PROXY=${env.NO_PROXY}`, `no_proxy=${env.no_proxy}`);
}

export function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  tz: string,
  hostIdentity: ContainerHostIdentity = detectContainerHostIdentity(),
  networkConfig: ContainerNetworkConfig = { addHostGateway: false },
  containerImage = CONTAINER_IMAGE,
  memoryLimit = CONTAINER_MEMORY_LIMIT,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  // Hardening from the Agent SDK secure-deployment guidance that this image
  // tolerates: the entrypoint drops root with runuser and Chromium runs with
  // --no-sandbox, so nothing needs a setuid privilege gain; the pids limit
  // only stops runaway forks and stays far above browser and build loads.
  args.push('--security-opt', 'no-new-privileges', '--pids-limit', '4096');
  // Opt-in cap so one runaway agent cannot exhaust a shared Docker VM.
  if (memoryLimit) {
    args.push('--memory', memoryLimit, '--memory-swap', memoryLimit);
  }

  // Set timezone so container Node.js processes use local time (Asia/Shanghai)
  args.push('-e', `TZ=${tz}`);
  args.push('-e', `HAPPYCLAW_AGENT_RUNNER_MODE=${resolveAgentRunnerMode()}`);
  args.push('-e', `HAPPYCLAW_HOST_IDENTITY_MODE=${hostIdentity.mode}`);
  if (hostIdentity.mode === 'direct') {
    if (isPositiveUnixId(hostIdentity.uid)) {
      args.push('-e', `HAPPYCLAW_HOST_UID=${hostIdentity.uid}`);
    }
    if (isPositiveUnixId(hostIdentity.gid)) {
      args.push('-e', `HAPPYCLAW_HOST_GID=${hostIdentity.gid}`);
    }
  }

  // Proxy URLs are sourced from the mounted 0600 runtime env file. Only this
  // non-sensitive name-resolution option is allowed into docker argv/logs.
  if (networkConfig.addHostGateway) {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(containerImage);

  return args;
}

/**
 * Reconcile a runner's own credential rotation at a safe output/exit
 * boundary: Docker runners, and host runners wherever Claude Code keeps its
 * credentials in the session `.credentials.json` (everywhere but macOS, where
 * the Keychain reconciliation owns it). The lower-level helper performs the
 * launch-snapshot CAS (newer expiry wins); on success, fan the adopted
 * credential out to other persisted sessions so the next runner does not start
 * from an invalidated refresh token.
 */
export function reconcileSessionOAuthAfterExit(
  providerId: string | null,
  launch: OAuthLaunchSnapshot | null,
  dependencies: {
    reconcile?: typeof reconcileDockerOAuthCredentials;
    fanOutUpdatedCredentials?: (providerId: string) => void;
  } = {},
): DockerOAuthReconcileOutcome | 'error' | null {
  if (!providerId || !launch) return null;
  try {
    const outcome = (dependencies.reconcile ?? reconcileDockerOAuthCredentials)(
      {
        providerId,
        credentialsFilePath: launch.credentialsFilePath,
        launchCredentials: launch.launchCredentials,
      },
    );
    if (outcome === 'updated') {
      const adopted = readDockerClaudeOAuthCredentials(
        launch.credentialsFilePath,
      );
      if (adopted) launch.launchCredentials = adopted;
      const fanOut =
        dependencies.fanOutUpdatedCredentials ??
        ((updatedProviderId: string) => {
          const provider = getProviders().find(
            (candidate) => candidate.id === updatedProviderId,
          );
          if (provider) {
            updateProviderSessionCredentials(
              updatedProviderId,
              providerToConfig(provider),
            );
          }
        });
      fanOut(providerId);
    } else if (outcome === 'stale') {
      // A sibling Runner may already have adopted this exact rotation and
      // fanned it into our mounted file. Advance this warm Runner's CAS base
      // only when disk and current Provider agree; an administrator change or
      // unrelated account can never be treated as our credential lineage.
      const diskCredentials = readDockerClaudeOAuthCredentials(
        launch.credentialsFilePath,
      );
      const currentProvider = getProviders().find(
        (candidate) => candidate.id === providerId,
      );
      const currentCredentials = currentProvider
        ? buildClaudeAiOauthPayload(providerToConfig(currentProvider))
        : null;
      if (
        diskCredentials &&
        currentCredentials &&
        dockerOAuthCredentialsEqual(diskCredentials, currentCredentials)
      ) {
        launch.launchCredentials = diskCredentials;
      }
    }
    return outcome;
  } catch {
    // Credential reconciliation is post-run best effort. It must never escape
    // the EventEmitter close callback or prevent the completed turn settling.
    return 'error';
  }
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
  // Worktrees are host checkouts; a container would run this session in the
  // shared workspace directory instead, so refuse rather than substitute.
  const sessionWorktree = getSessionWorktree(input.agentId);
  if (sessionWorktree) {
    const message = `会话使用独立 worktree（分支 ${sessionWorktree.branch}），只能在宿主机模式运行，本次运行已停止。`;
    return { status: 'error', result: message, error: message };
  }

  // Probed per launch as before, but asynchronously and ahead of provider
  // selection, so everything from selection to spawn stays one synchronous
  // step while the docker CLI round trip no longer blocks the event loop.
  const hostIdentity = await detectContainerHostIdentityAsync();
  const sessionAgentId = input.sessionAgentId ?? input.agentId;

  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);
  // Like the probe above, the host-owned OAuth renewal awaits ahead of the
  // synchronous selection-to-spawn block.
  await refreshLaunchOAuthCredentials(
    group.folder,
    sessionAgentId,
    input.agentProfile?.modelConfigId,
  );

  // ─── Model connection selection ───
  const poolResult = trySelectPoolProvider(
    group.folder,
    sessionAgentId,
    input.agentProfile?.modelConfigId,
    input.agentProfile?.model,
    resolveAgentSdkEffort(input.agentProfile?.runtimePolicy),
  );
  const selectedProfileId = poolResult?.profileId ?? null;
  const selectedProviderQuotaEpoch = selectedProfileId
    ? captureProviderQuotaObservationEpoch(selectedProfileId)
    : null;
  const resolvedProvider = poolResult?.resolved;
  let providerFailureReported = false;
  let providerFailureTerminal: boolean | undefined;
  /** The streamed failure the disposition was decided on, if it waits. */
  let providerFailureDecision: ContainerOutput | undefined;
  let providerFailureMaintenance = false;
  let healthyInputTurnCompleted = false;
  input = prepareLaunchInput(input, poolResult, sessionAgentId);

  const workspaceMemoryCapabilityScope: WorkspaceMemoryCapabilityScope = {
    groupFolder: group.folder,
    agentId: input.agentId ?? null,
  };
  const {
    runnerInstanceId: workspaceMemoryRunnerInstanceId,
    signingSecret: workspaceMemoryMutationSigningSecret,
  } = issueWorkspaceMemoryWriteCapability(
    workspaceMemoryCapabilityScope,
    input.turnId,
  );
  const codexGatewayLease = new CodexGatewayRunnerLease({
    kind: 'container',
    groupFolder: group.folder,
    agentId: input.agentId ?? null,
    sessionAgentId: sessionAgentId ?? null,
    agentEffort:
      poolResult?.gatewayAgentEffort ??
      resolveAgentSdkEffort(input.agentProfile?.runtimePolicy),
    sessionEffort: poolResult?.sessionEffort,
  });
  try {
    const isAdminHome = !!input.isAdminHome;
    // Per-user skills: always mount if the group has an owner
    const shouldMountUserSkills = !!group.created_by;
    // Resolve before creating mounts or spawning Docker so Linux loopback
    // configurations fail fast with an actionable error.
    const containerProxy = resolveContainerProxyConfig();
    const preparedLaunch = prepareVolumeMounts(
      group,
      isAdminHome,
      shouldMountUserSkills,
      sessionAgentId,
      ownerHomeFolder,
      resolvedProvider,
      input.agentId,
      input.agentProfile,
      input.channelContext,
      containerProxy,
      codexGatewayLease,
    );
    const mounts = preparedLaunch.mounts;
    const dockerPlugins = group.created_by
      ? loadUserPlugins(group.created_by, { runtime: 'docker' })
      : [];
    const pluginMcpServers =
      getAgentProfileMcpPolicyMode(input.agentProfile) === 'inherit'
        ? loadPluginMcpDefinitions(preparedLaunch.hostPlugins)
        : {};
    const effectiveMcpServers = {
      ...preparedLaunch.runtimeMcpServers,
      ...pluginMcpServers,
    };
    const mcpManifest = buildEffectiveMcpManifest(effectiveMcpServers);
    const requiresHeadroom =
      runtimeMcpServersRequireHeadroom(effectiveMcpServers);
    if (requiresHeadroom && !CONTAINER_IMAGE_HEADROOM) {
      throw new Error(
        'Headroom MCP requires CONTAINER_IMAGE_HEADROOM when the core image is pinned by digest',
      );
    }
    const containerImage = requiresHeadroom
      ? CONTAINER_IMAGE_HEADROOM
      : CONTAINER_IMAGE;
    const contextAudit = {
      ...preparedLaunch.claudeContextPlan.audit,
      mcp: {
        manifestHash: mcpManifest.hash,
        serverIds: mcpManifest.serverIds,
      },
    };
    const skillManifest = preparedLaunch.claudeContextPlan.effectiveSkills;
    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const agentSuffix = sessionAgentId
      ? `-${sessionAgentId.replace(/[^a-zA-Z0-9-]/g, '-')}`
      : '';
    const containerName = `happyclaw-${safeName}${agentSuffix}-${Date.now()}`;
    const containerArgs = buildContainerArgs(
      mounts,
      containerName,
      TIMEZONE,
      hostIdentity,
      {
        addHostGateway:
          containerProxy.addHostGateway ||
          preparedLaunch.usesCodexGateway ||
          preparedLaunch.providerNeedsHostGateway,
      },
      containerImage,
    );

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
        imageProfile:
          containerImage === CONTAINER_IMAGE_HEADROOM ? 'headroom' : 'core',
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
        workspaceMemoryMutationSigningSecret,
        workspaceMemoryRunnerInstanceId,
        plugins: dockerPlugins,
        contextAudit,
        skillManifest: {
          hash: skillManifest.hash,
          selectedSkillIds: skillManifest.selected.map((skill) => skill.id),
        },
      };
      container.stdin.write(JSON.stringify(dockerInput));
      container.stdin.end();

      let timedOut = false;
      const systemSettings = getSystemSettings();
      const timeoutMs = resolveRunnerLivenessTimeouts({
        executionTimeoutMs:
          group.containerConfig?.timeout || systemSettings.containerTimeout,
        idleTimeoutMs: systemSettings.idleTimeout,
      }).watchdogMs;

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
      const reconcileDockerOAuth = (
        phase: 'output' | 'exit',
      ): DockerOAuthReconcileOutcome | 'error' | null => {
        const outcome = reconcileSessionOAuthAfterExit(
          selectedProfileId,
          preparedLaunch.dockerOauthLaunch,
        );
        if (outcome === 'updated') {
          logger.info(
            { group: group.name, providerId: selectedProfileId, phase },
            'Persisted Docker SDK-refreshed OAuth credentials',
          );
        } else if (outcome === 'invalid' || outcome === 'not_newer') {
          logger.warn(
            {
              group: group.name,
              providerId: selectedProfileId,
              outcome,
              phase,
            },
            'Ignored invalid Docker OAuth credential rewrite',
          );
        } else if (outcome === 'stale') {
          logger.info(
            { group: group.name, providerId: selectedProfileId, phase },
            'Ignored Docker OAuth refresh after Provider credentials changed',
          );
        } else if (outcome === 'error') {
          logger.warn(
            { group: group.name, providerId: selectedProfileId, phase },
            'Docker OAuth credential reconciliation failed',
          );
        }
        return outcome;
      };
      const handleOutput = async (output: ContainerOutput): Promise<void> => {
        applyCodexGatewayVerdict(output, codexGatewayLease);
        if (
          output.providerQuotaObservation ||
          output.inputTurnCompleted === true ||
          output.status === 'success' ||
          output.status === 'error'
        ) {
          reconcileDockerOAuth('output');
        }
        if (
          consumeProviderQuotaControlOutput(
            selectedProfileId,
            output,
            selectedProviderQuotaEpoch,
          )
        ) {
          // Let the caller refresh its warm-runner activity clock, but keep
          // the frame on the control path (callers return before projection).
          if (onOutput) await onOutput(output);
          resetTimeout();
          return;
        }
        if (!onOutput) return;
        recordUsageConnection(output, selectedProfileId);
        settleUsageLimitWaitForOutput(output, input);
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
        if (output.providerFailureMaintenance && healthyInputTurnCompleted) {
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
            usageLimitWaitScopeFor(input),
          );
          providerFailureTerminal = terminal;
          providerFailureDecision = output;
          logger.warn(
            {
              group: group.name,
              containerName,
              providerId: selectedProfileId,
              terminal,
            },
            providerFailureDispositionLogMessage(output, terminal),
          );
        }
        // Quarantine and classify before awaiting any IM/card projection so
        // concurrent sessions cannot keep selecting a provider that just
        // returned an account-level failure.
        await onOutput(output);
        // The foreground projection resets its idle-close timer during
        // onOutput. Reset the outer watchdog afterwards so graceful idle
        // reclamation always wins, even when provider delivery was slow.
        resetTimeout();
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
      };

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
        reconcileDockerOAuth('exit');

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

    applyCodexGatewayVerdict(result, codexGatewayLease);
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
          usageLimitWaitScopeFor(input),
        );
      } else {
        applyKnownProviderFailureDisposition(result, providerFailureTerminal);
        carryUsageLimitWait(providerFailureDecision, result);
      }
    }

    return result;
  } finally {
    codexGatewayLease.revoke();
    revokeWorkspaceMemoryWriteCapability(
      workspaceMemoryCapabilityScope,
      workspaceMemoryRunnerInstanceId,
    );
    try {
      releaseHappyClawOwnerIntroductionLease(workspaceMemoryRunnerInstanceId);
    } catch (err) {
      logger.warn(
        { err, runnerInstanceId: workspaceMemoryRunnerInstanceId },
        'Failed to release Owner Profile introduction lease',
      );
    }
  }
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

export interface HostProcessSnapshot {
  pid: number;
  ppid: number;
  pgid: number;
  startIdentity: string;
  executable: string;
  argv: string[];
}

interface HostBrowserCleanupDeps {
  snapshot?: (processGroupId: number) => HostProcessSnapshot[];
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  schedule?: (callback: () => void, delayMs: number) => { unref?: () => void };
}

function splitPsArgs(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function readHostProcessLaunch(pid: number): {
  executable: string;
  argv: string[];
} {
  try {
    const executable = fs.readlinkSync(`/proc/${pid}/exe`);
    const argv = fs
      .readFileSync(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    return { executable, argv };
  } catch {
    // macOS has no /proc. Query `comm` separately so paths containing spaces
    // (notably Google Chrome.app) remain unambiguous.
  }
  const executable = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
    encoding: 'utf8',
  }).trim();
  const argsText = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
    encoding: 'utf8',
  }).trim();
  const tail = argsText.startsWith(executable)
    ? argsText.slice(executable.length).trim()
    : argsText;
  return { executable, argv: [executable, ...splitPsArgs(tail)] };
}

function hostProcessGroupSnapshot(
  processGroupId: number,
): HostProcessSnapshot[] {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return [];
  try {
    const output = execFileSync(
      'ps',
      ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart='],
      { encoding: 'utf8' },
    );
    return output
      .split('\n')
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => !!match)
      .filter((match) => Number(match[3]) === processGroupId)
      .flatMap((match) => {
        try {
          return [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              pgid: Number(match[3]),
              startIdentity: match[4].trim(),
              ...readHostProcessLaunch(Number(match[1])),
            },
          ];
        } catch {
          // Process exited between the group listing and identity reads.
          return [];
        }
      });
  } catch (err) {
    logger.warn(
      { processGroupId, err },
      'Failed to inspect host process group for browser cleanup',
    );
    return [];
  }
}

const MANAGED_BROWSER_EXECUTABLES = new Set([
  'agent-browser',
  'agent-browser.js',
  'google chrome',
  'chromium',
  'chromium-browser',
  'chrome',
  'chrome_crashpad_handler',
]);

function normalizedExecutableName(value: string): string {
  return path.basename(value).trim().toLowerCase();
}

function interpreterScript(argv: readonly string[]): string | undefined {
  const executable = normalizedExecutableName(argv[0] ?? '');
  const shell = new Set(['bash', 'sh', 'zsh', 'dash']);
  const interpreter = new Set([
    'node',
    'nodejs',
    'bun',
    'deno',
    'python',
    'python3',
  ]);
  if (!shell.has(executable) && !interpreter.has(executable)) return undefined;
  // Process listings flatten shell quoting, so once an interpreter option is
  // present we cannot safely distinguish its operand from the real script.
  // Fail closed instead of scanning later arguments and risking an unrelated
  // background job. Managed browser CLIs are launched with the script as the
  // immediate first argv operand.
  const value = argv[1];
  if (!value || value.startsWith('-')) return undefined;

  // macOS `ps -o args=` also flattens an immediate script path such as
  // `.../Google Chrome` into two tokens. Recover that one exact shape only
  // when the unjoined prefix is not itself a real script, the joined path is
  // real, and its basename is explicitly managed.
  const next = argv[2];
  if (next) {
    const joined = `${value} ${next}`;
    if (
      !fs.existsSync(value) &&
      MANAGED_BROWSER_EXECUTABLES.has(normalizedExecutableName(joined)) &&
      fs.existsSync(joined)
    ) {
      return joined;
    }
  }
  return value;
}

/** Match executable/script identity, never arbitrary command arguments. */
export function isManagedHostBrowserProcess(
  process: Pick<HostProcessSnapshot, 'executable' | 'argv'>,
): boolean {
  if (
    MANAGED_BROWSER_EXECUTABLES.has(
      normalizedExecutableName(process.executable),
    )
  ) {
    return true;
  }
  const script = interpreterScript(process.argv);
  if (!script) return false;
  const scriptName = normalizedExecutableName(script);
  if (MANAGED_BROWSER_EXECUTABLES.has(scriptName)) return true;
  const normalized = script.replaceAll('\\', '/').toLowerCase();
  return (
    normalized.includes('/agent-browser/') &&
    ['agent-browser.js', 'cli.js', 'index.js'].includes(scriptName)
  );
}

function managedHostBrowserProcesses(
  members: HostProcessSnapshot[],
): HostProcessSnapshot[] {
  const selected = new Set(
    members
      .filter((member) => isManagedHostBrowserProcess(member))
      .map((member) => member.pid),
  );
  // Browser helpers do not all carry a recognizable executable name. Once a
  // managed root is identified, include only its descendants; unrelated
  // background jobs remain siblings and survive the runner's clean exit.
  let changed = true;
  while (changed) {
    changed = false;
    for (const member of members) {
      if (!selected.has(member.pid) && selected.has(member.ppid)) {
        selected.add(member.pid);
        changed = true;
      }
    }
  }
  return members.filter((member) => selected.has(member.pid));
}

function processIdentity(process: HostProcessSnapshot): string {
  return JSON.stringify([
    process.pid,
    process.pgid,
    process.startIdentity,
    process.executable,
    process.argv,
  ]);
}

function signalOriginalBrowserTargets(
  originalTargets: ReadonlyMap<number, string>,
  current: HostProcessSnapshot[],
  signal: NodeJS.Signals,
  sendSignal: (pid: number, signal: NodeJS.Signals) => void,
): void {
  for (const process of current) {
    if (originalTargets.get(process.pid) !== processIdentity(process)) continue;
    try {
      sendSignal(process.pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Reap only browser resources left by a successful host-mode turn.
 *
 * The runner owns a detached process group, but Agent-authored background
 * shell jobs are allowed to outlive a turn. Killing the whole PGID here would
 * destroy those jobs. Browser roots and their descendants receive a graceful
 * TERM first; processes that are still the same PGID/command one second later
 * receive KILL.
 */
export function cleanupHostBrowserResources(
  processGroupId: number,
  killDelayMs = 1_000,
  deps: HostBrowserCleanupDeps = {},
): number {
  const snapshot = deps.snapshot ?? hostProcessGroupSnapshot;
  const sendSignal =
    deps.signal ?? ((pid, signal) => process.kill(pid, signal));
  const schedule =
    deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const targets = managedHostBrowserProcesses(snapshot(processGroupId));
  if (targets.length === 0) return 0;
  const originalTargets = new Map(
    targets.map((target) => [target.pid, processIdentity(target)] as const),
  );
  // Re-read before TERM too: a short-lived browser PID can be reused between
  // discovery and signalling. Exact start/launch identity must still match.
  signalOriginalBrowserTargets(
    originalTargets,
    snapshot(processGroupId),
    'SIGTERM',
    sendSignal,
  );
  const killTimer = schedule(
    () => {
      // Never expand the delayed target set. A newly-launched browser or a
      // reused PID belongs to a later lifecycle and must not be killed.
      signalOriginalBrowserTargets(
        originalTargets,
        snapshot(processGroupId),
        'SIGKILL',
        sendSignal,
      );
    },
    Math.max(0, killDelayMs),
  );
  killTimer.unref?.();
  return targets.length;
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
  // A session that owns a worktree runs only there. A missing or damaged
  // checkout fails the run; falling back would put its edits in the main
  // checkout.
  const sessionWorkdir = resolveSessionWorkingDirectory(input.agentId);
  if (sessionWorkdir.kind === 'broken') {
    return hostModeSetupError(
      sessionWorktreeRunError(sessionWorkdir.worktree, sessionWorkdir.reason),
    );
  }
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
  let groupDir =
    sessionWorkdir.kind === 'worktree'
      ? sessionWorkdir.cwd
      : group.customCwd || defaultGroupDir;
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
    // A worktree lives under data/worktrees; the directory the allowlist
    // governs is still the workspace's own custom directory.
    let allowlistTarget = groupDir;
    if (sessionWorkdir.kind === 'worktree') {
      try {
        allowlistTarget = fs.realpathSync(group.customCwd);
      } catch {
        return hostModeSetupError(
          `工作目录不存在或无法解析：${group.customCwd}`,
        );
      }
    }
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

        const relative = path.relative(realRoot, allowlistTarget);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        return hostModeSetupError(
          `工作目录 ${allowlistTarget} 不在允许的根目录下，请检查 mount-allowlist.json`,
        );
      }
    }
  }

  // Always store logs in data/groups/{folder}/logs/, not in customCwd
  const logsBaseDir = path.join(defaultGroupDir, 'logs');
  fs.mkdirSync(logsBaseDir, { recursive: true });

  // 2. 确保目录结构（宿主机模式下限制目录权限）
  // Sub-agents get their own IPC and session directories
  const groupIpcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', input.agentId)
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
  // Native instructions remain distinct from the host-authorized Workspace
  // Memory snapshot; Claude native auto-memory is disabled in settings.
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
    workspaceSkillRoots: resolveWorkspaceSkillRoots(group, {
      agentId: input.agentId,
    }),
    pluginSkillLayers: pluginSkillLayers(preparedHostPlugins),
  });
  const hostClaudeContextSync = syncHostClaudeContext(
    hostClaudeContextPlan,
    groupSessionsDir,
  );
  hostClaudeContextPlan.audit.claudeMd.status =
    hostClaudeContextSync.claudeMdStatus;
  hostClaudeContextPlan.audit.warnings = hostClaudeContextSync.warnings;
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const hostMcpServers = resolveRuntimeMcpServers(
    group,
    input.agentProfile,
    groupDir,
  );
  ensureSettingsJson(settingsFile, hostMcpServers, {
    replaceMcpServers: true,
    baseSettings: loadHostClaudeSettings(hostClaudeContextPlan),
  });
  const hostMcpManifest = buildRuntimeMcpManifest(
    hostMcpServers,
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

  // ─── Model connection selection (host mode) ───
  await refreshLaunchOAuthCredentials(
    group.folder,
    sessionAgentId,
    input.agentProfile?.modelConfigId,
  );
  const containerOverride = getContainerEnvConfig(group.folder);
  const hostPoolResult = trySelectPoolProvider(
    group.folder,
    sessionAgentId,
    input.agentProfile?.modelConfigId,
    input.agentProfile?.model,
    resolveAgentSdkEffort(input.agentProfile?.runtimePolicy),
  );
  const hostSelectedProfileId = hostPoolResult?.profileId ?? null;
  const hostProviderQuotaEpoch = hostSelectedProfileId
    ? captureProviderQuotaObservationEpoch(hostSelectedProfileId)
    : null;
  const rawGlobalConfig =
    hostPoolResult?.resolved.config ?? getClaudeProviderConfig();
  let hostProviderFailureReported = false;
  let hostProviderFailureTerminal: boolean | undefined;
  /** The streamed failure the disposition was decided on, if it waits. */
  let hostProviderFailureDecision: ContainerOutput | undefined;
  let hostProviderFailureMaintenance = false;
  let hostHealthyInputTurnCompleted = false;
  let hostOauthLaunch: OAuthLaunchSnapshot | null = null;
  input = prepareLaunchInput(input, hostPoolResult, sessionAgentId);

  const workspaceMemoryCapabilityScope: WorkspaceMemoryCapabilityScope = {
    groupFolder: group.folder,
    agentId: input.agentId ?? null,
  };
  const {
    runnerInstanceId: workspaceMemoryRunnerInstanceId,
    signingSecret: workspaceMemoryMutationSigningSecret,
  } = issueWorkspaceMemoryWriteCapability(
    workspaceMemoryCapabilityScope,
    input.turnId,
  );
  const codexGatewayLease = new CodexGatewayRunnerLease({
    kind: 'host',
    groupFolder: group.folder,
    agentId: input.agentId ?? null,
    sessionAgentId: sessionAgentId ?? null,
    agentEffort:
      hostPoolResult?.gatewayAgentEffort ??
      resolveAgentSdkEffort(input.agentProfile?.runtimePolicy),
    sessionEffort: hostPoolResult?.sessionEffort,
  });
  try {
    // Minted inside try so the finally below always revokes the token.
    const globalConfig = resolveCodexGatewayLaunchConfig(
      rawGlobalConfig,
      'host',
      codexGatewayLease,
    );
    // 配置层环境变量
    const envLines = buildContainerEnvLines(
      globalConfig,
      hostSelectedProfileId
        ? { customEnv: containerOverride.customEnv }
        : containerOverride,
      hostPoolResult?.resolved.customEnv,
    );
    applyLaunchEffortEnv(
      envLines,
      resolveAgentSdkEffort(input.agentProfile?.runtimePolicy),
      hostPoolResult
        ? (hostPoolResult.resolved.launchEffort ?? null)
        : undefined,
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
    const hostFallbackModel =
      hostPoolResult?.resolved.fallbackModel ??
      getSystemSettings().fallbackModel?.trim();
    if (hostFallbackModel) {
      hostEnv['HAPPYCLAW_FALLBACK_MODEL'] = hostFallbackModel;
    } else {
      delete hostEnv['HAPPYCLAW_FALLBACK_MODEL'];
    }
    if (isCodexGatewayBaseUrl(rawGlobalConfig.anthropicBaseUrl)) {
      applyCodexGatewayNoProxy(hostEnv, 'host');
    }

    // Resolve symlinks up front: this exact string becomes CLAUDE_CONFIG_DIR
    // below, and the macOS Keychain entry the CLI reads is addressed by a
    // hash of it — both consumers must see the identical path.
    let resolvedSessionsDir = groupSessionsDir;
    try {
      resolvedSessionsDir = fs.realpathSync(groupSessionsDir);
    } catch {
      // Path may not exist yet on first spawn; fall back to the literal path.
    }

    const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
    const clearSessionOAuth =
      !!mergedConfig.anthropicBaseUrl ||
      hasExplicitWorkspaceClaudeAuth(containerOverride);

    // A custom endpoint or an explicit workspace key/token selects a non-OAuth
    // authentication mode. Remove all session and Keychain OAuth state before
    // spawning so Claude Code cannot override that selection.
    if (clearSessionOAuth) {
      if (!injectsAnthropicAuthToken) {
        delete hostEnv['ANTHROPIC_AUTH_TOKEN'];
      }

      try {
        clearSessionClaudeOAuthFiles(groupSessionsDir, getHostClaudeJsonPath());
      } catch (err) {
        logger.error(
          { folder: group.folder, err },
          'Failed to remove host session OAuth credentials',
        );
        return hostModeSetupError(
          '无法清理宿主机会话 OAuth 凭据，已阻止工作区模型启动',
        );
      }

      // Same forced-OAuth hazard, second store: on macOS the CLI keeps OAuth
      // credentials in the Keychain and prefers them over the (now removed)
      // file, so the claudeAiOauth field must be stripped there as well.
      try {
        await removeClaudeKeychainOAuth(
          resolvedSessionsDir,
          hostSelectedProfileId ??
            workspaceRuntimeCredentialOwnerId(group.folder),
        );
      } catch (err) {
        logger.error(
          { folder: group.folder, err },
          'Failed to remove macOS Keychain OAuth for workspace provider',
        );
        return hostModeSetupError(
          '无法清理 macOS Keychain OAuth 凭据，已阻止第三方模型启动',
        );
      }
    }

    // Write .credentials.json for OAuth credentials
    if (mergedConfig.claudeOAuthCredentials) {
      let effectiveOauth = buildClaudeAiOauthPayload(mergedConfig);
      if (!effectiveOauth) {
        return hostModeSetupError('官方 OAuth 凭据不完整，已阻止启动');
      }
      try {
        effectiveOauth = await syncClaudeKeychainOAuth(resolvedSessionsDir, {
          providerId: hostSelectedProfileId ?? '',
          claudeAiOauth: effectiveOauth,
          folder: group.folder,
          persistRefreshedCredentials: (expected, refreshed) => {
            if (!hostSelectedProfileId) return false;
            return updateProviderOAuthCredentialsIfCurrent(
              hostSelectedProfileId,
              expected,
              refreshed,
            );
          },
        });
      } catch (err) {
        logger.error(
          { folder: group.folder, err },
          'Failed to reconcile macOS Keychain OAuth credentials',
        );
        return hostModeSetupError(
          '无法安全同步 macOS Keychain OAuth 凭据，已阻止启动',
        );
      }
      try {
        writeCredentialsFile(groupSessionsDir, {
          ...mergedConfig,
          claudeOAuthCredentials: effectiveOauth,
        });
      } catch (err) {
        logger.error(
          { folder: group.folder, err },
          'Failed to write .credentials.json for host agent',
        );
        return hostModeSetupError(
          '无法写入宿主机会话 OAuth 凭据文件，已阻止启动',
        );
      }
      // Off macOS, Claude Code refreshes into this file. Remember what was
      // written so a rotation is persisted back instead of being overwritten
      // by the stale stored credential on the next launch.
      if (process.platform !== 'darwin') {
        hostOauthLaunch = {
          credentialsFilePath: path.join(groupSessionsDir, '.credentials.json'),
          launchCredentials: effectiveOauth,
        };
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

    // CLAUDE_CONFIG_DIR is the real on-disk path (resolved above, before the
    // credential writes). Host mode also goes through the synchronized session
    // .claude directory so explicit externalClaudeDir is authoritative for
    // CLAUDE.md/rules/skills.
    hostEnv['CLAUDE_CONFIG_DIR'] = resolvedSessionsDir;

    // No DEBUG_CLAUDE_AGENT_SDK: the SDK turns it into DEBUG=1 for the CLI,
    // which then writes debug logs under CLAUDE_CONFIG_DIR/debug on every
    // run. The runner captures CLI stderr through the SDK `stderr` option.
    delete hostEnv['DEBUG_CLAUDE_AGENT_SDK'];
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
        workspaceMemoryMutationSigningSecret,
        workspaceMemoryRunnerInstanceId,
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
      const systemSettings = getSystemSettings();
      const timeoutMs = resolveRunnerLivenessTimeouts({
        executionTimeoutMs:
          group.containerConfig?.timeout || systemSettings.containerTimeout,
        idleTimeoutMs: systemSettings.idleTimeout,
      }).watchdogMs;

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
      const reconcileHostOAuth = (phase: 'output' | 'exit'): void => {
        const outcome = reconcileSessionOAuthAfterExit(
          hostSelectedProfileId,
          hostOauthLaunch,
        );
        if (outcome === 'updated') {
          logger.info(
            { group: group.name, providerId: hostSelectedProfileId, phase },
            'Persisted host SDK-refreshed OAuth credentials',
          );
        } else if (outcome === 'invalid' || outcome === 'not_newer') {
          logger.warn(
            {
              group: group.name,
              providerId: hostSelectedProfileId,
              outcome,
              phase,
            },
            'Ignored invalid host OAuth credential rewrite',
          );
        } else if (outcome === 'error') {
          logger.warn(
            { group: group.name, providerId: hostSelectedProfileId, phase },
            'Host OAuth credential reconciliation failed',
          );
        }
      };
      const handleOutput = async (output: ContainerOutput): Promise<void> => {
        applyCodexGatewayVerdict(output, codexGatewayLease);
        if (
          output.providerQuotaObservation ||
          output.inputTurnCompleted === true ||
          output.status === 'success' ||
          output.status === 'error'
        ) {
          reconcileHostOAuth('output');
        }
        if (
          consumeProviderQuotaControlOutput(
            hostSelectedProfileId,
            output,
            hostProviderQuotaEpoch,
          )
        ) {
          if (onOutput) await onOutput(output);
          resetTimeout();
          return;
        }
        if (!onOutput) return;
        recordUsageConnection(output, hostSelectedProfileId);
        settleUsageLimitWaitForOutput(output, input);
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
            usageLimitWaitScopeFor(input),
          );
          hostProviderFailureTerminal = terminal;
          hostProviderFailureDecision = output;
          logger.warn(
            {
              group: group.name,
              processId,
              providerId: hostSelectedProfileId,
              terminal,
            },
            providerFailureDispositionLogMessage(output, terminal),
          );
        }
        // Keep provider selection safe while the user-facing projection is
        // awaiting a network ACK.
        await onOutput(output);
        // See the container path above: start the watchdog after the
        // foreground projection has reset its graceful idle timer.
        resetTimeout();
        if (output.providerFailure) {
          killProcessTree(proc, 'SIGTERM');
        }
      };

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
        // Reap browser daemons without killing unrelated Agent-authored
        // background jobs that intentionally outlive this turn.
        if (proc.pid) cleanupHostBrowserResources(proc.pid);
        const duration = Date.now() - startTime;
        reconcileHostOAuth('exit');

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

    applyCodexGatewayVerdict(hostResult, codexGatewayLease);
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
          usageLimitWaitScopeFor(input),
        );
      } else {
        applyKnownProviderFailureDisposition(
          hostResult,
          hostProviderFailureTerminal,
        );
        carryUsageLimitWait(hostProviderFailureDecision, hostResult);
      }
    }

    return hostResult;
  } finally {
    codexGatewayLease.revoke();
    revokeWorkspaceMemoryWriteCapability(
      workspaceMemoryCapabilityScope,
      workspaceMemoryRunnerInstanceId,
    );
    try {
      releaseHappyClawOwnerIntroductionLease(workspaceMemoryRunnerInstanceId);
    } catch (err) {
      logger.warn(
        { err, runnerInstanceId: workspaceMemoryRunnerInstanceId },
        'Failed to release Owner Profile introduction lease',
      );
    }
  }
}

/** A concrete agent runner (Docker or host) — both share this signature. */
export type AgentRunner = typeof runContainerAgent | typeof runHostAgent;

/**
 * Model-tier fallback lives inside agent-runner, and provider failover for a
 * conversation lives in GroupQueue/IPC recovery, so a late warm-turn failure
 * never replays the process's original cold-start prompt. This is the single
 * entry both runner kinds go through.
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
  return runFn(group, input, onProcess, onOutput, ownerHomeFolder);
}
