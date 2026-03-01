/**
 * Container Runner for happyclaw
 * Spawns agent execution in Docker container and handles IPC
 */
import { ChildProcess, exec, execFile, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  DATA_DIR,
  GROUPS_DIR,
} from './config.js';
import { logger } from './logger.js';
import { loadMountAllowlist, validateAdditionalMounts } from './mount-security.js';
import {
  buildContainerEnvLines,
  getClaudeProviderConfig,
  getContainerEnvConfig,
  getSystemSettings,
  mergeClaudeEnvConfig,
  shellQuoteEnvLines,
  writeCredentialsFile,
} from './runtime-config.js';
import { RegisteredGroup, StreamEvent } from './types.js';
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
 * Required env flags for settings.json — 每次容器/进程启动时强制写入，不可被用户覆盖。
 * 合并模式：仅覆盖这些 key，保留用户自定义的其他 key。
 */
const REQUIRED_SETTINGS_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
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
  } catch { /* ignore parse errors, overwrite */ }

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
  } catch { /* write anyway */ }

  fs.writeFileSync(settingsFile, newContent, { mode: 0o644 });
}

/**
 * Load enabled MCP server configs for a user.
 * Reads data/mcp-servers/{userId}/servers.json and returns only enabled servers
 * with fields needed for settings.json. Supports both stdio (command/args/env)
 * and http/sse (type/url/headers) server types.
 */
function loadUserMcpServers(
  userId: string,
): Record<string, Record<string, unknown>> {
  const serversFile = path.join(DATA_DIR, 'mcp-servers', userId, 'servers.json');
  try {
    if (!fs.existsSync(serversFile)) return {};
    const file = JSON.parse(fs.readFileSync(serversFile, 'utf8')) as {
      servers?: Record<string, Record<string, unknown>>;
    };
    const raw = file.servers || {};
    const result: Record<string, Record<string, unknown>> = {};
    for (const [name, server] of Object.entries(raw)) {
      if (!server.enabled) continue;

      const isHttpType = server.type === 'http' || server.type === 'sse';

      if (isHttpType) {
        if (!server.url) continue;
        const entry: Record<string, unknown> = { type: server.type, url: server.url };
        if (server.headers && typeof server.headers === 'object' && Object.keys(server.headers as object).length > 0) {
          entry.headers = server.headers;
        }
        result[name] = entry;
      } else {
        if (!server.command) continue;
        const entry: Record<string, unknown> = { command: server.command };
        if (server.args) entry.args = server.args;
        if (server.env && typeof server.env === 'object' && Object.keys(server.env as object).length > 0) {
          entry.env = server.env;
        }
        result[name] = entry;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  /** @deprecated Use isHome + isAdminHome instead */
  isMain: boolean;
  isHome?: boolean;
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
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

function buildVolumeMounts(
  group: RegisteredGroup,
  isAdminHome: boolean,
  mountUserSkills = true,
  selectedSkills: string[] | null = null,
  agentId?: string,
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

  // Per-group memory directory (isolated from workspace to avoid polluting user files)
  const memoryDir = path.join(DATA_DIR, 'memory', group.folder);
  mkdirForContainer(memoryDir);
  mounts.push({
    hostPath: memoryDir,
    containerPath: '/workspace/memory',
    readonly: false,
  });

  // Per-group Claude sessions directory (isolated from other groups)
  // Sub-agents get their own session dir under agents/{agentId}/.claude/
  const groupSessionsDir = agentId
    ? path.join(DATA_DIR, 'sessions', group.folder, 'agents', agentId, '.claude')
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

  // Skills：以只读卷挂载宿主机目录（由 entrypoint 创建符号链接）
  // selectedSkills 为 null 时挂载整个目录（全部 skills）
  // selectedSkills 为数组时仅挂载选中的 skill 子目录
  const projectSkillsDir = path.join(projectRoot, 'container', 'skills');
  const userSkillsDir = (mountUserSkills && ownerId) ? path.join(DATA_DIR, 'skills', ownerId) : null;

  // Ensure user skills directory exists so it can always be mounted.
  // Skills may be installed after the group is created; without pre-creating,
  // the existsSync check would skip mounting and the container would never see them.
  if (userSkillsDir) {
    fs.mkdirSync(userSkillsDir, { recursive: true });
  }

  if (selectedSkills === null) {
    // 全量挂载（默认行为）
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
  } else {
    // 按需挂载：仅挂载选中的 skill 子目录
    const selectedSet = new Set(selectedSkills);
    // 项目级 skills
    if (fs.existsSync(projectSkillsDir)) {
      for (const name of selectedSet) {
        if (!/^[\w\-]+$/.test(name)) continue;  // 防御性跳过非法名称
        const skillPath = path.join(projectSkillsDir, name);
        if (fs.existsSync(skillPath) && fs.statSync(skillPath).isDirectory()) {
          mounts.push({
            hostPath: skillPath,
            containerPath: `/workspace/project-skills/${name}`,
            readonly: true,
          });
        }
      }
    }
    // 用户级 skills
    if (userSkillsDir) {
      for (const name of selectedSet) {
        if (!/^[\w\-]+$/.test(name)) continue;  // 防御性跳过非法名称
        const skillPath = path.join(userSkillsDir, name);
        if (fs.existsSync(skillPath) && fs.statSync(skillPath).isDirectory()) {
          mounts.push({
            hostPath: skillPath,
            containerPath: `/workspace/user-skills/${name}`,
            readonly: true,
          });
        }
      }
    }
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // Sub-agents get their own IPC subdirectory under agents/{agentId}/
  // Use 0o777 so container (node/1000) and host (agent/1002) can both read/write.
  const groupIpcDir = agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', agentId)
    : path.join(DATA_DIR, 'ipc', group.folder);
  mkdirForContainer(groupIpcDir);
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  // Use chmod 777 so both host (agent/1002) and container (node/1000) can write
  for (const sub of ['messages', 'tasks', 'input', 'agents'] as const) {
    const subDir = path.join(groupIpcDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    try { fs.chmodSync(subDir, 0o777); } catch { /* ignore if already correct */ }
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
  const globalConfig = getClaudeProviderConfig();
  const containerOverride = getContainerEnvConfig(group.folder);
  const envLines = buildContainerEnvLines(globalConfig, containerOverride);
  if (envLines.length > 0) {
    const envFilePath = path.join(envDir, 'env');
    const quotedLines = shellQuoteEnvLines(envLines);
    fs.writeFileSync(envFilePath, quotedLines.join('\n') + '\n', { mode: 0o600 });
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
      logger.warn({ group: group.name, err }, 'Failed to write .credentials.json');
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
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

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
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);

  // Determine if this is an admin home container (full privileges)
  const isAdminHome = !!group.is_home && group.folder === 'main';
  // Per-user skills: always mount if the group has an owner
  const shouldMountUserSkills = !!group.created_by;
  const mounts = buildVolumeMounts(group, isAdminHome, shouldMountUserSkills, group.selected_skills ?? null, input.agentId);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const agentSuffix = input.agentId ? `-${input.agentId.replace(/[^a-zA-Z0-9-]/g, '-')}` : '';
  const containerName = `happyclaw-${safeName}${agentSuffix}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

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

  return new Promise((resolve) => {
    const container = spawn('docker', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    const stdoutState = createStdoutParserState();
    const stderrState = createStderrState();

    // Write input and close stdin (容器需要 EOF 来刷新 stdin 管道)
    container.stdin.on('error', (err) => {
      logger.error({ group: group.name, err }, 'Container stdin write failed');
      container.kill();
    });
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    let timedOut = false;
    const timeoutMs = group.containerConfig?.timeout || getSystemSettings().containerTimeout;

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      execFile('docker', ['stop', containerName], { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
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
    attachStderrHandler(container.stderr, stderrState, group.name, { container: group.folder });

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
      if (handleNonZeroExit(closeCtx, code, signal, duration, logFile)) return;
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
  try { fs.unlinkSync(tasksFile); } catch { /* ignore */ }
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
  try { fs.unlinkSync(groupsFile); } catch { /* ignore */ }
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
 * Run agent directly on the host machine (no Docker container).
 * Used for host execution mode — the agent gets full access to the host filesystem.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, identifier: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
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
        execFileSync('git', ['init'], { cwd: defaultGroupDir, stdio: 'ignore' });
        logger.info({ folder: group.folder }, 'Initialized git repository for group');
      } catch (err) {
        // Non-fatal: agent still works, just reports wrong working directory
        logger.warn({ folder: group.folder, err }, 'Failed to initialize git repository');
      }
    }
  }
  let groupDir = group.customCwd || defaultGroupDir;
  if (!path.isAbsolute(groupDir)) {
    return hostModeSetupError(
      `工作目录必须是绝对路径：${groupDir}`,
    );
  }
  // Resolve symlinks to prevent TOCTOU attacks
  try {
    groupDir = fs.realpathSync(groupDir);
  } catch {
    return hostModeSetupError(
      `工作目录不存在或无法解析：${groupDir}`,
    );
  }
  if (!fs.statSync(groupDir).isDirectory()) {
    return hostModeSetupError(
      `工作目录不是目录：${groupDir}`,
    );
  }

  // Runtime allowlist validation for custom CWD (defense-in-depth: web.ts validates at creation,
  // but re-check here in case allowlist was tightened or path was injected via DB)
  if (group.customCwd) {
    const allowlist = loadMountAllowlist();
    if (allowlist && allowlist.allowedRoots && allowlist.allowedRoots.length > 0) {
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

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'memory', group.folder), { recursive: true });

  // 2. 确保目录结构（宿主机模式下限制目录权限）
  // Sub-agents get their own IPC and session directories
  const groupIpcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', input.agentId)
    : path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true, mode: 0o700 });
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  fs.mkdirSync(path.join(groupIpcDir, 'agents'), { recursive: true, mode: 0o700 });

  const groupSessionsDir = input.agentId
    ? path.join(DATA_DIR, 'sessions', group.folder, 'agents', input.agentId, '.claude')
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // 3. 写入 settings.json（合并模式，不覆盖已有用户配置）
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const hostMcpServers = group.created_by ? loadUserMcpServers(group.created_by) : {};
  ensureSettingsJson(settingsFile, hostMcpServers);

  // 4. Skills 自动链接到 session 目录
  // 链接顺序：项目级 → 宿主机级(admin only, 覆盖同名项目级) → 用户级(覆盖同名)
  // selected_skills 过滤：仅链接选中的 skills
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
      } catch { /* ignore */ }
    }

    const selectedSkills = group.selected_skills ?? null;
    const selectedSet = selectedSkills ? new Set(selectedSkills) : null;

    const linkSkillEntries = (sourceDir: string) => {
      if (!fs.existsSync(sourceDir)) return;
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (selectedSet && !selectedSet.has(entry.name)) continue;
        const linkPath = path.join(skillsDir, entry.name);
        try {
          // 移除已有符号链接（高优先级覆盖低优先级）
          if (fs.existsSync(linkPath)) {
            fs.rmSync(linkPath, { recursive: true, force: true });
          }
          fs.symlinkSync(path.join(sourceDir, entry.name), linkPath);
        } catch { /* ignore */ }
      }
    };

    // 项目级 skills
    const projectRoot = process.cwd();
    linkSkillEntries(path.join(projectRoot, 'container', 'skills'));
    // 用户级 skills（覆盖同名项目级）
    const ownerId = group.created_by;
    if (ownerId) {
      linkSkillEntries(path.join(DATA_DIR, 'skills', ownerId));
    }
  } catch (err) {
    logger.warn({ folder: group.folder, err }, '宿主机模式 skills 符号链接失败');
  }

  // 5. 构建环境变量
  const hostEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  // 配置层环境变量
  const globalConfig = getClaudeProviderConfig();
  const containerOverride = getContainerEnvConfig(group.folder);
  const envLines = buildContainerEnvLines(globalConfig, containerOverride);
  for (const line of envLines) {
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      hostEnv[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
    }
  }

  // Write .credentials.json for OAuth credentials
  const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
  if (mergedConfig.claudeOAuthCredentials) {
    try {
      writeCredentialsFile(groupSessionsDir, mergedConfig);
    } catch (err) {
      logger.warn({ folder: group.folder, err }, 'Failed to write .credentials.json for host agent');
    }
  }

  // 路径映射
  hostEnv['HAPPYCLAW_WORKSPACE_GROUP'] = groupDir;
  // Per-user global memory
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
  hostEnv['HAPPYCLAW_WORKSPACE_MEMORY'] = path.join(DATA_DIR, 'memory', group.folder);
  hostEnv['HAPPYCLAW_WORKSPACE_IPC'] = groupIpcDir;
  hostEnv['CLAUDE_CONFIG_DIR'] = groupSessionsDir;
  // 让 SDK 捕获 CLI 的 stderr 输出，便于排查启动失败
  hostEnv['DEBUG_CLAUDE_AGENT_SDK'] = '1';
  // CLI 禁止 root 用户使用 --dangerously-skip-permissions，
  // 通过 IS_SANDBOX 标记告知 CLI 当前运行在受控环境中以绕过此限制
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    hostEnv['IS_SANDBOX'] = '1';
  }

  // 6. 编译检查
  const projectRoot = process.cwd();
  const agentRunnerRoot = path.join(projectRoot, 'container', 'agent-runner');
  const agentRunnerNodeModules = path.join(agentRunnerRoot, 'node_modules');
  const agentRunnerDist = path.join(
    agentRunnerRoot,
    'dist',
    'index.js',
  );
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

  // Warn if dist may be stale (src newer than dist)
  try {
    const distMtime = fs.statSync(agentRunnerDist).mtimeMs;
    const srcDir = path.join(agentRunnerRoot, 'src');
    const srcFiles = fs.readdirSync(srcDir);
    const newestSrc = Math.max(
      ...srcFiles.map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs),
    );
    if (newestSrc > distMtime) {
      logger.warn(
        { group: group.name },
        `agent-runner dist 可能已过期（src 比 dist 新）。建议执行：${setupBuildHint}`,
      );
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

  const logsDir = path.join(groupDir, 'logs');

  return new Promise((resolve) => {
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
    });

    const processId = `host-${group.folder}-${Date.now()}`;
    onProcess(proc, processId);

    const stdoutState = createStdoutParserState();
    const stderrState = createStderrState();

    // 8. stdin 输入
    proc.stdin.on('error', (err) => {
      logger.error({ group: group.name, err }, 'Host agent stdin write failed');
      proc.kill();
    });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // 9. 超时管理
    let timedOut = false;
    const timeoutMs = group.containerConfig?.timeout || getSystemSettings().containerTimeout;

    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processId },
        'Host agent timeout, killing',
      );
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
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
    attachStderrHandler(proc.stderr, stderrState, group.name, { host: group.folder });

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
        extraSummaryLines: [
          `Working Directory: ${groupDir}`,
        ],
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
      if (handleNonZeroExit(closeCtx, code, signal, duration, logFile)) return;
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
}
