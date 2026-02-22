import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import {
  isHostExecutionGroup,
  isDockerAvailable,
  hasHostExecutionPermission,
  canAccessGroup,
  getWebDeps,
} from '../web-context.js';
import { getRegisteredGroup, getRouterState } from '../db.js';
import {
  CONTAINER_IMAGE,
  MAX_CONCURRENT_CONTAINERS,
  MAX_CONCURRENT_HOST_PROCESSES,
} from '../config.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

let buildState: {
  building: boolean;
  startedAt: number | null;
  startedBy: string | null;
} = { building: false, startedAt: null, startedBy: null };

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
    activeHostProcesses: isAdmin ? queueStatus.activeHostProcessCount : undefined,
    activeTotal: isAdmin ? queueStatus.activeCount : activeContainers,
    maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
    maxConcurrentHostProcesses: isAdmin ? MAX_CONCURRENT_HOST_PROCESSES : undefined,
    queueLength,
    uptime: Math.floor(process.uptime()),
    groups: filteredGroups,
    dockerAvailable: isDockerAvailable(),
    dockerImageExists,
    dockerBuildInProgress: buildState.building,
  });
});

// POST /api/docker/build - 构建 Docker 镜像（仅 admin）
monitorRoutes.post('/docker/build', authMiddleware, systemConfigMiddleware, async (c) => {
  if (buildState.building) {
    return c.json({
      error: 'Docker image build already in progress',
      startedAt: buildState.startedAt,
      startedBy: buildState.startedBy,
    }, 409);
  }

  const authUser = c.get('user') as AuthUser;
  const buildScript = path.resolve(process.cwd(), 'container', 'build.sh');

  buildState = { building: true, startedAt: Date.now(), startedBy: authUser.username };
  logger.info({ startedBy: authUser.username }, 'Docker image build requested via API');

  try {
    const { stdout, stderr } = await execFileAsync('bash', [buildScript], {
      timeout: 10 * 60 * 1000, // 10 分钟超时
      cwd: path.resolve(process.cwd(), 'container'),
    });

    logger.info('Docker image build completed');
    return c.json({
      success: true,
      stdout: typeof stdout === 'string' ? stdout : String(stdout),
      stderr: typeof stderr === 'string' ? stderr : String(stderr),
    });
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Docker image build failed');
    return c.json({
      success: false,
      error: errorMsg,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
    }, 500);
  } finally {
    buildState = { building: false, startedAt: null, startedBy: null };
  }
});

export default monitorRoutes;
