import { execFile, spawn } from 'child_process';
import path from 'path';
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
import { getRegisteredGroup, getRouterState } from '../db.js';
import { CONTAINER_IMAGE } from '../config.js';
import { getSystemSettings } from '../runtime-config.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

// --- Claude Code version cache (1h TTL) ---

let cachedClaudeVersion: { version: string | null; fetchedAt: number } | null =
  null;
const VERSION_CACHE_TTL = 60 * 60 * 1000;

async function getClaudeCodeVersion(): Promise<string | null> {
  const now = Date.now();
  if (
    cachedClaudeVersion &&
    now - cachedClaudeVersion.fetchedAt < VERSION_CACHE_TTL
  ) {
    return cachedClaudeVersion.version;
  }
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], {
      timeout: 5000,
    });
    const version = stdout.trim() || null;
    cachedClaudeVersion = { version, fetchedAt: now };
    return version;
  } catch {
    cachedClaudeVersion = { version: null, fetchedAt: now };
    return null;
  }
}

// --- Docker build state ---

let buildState: {
  building: boolean;
  startedAt: number | null;
  startedBy: string | null;
  logs: string[];
  result: { success: boolean; error?: string } | null;
} = {
  building: false,
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
  broadcastDockerBuildLog: (line: string) => void;
  broadcastDockerBuildComplete: (success: boolean, error?: string) => void;
}) {
  broadcastLog = deps.broadcastDockerBuildLog;
  broadcastComplete = deps.broadcastDockerBuildComplete;
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
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['images', CONTAINER_IMAGE, '--format', '{{.ID}}'],
      { timeout: 10000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// GET /api/status - 获取系统状态
monitorRoutes.get('/status', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const authUser = c.get('user') as AuthUser;
  const isAdmin = hasHostExecutionPermission(authUser);
  const queueStatus = deps.queue.getStatus();

  // Filter groups for non-admin users: only show groups they own, exclude host-mode
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

  return c.json({
    activeContainers,
    activeHostProcesses: isAdmin
      ? queueStatus.activeHostProcessCount
      : undefined,
    activeTotal: isAdmin ? queueStatus.activeCount : activeContainers,
    maxConcurrentContainers: getSystemSettings().maxConcurrentContainers,
    maxConcurrentHostProcesses: isAdmin
      ? getSystemSettings().maxConcurrentHostProcesses
      : undefined,
    queueLength,
    uptime: Math.floor(process.uptime()),
    groups: filteredGroups,
    dockerImageExists,
    dockerBuildInProgress: buildState.building,
    claudeCodeVersion: isAdmin ? await getClaudeCodeVersion() : undefined,
    dockerBuildLogs:
      isAdmin && buildState.building ? buildState.logs.slice(-50) : undefined,
    dockerBuildResult: isAdmin ? buildState.result : undefined,
  });
});

// POST /api/docker/build - 构建 Docker 镜像（仅 admin，异步启动 + WS 推送进度）
monitorRoutes.post(
  '/docker/build',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    if (buildState.building) {
      return c.json(
        {
          error: 'Docker image build already in progress',
          startedAt: buildState.startedAt,
          startedBy: buildState.startedBy,
        },
        409,
      );
    }

    const authUser = c.get('user') as AuthUser;
    const buildScript = path.resolve(process.cwd(), 'container', 'build.sh');

    buildState = {
      building: true,
      startedAt: Date.now(),
      startedBy: authUser.username,
      logs: [],
      result: null,
    };
    logger.info(
      { startedBy: authUser.username },
      'Docker image build requested via API',
    );

    // Spawn build process asynchronously
    const proc = spawn('bash', [buildScript], {
      cwd: path.resolve(process.cwd(), 'container'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 10-minute timeout
    const timeout = setTimeout(
      () => {
        proc.kill('SIGKILL');
        const errMsg = 'Docker build timed out after 10 minutes';
        logger.error(errMsg);
        buildState.building = false;
        buildState.result = { success: false, error: errMsg };
        broadcastLog?.(errMsg);
        broadcastComplete?.(false, errMsg);
      },
      10 * 60 * 1000,
    );

    const pushLine = (line: string) => {
      buildState.logs.push(line);
      // Keep last 200 lines in memory
      if (buildState.logs.length > 200) {
        buildState.logs = buildState.logs.slice(-200);
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
        : `Build process exited with code ${code}`;
      if (success) {
        logger.info('Docker image build completed');
      } else {
        logger.error({ code }, 'Docker image build failed');
      }
      buildState.building = false;
      buildState.result = { success, error };
      broadcastComplete?.(success, error);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      const errorMsg = err.message;
      logger.error({ err }, 'Docker image build process error');
      buildState.building = false;
      buildState.result = { success: false, error: errorMsg };
      broadcastComplete?.(false, errorMsg);
    });

    // Return immediately with 202 Accepted
    return c.json(
      {
        accepted: true,
        message:
          'Docker image build started. Progress will be streamed via WebSocket.',
      },
      202,
    );
  },
);

export default monitorRoutes;
