import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  hasBoundWorkspaceReference,
  resolveBoundWorkspaceJid,
} from '../workspace-attribution.js';
import {
  GroupAgentProfilePatchSchema,
  GroupCreateSchema,
  GroupPatchSchema,
  ContainerEnvSchema,
} from '../schemas.js';
import type {
  AuthUser,
  ConversationSource,
  RegisteredGroup,
  ExecutionMode,
  InteractionMode,
} from '../types.js';
import { checkGroupLimit } from '../billing.js';
import { DATA_DIR, GROUPS_DIR, isDockerAvailable } from '../config.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
  canModifyGroup,
  canDeleteGroup,
  MAX_GROUP_NAME_LEN,
  getWebDeps,
} from '../web-context.js';
import {
  clearSessionChannelOwner,
  getRegisteredGroup,
  setRegisteredGroup,
  deleteRegisteredGroup,
  getAllRegisteredGroups,
  getAllChats,
  getJidsByFolder,
  getChannelMount,
  updateChatName,
  deleteSession,
  deleteWorkspaceSessions,
  deleteChatHistory,
  pauseWorkspaceTasksForRebuild,
  rebuildWorkspacePersistentState,
  restoreWorkspaceTasksAfterFailedRebuild,
  deleteGroupData,
  deleteImGroupRecord,
  ensureChatExists,
  storeMessageDirect,
  getMessagesPage,
  getMessagesAfter,
  getLatestMessagePreviewPerChat,
  getMessagesPageMulti,
  getMessagesAfterMulti,
  getAgent,
  listAgentsByJid,
  getGroupsByTargetAgent,
  getGroupsByTargetMainJid,
  listChannelMountsByWorkspace,
  listImContextBindingsByWorkspace,
  getMessage,
  deleteMessage,
  getUserPinnedGroups,
  pinGroup,
  unpinGroup,
  assignWorkspaceAgentProfile,
  deleteWorkspaceAgentProfile,
  getAgentProfileForUser,
  peekAgentProfileForWorkspace,
  getOrCreateDefaultAgentProfile,
  getWorkspaceAgentProfileId,
  getWorkspaceInteractionMode,
  setWorkspaceInteractionMode,
  getUserById,
} from '../db.js';
import { releaseOwner, persistGroupUpdate } from '../group-owner.js';
import { logger } from '../logger.js';
import {
  getWorkspaceRuntimeJids,
  quiesceWorkspaceRunnersAroundCommit,
  withAgentProfileLocks,
  WorkspaceRuntimeQuiesceError,
} from '../agent-profile-runtime.js';
import {
  getContainerEnvConfig,
  getSystemSettings,
  saveContainerEnvConfig,
  toPublicContainerEnvConfig,
} from '../runtime-config.js';
import { clearTargetAgentBindingsForDeletedAgents } from '../im-context-isolation.js';
import { getChannelType } from '../im-channel.js';
import {
  buildNativeThreadWorkspaceUpdate,
  buildUnmountUpdate,
  ensureDirectChannelSessionMount,
  resolveDefaultChannelMountForWorkspaceDeletion,
} from '../channel-mount-service.js';
import { resolveChannelConversationKind } from '../channel-conversation-kind.js';
import {
  AdditionalMountValidationError,
  loadMountAllowlist,
  findAllowedRoot,
  matchesBlockedPattern,
  validateAdditionalMountsStrict,
} from '../mount-security.js';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
// SSRF helpers 抽到 ../url-safety.ts；本文件 re-export isPrivateHostname 以保留旧导入路径。
import { z } from 'zod';
import { broadcastNewMessage } from '../web.js';
import { getStreamingSession } from '../feishu-streaming-card.js';
import { attachSessionWorkflowRuns } from '../session-workflows.js';
import {
  buildPinnedGitEnvironment,
  startPinnedHttpsProxy,
} from '../safe-git-proxy.js';
import {
  SYSTEM_CAPABILITY_LOCK_KEY,
  withCapabilityScopeLocks,
} from '../capability-lock.js';

const execFileAsync = promisify(execFile);

/**
 * The workspace lost its AgentProfile binding between the PATCH pre-check and
 * the commit. interaction_mode is stored on that row, so the update cannot be
 * persisted — a client-correctable conflict, never a server fault.
 */
class WorkspaceAgentProfileMissingError extends Error {}
class AdminHostOnlyModeConflictError extends Error {}

/**
 * 检查 hostname 是否为内网地址（SSRF 防护）。
 * 拒绝 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, ::1, fd00::, fe80:: 等。
 *
 * Re-export 自 ../url-safety.ts 以兼容已有调用方；新代码应直接 import 那里的版本。
 */
import {
  assertResolvesToPublicAddress,
  isPrivateHostname,
} from '../url-safety.js';
export { isPrivateHostname };

const groupRoutes = new Hono<{ Variables: Variables }>();

// --- Helper functions ---

function normalizeGroupName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, MAX_GROUP_NAME_LEN);
}

interface WorkspaceDeleteBindingSummary {
  boundSessions: Array<{
    sessionId: string;
    sessionName: string;
    imGroups: Array<{ jid: string; name: string }>;
  }>;
  mainImGroups: Array<{ jid: string; name: string }>;
  threadContextBindings: Array<{
    jid: string;
    name: string;
    context_id: string;
  }>;
  /** Channels whose current route must move before the workspace disappears. */
  mountedChannelJids: string[];
  channelBindingCount: number;
  hasChannelBindings: boolean;
}

function collectWorkspaceDeleteBindings(
  jid: string,
  existing: RegisteredGroup,
): WorkspaceDeleteBindingSummary {
  const agents = listAgentsByJid(jid);
  const sessionNameById = new Map(
    agents
      .filter((agent) => agent.kind === 'conversation')
      .map((agent) => [agent.id, agent.name] as const),
  );
  const sessionBindings = new Map<
    string,
    Map<string, { jid: string; name: string }>
  >();
  const mainBindings = new Map<string, { jid: string; name: string }>();

  for (const mount of listChannelMountsByWorkspace(jid)) {
    const imGroup = getRegisteredGroup(mount.channel_jid);
    const item = {
      jid: mount.channel_jid,
      name: imGroup?.name ?? mount.channel_jid,
    };
    if (mount.session_id) {
      const items = sessionBindings.get(mount.session_id) ?? new Map();
      items.set(item.jid, item);
      sessionBindings.set(mount.session_id, items);
    } else {
      mainBindings.set(item.jid, item);
    }
  }

  for (const agent of agents) {
    if (agent.kind !== 'conversation') continue;
    const items = sessionBindings.get(agent.id) ?? new Map();
    for (const linked of getGroupsByTargetAgent(agent.id)) {
      items.set(linked.jid, { jid: linked.jid, name: linked.group.name });
    }
    if (items.size > 0) sessionBindings.set(agent.id, items);
  }

  const legacyMainJid = `web:${existing.folder}`;
  const mainBoundByJid = getGroupsByTargetMainJid(jid);
  const mainBoundByFolder =
    legacyMainJid !== jid ? getGroupsByTargetMainJid(legacyMainJid) : [];
  for (const linked of [...mainBoundByJid, ...mainBoundByFolder]) {
    mainBindings.set(linked.jid, {
      jid: linked.jid,
      name: linked.group.name,
    });
  }

  const boundSessions = Array.from(sessionBindings.entries()).map(
    ([sessionId, imGroups]) => ({
      sessionId,
      sessionName: sessionNameById.get(sessionId) ?? sessionId,
      imGroups: Array.from(imGroups.values()),
    }),
  );
  const mainImGroups = Array.from(mainBindings.values());
  const threadContextBindings = listImContextBindingsByWorkspace(jid).map(
    (binding) => {
      const imGroup = getRegisteredGroup(binding.source_jid);
      return {
        jid: binding.source_jid,
        name: imGroup?.name ?? binding.source_jid,
        context_id: binding.context_id,
      };
    },
  );
  const mountedChannelJids = Array.from(
    new Set([
      ...mainImGroups.map((item) => item.jid),
      ...boundSessions.flatMap((session) =>
        session.imGroups.map((item) => item.jid),
      ),
    ]),
  );
  const allChannelJids = new Set([
    ...mountedChannelJids,
    ...threadContextBindings.map((item) => item.jid),
  ]);

  return {
    boundSessions,
    mainImGroups,
    threadContextBindings,
    mountedChannelJids,
    channelBindingCount: allChannelJids.size,
    hasChannelBindings: allChannelJids.size > 0,
  };
}

function workspaceDeleteImpactPayload(
  summary: WorkspaceDeleteBindingSummary,
): Record<string, unknown> {
  return {
    has_channel_bindings: summary.hasChannelBindings,
    channel_binding_count: summary.channelBindingCount,
    bound_sessions: summary.boundSessions,
    // Compatibility for clients that still call conversation sessions Agents.
    bound_agents: summary.boundSessions.map((session) => ({
      agentId: session.sessionId,
      agentName: session.sessionName,
      imGroups: session.imGroups,
    })),
    bound_main_im_groups: summary.mainImGroups,
    bound_thread_contexts: summary.threadContextBindings,
  };
}

interface GroupPayloadItem {
  name: string;
  folder: string;
  added_at: string;
  kind: 'home' | 'feishu' | 'web';
  editable: boolean;
  deletable: boolean;
  lastMessage?: string;
  lastMessageTime?: string;
  execution_mode: 'container' | 'host';
  interaction_mode?: InteractionMode;
  custom_cwd?: string;
  is_home?: boolean;
  is_my_home?: boolean;
  can_modify?: boolean;
  pinned_at?: string;
  activation_mode?:
    | 'auto'
    | 'always'
    | 'when_mentioned'
    | 'owner_mentioned'
    | 'disabled';
  conversation_source?: ConversationSource;
  conversation_nav_mode?: 'horizontal' | 'vertical_threads';
  agent_profile_id?: string;
  agent_profile_name?: string;
  agent_profile_version?: number;
  agent_profile_avatar_emoji?: string | null;
  agent_profile_avatar_color?: string | null;
  agent_profile_avatar_url?: string | null;
}

function buildGroupsPayload(user: AuthUser): Record<string, GroupPayloadItem> {
  const groups = getAllRegisteredGroups();
  const chats = new Map(getAllChats().map((chat) => [chat.jid, chat]));
  const isAdmin = hasHostExecutionPermission(user);
  const homeFolders = new Set(
    Object.entries(groups)
      .filter(([jid, group]) => jid.startsWith('web:') && !!group.is_home)
      .map(([_, group]) => group.folder),
  );

  const result: Record<string, GroupPayloadItem> = {};

  // 先过滤出要显示的群组 jid
  const visibleEntries: Array<[string, (typeof groups)[string]]> = [];
  for (const [jid, group] of Object.entries(groups)) {
    const isHome = !!group.is_home;
    const isWeb = jid.startsWith('web:');
    const isHost = isHostExecutionGroup(group);

    // Hide IM channels that belong to a home folder.
    // These are merged into the home conversation in UI and message APIs.
    if (!isWeb && !isHome && homeFolders.has(group.folder)) continue;

    // Hide other users' home groups from the chat sidebar.
    // Each user only sees their own home container.
    if (isHome && group.created_by !== user.id) continue;

    // Host execution groups require admin unless it's the user's own home group
    if (isHost && !isAdmin && !(isHome && group.created_by === user.id))
      continue;

    // Workspaces are private to their creator. IM rows without created_by use
    // the legacy sibling-home fallback inside canAccessGroup.
    if (!canAccessGroup({ id: user.id, role: user.role }, { ...group, jid }))
      continue;

    visibleEntries.push([jid, group]);
  }

  // 每个 jid 各取最新一条（分区窗口，不再被高频群吃光全局窗口）
  const visibleJids = visibleEntries.map(([jid]) => jid);
  const latestByJid = getLatestMessagePreviewPerChat(visibleJids);

  // Fetch user's pinned groups
  const pins = getUserPinnedGroups(user.id);

  for (const [jid, group] of visibleEntries) {
    const isHome = !!group.is_home;
    const isWeb = jid.startsWith('web:');

    const latest = latestByJid.get(jid);
    // 只读投影：列表 GET 不允许因为某个工作区绑定缺失而顺手开写事务修复
    // （那属于启动 backfill 和运行时解析的职责）。
    const agentProfile = isWeb
      ? peekAgentProfileForWorkspace(group.folder, group.created_by)
      : undefined;

    result[jid] = {
      name: group.name,
      folder: group.folder,
      added_at: group.added_at,
      kind: isHome ? 'home' : isWeb ? 'web' : 'feishu',
      editable: isWeb,
      deletable: isWeb && !isHome,
      lastMessage: latest?.content,
      lastMessageTime:
        latest?.timestamp ||
        chats.get(jid)?.last_message_time ||
        group.added_at,
      execution_mode: group.executionMode || 'container',
      interaction_mode: isWeb
        ? getWorkspaceInteractionMode(group.folder)
        : undefined,
      custom_cwd: isAdmin ? group.customCwd : undefined,
      is_home: isHome || undefined,
      is_my_home: (isHome && group.created_by === user.id) || undefined,
      can_modify: canModifyGroup(user, { ...group, jid }),
      pinned_at: pins[jid] || undefined,
      activation_mode: group.activation_mode ?? 'auto',
      conversation_source: group.conversation_source ?? 'manual',
      conversation_nav_mode: group.conversation_nav_mode ?? 'horizontal',
      agent_profile_id: agentProfile?.id,
      agent_profile_name: agentProfile?.name,
      agent_profile_version: agentProfile?.version,
      agent_profile_avatar_emoji: agentProfile?.avatar_emoji,
      agent_profile_avatar_color: agentProfile?.avatar_color,
      agent_profile_avatar_url: agentProfile?.avatar_url,
    };
  }

  return result;
}

import { removeFlowArtifacts } from '../file-manager.js';
import { clearSessionFiles } from '../session-files.js';
export { removeFlowArtifacts };

class WorkspaceMissingDuringMigrationError extends Error {
  constructor() {
    super('Workspace no longer exists or changed during migration');
    this.name = 'WorkspaceMissingDuringMigrationError';
  }
}

interface StagedWorkspaceReset {
  commit(): Array<{ path: string; error: unknown }>;
  rollback(): void;
}

class WorkspaceFilesystemRollbackError extends AggregateError {
  constructor(errors: Iterable<unknown>, folder: string) {
    super(
      errors,
      `Failed to stage and roll back workspace filesystem reset for ${folder}`,
    );
    this.name = 'WorkspaceFilesystemRollbackError';
  }
}

/**
 * Move destructive filesystem targets aside before touching SQLite. A handled
 * database failure can then restore the exact original directories instead of
 * returning 500 after files have already been permanently deleted.
 */
function stageWorkspaceResetForGroup(folder: string): StagedWorkspaceReset {
  const suffix = `.rebuild-backup-${crypto.randomUUID()}`;
  const groupDir = path.join(GROUPS_DIR, folder);
  const sessionDir = path.join(DATA_DIR, 'sessions', folder);
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);
  const legacyMemoryDir = path.join(DATA_DIR, 'memory', folder);
  const targets = [groupDir, sessionDir, ipcDir, legacyMemoryDir].map(
    (targetPath) => ({
      targetPath,
      backupPath: `${targetPath}${suffix}`,
      moved: false,
    }),
  );

  const rollback = () => {
    const errors: unknown[] = [];
    for (const target of [...targets].reverse()) {
      try {
        fs.rmSync(target.targetPath, { recursive: true, force: true });
        if (target.moved) {
          fs.renameSync(target.backupPath, target.targetPath);
          target.moved = false;
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to roll back staged workspace filesystem reset for ${folder}`,
      );
    }
  };

  try {
    for (const target of targets) {
      if (!fs.existsSync(target.targetPath)) continue;
      fs.renameSync(target.targetPath, target.backupPath);
      target.moved = true;
    }
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new WorkspaceFilesystemRollbackError(
        [error, rollbackError],
        folder,
      );
    }
    throw error;
  }

  return {
    rollback,
    commit: () => {
      const failures: Array<{ path: string; error: unknown }> = [];
      for (const target of targets) {
        if (!target.moved) continue;
        try {
          fs.rmSync(target.backupPath, { recursive: true, force: true });
          target.moved = false;
        } catch (error) {
          failures.push({ path: target.backupPath, error });
        }
      }
      return failures;
    },
  };
}

function toPublicContainerEnvForUser(
  config: ReturnType<typeof getContainerEnvConfig>,
  user: AuthUser,
) {
  const base = toPublicContainerEnvConfig(config);
  if (
    user.role === 'admin' ||
    (user.permissions && user.permissions.includes('manage_group_env'))
  ) {
    return base;
  }
  return {
    ...base,
    customEnv: {},
  };
}

// --- Routes ---

// GET /api/groups - 获取群组列表
groupRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const groups = buildGroupsPayload(user);
  return c.json({
    groups,
    admin_host_only_mode:
      user.role === 'admin' && getSystemSettings().adminHostOnlyMode,
  });
});

// POST /api/groups - 创建新群组
groupRoutes.post('/', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const body = await c.req.json().catch(() => ({}));

  const validation = GroupCreateSchema.safeParse(body);
  if (!validation.success) {
    const flattened = validation.error.flatten().fieldErrors;
    const fieldErrors = Object.fromEntries(
      Object.entries(flattened)
        .filter(([, messages]) => messages && messages.length > 0)
        .map(([field, messages]) => [field, messages!.join('; ')]),
    );
    const mountError = validation.error.issues.some(
      (issue) => issue.path[0] === 'additional_mounts',
    );
    return c.json(
      {
        error: 'Invalid request body',
        code: mountError ? 'INVALID_ADDITIONAL_MOUNTS' : 'INVALID_REQUEST_BODY',
        field_errors: fieldErrors,
      },
      400,
    );
  }

  const name = normalizeGroupName(validation.data.name);
  if (!name) {
    return c.json({ error: 'Group name is required' }, 400);
  }

  const authUser = c.get('user') as AuthUser;
  const adminHostOnlyMode =
    authUser.role === 'admin' &&
    authUser.status === 'active' &&
    getSystemSettings().adminHostOnlyMode;
  if (adminHostOnlyMode && validation.data.execution_mode === 'container') {
    return c.json(
      {
        error: '管理员纯宿主机模式已开启，不能创建 Docker 工作区',
        code: 'ADMIN_HOST_ONLY_MODE_ENABLED',
      },
      409,
    );
  }

  // Members always stay container-isolated. Administrators in hybrid mode
  // retain the existing Docker-availability fallback.
  const executionMode = adminHostOnlyMode
    ? 'host'
    : validation.data.execution_mode ||
      (authUser.role === 'admin' && !(await isDockerAvailable())
        ? 'host'
        : 'container');
  const interactionMode = validation.data.interaction_mode ?? 'assistant';
  const customCwd = validation.data.custom_cwd; // Schema already trims and converts empty to undefined
  const initSourcePath = validation.data.init_source_path;
  const initGitUrl = validation.data.init_git_url;
  const requestedAdditionalMounts = validation.data.additional_mounts ?? [];
  const agentProfile = validation.data.agent_profile_id
    ? getAgentProfileForUser(validation.data.agent_profile_id, authUser.id)
    : getOrCreateDefaultAgentProfile(authUser.id);
  if (!agentProfile) {
    return c.json({ error: '智能体配置不存在' }, 404);
  }

  // Billing: check group limit
  const groupLimit = checkGroupLimit(authUser.id, authUser.role);
  if (!groupLimit.allowed) {
    return c.json({ error: groupLimit.reason }, 403);
  }

  // Host paths are a privileged server capability. Check authorization and
  // execution mode before touching any submitted path so a member cannot use
  // this endpoint as a host filesystem existence oracle.
  if (requestedAdditionalMounts.length > 0) {
    if (authUser.role !== 'admin' || authUser.status !== 'active') {
      return c.json(
        {
          error:
            'Only an active administrator can mount host directories into a workspace',
          code: 'HOST_MOUNT_ADMIN_REQUIRED',
        },
        403,
      );
    }
    if (executionMode !== 'container') {
      return c.json(
        {
          error: 'Host directory mounts are only valid for container mode',
          code: 'HOST_MOUNT_CONTAINER_ONLY',
        },
        400,
      );
    }
  }

  let validatedAdditionalMounts: ReturnType<
    typeof validateAdditionalMountsStrict
  > = [];
  if (requestedAdditionalMounts.length > 0) {
    try {
      validatedAdditionalMounts = validateAdditionalMountsStrict(
        requestedAdditionalMounts.map((mount) => ({
          hostPath: mount.host_path,
          containerPath: mount.container_path,
          readonly: mount.readonly,
        })),
        name,
        false,
      );
    } catch (err) {
      if (err instanceof AdditionalMountValidationError) {
        const conflict = err.conflict;
        return c.json(
          {
            error: conflict
              ? 'Additional mount targets conflict'
              : 'Invalid additional mount configuration',
            code: conflict ? 'HOST_MOUNT_TARGET_CONFLICT' : err.code,
            field_errors: {
              additional_mounts: err.issues.join('; '),
            },
          },
          conflict ? 409 : 400,
        );
      }
      throw err;
    }
  }

  // 互斥校验：init_source_path 和 init_git_url 不能同时指定
  if (initSourcePath && initGitUrl) {
    return c.json(
      { error: 'init_source_path and init_git_url are mutually exclusive' },
      400,
    );
  }

  // init_source_path / init_git_url 仅 container 模式可用
  if (executionMode === 'host' && (initSourcePath || initGitUrl)) {
    return c.json(
      {
        error:
          'init_source_path and init_git_url are only valid for container mode',
      },
      400,
    );
  }

  if (executionMode === 'host') {
    if (!hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for host execution mode' },
        403,
      );
    }
    if (customCwd) {
      if (!path.isAbsolute(customCwd)) {
        return c.json({ error: 'custom_cwd must be an absolute path' }, 400);
      }

      // 检查路径是否存在
      let realPath: string;
      try {
        const stat = fs.statSync(customCwd);
        if (!stat.isDirectory()) {
          return c.json(
            { error: 'custom_cwd must be an existing directory' },
            400,
          );
        }
        realPath = fs.realpathSync(customCwd);
      } catch {
        return c.json({ error: 'custom_cwd directory does not exist' }, 400);
      }

      // 白名单校验：检查路径是否在允许的根目录下，并过滤敏感路径
      // （与 init_source_path 对齐：之前缺少 matchesBlockedPattern，可把
      // .ssh / .aws / .gnupg 等敏感目录挂进容器）
      const allowlist = loadMountAllowlist();
      if (
        allowlist &&
        allowlist.allowedRoots &&
        allowlist.allowedRoots.length > 0
      ) {
        const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
        if (!allowedRoot) {
          const allowedPaths = allowlist.allowedRoots
            .map((r) => r.path)
            .join(', ');
          return c.json(
            {
              error: `custom_cwd must be under an allowed root. Allowed roots: ${allowedPaths}. Check config/mount-allowlist.json`,
            },
            403,
          );
        }

        const blockedMatch = matchesBlockedPattern(
          realPath,
          allowlist.blockedPatterns,
        );
        if (blockedMatch) {
          return c.json(
            { error: `custom_cwd matches blocked pattern "${blockedMatch}"` },
            403,
          );
        }
      }
    }
  } else if (customCwd) {
    return c.json({ error: 'custom_cwd is only valid for host mode' }, 400);
  }

  // 验证 init_source_path
  if (initSourcePath) {
    if (!hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions: init_source_path requires admin' },
        403,
      );
    }
    if (!path.isAbsolute(initSourcePath)) {
      return c.json(
        { error: 'init_source_path must be an absolute path' },
        400,
      );
    }

    let realPath: string;
    try {
      const stat = fs.statSync(initSourcePath);
      if (!stat.isDirectory()) {
        return c.json(
          { error: 'init_source_path must be an existing directory' },
          400,
        );
      }
      realPath = fs.realpathSync(initSourcePath);
    } catch {
      return c.json(
        { error: 'init_source_path directory does not exist' },
        400,
      );
    }

    // 白名单校验
    const allowlist = loadMountAllowlist();
    if (
      allowlist &&
      allowlist.allowedRoots &&
      allowlist.allowedRoots.length > 0
    ) {
      const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
      if (!allowedRoot) {
        const allowedPaths = allowlist.allowedRoots
          .map((r) => r.path)
          .join(', ');
        return c.json(
          {
            error: `init_source_path must be under an allowed root. Allowed roots: ${allowedPaths}. Check config/mount-allowlist.json`,
          },
          403,
        );
      }

      // 敏感路径过滤
      const blockedMatch = matchesBlockedPattern(
        realPath,
        allowlist.blockedPatterns,
      );
      if (blockedMatch) {
        return c.json(
          {
            error: `init_source_path matches blocked pattern "${blockedMatch}"`,
          },
          403,
        );
      }
    }
  }

  // 验证 init_git_url（SSRF 防护 + admin 权限）
  if (initGitUrl) {
    if (!hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions: init_git_url requires admin' },
        403,
      );
    }
    if (initGitUrl.length > 2000) {
      return c.json(
        { error: 'init_git_url is too long (max 2000 characters)' },
        400,
      );
    }

    let gitUrl: URL;
    try {
      gitUrl = new URL(initGitUrl);
    } catch {
      return c.json({ error: 'init_git_url is not a valid URL' }, 400);
    }

    // 仅允许 https 协议（HTTP 明文传输存在中间人攻击风险）
    if (gitUrl.protocol !== 'https:') {
      return c.json({ error: 'init_git_url must use https protocol' }, 400);
    }

    // 阻止内网地址（字面量 IP/localhost）
    if (isPrivateHostname(gitUrl.hostname)) {
      return c.json(
        { error: 'init_git_url must not point to a private/internal address' },
        400,
      );
    }

    // URL 内嵌凭据会被传给 git 子进程，可能落进进程列表/日志；与
    // skill-import-service.ts 的 importSkillsFromGit 保持一致，直接拒绝。
    if (gitUrl.username || gitUrl.password) {
      return c.json(
        { error: 'init_git_url must not contain credentials' },
        400,
      );
    }

    // Early DNS check gives a fast 400 response. The actual clone is also
    // forced through a connection-time validating proxy below, which pins
    // each socket to the exact public IP it just validated.
    try {
      await assertResolvesToPublicAddress(
        gitUrl.hostname,
        'init_git_url hostname',
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return c.json({ error: errMsg }, 400);
    }
  }

  const jid = `web:${crypto.randomUUID()}`;
  const folder = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  const group: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: executionMode as ExecutionMode,
    customCwd: executionMode === 'host' ? customCwd : undefined,
    initSourcePath: executionMode !== 'host' ? initSourcePath : undefined,
    initGitUrl: executionMode !== 'host' ? initGitUrl : undefined,
    created_by: authUser.id,
    containerConfig:
      validatedAdditionalMounts.length > 0
        ? {
            version: 1,
            additionalMounts: validatedAdditionalMounts.map(
              (mount) => mount.persisted,
            ),
          }
        : undefined,
  };

  // Initialize private filesystem state before publishing either the
  // registered workspace or its Agent membership. This removes the rollback
  // race entirely: while clone/copy awaits, migration/delete routes cannot see
  // the workspace, and a failure has no DB membership to undo.
  const groupDir = path.join(GROUPS_DIR, folder);
  try {
    if (initSourcePath) {
      await fsp.mkdir(groupDir, { recursive: true });
      await fsp.cp(initSourcePath, groupDir, { recursive: true });
      logger.info(
        { folder, source: initSourcePath },
        'Workspace initialized from local directory',
      );
    }

    if (initGitUrl) {
      const reGitUrl = new URL(initGitUrl);
      const gitProxy = await startPinnedHttpsProxy(reGitUrl.hostname, {
        expectedPort: reGitUrl.port ? Number(reGitUrl.port) : 443,
      });
      // Hardening flags mirror skill-import-service.ts's importSkillsFromGit:
      // - http.followRedirects=false: an initial 302 to a private/internal
      //   address would otherwise bypass the DNS precheck above entirely.
      // - protocol.file.allow=never: refuse a local-file clone smuggled in
      //   via a redirect or a crafted URL scheme override.
      // - submodule.recurse=false: don't let a malicious repo's submodules
      //   pull from arbitrary, unvalidated URLs.
      // - --no-tags --single-branch: minimize what an untrusted repo can
      //   push into this clone beyond the requested ref.
      // - GIT_TERMINAL_PROMPT=0: never hang waiting for credential input.
      try {
        await execFileAsync(
          'git',
          [
            '-c',
            `http.proxy=${gitProxy.url}`,
            '-c',
            'http.followRedirects=false',
            '-c',
            'protocol.file.allow=never',
            '-c',
            'submodule.recurse=false',
            'clone',
            '--depth',
            '1',
            '--no-tags',
            '--single-branch',
            '--',
            initGitUrl,
            groupDir,
          ],
          {
            timeout: 120_000,
            env: buildPinnedGitEnvironment(gitProxy.url),
          },
        );
      } finally {
        await gitProxy.close();
      }
      logger.info(
        { folder, url: initGitUrl },
        'Workspace initialized from git clone',
      );
    }
  } catch (err) {
    logger.error({ folder, err }, 'Workspace initialization failed');
    fs.rmSync(groupDir, { recursive: true, force: true });
    const errMsg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Workspace initialization failed: ${errMsg}` }, 500);
  }

  let publishedAgentProfile;
  let hostOnlyPolicyChangedDuringCreate = false;
  try {
    publishedAgentProfile = await withCapabilityScopeLocks(
      [SYSTEM_CAPABILITY_LOCK_KEY],
      async () => {
        const profile = await withAgentProfileLocks([agentProfile.id], () => {
          // The target may have been archived while the request performed its
          // filesystem/network validation. Recheck under the same lock used by
          // Agent DELETE/PATCH and workspace migration.
          const lockedProfile = getAgentProfileForUser(
            agentProfile.id,
            authUser.id,
          );
          if (!lockedProfile) return undefined;
          const currentOwner = getUserById(authUser.id);
          if (
            group.executionMode !== 'host' &&
            currentOwner?.role === 'admin' &&
            currentOwner.status === 'active' &&
            getSystemSettings().adminHostOnlyMode
          ) {
            hostOnlyPolicyChangedDuringCreate = true;
            return undefined;
          }

          try {
            // Mapping first and registered-group publication immediately after
            // it occur in one synchronous critical section. Agent PATCH cannot
            // snapshot between them: it holds this same profile lock.
            assignWorkspaceAgentProfile(
              folder,
              lockedProfile.id,
              interactionMode,
            );
            setRegisteredGroup(jid, group);
            updateChatName(jid, name);
            deps.getRegisteredGroups()[jid] = group;
            return lockedProfile;
          } catch (err) {
            // setRegisteredGroup may fail after the mapping write. Clear both
            // sides before releasing the profile lock so no partial membership
            // can become visible to the next mutation.
            try {
              deleteRegisteredGroup(jid);
            } catch {
              /* best-effort cleanup continues below */
            }
            deleteWorkspaceAgentProfile(folder);
            deleteChatHistory(jid);
            delete deps.getRegisteredGroups()[jid];
            throw err;
          }
        });
        // Hold the system policy lock through container prewarm. If host-only
        // mode is enabled concurrently, its snapshot can only run after this
        // workspace is fully published and will therefore quiesce the new
        // container before committing the policy.
        if (profile && executionMode === 'container') {
          try {
            deps.ensureTerminalContainerStarted(jid);
          } catch (err) {
            logger.warn(
              { err, jid },
              'Workspace created but container prewarm could not be started',
            );
          }
        }
        return profile;
      },
    );
  } catch (err) {
    logger.error({ err, jid, folder }, 'Workspace publication failed');
    fs.rmSync(groupDir, { recursive: true, force: true });
    return c.json({ error: 'Workspace publication failed' }, 500);
  }
  if (!publishedAgentProfile) {
    fs.rmSync(groupDir, { recursive: true, force: true });
    if (hostOnlyPolicyChangedDuringCreate) {
      return c.json(
        {
          error: '管理员纯宿主机模式已开启，请按宿主机模式重新创建工作区',
          code: 'ADMIN_HOST_ONLY_MODE_ENABLED',
        },
        409,
      );
    }
    return c.json({ error: '该智能体配置已失效；请选择其他智能体' }, 409);
  }

  // Mirror buildGroupsPayload ACL shape so the frontend doesn't need to
  // refetch /api/groups just to learn the writer can edit Skills/MCP.
  const groupWithJid = { ...group, jid };
  const isAdmin = hasHostExecutionPermission(authUser);
  const responseGroup: GroupPayloadItem = {
    name: group.name,
    folder: group.folder,
    added_at: group.added_at,
    kind: 'web',
    editable: true,
    deletable: true,
    lastMessage: undefined,
    lastMessageTime: now,
    execution_mode: group.executionMode || 'container',
    interaction_mode: interactionMode,
    custom_cwd: isAdmin ? group.customCwd : undefined,
    is_my_home: undefined,
    can_modify: canModifyGroup(authUser, groupWithJid),
    activation_mode: group.activation_mode ?? 'auto',
    conversation_source: group.conversation_source ?? 'manual',
    conversation_nav_mode: group.conversation_nav_mode ?? 'horizontal',
    agent_profile_id: publishedAgentProfile.id,
    agent_profile_name: publishedAgentProfile.name,
    agent_profile_version: publishedAgentProfile.version,
    agent_profile_avatar_emoji: publishedAgentProfile.avatar_emoji,
    agent_profile_avatar_color: publishedAgentProfile.avatar_color,
    agent_profile_avatar_url: publishedAgentProfile.avatar_url,
  };

  return c.json({
    success: true,
    jid,
    group: responseGroup,
  });
});

// PATCH /api/groups/:jid - 重命名群组
groupRoutes.patch('/:jid', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const jid = c.req.param('jid');
  const existing = getRegisteredGroup(jid);
  if (!existing) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;

  const body = await c.req.json().catch(() => ({}));
  const validation = GroupPatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const {
    name: rawName,
    is_pinned,
    activation_mode,
    execution_mode,
    interaction_mode,
  } = validation.data;
  const name = rawName ? normalizeGroupName(rawName) : undefined;

  // 至少需要提供一个字段
  if (
    !name &&
    is_pinned === undefined &&
    activation_mode === undefined &&
    execution_mode === undefined &&
    interaction_mode === undefined
  ) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // 不允许修改 is_home=true 的主容器执行模式（主容器由 loadState 强制管理）
  if (execution_mode !== undefined && existing.is_home) {
    return c.json(
      { error: 'Cannot change execution mode of home containers' },
      403,
    );
  }

  // member 用户不允许使用 host 模式（安全限制）
  if (execution_mode === 'host' && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }
  if (
    execution_mode === 'container' &&
    authUser.role === 'admin' &&
    authUser.status === 'active' &&
    getSystemSettings().adminHostOnlyMode
  ) {
    return c.json(
      {
        error: '管理员纯宿主机模式已开启，不能切换到 Docker 执行',
        code: 'ADMIN_HOST_ONLY_MODE_ENABLED',
      },
      409,
    );
  }

  // Pin/unpin only requires canAccessGroup (it's a per-user preference)
  const isPinOnly =
    is_pinned !== undefined &&
    !name &&
    activation_mode === undefined &&
    execution_mode === undefined &&
    interaction_mode === undefined;
  if (isPinOnly) {
    if (
      !canAccessGroup(
        { id: authUser.id, role: authUser.role },
        { ...existing, jid },
      )
    ) {
      return c.json({ error: 'Group not found' }, 404);
    }
  } else {
    // Name/skills changes require canModifyGroup (owner only)
    if (
      !canModifyGroup(
        { id: authUser.id, role: authUser.role },
        { ...existing, jid },
      )
    ) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!jid.startsWith('web:') && authUser.role !== 'admin') {
      return c.json({ error: 'This group cannot be edited' }, 403);
    }
    if (
      isHostExecutionGroup(existing) &&
      !hasHostExecutionPermission(authUser)
    ) {
      return c.json(
        { error: 'Insufficient permissions for host execution mode' },
        403,
      );
    }
    if (interaction_mode !== undefined && !jid.startsWith('web:')) {
      return c.json(
        { error: 'Only web workspaces can change interaction mode' },
        403,
      );
    }
  }

  // Handle pin/unpin (per-user, separate table)
  let pinned_at: string | undefined;
  if (is_pinned === true) {
    pinned_at = pinGroup(authUser.id, jid);
  } else if (is_pinned === false) {
    unpinGroup(authUser.id, jid);
  }

  // interaction_mode lives on the Workspace↔AgentProfile binding row, so a
  // workspace without one cannot store it. The startup backfill only maps
  // web workspaces whose created_by is set, leaving legacy ownerless rows
  // unbound. Refuse up front: throwing inside commitUpdate would surface as a
  // 500 and, on the quiesce path, only after the runtime was already stopped.
  if (
    interaction_mode !== undefined &&
    !getWorkspaceAgentProfileId(existing.folder)
  ) {
    return c.json(
      {
        error: '该工作区未绑定智能体配置，因此无法修改回复模式。',
        code: 'WORKSPACE_AGENT_PROFILE_MISSING',
      },
      409,
    );
  }

  // Interaction mode is stored on the Workspace↔AgentProfile binding rather
  // than registered_groups. It still shares the execution-mode quiesce
  // boundary so a warm runner can observe only the old or the new contract.
  if (
    name ||
    activation_mode !== undefined ||
    execution_mode !== undefined ||
    interaction_mode !== undefined
  ) {
    // Spread `...existing` instead of rebuilding from an explicit field list.
    // setRegisteredGroup is INSERT OR REPLACE (full-row overwrite), so every
    // field omitted from the object gets silently nulled. The old explicit list
    // dropped owner_im_id / sender_allowlist / conversation_source /
    // conversation_nav_mode / binding_mode / feishu_chat_mode /
    // feishu_group_message_type on EVERY rename — wiping the IM owner-gate's
    // security anchor and corrupting feishu_thread workspaces. Only override
    // what this PATCH actually changes.
    const updated: RegisteredGroup = {
      ...existing,
      name: name || existing.name,
      executionMode:
        execution_mode !== undefined
          ? (execution_mode as ExecutionMode)
          : existing.executionMode,
      activation_mode:
        activation_mode !== undefined
          ? activation_mode
          : existing.activation_mode,
    };

    const commitUpdate = () => {
      if (
        execution_mode === 'container' &&
        authUser.role === 'admin' &&
        authUser.status === 'active' &&
        getSystemSettings().adminHostOnlyMode
      ) {
        throw new AdminHostOnlyModeConflictError();
      }
      if (
        name ||
        activation_mode !== undefined ||
        execution_mode !== undefined
      ) {
        setRegisteredGroup(jid, updated);
        if (name) updateChatName(jid, name);
        deps.getRegisteredGroups()[jid] = updated;
      }
      if (
        interaction_mode !== undefined &&
        !setWorkspaceInteractionMode(existing.folder, interaction_mode)
      ) {
        // The pre-check above already rejected unbound workspaces, so reaching
        // here means the binding was deleted concurrently. Keep it a typed
        // error so both commit paths answer 409 instead of leaking a 500.
        throw new WorkspaceAgentProfileMissingError(
          `Workspace ${jid} has no AgentProfile binding for interaction mode update`,
        );
      }
      if (executionModeChanged || interactionModeChanged) {
        // SDK resume state is environment-bound. Never carry a host session
        // into a container, or an assistant/proactive transcript across output
        // authorities, after the old runner is stopped.
        deleteWorkspaceSessions(existing.folder);
        delete deps.sessions[existing.folder];
      }
    };

    const executionModeChanged =
      execution_mode !== undefined &&
      execution_mode !== (existing.executionMode || 'container');
    const interactionModeChanged =
      interaction_mode !== undefined &&
      interaction_mode !== getWorkspaceInteractionMode(existing.folder);
    const runtimeContractFieldProvided =
      execution_mode !== undefined || interaction_mode !== undefined;
    const runtimeWasSafetyBlocked =
      runtimeContractFieldProvided &&
      (deps.queue?.isGroupRuntimeSafetyBlocked?.(jid) ?? false);
    if (
      executionModeChanged ||
      interactionModeChanged ||
      (runtimeContractFieldProvided && runtimeWasSafetyBlocked)
    ) {
      const runtimeJids = getWorkspaceRuntimeJids(deps, existing.folder, jid);
      try {
        await quiesceWorkspaceRunnersAroundCommit(
          deps,
          [{ folder: existing.folder, primaryJid: jid }],
          {
            reason: `Workspace ${jid} runtime interaction contract changed`,
            onPostCommitFailure: (failedRuntimeJids) =>
              deps.queue?.blockGroupsForRuntimeSafety?.(
                failedRuntimeJids,
                `Workspace ${jid} runtime cleanup failed after interaction contract commit`,
              ),
          },
          commitUpdate,
        );
        deps.queue?.unblockGroupsForRuntimeSafety?.(runtimeJids);
      } catch (err) {
        if (err instanceof AdminHostOnlyModeConflictError) {
          return c.json(
            {
              error: '管理员纯宿主机模式已开启，不能切换到 Docker 执行',
              code: 'ADMIN_HOST_ONLY_MODE_ENABLED',
            },
            409,
          );
        }
        if (err instanceof WorkspaceAgentProfileMissingError) {
          deps.queue?.unblockGroupsForRuntimeSafety?.(runtimeJids);
          return c.json(
            {
              error: '该工作区未绑定智能体配置，因此无法修改回复模式。',
              code: 'WORKSPACE_AGENT_PROFILE_MISSING',
            },
            409,
          );
        }
        if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
        if (err.persisted) {
          deps.queue?.blockGroupsForRuntimeSafety?.(
            runtimeJids,
            `Workspace ${jid} runtime cleanup failed after interaction contract commit`,
          );
        }
        return c.json(
          {
            error: err.persisted
              ? 'Workspace interaction contract changed, but runtime cleanup failed; retry the request'
              : 'Failed to stop the active workspace; interaction contract was not changed',
            persisted: err.persisted,
            retryable: true,
          },
          503,
        );
      }
    } else {
      try {
        commitUpdate();
      } catch (err) {
        if (err instanceof AdminHostOnlyModeConflictError) {
          return c.json(
            {
              error: '管理员纯宿主机模式已开启，不能切换到 Docker 执行',
              code: 'ADMIN_HOST_ONLY_MODE_ENABLED',
            },
            409,
          );
        }
        if (!(err instanceof WorkspaceAgentProfileMissingError)) throw err;
        return c.json(
          {
            error: '该工作区未绑定智能体配置，因此无法修改回复模式。',
            code: 'WORKSPACE_AGENT_PROFILE_MISSING',
          },
          409,
        );
      }
    }
  }

  return c.json({
    success: true,
    pinned_at,
    interaction_mode: getWorkspaceInteractionMode(existing.folder),
  });
});

// PATCH /api/groups/:jid/agent-profile - 切换 workspace 归属的顶层 AgentProfile
groupRoutes.patch('/:jid/agent-profile', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const jid = c.req.param('jid');
  const existing = getRegisteredGroup(jid);
  if (!existing) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  if (
    !canModifyGroup(
      { id: authUser.id, role: authUser.role },
      { ...existing, jid },
    )
  ) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!jid.startsWith('web:')) {
    return c.json(
      { error: 'Only web workspaces can switch AgentProfile' },
      403,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = GroupAgentProfilePatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const profile = getAgentProfileForUser(
    validation.data.agent_profile_id,
    authUser.id,
  );
  if (!profile) return c.json({ error: '智能体配置不存在' }, 404);
  if (existing.is_home) {
    const defaultProfile = getOrCreateDefaultAgentProfile(authUser.id);
    if (profile.id !== defaultProfile.id) {
      return c.json(
        {
          error:
            'Home Workspace 始终属于内置 HappyClaw，不能迁移到自定义智能体',
          code: 'HOME_WORKSPACE_AGENT_IMMUTABLE',
        },
        409,
      );
    }
    assignWorkspaceAgentProfile(existing.folder, defaultProfile.id);
    return c.json({
      success: true,
      agent_profile_id: defaultProfile.id,
      agent_profile_name: defaultProfile.name,
      agent_profile_version: defaultProfile.version,
      interaction_mode: getWorkspaceInteractionMode(existing.folder),
      invalidated_runtime_jids: 0,
    });
  }

  let invalidatedRuntimeJids = 0;
  let committedProfile = profile;
  for (;;) {
    const observedOldProfileId =
      getWorkspaceAgentProfileId(existing.folder) ??
      getOrCreateDefaultAgentProfile(authUser.id).id;
    try {
      const outcome = await withAgentProfileLocks(
        [observedOldProfileId, profile.id],
        async () => {
          // DELETE may have archived the target while this request waited for
          // the locks. Never publish a mapping to a no-longer-active Agent.
          const lockedTarget = getAgentProfileForUser(profile.id, authUser.id);
          if (!lockedTarget) return { kind: 'target_missing' as const };

          // This route does not share a lock with workspace DELETE. Re-read the
          // workspace after acquiring the profile locks so a request that was
          // deleted or reassigned while we waited cannot be migrated from a
          // stale entry snapshot.
          const lockedWorkspace = getRegisteredGroup(jid);
          if (
            !lockedWorkspace ||
            lockedWorkspace.folder !== existing.folder ||
            !canModifyGroup(
              { id: authUser.id, role: authUser.role },
              { ...lockedWorkspace, jid },
            )
          ) {
            return { kind: 'workspace_missing' as const };
          }

          const lockedOldProfileId =
            getWorkspaceAgentProfileId(lockedWorkspace.folder) ??
            getOrCreateDefaultAgentProfile(authUser.id).id;
          if (lockedOldProfileId !== observedOldProfileId) {
            return { kind: 'retry' as const };
          }

          const result = await quiesceWorkspaceRunnersAroundCommit(
            deps,
            [{ folder: lockedWorkspace.folder, primaryJid: jid }],
            {
              reason: `Workspace ${jid} switched to Agent profile ${lockedTarget.id}`,
            },
            () => {
              // DELETE can finish while the pre-commit stop awaits. Keep this
              // final check and assignment synchronous so either migration
              // publishes first or deletion wins without an orphan mapping.
              const commitWorkspace = getRegisteredGroup(jid);
              if (
                !commitWorkspace ||
                commitWorkspace.folder !== existing.folder ||
                !canModifyGroup(
                  { id: authUser.id, role: authUser.role },
                  { ...commitWorkspace, jid },
                )
              ) {
                // Throw before any assignment. A false return would be
                // indistinguishable from a successful commit to the generic
                // quiesce helper, causing it to run post-stop and potentially
                // report persisted:true even though nothing was written.
                throw new WorkspaceMissingDuringMigrationError();
              }
              assignWorkspaceAgentProfile(
                commitWorkspace.folder,
                lockedTarget.id,
              );
            },
          );
          return { kind: 'success' as const, result, profile: lockedTarget };
        },
      );
      if (outcome.kind === 'retry') continue;
      if (outcome.kind === 'target_missing') {
        return c.json({ error: '该智能体配置已失效' }, 409);
      }
      if (outcome.kind === 'workspace_missing') {
        return c.json(
          { error: 'Workspace no longer exists or changed during migration' },
          409,
        );
      }
      invalidatedRuntimeJids = outcome.result.runtimeJids.length;
      committedProfile = outcome.profile;
      break;
    } catch (err) {
      if (err instanceof WorkspaceMissingDuringMigrationError) {
        return c.json(
          {
            error: err.message,
            persisted: false,
          },
          409,
        );
      }
      if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
      logger.error(
        {
          err,
          jid,
          folder: existing.folder,
          agentProfileId: profile.id,
          persisted: err.persisted,
        },
        err.persisted
          ? 'Workspace Agent profile persisted but post-commit runtime cleanup failed'
          : 'Workspace Agent profile switch aborted before persistence',
      );
      return c.json(
        {
          error: err.persisted
            ? '工作区智能体配置已更新，但运行时清理失败；请重试相同请求'
            : '无法停止活动运行时；工作区智能体配置未更新',
          persisted: err.persisted,
          retryable: true,
          agent_profile_id: err.persisted ? profile.id : undefined,
        },
        503,
      );
    }
  }

  return c.json({
    success: true,
    agent_profile_id: committedProfile.id,
    agent_profile_name: committedProfile.name,
    agent_profile_version: committedProfile.version,
    interaction_mode: getWorkspaceInteractionMode(existing.folder),
    invalidated_runtime_jids: invalidatedRuntimeJids,
  });
});

// POST /api/groups/:jid/reset-owner — admin break-glass for a stuck IM owner.
// The IM owner-gate keys destructive commands on owner_im_id === sender. If the
// recorded owner leaves the group / switches account, nobody matches and
// /release_owner (owner-only) can't fire either, so owner-only commands lock up
// permanently. A platform admin can force-release here; the next user reclaims
// via /owner_mention (or DM auto-claim).
groupRoutes.post('/:jid/reset-owner', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json(
      { error: 'Only an admin can reset the workspace owner' },
      403,
    );
  }

  const jid = c.req.param('jid');
  const existing = getRegisteredGroup(jid);
  if (!existing) return c.json({ error: 'Group not found' }, 404);

  // Same transition as /release_owner — clearing the owner anchor + allowlist
  // and downgrading owner_mentioned → when_mentioned is the shared invariant
  // (see group-owner.ts): without the downgrade isGroupOwnerMessage returns
  // false for everyone once owner_im_id is gone and the bot goes silent
  // group-wide.
  const updated = releaseOwner(existing);
  persistGroupUpdate(jid, updated, deps.getRegisteredGroups());
  logger.info(
    { jid, adminId: authUser.id },
    'Workspace owner force-reset by admin (/reset-owner)',
  );
  return c.json({ success: true });
});

// GET /api/groups/:jid/delete-impact - 删除前检查渠道绑定
groupRoutes.get('/:jid/delete-impact', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const existing = getRegisteredGroup(jid);
  if (!existing) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  if (!canDeleteGroup({ id: authUser.id, role: authUser.role }, existing)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!jid.startsWith('web:')) {
    return c.json({ error: 'This group cannot be deleted here' }, 400);
  }
  if (isHostExecutionGroup(existing) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  return c.json(
    workspaceDeleteImpactPayload(collectWorkspaceDeleteBindings(jid, existing)),
  );
});

// DELETE /api/groups/:jid - 删除群组
groupRoutes.delete('/:jid', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const jid = c.req.param('jid');
  const existing = getRegisteredGroup(jid);
  if (!existing) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  if (!canDeleteGroup({ id: authUser.id, role: authUser.role }, existing)) {
    return c.json({ error: 'Group not found' }, 404);
  }

  // IM-prefixed groups (feishu:, telegram:, qq:, etc.) follow a separate
  // cleanup path. They share their folder with the owner's home workspace,
  // so we must NOT touch folder-scoped data (sessions, scheduled_tasks) or
  // the workspace directory.
  if (!jid.startsWith('web:')) {
    if (!getChannelType(jid)) {
      return c.json({ error: 'This group cannot be deleted' }, 403);
    }
    // Reuse the shared helper so the manual delete path also resets
    // imSendFailCounts / imHealthCheckFailCounts, matching the auto-cleanup
    // paths (bot removed / health check / send fail).
    if (deps.removeImGroupRecord) {
      deps.removeImGroupRecord(jid, 'Manually deleted via API');
    } else {
      deleteImGroupRecord(jid);
      delete deps.getRegisteredGroups()[jid];
    }
    deps.setLastAgentTimestamp(jid, { timestamp: '', id: '' });
    return c.json({ success: true });
  }

  if (isHostExecutionGroup(existing) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  const confirmedChannelUnbind = c.req.query('unbind_channels') === 'true';
  const initialBindingSummary = collectWorkspaceDeleteBindings(jid, existing);
  if (initialBindingSummary.hasChannelBindings && !confirmedChannelUnbind) {
    return c.json(
      {
        error: '该工作区绑定了 IM 群组，请先解绑后再删除。',
        requires_unbind_confirmation: true,
        ...workspaceDeleteImpactPayload(initialBindingSummary),
      },
      409,
    );
  }

  // Wait for container to fully stop before cleaning up its files.
  // Must include sibling JIDs (same folder) AND descendant virtual JIDs —
  // sub-agents (`{jid}#agent:{id}`) and scheduled tasks (`{jid}#task:{id}`) —
  // mirroring clear-history. Otherwise those runners keep executing with their
  // cwd/session dirs deleted out from under them (container/process leak + ENOENT).
  const deleteSiblingJids = getJidsByFolder(existing.folder);
  const deleteDescendantJids = Array.from(
    new Set(deleteSiblingJids.flatMap((j) => deps.queue.listDescendantJids(j))),
  );
  const deleteStopJids = Array.from(
    new Set([jid, ...deleteSiblingJids, ...deleteDescendantJids]),
  );
  // Unlike an Agent identity mutation, deletion is destructive: work accepted
  // after this point must be parked across the entire serialization family and
  // then discarded after the DB/filesystem commit, never resumed against the
  // deleted workspace. The batch pause is intentionally acquired before the
  // first await so new sibling and virtual-descendant work cannot slip between
  // individual stopGroup calls.
  const deletePauseToken = deps.queue.pauseGroupsForMutation(deleteStopJids);
  let deleteCommitted = false;
  try {
    try {
      // Do not preserve queued work for permanent deletion. stopGroup clears
      // work that was already known; discardGroupsAfterMutation below clears
      // anything newly parked while these asynchronous stops were in flight.
      await Promise.all(
        deleteStopJids.map((j) => deps.queue.stopGroup(j, { force: true })),
      );
    } catch (err) {
      logger.error(
        { jid, stopJids: deleteStopJids, err },
        'Failed to stop container before deleting group',
      );
      return c.json(
        { error: 'Failed to stop container, group not deleted' },
        500,
      );
    }

    // Binding APIs are independent from the message queue and may have changed
    // while runners were stopping. Re-read after the await so an unconfirmed
    // delete never absorbs a newly-created channel binding.
    const freshExisting = getRegisteredGroup(jid);
    if (!freshExisting) {
      return c.json({ error: 'Group not found' }, 404);
    }
    const freshBindingSummary = collectWorkspaceDeleteBindings(
      jid,
      freshExisting,
    );
    if (freshBindingSummary.hasChannelBindings && !confirmedChannelUnbind) {
      return c.json(
        {
          error: '该工作区新增了渠道绑定，请确认解绑后再删除。',
          requires_unbind_confirmation: true,
          ...workspaceDeleteImpactPayload(freshBindingSummary),
        },
        409,
      );
    }

    const excludedWorkspaceJids = new Set([jid, `web:${freshExisting.folder}`]);
    const channelUpdates: Array<{
      jid: string;
      group: RegisteredGroup;
    }> = [];
    const nativeThreadTargets = new Set<string>();

    deleteGroupData(jid, freshExisting.folder, {
      // Resolve and create any fallback direct sessions inside the same SQLite
      // transaction as the workspace deletion. A crash must not leave a DM on
      // a shared main mount or publish a half-created session route.
      channelUpdates: () => {
        if (!confirmedChannelUnbind) return channelUpdates;
        for (const channelJid of freshBindingSummary.mountedChannelJids) {
          const channelGroup = getRegisteredGroup(channelJid);
          if (!channelGroup) continue;
          const restored = resolveDefaultChannelMountForWorkspaceDeletion(
            channelJid,
            channelGroup,
            channelGroup.created_by ?? authUser.id,
            excludedWorkspaceJids,
          );
          if (restored.status === 'resolved') {
            const updated =
              resolveChannelConversationKind(channelJid) === 'direct'
                ? ensureDirectChannelSessionMount({
                    sourceJid: channelJid,
                    group: restored.updated,
                    workspaceJid: restored.workspaceJid,
                    userId: channelGroup.created_by ?? authUser.id,
                    force: true,
                    mountOptions: { replyPolicy: 'source_only' },
                  })
                : restored.updated;
            channelUpdates.push({ jid: channelJid, group: updated });
            if (restored.routingMode === 'thread_map') {
              nativeThreadTargets.add(restored.workspaceJid);
            }
          } else {
            // A damaged legacy account may have no viable default workspace.
            // Clearing its route is still safer than leaving a dangling pointer
            // to the workspace that is about to disappear.
            channelUpdates.push({
              jid: channelJid,
              group: buildUnmountUpdate(channelGroup),
            });
          }
        }
        return channelUpdates;
      },
    });
    deleteCommitted = true;

    const registeredGroups = deps.getRegisteredGroups();
    for (const update of channelUpdates) {
      if (registeredGroups[update.jid]) {
        registeredGroups[update.jid] = update.group;
      }
    }
    for (const targetJid of nativeThreadTargets) {
      const target = getRegisteredGroup(targetJid);
      if (!target || targetJid === jid) continue;
      const updatedTarget = buildNativeThreadWorkspaceUpdate(target);
      setRegisteredGroup(targetJid, updatedTarget);
      if (registeredGroups[targetJid]) {
        registeredGroups[targetJid] = updatedTarget;
      }
    }
    delete registeredGroups[jid];
    delete deps.getSessions()[freshExisting.folder];
    deps.setLastAgentTimestamp(jid, { timestamp: '', id: '' });

    removeFlowArtifacts(freshExisting.folder);

    logger.info(
      {
        jid,
        userId: authUser.id,
        channelBindingCount: freshBindingSummary.channelBindingCount,
        reroutedChannels: channelUpdates.length,
      },
      'Workspace deleted with confirmed channel cleanup',
    );

    return c.json({
      success: true,
      unbound_channel_count: channelUpdates.length,
    });
  } finally {
    if (deleteCommitted) {
      deps.queue.discardGroupsAfterMutation(deletePauseToken);
    } else {
      // Stop/DB failure leaves the workspace valid, so accepted work remains
      // legitimate and must drain once the failed delete releases its gate.
      deps.queue.resumeGroupsAfterMutation(deletePauseToken);
    }
  }
});

// POST /api/groups/:jid/stop - 停止当前运行的容器/进程
groupRoutes.post('/:jid/stop', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (
    !canModifyGroup({ id: authUser.id, role: authUser.role }, { ...group, jid })
  ) {
    return c.json({ error: 'Only the workspace owner can stop it' }, 403);
  }

  try {
    await deps.queue.stopGroup(jid);
    return c.json({ success: true });
  } catch (err) {
    logger.error({ jid, err }, 'Failed to stop group');
    return c.json({ error: 'Failed to stop container' }, 500);
  }
});

// POST /api/groups/:jid/interrupt - 中断当前查询（不杀容器）
groupRoutes.post('/:jid/interrupt', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const rawJid = c.req.param('jid');
  const jid = decodeURIComponent(rawJid);
  // Support virtual JIDs for conversation agents: {jid}#agent:{agentId}
  const agentSep = jid.indexOf('#agent:');
  const baseJid = agentSep >= 0 ? jid.slice(0, agentSep) : jid;
  const group = getRegisteredGroup(baseJid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (
    !canModifyGroup(
      { id: authUser.id, role: authUser.role },
      { ...group, jid: baseJid },
    )
  ) {
    return c.json({ error: 'Only the workspace owner can interrupt it' }, 403);
  }

  const interrupted = deps.queue.interruptQuery(jid);
  if (interrupted) {
    // ── 立即 abort 飞书流式卡片 ──
    const session = getStreamingSession(jid);
    if (session?.isActive()) {
      session.abort('已停止').catch(() => {});
    }

    // Persist interrupt as a system marker so refresh/state-restore can
    // deterministically clear waiting even when no assistant reply exists.
    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    try {
      ensureChatExists(jid);
      storeMessageDirect(
        messageId,
        jid,
        '__system__',
        'system',
        'query_interrupted',
        timestamp,
        true,
      );
      broadcastNewMessage(jid, {
        id: messageId,
        chat_jid: jid,
        sender: '__system__',
        sender_name: 'system',
        content: 'query_interrupted',
        timestamp,
        is_from_me: true,
      });
    } catch (err) {
      logger.warn(
        { jid, err },
        'Interrupt succeeded but failed to append system marker',
      );
    }
  }
  return c.json({ success: true, interrupted });
});

// POST /api/groups/:jid/reset-session - 重置会话上下文
// Optional body: { agentId?: string } — when provided, only reset that agent's session
groupRoutes.post('/:jid/reset-session', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (
    !canModifyGroup({ id: authUser.id, role: authUser.role }, { ...group, jid })
  ) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  // Read optional agentId from request body
  let agentId: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    if (body && typeof body.agentId === 'string' && body.agentId) {
      agentId = body.agentId;
    }
  } catch {
    /* no body or invalid JSON — treat as main session reset */
  }

  // Validate agentId belongs to this group
  if (agentId) {
    const agent = getAgent(agentId);
    if (!agent || agent.chat_jid !== jid) {
      return c.json({ error: 'Agent not found' }, 404);
    }
  }

  // 1. Stop running processes
  try {
    if (agentId) {
      // Agent-specific: only stop the agent's virtual JID process
      const virtualJid = `${jid}#agent:${agentId}`;
      await deps.queue.stopGroup(virtualJid, { force: true });
    } else {
      // Main session: stop ALL processes for this folder
      const siblingJids = getJidsByFolder(group.folder);
      await Promise.all(
        siblingJids.map((j) => deps.queue.stopGroup(j, { force: true })),
      );
    }
  } catch (err) {
    logger.error(
      { jid, agentId, err },
      'Failed to stop containers before resetting session',
    );
    return c.json(
      { error: 'Failed to stop container, session not reset' },
      500,
    );
  }

  // 2. Delete session JSONL files so Claude starts fresh.
  try {
    clearSessionFiles(group.folder, agentId);
  } catch (err) {
    logger.error(
      { jid, folder: group.folder, agentId, err },
      'Failed to clear session files during reset',
    );
    return c.json(
      { error: 'Failed to clear session files, session not reset' },
      500,
    );
  }

  // 3. Delete session from DB (and in-memory cache for main session).
  try {
    deleteSession(group.folder, agentId);
    clearSessionChannelOwner(group.folder, agentId);
    if (!agentId) {
      delete deps.getSessions()[group.folder];
    }
  } catch (err) {
    logger.error(
      { jid, folder: group.folder, agentId, err },
      'Failed to clear session state during reset',
    );
    return c.json(
      { error: 'Failed to clear session state, session not reset' },
      500,
    );
  }

  // 4. Insert system divider message into the correct JID (best-effort).
  const targetJid = agentId ? `${jid}#agent:${agentId}` : jid;
  const dividerMessageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  try {
    ensureChatExists(targetJid);
    storeMessageDirect(
      dividerMessageId,
      targetJid,
      '__system__',
      'system',
      'context_reset',
      timestamp,
      true,
    );

    broadcastNewMessage(targetJid, {
      id: dividerMessageId,
      chat_jid: targetJid,
      sender: '__system__',
      sender_name: 'system',
      content: 'context_reset',
      timestamp,
      is_from_me: true,
    });
  } catch (err) {
    logger.warn(
      { jid, agentId, err },
      'Session reset succeeded but failed to append divider message',
    );
  }

  // 5. Advance lastAgentTimestamp so old messages before the reset are not
  //    re-sent to the next fresh agent session.
  if (agentId) {
    const virtualJid = `${jid}#agent:${agentId}`;
    deps.setLastAgentTimestamp(virtualJid, { timestamp, id: dividerMessageId });
  } else {
    // Main session: advance cursor for ALL sibling JIDs sharing this folder.
    const siblingJids = getJidsByFolder(group.folder);
    for (const siblingJid of siblingJids) {
      deps.setLastAgentTimestamp(siblingJid, {
        timestamp,
        id: dividerMessageId,
      });
    }
  }

  logger.info(
    { jid, folder: group.folder, agentId },
    'Session reset: cleared session files and stopped containers',
  );

  return c.json({ success: true, dividerMessageId });
});

// POST /api/groups/:jid/clear-history - 清除聊天历史
groupRoutes.post('/:jid/clear-history', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (
    !canModifyGroup({ id: authUser.id, role: authUser.role }, { ...group, jid })
  ) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  // Collect all JIDs sharing the same folder (e.g., web:main + feishu groups)
  const siblingJids = getJidsByFolder(group.folder);
  const workspaceJids = siblingJids.filter((candidate) =>
    candidate.startsWith('web:'),
  );

  // Freeze the whole serialization family before the first await. Work arriving
  // during rebuild remains parked and runs against the fresh workspace after
  // the mutation gate is released.
  const descendantJids = Array.from(
    new Set(siblingJids.flatMap((j) => deps.queue.listDescendantJids(j))),
  );
  const stopJids = Array.from(
    new Set([jid, ...siblingJids, ...descendantJids]),
  );
  const pauseToken = deps.queue.pauseGroupsForMutation(stopJids);
  let taskPause: ReturnType<typeof pauseWorkspaceTasksForRebuild> | null = null;
  let stagedReset: StagedWorkspaceReset | null = null;
  let databaseCommitted = false;
  try {
    // Pause definitions synchronously so the scheduler cannot admit another
    // occurrence while active task processes are being cancelled.
    taskPause = pauseWorkspaceTasksForRebuild(group.folder);
    if (taskPause.activeRunIds.length > 0 && !deps.cancelTaskRun) {
      throw new Error(
        'Scheduler is unavailable while task runs are active; workspace not rebuilt',
      );
    }
    for (const runId of taskPause.activeRunIds) {
      const cancelled = deps.cancelTaskRun!(runId);
      if (!cancelled.success) {
        throw new Error(
          cancelled.error ||
            `Failed to cancel scheduled task run during rebuild: ${runId}`,
        );
      }
    }

    // Stop every current Main/Session/Task/Spawn runner before moving files.
    await Promise.all(
      stopJids.map((j) => deps.queue.stopGroup(j, { force: true })),
    );
    if (
      taskPause.activeRunIds.length > 0 &&
      deps.waitForTaskRunsToStop &&
      !(await deps.waitForTaskRunsToStop(taskPause.activeRunIds))
    ) {
      throw new Error(
        'Timed out waiting for scheduled task processes to stop; workspace not rebuilt',
      );
    }
    if (taskPause.activeRunIds.length > 0 && !deps.waitForTaskRunsToStop) {
      throw new Error(
        'Scheduler cannot confirm task process shutdown; workspace not rebuilt',
      );
    }

    // Files are moved aside rather than deleted. The SQLite transaction below
    // either commits the whole rebuild or leaves the database untouched, in
    // which case catch restores these exact directories.
    stagedReset = stageWorkspaceResetForGroup(group.folder);
    const result = rebuildWorkspacePersistentState({
      groupFolder: group.folder,
      workspaceJids,
      siblingJids,
    });
    databaseCommitted = true;

    const cleanupFailures = stagedReset.commit();
    stagedReset = null;
    if (cleanupFailures.length > 0) {
      logger.warn(
        { jid, folder: group.folder, cleanupFailures },
        'Workspace rebuild committed but backup cleanup was incomplete',
      );
    }

    // Refresh process-local projections only after the durable commit. A cache
    // refresh failure must not turn a successfully committed rebuild into a
    // misleading 500 response: the authoritative state is already in SQLite.
    try {
      delete deps.getSessions()[group.folder];
      for (const siblingJid of siblingJids) {
        deps.setLastAgentTimestamp(siblingJid, { timestamp: '', id: '' });
      }
      const deletedAgentIds = new Set(result.deletedAgentIds);
      const unboundCount = clearTargetAgentBindingsForDeletedAgents(
        deps.getRegisteredGroups(),
        deletedAgentIds,
        (targetJid, updated) => {
          setRegisteredGroup(targetJid, updated);
          deps.getRegisteredGroups()[targetJid] = updated;
          deps.clearImFailCounts?.(targetJid);
        },
      );
      if (unboundCount > 0) {
        logger.info(
          { jid, folder: group.folder, unboundCount },
          'Cleared IM agent bindings for rebuilt workspace',
        );
      }
    } catch (cacheRefreshError) {
      logger.warn(
        { jid, folder: group.folder, cacheRefreshError },
        'Workspace rebuild committed but process-local cache refresh failed',
      );
    }

    logger.info(
      {
        jid,
        folder: group.folder,
        siblingJids,
        deletedAgentCount: result.deletedAgentIds.length,
        recycledTaskCount: result.recycledTaskIds.length,
      },
      'Rebuilt workspace files, Memory, tasks, context and chat history',
    );
    return c.json({ success: true });
  } catch (err) {
    let rollbackError: unknown =
      err instanceof WorkspaceFilesystemRollbackError ? err : undefined;
    if (!databaseCommitted && stagedReset) {
      try {
        stagedReset.rollback();
        stagedReset = null;
      } catch (error) {
        rollbackError = error;
      }
    }
    let taskRestore:
      | ReturnType<typeof restoreWorkspaceTasksAfterFailedRebuild>
      | undefined;
    if (!databaseCommitted && taskPause) {
      try {
        taskRestore = restoreWorkspaceTasksAfterFailedRebuild(taskPause);
        if (taskRestore.conflicts.length > 0) {
          const conflictError = new Error(
            `Task rollback conflicted for: ${taskRestore.conflicts.join(', ')}`,
          );
          rollbackError = rollbackError
            ? new AggregateError([rollbackError, conflictError])
            : conflictError;
        }
      } catch (error) {
        rollbackError = rollbackError
          ? new AggregateError([rollbackError, error])
          : error;
      }
    }
    logger.error(
      {
        jid,
        folder: group.folder,
        stopJids,
        err,
        rollbackError,
        taskRestore,
      },
      'Workspace rebuild failed',
    );
    return c.json(
      {
        error: rollbackError
          ? 'Workspace rebuild failed and automatic rollback was incomplete'
          : 'Workspace rebuild failed; original data was restored',
      },
      500,
    );
  } finally {
    deps.queue.resumeGroupsAfterMutation(pauseToken);
  }
});

// GET /api/groups/:jid/messages - 获取消息历史
groupRoutes.get('/:jid/messages', authMiddleware, async (c) => {
  // Messages are per-user sensitive content.  Block intermediary caches and
  // browser HTTP cache; PWA service worker handles its own caching policy
  // explicitly (NetworkFirst with explicit invalidation on clear/delete).
  c.header('Cache-Control', 'private, no-store');

  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  const before = c.req.query('before');
  const after = c.req.query('after');
  const agentIdParam = c.req.query('agentId');
  const limitRaw = parseInt(c.req.query('limit') || '50', 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) ? Math.max(1, limitRaw) : 50,
    200,
  );

  // Agent conversation: query messages from the virtual chat_jid
  if (agentIdParam) {
    const agent = getAgent(agentIdParam);
    if (!agent || agent.chat_jid !== jid) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    const virtualJid = `${jid}#agent:${agentIdParam}`;
    if (after) {
      const messages = attachSessionWorkflowRuns(
        getMessagesAfter(virtualJid, after, limit),
        { groupFolder: group.folder, agentId: agentIdParam },
      );
      return c.json({ messages });
    }
    const rows = getMessagesPage(virtualJid, before, limit + 1);
    const hasMore = rows.length > limit;
    const messages = attachSessionWorkflowRuns(
      hasMore ? rows.slice(0, limit) : rows,
      { groupFolder: group.folder, agentId: agentIdParam },
    );
    return c.json({ messages, hasMore });
  }

  // is_home 群组合并查询：将同一 owner、同 folder 下的 Web 与 IM 消息合并展示。
  // 已绑定到其它工作区的 IM 会话必须排除：它的 folder/created_by 仍停留在渠道
  // 账号归属人，若只按 folder + owner 合并，别的工作区的对话会出现在账号归属人
  // 的 Home 历史里。
  const queryJids = [jid];
  if (group.is_home) {
    const siblingJids = getJidsByFolder(group.folder);
    for (const siblingJid of siblingJids) {
      if (siblingJid === jid) continue;
      const siblingGroup = getRegisteredGroup(siblingJid);
      if (!siblingGroup) continue;
      const ownerMatch =
        group.created_by && siblingGroup.created_by === group.created_by;
      if (!ownerMatch) continue;
      const attributionDeps = {
        getRegisteredGroup,
        getAgent,
        getJidsByFolder,
        getChannelMount,
      };
      const boundJid = resolveBoundWorkspaceJid(siblingJid, attributionDeps);
      if (
        (boundJid && boundJid !== jid) ||
        (!boundJid && hasBoundWorkspaceReference(siblingJid, attributionDeps))
      ) {
        continue;
      }
      queryJids.push(siblingJid);
    }
  }

  if (queryJids.length === 1) {
    // 单 JID 走原路径
    if (after) {
      const messages = attachSessionWorkflowRuns(
        getMessagesAfter(jid, after, limit),
        { groupFolder: group.folder, agentId: null },
      );
      return c.json({ messages });
    }
    const rows = getMessagesPage(jid, before, limit + 1);
    const hasMore = rows.length > limit;
    const messages = attachSessionWorkflowRuns(
      hasMore ? rows.slice(0, limit) : rows,
      { groupFolder: group.folder, agentId: null },
    );
    return c.json({ messages, hasMore });
  }

  // 多 JID 合并查询
  if (after) {
    const messages = attachSessionWorkflowRuns(
      getMessagesAfterMulti(queryJids, after, limit),
      { groupFolder: group.folder, agentId: null },
    );
    return c.json({ messages });
  }
  const rows = getMessagesPageMulti(queryJids, before, limit + 1);
  const hasMore = rows.length > limit;
  const messages = attachSessionWorkflowRuns(
    hasMore ? rows.slice(0, limit) : rows,
    { groupFolder: group.folder, agentId: null },
  );
  return c.json({ messages, hasMore });
});

// DELETE /api/groups/:jid/messages/:messageId - 删除单条消息
groupRoutes.delete('/:jid/messages/:messageId', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const messageId = c.req.param('messageId');
  const group = getRegisteredGroup(jid);
  if (!group) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }

  // Ownership check: admin can delete any message, non-admin can only delete their own
  const msg = getMessage(jid, messageId);
  if (!msg) {
    return c.json({ error: 'Message not found' }, 404);
  }
  if (authUser.role !== 'admin') {
    // AI messages (is_from_me=1) cannot be deleted by non-admin
    // User messages can only be deleted by the sender
    if (msg.is_from_me === 1 || (msg.sender && msg.sender !== authUser.id)) {
      return c.json({ error: 'Permission denied' }, 403);
    }
  }

  const deleted = deleteMessage(jid, messageId);
  if (!deleted) {
    return c.json({ error: 'Message not found' }, 404);
  }

  return c.json({ success: true });
});

// GET /api/groups/:jid/env - 获取容器环境变量配置
groupRoutes.get('/:jid/env', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const user = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: user.id, role: user.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(user)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  // Check permissions: 与 PUT 对称收紧为 owner-only。`customEnv` 含
  // 第三方 token（GitHub / 自定义 API key 等），即使 toPublicContainerEnvForUser
  // 把 anthropic/openai 字段做了 mask，customEnv 仍是明文返回；shared
  // workspace 中持有 manage_group_env 的非 owner 不应能读 owner 的私密 env。
  if (
    user.role !== 'admin' &&
    !canModifyGroup({ id: user.id, role: user.role }, { ...group, jid })
  ) {
    return c.json(
      { error: 'Forbidden: only the workspace owner can read env' },
      403,
    );
  }
  if (
    user.role !== 'admin' &&
    (!user.permissions || !user.permissions.includes('manage_group_env'))
  ) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const config = getContainerEnvConfig(group.folder);
  return c.json(toPublicContainerEnvForUser(config, user));
});

// PUT /api/groups/:jid/env - 更新容器环境变量配置
groupRoutes.put('/:jid/env', authMiddleware, async (c) => {
  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const envUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: envUser.id, role: envUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(envUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  // Check permissions：owner-only。`manage_group_env` 是系统级权限但 envvar
  // 包含 anthropicAuthToken 等会让 agent 全部流量被劫持的字段，跨用户共享
  // 工作区里持有该权限的非 owner 不能改 owner 的 token。Admin 例外。
  if (
    envUser.role !== 'admin' &&
    !canModifyGroup({ id: envUser.id, role: envUser.role }, { ...group, jid })
  ) {
    return c.json(
      { error: 'Forbidden: only the workspace owner can modify env' },
      403,
    );
  }
  if (
    envUser.role !== 'admin' &&
    (!envUser.permissions || !envUser.permissions.includes('manage_group_env'))
  ) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = ContainerEnvSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const data = validation.data;

  // Validate customEnv keys/values to prevent env injection
  if (data.customEnv) {
    const envKeyRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const [key, value] of Object.entries(data.customEnv)) {
      if (!envKeyRe.test(key)) {
        return c.json(
          {
            error: `Invalid env key: "${key}". Keys must match [A-Za-z_][A-Za-z0-9_]*`,
          },
          400,
        );
      }
      if (/[\r\n\0]/.test(value)) {
        return c.json(
          {
            error: `Env value for "${key}" contains invalid control characters`,
          },
          400,
        );
      }
    }
  }

  const current = getContainerEnvConfig(group.folder);

  // Build updated config: only update fields that are explicitly provided
  const updated = { ...current };

  if (data.anthropicBaseUrl !== undefined)
    updated.anthropicBaseUrl = data.anthropicBaseUrl;
  if (data.anthropicAuthToken !== undefined)
    updated.anthropicAuthToken = data.anthropicAuthToken;
  if (data.anthropicApiKey !== undefined)
    updated.anthropicApiKey = data.anthropicApiKey;
  if (data.claudeCodeOauthToken !== undefined)
    updated.claudeCodeOauthToken = data.claudeCodeOauthToken;
  if (data.anthropicModel !== undefined)
    updated.anthropicModel = data.anthropicModel;
  if (data.customEnv !== undefined) updated.customEnv = data.customEnv;

  try {
    saveContainerEnvConfig(group.folder, updated);

    // Restart container so it picks up the new env immediately
    const deps = getWebDeps();
    if (deps) {
      await deps.queue.restartGroup(jid);
      logger.info(
        { jid, folder: group.folder },
        'Restarted container after env config update',
      );
    }

    return c.json(toPublicContainerEnvConfig(updated));
  } catch (err) {
    logger.error({ err }, 'Failed to save container env config');
    return c.json({ error: 'Failed to save config' }, 500);
  }
});

// --- MCP Configuration Routes ---

// GET /api/groups/:jid/mcp - 获取工作区 MCP 配置
groupRoutes.get('/:jid/mcp', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }

  return c.json({
    mcp_mode: group.mcp_mode ?? 'inherit',
    selected_mcps: group.selected_mcps ?? null,
  });
});

// PUT /api/groups/:jid/mcp - 更新工作区 MCP 配置
groupRoutes.put('/:jid/mcp', authMiddleware, async (c) => {
  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const mcp_mode = body.mcp_mode;
  const selected_mcps = body.selected_mcps;

  // Validate mcp_mode
  if (
    mcp_mode !== undefined &&
    mcp_mode !== 'inherit' &&
    mcp_mode !== 'custom'
  ) {
    return c.json({ error: 'Invalid mcp_mode' }, 400);
  }

  // Validate selected_mcps
  if (selected_mcps !== undefined && selected_mcps !== null) {
    if (!Array.isArray(selected_mcps)) {
      return c.json({ error: 'selected_mcps must be an array' }, 400);
    }
    for (const mcp of selected_mcps) {
      if (typeof mcp !== 'string') {
        return c.json({ error: 'selected_mcps must contain strings' }, 400);
      }
    }
  }

  // Update the group
  const updatedGroup: RegisteredGroup = {
    ...group,
    mcp_mode: mcp_mode ?? group.mcp_mode ?? 'inherit',
    selected_mcps:
      selected_mcps !== undefined ? selected_mcps : group.selected_mcps,
  };

  setRegisteredGroup(jid, updatedGroup);

  return c.json({
    success: true,
    mcp_mode: updatedGroup.mcp_mode,
    selected_mcps: updatedGroup.selected_mcps,
  });
});

export default groupRoutes;
