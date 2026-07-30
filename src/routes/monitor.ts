import { execFile, spawn } from 'child_process';
import readline from 'readline';
import { promisify } from 'util';

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
  getWebDeps,
} from '../web-context.js';
import {
  getAllRegisteredGroups,
  getRegisteredGroup,
  getRouterState,
  getUserById,
  hasContainerModeGroups,
} from '../db.js';
import {
  getChannelOutboxItem,
  listUncertainChannelOutbox,
  resolveUncertainChannelOutbox,
} from '../channel-reliability-store.js';
import { CONTAINER_IMAGE } from '../config.js';
import { getSystemSettings, getProviders } from '../runtime-config.js';
import { setProviderOverride } from '../container-runner.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

// --- Claude Code version cache ---

interface VersionInfo {
  host: string | null;
  container: string | null;
  latest: string | null;
}

let cachedVersions: {
  info: VersionInfo;
  fetchedAt: number;
  imageId: string | null;
} | null = null;
const VERSION_CACHE_TTL = 60 * 60 * 1000;

// Latest version cache (separate TTL, queried from npm registry)
let cachedLatestVersion: { version: string | null; fetchedAt: number } | null =
  null;
const LATEST_VERSION_CACHE_TTL = 30 * 60 * 1000; // 30min

/** Query latest Claude Code version from npm registry */
async function getLatestClaudeCodeVersion(): Promise<string | null> {
  const now = Date.now();
  if (
    cachedLatestVersion &&
    now - cachedLatestVersion.fetchedAt < LATEST_VERSION_CACHE_TTL
  ) {
    return cachedLatestVersion.version;
  }

  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', '@anthropic-ai/claude-code', 'version'],
      { timeout: 15000 },
    );
    const version = stdout.trim() || null;
    cachedLatestVersion = { version, fetchedAt: now };
    return version;
  } catch {
    // Fallback: keep stale cache if available
    if (cachedLatestVersion) return cachedLatestVersion.version;
    cachedLatestVersion = { version: null, fetchedAt: now };
    return null;
  }
}

/** Get host Claude Code version via global `claude --version` CLI */
async function getHostClaudeCodeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], {
      timeout: 10000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// /api/status 由前端 10 秒轮询；每次请求都 fork 一个 docker CLI 子进程
// （冷启 50-200ms、生产实测 33-90ms）纯属浪费。镜像 ID 30 秒内视为不变。
const DOCKER_IMAGE_ID_TTL_MS = 30_000;
let cachedDockerImageId: { id: string | null; fetchedAt: number } | null = null;

async function getDockerImageId(): Promise<string | null> {
  const now = Date.now();
  if (
    cachedDockerImageId &&
    now - cachedDockerImageId.fetchedAt < DOCKER_IMAGE_ID_TTL_MS
  ) {
    return cachedDockerImageId.id;
  }
  let id: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['images', CONTAINER_IMAGE, '--format', '{{.ID}}'],
      { timeout: 10000 },
    );
    id = stdout.trim() || null;
  } catch {
    id = null;
  }
  cachedDockerImageId = { id, fetchedAt: now };
  return id;
}

/** Get container Claude Code version from Docker image */
async function getContainerClaudeCodeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        '/app/node_modules/.bin/claude',
        CONTAINER_IMAGE,
        '--version',
      ],
      { timeout: 30000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getClaudeCodeVersions(): Promise<VersionInfo> {
  const now = Date.now();
  const imageId = await getDockerImageId();

  // Return cached if same image and within TTL
  if (
    cachedVersions &&
    cachedVersions.imageId === imageId &&
    now - cachedVersions.fetchedAt < VERSION_CACHE_TTL
  ) {
    return cachedVersions.info;
  }

  // Fetch all versions concurrently
  const [host, container, latest] = await Promise.all([
    getHostClaudeCodeVersion(),
    imageId ? getContainerClaudeCodeVersion() : Promise.resolve(null),
    getLatestClaudeCodeVersion(),
  ]);
  const info: VersionInfo = { host, container, latest };

  cachedVersions = { info, fetchedAt: now, imageId };
  return info;
}

// --- Docker image pull state ---

let pullState: {
  pulling: boolean;
  startedAt: number | null;
  startedBy: string | null;
  logs: string[];
  result: { success: boolean; error?: string } | null;
} = {
  pulling: false,
  startedAt: null,
  startedBy: null,
  logs: [],
  result: null,
};

// --- Dependency injection (avoid circular imports) ---

let broadcastLog: ((line: string) => void) | null = null;
let broadcastComplete: ((success: boolean, error?: string) => void) | null =
  null;

export function injectMonitorDeps(deps: {
  broadcastDockerPullLog: (line: string) => void;
  broadcastDockerPullComplete: (success: boolean, error?: string) => void;
}) {
  broadcastLog = deps.broadcastDockerPullLog;
  broadcastComplete = deps.broadcastDockerPullComplete;
}

const monitorRoutes = new Hono<{ Variables: Variables }>();

// GET /api/health - 健康检查（无认证）
monitorRoutes.get('/health', async (c) => {
  const checks = {
    database: false,
    queue: false,
    uptime: 0,
  };

  let healthy = true;

  // 检查数据库连通性
  try {
    getRouterState('last_timestamp');
    checks.database = true;
  } catch (err) {
    healthy = false;
    logger.warn({ err }, '健康检查：数据库连接失败');
  }

  // 检查队列状态
  try {
    const deps = getWebDeps();
    if (deps && deps.queue) {
      checks.queue = true;
    } else {
      healthy = false;
    }
  } catch (err) {
    healthy = false;
    logger.warn({ err }, '健康检查：队列不可用');
  }

  // 进程运行时间
  checks.uptime = Math.floor(process.uptime());

  const status = healthy ? 'healthy' : 'unhealthy';
  const statusCode = healthy ? 200 : 503;

  return c.json({ status, checks }, statusCode);
});

async function checkDockerImageExists(): Promise<boolean> {
  // Skip Docker check entirely when no groups use container mode
  if (!hasContainerModeGroups()) return false;
  return Boolean(await getDockerImageId());
}

// GET /api/status - 获取系统状态
monitorRoutes.get('/status', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const authUser = c.get('user') as AuthUser;
  const isAdmin = hasHostExecutionPermission(authUser);
  const queueStatus = deps.queue.getStatus();

  // 监控页面属于系统管理功能，admin 可见所有群组状态（不受工作区隔离约束）
  const filteredGroups = isAdmin
    ? queueStatus.groups
    : queueStatus.groups.filter((g) => {
        const group = getRegisteredGroup(g.jid);
        if (!group) return false;
        if (isHostExecutionGroup(group)) return false;
        return canAccessGroup({ id: authUser.id, role: authUser.role }, group);
      });

  const dockerImageExists = await checkDockerImageExists();

  // For non-admin users, derive aggregate metrics from their own filtered groups only
  // to prevent leaking global system load information across users
  let activeContainers: number;
  let queueLength: number;
  if (isAdmin) {
    activeContainers = queueStatus.activeContainerCount;
    queueLength = queueStatus.waitingCount;
  } else {
    activeContainers = filteredGroups.filter((g) => g.active).length;
    // Filter waiting groups by user ownership
    queueLength = queueStatus.waitingGroupJids.filter((jid) => {
      const group = getRegisteredGroup(jid);
      if (!group) return false;
      if (isHostExecutionGroup(group)) return false;
      return canAccessGroup({ id: authUser.id, role: authUser.role }, group);
    }).length;
  }

  // Enrich groups with provider name and owner username (batch lookups)
  const providers = getProviders();
  const providerNameMap = new Map(providers.map((p) => [p.id, p.name]));
  const allRegistered = getAllRegisteredGroups();

  // Collect unique creator IDs, then batch-resolve usernames
  const creatorIds = new Set<string>();
  for (const g of filteredGroups) {
    const baseJid = g.jid.includes('#agent:')
      ? g.jid.split('#agent:')[0]
      : g.jid;
    const reg = allRegistered[baseJid];
    if (reg?.created_by) creatorIds.add(reg.created_by);
  }
  const userNameMap = new Map<string, string>();
  for (const uid of creatorIds) {
    const user = getUserById(uid);
    if (user?.username) userNameMap.set(uid, user.username);
  }

  const enrichedGroups = filteredGroups.map((g) => {
    const baseJid = g.jid.includes('#agent:')
      ? g.jid.split('#agent:')[0]
      : g.jid;
    const reg = allRegistered[baseJid];
    return {
      ...g,
      ownerUsername: reg?.created_by
        ? (userNameMap.get(reg.created_by) ?? null)
        : null,
      selectedProviderName: g.selectedProviderId
        ? (providerNameMap.get(g.selectedProviderId) ?? null)
        : null,
    };
  });

  return c.json({
    activeContainers,
    activeHostProcesses: isAdmin
      ? queueStatus.activeHostProcessCount
      : undefined,
    activeTotal: isAdmin ? queueStatus.activeCount : activeContainers,
    maxConcurrentContainers: getSystemSettings().maxConcurrentContainers,
    queueLength,
    uptime: Math.floor(process.uptime()),
    groups: enrichedGroups,
    dockerImageExists,
    dockerPullInProgress: pullState.pulling,
    claudeCodeVersions: isAdmin ? await getClaudeCodeVersions() : undefined,
    dockerPullLogs:
      isAdmin && pullState.pulling ? pullState.logs.slice(-50) : undefined,
    dockerPullResult: isAdmin ? pullState.result : undefined,
  });
});

// POST /api/status/groups/:folder/switch-provider — 一次性切换 provider + 优雅重启
monitorRoutes.post(
  '/status/groups/:folder/switch-provider',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const deps = getWebDeps();
    if (!deps) return c.json({ error: 'Server not initialized' }, 500);

    const folder = c.req.param('folder');
    let body: { providerId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (typeof body.providerId !== 'string' || !body.providerId) {
      return c.json({ error: 'providerId (string) is required' }, 400);
    }
    const providerId = body.providerId;

    // Validate provider exists and is enabled
    const providers = getProviders();
    const target = providers.find((p) => p.id === providerId);
    if (!target) {
      return c.json({ error: 'Provider not found' }, 404);
    }
    if (!target.enabled) {
      return c.json({ error: 'Provider is disabled' }, 400);
    }

    // Find active group for this folder
    const queueStatus = deps.queue.getStatus();
    const activeGroup = queueStatus.groups.find(
      (g) => g.groupFolder === folder && g.active,
    );

    // Set one-time override (consumed on next container start)
    setProviderOverride(folder, providerId);

    if (!activeGroup) {
      return c.json({
        ok: true,
        providerId,
        providerName: target.name,
        restarted: false,
        pending: true,
      });
    }

    const restarted = deps.queue.requestGracefulRestart(activeGroup.jid);

    logger.info({ folder, providerId, restarted }, 'Provider switch requested');

    return c.json({
      ok: true,
      providerId,
      providerName: target.name,
      restarted,
    });
  },
);

// GET /api/status/channel-outbox/uncertain - 列出待人工确认的投递
//
// An outbox row goes `uncertain` when the send started but its provider ACK
// was lost. That fences the whole turn: a sibling row could duplicate a
// message the provider already accepted. Only a human can inspect the target
// chat and decide, so this pair of endpoints is the fence's release — without
// them the turn can never complete and the row is unreachable.
monitorRoutes.get(
  '/status/channel-outbox/uncertain',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const limitParam = Number(c.req.query('limit') ?? '100');
    const items = listUncertainChannelOutbox(
      Number.isFinite(limitParam) ? limitParam : 100,
    );
    // Payload is deliberately omitted: it carries user message content, and
    // the operator only needs identity plus routing to reconcile.
    return c.json({
      items: items.map((item) => ({
        id: item.id,
        turnRunId: item.turnRunId,
        kind: item.kind,
        ordinal: item.ordinal,
        revision: item.revision,
        provider: item.provider,
        accountId: item.accountId,
        chatId: item.chatId,
        attempt: item.attempt,
        error: item.error,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      total: items.length,
    });
  },
);

// POST /api/status/channel-outbox/:id/resolve - 人工裁决一条待确认投递
monitorRoutes.post(
  '/status/channel-outbox/:id/resolve',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const id = c.req.param('id');
    let body: {
      resolution?: unknown;
      expectedRevision?: unknown;
      providerMessageId?: unknown;
      error?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (body.resolution !== 'delivered' && body.resolution !== 'failed') {
      return c.json(
        { error: "resolution must be 'delivered' or 'failed'" },
        400,
      );
    }
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return c.json(
        { error: 'expectedRevision (non-negative integer) is required' },
        400,
      );
    }
    if (
      body.resolution === 'delivered' &&
      (typeof body.providerMessageId !== 'string' || !body.providerMessageId)
    ) {
      return c.json(
        {
          error:
            "providerMessageId (string) is required when resolution is 'delivered'",
        },
        400,
      );
    }

    const existing = getChannelOutboxItem(id);
    if (!existing) return c.json({ error: 'Outbox item not found' }, 404);
    if (existing.status !== 'uncertain') {
      return c.json(
        {
          error: `Outbox item is '${existing.status}', not 'uncertain'`,
          status: existing.status,
        },
        409,
      );
    }

    const resolved =
      body.resolution === 'delivered'
        ? resolveUncertainChannelOutbox(id, expectedRevision, {
            resolution: 'delivered',
            providerMessageId: body.providerMessageId as string,
          })
        : resolveUncertainChannelOutbox(id, expectedRevision, {
            resolution: 'failed',
            error:
              typeof body.error === 'string' && body.error
                ? body.error
                : 'Operator marked this delivery as failed',
          });
    if (!resolved) {
      // Lost the compare-and-set: someone else resolved it, or the caller's
      // revision is stale. Never retry blindly — re-read and decide again.
      return c.json(
        {
          error:
            'Outbox item changed since it was read; re-read it and retry with the current revision',
          currentRevision: getChannelOutboxItem(id)?.revision ?? null,
        },
        409,
      );
    }

    const authUser = c.get('user') as AuthUser;
    logger.warn(
      {
        outboxItemId: id,
        turnRunId: existing.turnRunId,
        resolution: body.resolution,
        resolvedBy: authUser.username,
      },
      'Uncertain channel outbox item resolved by operator',
    );
    return c.json({ ok: true, id, resolution: body.resolution });
  },
);

// POST /api/docker/pull - 拉取 GitHub Actions 发布的镜像（仅 admin，异步 + WS 进度）
monitorRoutes.post(
  '/docker/pull',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    if (pullState.pulling) {
      return c.json(
        {
          error: 'Docker image pull already in progress',
          startedAt: pullState.startedAt,
          startedBy: pullState.startedBy,
        },
        409,
      );
    }

    const authUser = c.get('user') as AuthUser;

    pullState = {
      pulling: true,
      startedAt: Date.now(),
      startedBy: authUser.username,
      logs: [],
      result: null,
    };
    logger.info(
      { image: CONTAINER_IMAGE, startedBy: authUser.username },
      'Docker image pull requested via API',
    );

    // Runtime hosts only consume immutable output from the registry. Image
    // compilation is exclusively owned by .github/workflows/docker-publish.yml.
    const proc = spawn('docker', ['pull', CONTAINER_IMAGE], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;

    const finish = (success: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      pullState.pulling = false;
      pullState.result = { success, error };
      if (success) {
        cachedDockerImageId = null;
        cachedVersions = null;
        logger.info({ image: CONTAINER_IMAGE }, 'Docker image pull completed');
      } else {
        logger.error(
          { image: CONTAINER_IMAGE, error },
          'Docker image pull failed',
        );
      }
      broadcastComplete?.(success, error);
    };

    // 10-minute timeout
    const timeout = setTimeout(
      () => {
        proc.kill('SIGKILL');
        const errMsg = 'Docker image pull timed out after 10 minutes';
        logger.error(errMsg);
        broadcastLog?.(errMsg);
        finish(false, errMsg);
      },
      10 * 60 * 1000,
    );

    const pushLine = (line: string) => {
      pullState.logs.push(line);
      // Keep last 200 lines in memory
      if (pullState.logs.length > 200) {
        pullState.logs = pullState.logs.slice(-200);
      }
      broadcastLog?.(line);
    };

    // Read stdout and stderr line by line
    if (proc.stdout) {
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', pushLine);
    }
    if (proc.stderr) {
      const rl = readline.createInterface({ input: proc.stderr });
      rl.on('line', pushLine);
    }

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const success = code === 0;
      const error = success
        ? undefined
        : `Docker pull exited with code ${code}`;
      finish(success, error);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      finish(false, err.message);
    });

    // Return immediately with 202 Accepted
    return c.json(
      {
        accepted: true,
        message:
          'Docker image pull started. Progress will be streamed via WebSocket.',
      },
      202,
    );
  },
);

export default monitorRoutes;
