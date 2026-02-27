import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  GroupCreateSchema,
  GroupPatchSchema,
  GroupMemberAddSchema,
  ContainerEnvSchema,
} from '../schemas.js';
import type { AuthUser, RegisteredGroup, ExecutionMode } from '../types.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { HOME_DIR } from '../environment.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
  canModifyGroup,
  canDeleteGroup,
  canManageGroupMembers,
  MAX_GROUP_NAME_LEN,
  getWebDeps,
} from '../web-context.js';
import {
  getRegisteredGroup,
  setRegisteredGroup,
  deleteRegisteredGroup,
  getAllRegisteredGroups,
  getAllChats,
  getJidsByFolder,
  updateChatName,
  deleteSession,
  deleteChatHistory,
  deleteGroupData,
  ensureChatExists,
  storeMessageDirect,
  getMessagesPage,
  getMessagesAfter,
  getMessagesPageMulti,
  getMessagesAfterMulti,
  addGroupMember,
  removeGroupMember,
  getGroupMembers,
  getGroupMemberRole,
  getUserById,
  getAgent,
  listUsers,
} from '../db.js';
import { logger } from '../logger.js';
import {
  getContainerEnvConfig,
  saveContainerEnvConfig,
  deleteContainerEnvConfig,
  toPublicContainerEnvConfig,
} from '../runtime-config.js';
import {
  loadMountAllowlist,
  findAllowedRoot,
  matchesBlockedPattern,
} from '../mount-security.js';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { z } from 'zod';
import { broadcastNewMessage, invalidateAllowedUserCache } from '../web.js';

const execFileAsync = promisify(execFile);

/**
 * 检查 hostname 是否为内网地址（SSRF 防护）。
 * 拒绝 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, ::1, fd00::, fe80:: 等。
 */
function isPrivateHostname(hostname: string): boolean {
  // localhost 变体
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;

  // IPv6: 移除方括号
  const cleaned = hostname.replace(/^\[|\]$/g, '');

  if (net.isIPv6(cleaned)) {
    const lower = cleaned.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // fd00::/8 (unique local) 和 fe80::/10 (link-local)
    if (lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    // ::ffff:127.0.0.1 等 IPv4-mapped IPv6
    if (lower.startsWith('::ffff:')) {
      const ipv4Part = lower.slice(7);
      return isPrivateIPv4(ipv4Part);
    }
    return false;
  }

  if (net.isIPv4(cleaned)) {
    return isPrivateIPv4(cleaned);
  }

  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0
  if (a === 0) return true;
  return false;
}

const groupRoutes = new Hono<{ Variables: Variables }>();

// --- Helper functions ---

function normalizeGroupName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, MAX_GROUP_NAME_LEN);
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
  custom_cwd?: string;
  is_home?: boolean;
  is_my_home?: boolean;
  is_shared?: boolean;
  member_role?: 'owner' | 'member';
  member_count?: number;
  selected_skills?: string[] | null;
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
  const visibleEntries: Array<[string, typeof groups[string]]> = [];
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
    if (isHost && !isAdmin && !(isHome && group.created_by === user.id)) continue;

    // User isolation: non-admin can only see their own web groups
    if (!canAccessGroup({ id: user.id, role: user.role }, { ...group, jid })) continue;

    visibleEntries.push([jid, group]);
  }

  // 批量获取每个 jid 的最新消息（替代 N+1 逐个查询）
  const visibleJids = visibleEntries.map(([jid]) => jid);
  const latestByJid = new Map<string, { content: string; timestamp: string }>();
  if (visibleJids.length > 0) {
    // 用 multi 查询获取足够多的消息来覆盖所有 jid
    const allLatest = getMessagesPageMulti(visibleJids, undefined, visibleJids.length * 3);
    for (const msg of allLatest) {
      if (!latestByJid.has(msg.chat_jid)) {
        latestByJid.set(msg.chat_jid, { content: msg.content, timestamp: msg.timestamp });
      }
    }
  }

  // Cache member info per folder (avoid repeated queries)
  const memberCache = new Map<string, { count: number; role: 'owner' | 'member' | null }>();
  function getMemberInfo(folder: string) {
    let cached = memberCache.get(folder);
    if (!cached) {
      const members = getGroupMembers(folder);
      const role = members.find((m) => m.user_id === user.id)?.role ?? null;
      cached = { count: members.length, role };
      memberCache.set(folder, cached);
    }
    return cached;
  }

  for (const [jid, group] of visibleEntries) {
    const isHome = !!group.is_home;
    const isWeb = jid.startsWith('web:');

    const latest = latestByJid.get(jid);
    const memberInfo = !isHome ? getMemberInfo(group.folder) : null;
    const isShared = memberInfo ? memberInfo.count > 1 : false;

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
      custom_cwd: isAdmin ? group.customCwd : undefined,
      is_home: isHome || undefined,
      is_my_home: (isHome && group.created_by === user.id) || undefined,
      is_shared: isShared || undefined,
      member_role: memberInfo?.role ?? undefined,
      member_count: isShared ? memberInfo?.count : undefined,
      selected_skills: group.selected_skills ?? null,
    };
  }

  return result;
}

function removeFlowArtifacts(folder: string): void {
  fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'sessions', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'ipc', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'env', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'memory', folder), {
    recursive: true,
    force: true,
  });
  deleteContainerEnvConfig(folder);
}

function clearSessionJsonlFiles(folder: string): void {
  const claudeDir = path.join(DATA_DIR, 'sessions', folder, '.claude');
  if (!fs.existsSync(claudeDir)) return;

  // 保留 settings.json，清除所有其他运行时文件和目录
  const keep = new Set(['settings.json']);
  const entries = fs.readdirSync(claudeDir);
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    const fullPath = path.join(claudeDir, entry);
    fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

function resetWorkspaceForGroup(folder: string): void {
  // 1. 清除工作目录（Agent 文件、CLAUDE.md、logs/ 等），然后重建空目录
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.mkdirSync(groupDir, { recursive: true });

  // 2. 清除整个 Claude 会话目录（下次启动时 container-runner 会重建）
  fs.rmSync(path.join(DATA_DIR, 'sessions', folder), {
    recursive: true,
    force: true,
  });

  // 3. 清除 IPC 残留并重建目录结构
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);
  fs.rmSync(ipcDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });

  // 4. 清除日期记忆目录（data/memory/{folder}/）
  fs.rmSync(path.join(DATA_DIR, 'memory', folder), {
    recursive: true,
    force: true,
  });
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
  return c.json({ groups });
});

// POST /api/groups - 创建新群组
groupRoutes.post('/', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const body = await c.req.json().catch(() => ({}));

  const validation = GroupCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const name = normalizeGroupName(validation.data.name);
  if (!name) {
    return c.json({ error: 'Group name is required' }, 400);
  }

  const executionMode = validation.data.execution_mode || 'container';
  const customCwd = validation.data.custom_cwd; // Schema already trims and converts empty to undefined
  const initSourcePath = validation.data.init_source_path;
  const initGitUrl = validation.data.init_git_url;
  const authUser = c.get('user') as AuthUser;

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
      { error: 'init_source_path and init_git_url are only valid for container mode' },
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

      // 白名单校验：检查路径是否在允许的根目录下
      const allowlist = loadMountAllowlist();
      if (allowlist && allowlist.allowedRoots && allowlist.allowedRoots.length > 0) {
        let allowed = false;
        for (const root of allowlist.allowedRoots) {
          const expandedRoot = root.path.startsWith('~')
            ? path.join(
                HOME_DIR,
                root.path.slice(root.path.startsWith('~/') ? 2 : 1),
              )
            : path.resolve(root.path);

          let realRoot: string;
          try {
            realRoot = fs.realpathSync(expandedRoot);
          } catch {
            continue; // 允许的根目录不存在，跳过
          }

          const relative = path.relative(realRoot, realPath);
          if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
            allowed = true;
            break;
          }
        }

        if (!allowed) {
          const allowedPaths = allowlist.allowedRoots.map((r) => r.path).join(', ');
          return c.json(
            {
              error: `custom_cwd must be under an allowed root. Allowed roots: ${allowedPaths}. Check config/mount-allowlist.json`,
            },
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
      return c.json({ error: 'init_source_path must be an absolute path' }, 400);
    }

    let realPath: string;
    try {
      const stat = fs.statSync(initSourcePath);
      if (!stat.isDirectory()) {
        return c.json({ error: 'init_source_path must be an existing directory' }, 400);
      }
      realPath = fs.realpathSync(initSourcePath);
    } catch {
      return c.json({ error: 'init_source_path directory does not exist' }, 400);
    }

    // 白名单校验
    const allowlist = loadMountAllowlist();
    if (allowlist && allowlist.allowedRoots && allowlist.allowedRoots.length > 0) {
      const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
      if (!allowedRoot) {
        const allowedPaths = allowlist.allowedRoots.map((r) => r.path).join(', ');
        return c.json(
          {
            error: `init_source_path must be under an allowed root. Allowed roots: ${allowedPaths}. Check config/mount-allowlist.json`,
          },
          403,
        );
      }

      // 敏感路径过滤
      const blockedMatch = matchesBlockedPattern(realPath, allowlist.blockedPatterns);
      if (blockedMatch) {
        return c.json(
          { error: `init_source_path matches blocked pattern "${blockedMatch}"` },
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
      return c.json({ error: 'init_git_url is too long (max 2000 characters)' }, 400);
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

    // 阻止内网地址
    if (isPrivateHostname(gitUrl.hostname)) {
      return c.json({ error: 'init_git_url must not point to a private/internal address' }, 400);
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
  };

  setRegisteredGroup(jid, group);
  updateChatName(jid, name);
  deps.getRegisteredGroups()[jid] = group;

  // Register creator as owner in group_members
  addGroupMember(folder, authUser.id, 'owner', authUser.id);

  // 工作区初始化
  const groupDir = path.join(GROUPS_DIR, folder);

  try {
    if (initSourcePath) {
      await fsp.mkdir(groupDir, { recursive: true });
      await fsp.cp(initSourcePath, groupDir, { recursive: true });
      logger.info({ folder, source: initSourcePath }, 'Workspace initialized from local directory');
    }

    if (initGitUrl) {
      await execFileAsync('git', ['clone', '--depth', '1', initGitUrl, groupDir], {
        timeout: 120_000,
      });
      logger.info({ folder, url: initGitUrl }, 'Workspace initialized from git clone');
    }
  } catch (err) {
    // 初始化失败时清理
    logger.error({ folder, err }, 'Workspace initialization failed, cleaning up');
    fs.rmSync(groupDir, { recursive: true, force: true });
    deleteRegisteredGroup(jid);
    deleteChatHistory(jid);
    delete deps.getRegisteredGroups()[jid];

    const errMsg = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: `Workspace initialization failed: ${errMsg}` },
      500,
    );
  }

  return c.json({
    success: true,
    jid,
    group: {
      name: group.name,
      folder: group.folder,
      added_at: group.added_at,
      execution_mode: group.executionMode || 'container',
      custom_cwd: hasHostExecutionPermission(authUser)
        ? group.customCwd
        : undefined,
      kind: 'web',
      editable: true,
      deletable: true,
      lastMessage: undefined,
      lastMessageTime: now,
      member_role: 'owner',
      member_count: 1,
      is_shared: false,
    },
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
  if (!canModifyGroup({ id: authUser.id, role: authUser.role }, existing)) {
    return c.json({ error: 'Group not found' }, 404);
  }

  // Non-web JIDs (feishu/telegram) cannot be renamed by non-admin
  if (!jid.startsWith('web:') && authUser.role !== 'admin') {
    return c.json({ error: 'This group cannot be edited' }, 403);
  }

  if (isHostExecutionGroup(existing) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = GroupPatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body' },
      400,
    );
  }

  const { name: rawName, selected_skills } = validation.data;
  const name = rawName ? normalizeGroupName(rawName) : undefined;

  // 至少需要提供一个字段
  if (!name && selected_skills === undefined) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  const updated: RegisteredGroup = {
    name: name || existing.name,
    folder: existing.folder,
    added_at: existing.added_at,
    containerConfig: existing.containerConfig,
    executionMode: existing.executionMode,
    customCwd: existing.customCwd,
    created_by: existing.created_by,
    is_home: existing.is_home,
    selected_skills: selected_skills !== undefined ? (selected_skills ?? null) : existing.selected_skills,
  };

  setRegisteredGroup(jid, updated);
  if (name) updateChatName(jid, name);
  deps.getRegisteredGroups()[jid] = updated;

  return c.json({ success: true });
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

  if (!jid.startsWith('web:')) {
    return c.json({ error: 'This group cannot be deleted' }, 403);
  }

  if (isHostExecutionGroup(existing) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  // Wait for container to fully stop before cleaning up its files
  try {
    await deps.queue.stopGroup(jid);
  } catch (err) {
    logger.error(
      { jid, err },
      'Failed to stop container before deleting group',
    );
    return c.json(
      { error: 'Failed to stop container, group not deleted' },
      500,
    );
  }
  deleteGroupData(jid, existing.folder);
  removeFlowArtifacts(existing.folder);

  delete deps.getRegisteredGroups()[jid];
  delete deps.getSessions()[existing.folder];
  deps.setLastAgentTimestamp(jid, { timestamp: '', id: '' });

  return c.json({ success: true });
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

  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const interrupted = deps.queue.interruptQuery(jid);
  if (interrupted) {
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
      logger.warn({ jid, err }, 'Interrupt succeeded but failed to append system marker');
    }
  }
  return c.json({ success: true, interrupted });
});

// POST /api/groups/:jid/reset-session - 重置会话上下文
groupRoutes.post('/:jid/reset-session', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (!canModifyGroup({ id: authUser.id, role: authUser.role }, { ...group, jid })) {
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

  // 1. Stop ALL running processes for this folder FIRST and WAIT for them to finish
  //    to prevent any process from writing session files during cleanup
  try {
    await Promise.all(siblingJids.map((j) => deps.queue.stopGroup(j, { force: true })));
  } catch (err) {
    logger.error(
      { jid, siblingJids, err },
      'Failed to stop containers before resetting session',
    );
    return c.json(
      { error: 'Failed to stop container, session not reset' },
      500,
    );
  }

  // 2. Delete session JSONL files so Claude starts fresh.
  // Do this before touching DB state to reduce partial-reset failure cases.
  try {
    clearSessionJsonlFiles(group.folder);
  } catch (err) {
    logger.error(
      { jid, folder: group.folder, err },
      'Failed to clear session files during reset',
    );
    return c.json(
      { error: 'Failed to clear session files, session not reset' },
      500,
    );
  }

  // 3. Delete session from DB and in-memory cache.
  try {
    deleteSession(group.folder);
    delete deps.getSessions()[group.folder];
  } catch (err) {
    logger.error(
      { jid, folder: group.folder, err },
      'Failed to clear session state during reset',
    );
    return c.json(
      { error: 'Failed to clear session state, session not reset' },
      500,
    );
  }

  // 4. Insert system divider message (best-effort).
  const dividerMessageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  try {
    ensureChatExists(jid);
    storeMessageDirect(
      dividerMessageId,
      jid,
      '__system__',
      'system',
      'context_reset',
      timestamp,
      true,
    );

    broadcastNewMessage(jid, {
      id: dividerMessageId,
      chat_jid: jid,
      sender: '__system__',
      sender_name: 'system',
      content: 'context_reset',
      timestamp,
      is_from_me: true,
    });
  } catch (err) {
    logger.warn(
      { jid, err },
      'Session reset succeeded but failed to append divider message',
    );
  }

  logger.info(
    { jid, folder: group.folder, siblingJids },
    'Session reset: cleared session files and stopped all containers for folder',
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
  if (!canModifyGroup({ id: authUser.id, role: authUser.role }, { ...group, jid })) {
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

  // 1. Stop ALL active processes for this folder first to avoid writes during cleanup.
  try {
    await Promise.all(siblingJids.map((j) => deps.queue.stopGroup(j, { force: true })));
  } catch (err) {
    logger.error(
      { jid, siblingJids, err },
      'Failed to stop containers before clearing history',
    );
    return c.json(
      { error: 'Failed to stop container, history not cleared' },
      500,
    );
  }

  // 2. Reset workspace: clear working directory, session files, and IPC artifacts.
  try {
    resetWorkspaceForGroup(group.folder);
  } catch (err) {
    logger.error(
      { jid, folder: group.folder, err },
      'Failed to reset workspace while clearing history',
    );
    return c.json(
      { error: 'Failed to reset workspace, history not cleared' },
      500,
    );
  }

  // 3. Clear session state and message history for ALL sibling JIDs.
  try {
    deleteSession(group.folder);
    delete deps.getSessions()[group.folder];
    for (const siblingJid of siblingJids) {
      deleteChatHistory(siblingJid);
      // Re-create the chats row so subsequent messages work properly
      ensureChatExists(siblingJid);
      deps.setLastAgentTimestamp(siblingJid, { timestamp: '', id: '' });
    }
  } catch (err) {
    logger.error(
      { jid, folder: group.folder, err },
      'Failed to clear history state',
    );
    return c.json({ error: 'Failed to clear history' }, 500);
  }

  logger.info(
    { jid, folder: group.folder, siblingJids },
    'Cleared workspace, context and chat history for group and all siblings',
  );
  return c.json({ success: true });
});

// GET /api/groups/:jid/messages - 获取消息历史
groupRoutes.get('/:jid/messages', authMiddleware, async (c) => {
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
  const limit = Math.min(Number.isFinite(limitRaw) ? Math.max(1, limitRaw) : 50, 200);

  // Agent conversation: query messages from the virtual chat_jid
  if (agentIdParam) {
    const agent = getAgent(agentIdParam);
    if (!agent || agent.chat_jid !== jid) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    const virtualJid = `${jid}#agent:${agentIdParam}`;
    if (after) {
      const messages = getMessagesAfter(virtualJid, after, limit);
      return c.json({ messages });
    }
    const rows = getMessagesPage(virtualJid, before, limit + 1);
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    return c.json({ messages, hasMore });
  }

  // is_home 群组合并查询：将同 folder 下所有 JID（web + feishu/telegram IM 通道）的消息合并展示
  // - admin: merge all siblings in the folder (shared admin home)
  // - member: merge only siblings with same owner to prevent cross-user leakage
  const queryJids = [jid];
  if (group.is_home) {
    const siblingJids = getJidsByFolder(group.folder);
    for (const siblingJid of siblingJids) {
      if (siblingJid === jid) continue;
      const siblingGroup = getRegisteredGroup(siblingJid);
      if (!siblingGroup) continue;
      // Merge siblings by ownership: same creator, or admin's own IM channels
      const ownerMatch = group.created_by && siblingGroup.created_by === group.created_by;
      const adminSelfMatch = authUser.role === 'admin' && siblingGroup.created_by === authUser.id;
      if (ownerMatch || adminSelfMatch) {
        queryJids.push(siblingJid);
      }
    }
  }

  if (queryJids.length === 1) {
    // 单 JID 走原路径
    if (after) {
      const messages = getMessagesAfter(jid, after, limit);
      return c.json({ messages });
    }
    const rows = getMessagesPage(jid, before, limit + 1);
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    return c.json({ messages, hasMore });
  }

  // 多 JID 合并查询
  if (after) {
    const messages = getMessagesAfterMulti(queryJids, after, limit);
    return c.json({ messages });
  }
  const rows = getMessagesPageMulti(queryJids, before, limit + 1);
  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;
  return c.json({ messages, hasMore });
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

  // Check permissions
  if (
    user.role !== 'admin' &&
    (!user.permissions ||
      !user.permissions.includes('manage_group_env'))
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

  // Check permissions
  if (
    envUser.role !== 'admin' &&
    (!envUser.permissions ||
      !envUser.permissions.includes('manage_group_env'))
  ) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = ContainerEnvSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body' },
      400,
    );
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

// --- Member Management Routes ---

// GET /api/groups/:jid/members - 列出成员
groupRoutes.get('/:jid/members', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }

  const members = getGroupMembers(group.folder);
  return c.json({ members });
});

// GET /api/groups/:jid/members/search?q=... - 搜索可添加的用户（owner/admin 权限）
groupRoutes.get('/:jid/members/search', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  if (!canManageGroupMembers({ id: authUser.id, role: authUser.role }, { ...group, jid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const q = c.req.query('q') || '';
  if (!q.trim()) return c.json({ users: [] });

  const result = listUsers({ query: q.trim(), status: 'active', pageSize: 10 });
  const existingIds = new Set(getGroupMembers(group.folder).map((m) => m.user_id));
  const users = result.users
    .filter((u) => !existingIds.has(u.id))
    .map((u) => ({ id: u.id, username: u.username, display_name: u.display_name }));

  return c.json({ users });
});

// POST /api/groups/:jid/members - 添加成员
groupRoutes.post('/:jid/members', authMiddleware, async (c) => {
  const jid = c.req.param('jid');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;
  if (!canManageGroupMembers({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  if (group.is_home) {
    return c.json({ error: 'Cannot add members to home groups' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = GroupMemberAddSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { user_id: targetUserId } = validation.data;

  // Check target user exists and is active
  const targetUser = getUserById(targetUserId);
  if (!targetUser || targetUser.status !== 'active') {
    return c.json({ error: 'User not found or inactive' }, 404);
  }

  // Check if already a member
  const existingRole = getGroupMemberRole(group.folder, targetUserId);
  if (existingRole !== null) {
    return c.json({ error: 'User is already a member' }, 409);
  }

  addGroupMember(group.folder, targetUserId, 'member', authUser.id);
  invalidateAllowedUserCache(jid);
  logger.info(
    { jid, folder: group.folder, targetUserId, addedBy: authUser.id },
    'Group member added',
  );

  const members = getGroupMembers(group.folder);
  return c.json({ success: true, members });
});

// DELETE /api/groups/:jid/members/:userId - 移除成员
groupRoutes.delete('/:jid/members/:userId', authMiddleware, (c) => {
  const jid = c.req.param('jid');
  const targetUserId = c.req.param('userId');
  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);

  const authUser = c.get('user') as AuthUser;

  // Self-removal: any member can leave
  const isSelfRemoval = targetUserId === authUser.id;
  if (!isSelfRemoval) {
    if (!canManageGroupMembers({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }
  }

  // Check target is actually a member
  const targetRole = getGroupMemberRole(group.folder, targetUserId);
  if (targetRole === null) {
    return c.json({ error: 'User is not a member' }, 404);
  }

  // Owner cannot be removed
  if (targetRole === 'owner') {
    return c.json({ error: 'Cannot remove the owner' }, 400);
  }

  removeGroupMember(group.folder, targetUserId);
  invalidateAllowedUserCache(jid);
  logger.info(
    { jid, folder: group.folder, targetUserId, removedBy: authUser.id, isSelfRemoval },
    'Group member removed',
  );

  const members = getGroupMembers(group.folder);
  return c.json({ success: true, members });
});

export default groupRoutes;
