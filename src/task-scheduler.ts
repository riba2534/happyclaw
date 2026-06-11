import { ChildProcess } from 'child_process';
import crypto from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { getSystemSettings } from './runtime-config.js';
import {
  ContainerOutput,
  runContainerAgent,
  runHostAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  addGroupMember,
  advanceSkippedTask,
  getAllTasks,
  cleanupOldTaskRunLogs,
  cleanupStaleRunningLogs,
  deleteGroupData,
  ensureChatExists,
  getDueTasks,
  getTaskById,
  getUserById,
  getUserHomeGroup,
  logTaskRun,
  logTaskRunStart,
  updateTaskRunLog,
  setRegisteredGroup,
  updateChatName,
  updateTaskAfterRun,
  updateTaskWorkspace,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { resolveTaskOwner } from './task-utils.js';
import { removeFlowArtifacts } from './file-manager.js';
import { hasScriptCapacity, runScript } from './script-runner.js';
import type { StreamEvent } from './stream-event.types.js';
import { ExecutionMode, RegisteredGroup, ScheduledTask } from './types.js';
import { checkBillingAccessFresh, isBillingEnabled } from './billing.js';
import { checkOwnerActive } from './owner-gate.js';
import { stripAgentInternalTags } from './utils.js';

/**
 * Resolve the actual group JID to send a task to.
 * Falls back from the task's stored chat_jid to any group matching the same folder.
 */
function resolveTargetGroupJid(
  task: ScheduledTask,
  groups: Record<string, RegisteredGroup>,
): string {
  const directTarget = groups[task.chat_jid];
  if (directTarget && directTarget.folder === task.group_folder) {
    return task.chat_jid;
  }
  const sameFolder = Object.entries(groups).filter(
    ([, g]) => g.folder === task.group_folder,
  );
  const preferred =
    sameFolder.find(([jid]) => jid.startsWith('web:')) || sameFolder[0];
  return preferred?.[0] || '';
}

function resolveTaskExecutionMode(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): ExecutionMode {
  if (task.execution_mode === 'host' || task.execution_mode === 'container') {
    return task.execution_mode;
  }
  // Legacy fallback: inherit from the original group
  const groups = deps.registeredGroups();
  const group = groups[task.chat_jid];
  if (group) {
    if (!group.is_home) {
      const homeSibling = Object.values(groups).find(
        (g) => g.folder === group.folder && g.is_home,
      );
      if (homeSibling) return homeSibling.executionMode || 'container';
    }
    return group.executionMode || 'container';
  }
  return 'container';
}

function ensureTaskWorkspace(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): { jid: string; folder: string } {
  // If workspace already exists and is registered, reuse it
  if (task.workspace_jid && task.workspace_folder) {
    const groups = deps.registeredGroups();
    if (groups[task.workspace_jid]) {
      return { jid: task.workspace_jid, folder: task.workspace_folder };
    }
    // Workspace was deleted externally — clean up orphaned filesystem directory before recreating
    const oldDir = path.join(GROUPS_DIR, task.workspace_folder);
    try {
      fs.rmSync(oldDir, { recursive: true, force: true });
    } catch { /* ignore if already gone */ }
  }

  const jid = `web:${crypto.randomUUID()}`;
  // Strip existing 'task-' prefix from IPC-originated IDs to avoid 'task-task-...'
  const idBase = task.id.startsWith('task-') ? task.id.slice(5) : task.id;
  // 用完整 task id 而不是 slice(0,12)：12 字符的截断只有 ~32 bit 熵，会让两个
  // 同时创建的隔离任务指向同一个 folder，互相覆盖工作区文件。task id 已经是
  // randomUUID 形态、不超长，直接用。registerGroup 的 folder 校验允许 . - _。
  const folder = `task-${idBase}`;
  // 从 prompt 提取简短名称（取第一行前 12 个字符）
  const firstLine = task.prompt.split('\n')[0].trim();
  const shortName = firstLine.slice(0, 12).trim() || task.id.slice(0, 6);
  const name = shortName;

  const executionMode = resolveTaskExecutionMode(task, deps);

  const sourceGroup = Object.values(deps.registeredGroups()).find(
    (g) => g.folder === task.group_folder,
  );
  const ownerId = resolveTaskOwner(task, sourceGroup);

  const group: RegisteredGroup = {
    name,
    folder,
    added_at: new Date().toISOString(),
    executionMode,
    created_by: ownerId,
  };

  setRegisteredGroup(jid, group);
  ensureChatExists(jid);
  updateChatName(jid, name);
  if (ownerId) {
    addGroupMember(folder, ownerId, 'owner', ownerId);
  }
  deps.registeredGroups()[jid] = group;

  // Create filesystem directory
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Persist workspace info back to the task record
  updateTaskWorkspace(task.id, jid, folder);
  // Also update the in-memory task object
  task.workspace_jid = jid;
  task.workspace_folder = folder;

  logger.info(
    { taskId: task.id, folder, jid, executionMode, ownerId },
    'Created task workspace',
  );

  // Notify frontend via WebSocket so sidebar refreshes (scoped to task owner)
  deps.onWorkspaceCreated?.(jid, folder, name, ownerId);

  return { jid, folder };
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string | null,
    groupFolder: string,
    displayName?: string,
    taskRunId?: string,
    selectedProviderId?: string | null,
  ) => void;
  sendMessage: (
    jid: string,
    text: string,
    options?: { source?: string },
  ) => Promise<string | undefined | void>;
  broadcastStreamEvent?: (chatJid: string, event: StreamEvent) => void;
  onWorkspaceCreated?: (jid: string, folder: string, name: string, userId?: string) => void;
  /** Store task prompt as a user-visible message in the workspace chat */
  storePromptMessage?: (chatJid: string, senderId: string, senderName: string, text: string, taskId?: string) => void;
  /** Store task result in workspace chat and push to owner's IM channels */
  storeResultAndNotify?: (
    chatJid: string,
    text: string,
    options: {
      ownerId?: string;
      notifyChannels?: string[] | null;
      sourceKind?: ContainerOutput['sourceKind'];
      skipStore?: boolean;
      workspaceFolder?: string;
    },
  ) => Promise<void>;
  assistantName: string;
}

export interface RunTaskOptions {
  /** Unique ID for isolated task IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  /** Manual trigger — don't update next_run, skip isTaskStillActive check */
  manualRun?: boolean;
}

const runningTaskIds = new Set<string>();

export function getRunningTaskIds(): string[] {
  return [...runningTaskIds];
}

/**
 * Decide whether a due task is so overdue that we should skip this missed run
 * and advance to the next scheduled trigger instead. Prevents the
 * "restart-storm" failure mode where many tasks fire concurrently after a
 * long downtime. Exported for direct test coverage of the policy.
 */
export function shouldSkipBackfill(
  nextRunIso: string | null | undefined,
  nowMs: number,
  graceMs: number,
): boolean {
  if (graceMs <= 0 || !nextRunIso) return false;
  const overdueMs = nowMs - new Date(nextRunIso).getTime();
  return overdueMs > graceMs;
}

function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = Number(task.schedule_value);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const anchorRaw = task.next_run
      ? new Date(task.next_run).getTime()
      : Date.now();
    // 防御：损坏的 next_run（手工 SQL / 旧版宽松校验）会让 anchor=NaN，
    // 后续算术全变 NaN，最终 `new Date(NaN).toISOString()` 抛 RangeError，
    // 把任务永久卡死在 runningTaskIds。优雅 fallback 到 now。
    const anchor = Number.isFinite(anchorRaw) ? anchorRaw : Date.now();
    const now = Date.now();
    const elapsed = now - anchor;
    const periods = elapsed > 0 ? Math.ceil(elapsed / ms) : 1;
    const next = anchor + periods * ms;
    if (!Number.isFinite(next)) return null;
    return new Date(next).toISOString();
  }
  // 'once' tasks have no next run
  return null;
}

function safeComputeNextRun(task: ScheduledTask, manualRun?: boolean): string | null {
  if (manualRun) return task.next_run ?? null;
  try {
    return computeNextRun(task);
  } catch (err) {
    logger.error(
      { taskId: task.id, err },
      'computeNextRun failed; leaving next_run unchanged',
    );
    return null;
  }
}

/**
 * 包装 updateTaskRunLog 让 SQLite 临时抛错（WAL busy / 磁盘满 / migration
 * 期间 schema 锁）不会冒泡出函数体，否则会跳过下面 runningTaskIds.delete
 * 让任务永久卡在 running set。
 */
function safeUpdateTaskRunLog(
  taskId: string,
  runLogId: number,
  patch: Parameters<typeof updateTaskRunLog>[1],
): void {
  try {
    updateTaskRunLog(runLogId, patch);
  } catch (err) {
    logger.error(
      { taskId, runLogId, err },
      'updateTaskRunLog failed (continuing to free runningTaskIds)',
    );
  }
}

/**
 * Re-check DB before running — task may have been cancelled/paused while queued.
 * Returns true if the task is still active and should proceed.
 */
function isTaskStillActive(taskId: string, label?: string): boolean {
  const currentTask = getTaskById(taskId);
  if (!currentTask || currentTask.status !== 'active') {
    logger.info(
      { taskId },
      `Skipping ${label ?? 'task'}: deleted or no longer active since enqueue`,
    );
    return false;
  }
  return true;
}

async function runTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): Promise<void> {
  if (!options?.manualRun && !isTaskStillActive(staleTask.id, 'task')) return;

  // Refresh task from DB to avoid stale closure data
  const task = getTaskById(staleTask.id);
  if (!task) return;

  runningTaskIds.add(task.id);
  // 顶层兜底 finally：runningTaskIds.add 之后到 inner runTask 真正进入 try
  // 之间还有 logTaskRunStart / ensureTaskWorkspace / mkdirSync / getUserById /
  // checkBilling / writeTasksSnapshot 等多次 DB/FS 调用，任意一处抛错都会
  // 让 task.id 永久挂在 runningTaskIds（scheduler 跳过该任务直到进程重启）。
  // 内层 try/finally 仍照常处理 next_run / 计费等逻辑；这层只兜底删 set。
  try {
    await runTaskInner(task, deps, options);
  } finally {
    runningTaskIds.delete(task.id);
  }
}

async function runTaskInner(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): Promise<void> {
  const startTime = Date.now();
  const runLogId = logTaskRunStart(task.id);

  // Ensure task has a dedicated workspace (Agent tasks only)
  const workspace = ensureTaskWorkspace(task, deps);
  const workspaceGroups = deps.registeredGroups();
  const workspaceGroup = workspaceGroups[workspace.jid];

  if (!workspaceGroup) {
    logger.error(
      { taskId: task.id, workspaceJid: workspace.jid },
      'Workspace group not found after creation',
    );
    safeUpdateTaskRunLog(task.id, runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Workspace group not found: ${workspace.jid}`,
    });
    try {
      const nextRun = safeComputeNextRun(task, options?.manualRun);
      updateTaskAfterRun(task.id, nextRun, `Error: Workspace group not found: ${workspace.jid}`);
    } catch (err) {
      logger.error({ taskId: task.id, err }, 'updateTaskAfterRun failed in early-exit');
    } finally {
      runningTaskIds.delete(task.id);
    }
    return;
  }

  const effectiveJid = options?.taskRunId
    ? `${workspace.jid}#task:${options.taskRunId}`
    : workspace.jid;

  const groupDir = path.join(GROUPS_DIR, workspace.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: workspace.folder },
    'Running scheduled task',
  );

  // Owner gate before running task: a disabled/deleted owner's scheduled
  // tasks must stop firing (billing only checks balance, not status, and is
  // skipped for admins — so it can't cover this). See `src/owner-gate.ts`.
  if (workspaceGroup.created_by) {
    const ownerGate = checkOwnerActive(getUserById(workspaceGroup.created_by));
    if (!ownerGate.allowed) {
      logger.info(
        {
          taskId: task.id,
          userId: workspaceGroup.created_by,
          ownerStatus: ownerGate.status,
        },
        'Owner not active, blocking scheduled task',
      );
      safeUpdateTaskRunLog(task.id, runLogId, {
        duration_ms: Date.now() - startTime,
        status: 'error',
        result: null,
        error: '账户已禁用',
      });
      try {
        const nextRun = safeComputeNextRun(task, options?.manualRun);
        updateTaskAfterRun(task.id, nextRun, 'Error: 账户已禁用');
      } catch (err) {
        logger.error({ taskId: task.id, err }, 'updateTaskAfterRun failed in owner-gate');
      } finally {
        runningTaskIds.delete(task.id);
      }
      return;
    }
  }

  // Billing quota check before running task
  if (isBillingEnabled() && workspaceGroup.created_by) {
    const owner = getUserById(workspaceGroup.created_by);
    if (owner && owner.role !== 'admin') {
      const accessResult = checkBillingAccessFresh(workspaceGroup.created_by, owner.role);
      if (!accessResult.allowed) {
        const reason = accessResult.reason || '当前账户不可用';
        logger.info(
          {
            taskId: task.id,
            userId: workspaceGroup.created_by,
            reason,
            blockType: accessResult.blockType,
          },
          'Billing access denied, blocking scheduled task',
        );
        safeUpdateTaskRunLog(task.id, runLogId, {
          duration_ms: Date.now() - startTime,
          status: 'error',
          result: null,
          error: `计费限制: ${reason}`,
        });
        try {
          // Still compute next run so the task isn't stuck (but preserve for manual runs)
          const nextRun = safeComputeNextRun(task, options?.manualRun);
          updateTaskAfterRun(task.id, nextRun, `Error: 计费限制: ${reason}`);
        } catch (err) {
          logger.error({ taskId: task.id, err }, 'updateTaskAfterRun failed in billing-gate');
        } finally {
          runningTaskIds.delete(task.id);
        }
        return;
      }
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isHome = false; // Task workspaces are never home
  const isAdminHome = false;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    workspace.folder,
    isAdminHome,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Store task prompt as a user message in workspace chat so it's visible in conversation
  if (deps.storePromptMessage) {
    const owner = workspaceGroup.created_by ? getUserById(workspaceGroup.created_by) : null;
    const senderName = owner?.display_name || owner?.username || '定时任务';
    deps.storePromptMessage(workspace.jid, owner?.id || 'system', senderName, task.prompt, task.id);
  }

  let result: string | null = null;
  let error: string | null = null;
  // Track the time of last meaningful output from the agent.
  // duration_ms should measure actual work time, not include idle wait.
  let lastOutputTime = startTime;
  let runLogFinalized = false;

  const finalizeRunLog = () => {
    if (runLogFinalized) return;
    runLogFinalized = true;
    // 注意：runningTaskIds.delete() 不在此处调用，
    // 必须等到 updateTaskAfterRun() ��新 next_run 后才能释放防重复屏障（#363）
    const durationMs = lastOutputTime - startTime;
    safeUpdateTaskRunLog(task.id, runLogId, {
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result,
      error,
    });
    // Send _close sentinel so the idle agent process exits promptly,
    // freeing the queue slot for the next run.
    if (idleTimer) clearTimeout(idleTimer);
    deps.queue.closeStdin(effectiveJid);
  };

  // Use persistent session for task workspace
  const sessions = deps.getSessions();
  const sessionId = sessions[workspace.folder];

  // Idle timer: writes _close sentinel after idleTimeout of no output,
  // so the container exits instead of hanging at waitForIpcMessage forever.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { taskId: task.id },
        'Scheduled task idle timeout, closing container stdin',
      );
      deps.queue.closeStdin(effectiveJid);
    }, getSystemSettings().idleTimeout);
  };

  try {
    const executionMode = resolveTaskExecutionMode(task, deps);
    const runAgent =
      executionMode === 'host' ? runHostAgent : runContainerAgent;

    // Resolve owner's home folder for correct volume mounts (skills, memory, CLAUDE.md)
    const ownerHomeFolder = workspaceGroup.created_by
      ? getUserHomeGroup(workspaceGroup.created_by)?.folder || workspace.folder
      : workspace.folder;

    const output = await runAgent(
      workspaceGroup,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: workspace.folder,
        chatJid: workspace.jid,
        isMain: isAdminHome,
        isHome,
        isAdminHome,
        isScheduledTask: true,
        taskRunId: options?.taskRunId,
      },
      (proc, identifier, selectedProviderId) =>
        deps.onProcess(
          effectiveJid,
          proc,
          executionMode === 'container' ? identifier : null,
          workspace.folder,
          identifier,
          options?.taskRunId,
          selectedProviderId,
        ),
      async (streamedOutput: ContainerOutput) => {
        // Broadcast stream events to WebSocket clients viewing the task workspace
        if (streamedOutput.status === 'stream' && streamedOutput.streamEvent) {
          deps.broadcastStreamEvent?.(workspace.jid, streamedOutput.streamEvent);
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          lastOutputTime = Date.now();
          resetIdleTimer();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
          lastOutputTime = Date.now();
        }
        // Finalize run log on first non-stream output (success/error/closed).
        // Don't wait for the process to exit — idle timeout can be very long.
        if (streamedOutput.status !== 'stream') {
          finalizeRunLog();
        }
      },
      ownerHomeFolder,
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
      lastOutputTime = Date.now();
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
      lastOutputTime = Date.now();
    }

    // Finalize if not already done by onOutput callback
    finalizeRunLog();

    logger.info(
      { taskId: task.id, durationMs: lastOutputTime - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    lastOutputTime = Date.now();
    logger.error({ taskId: task.id, error }, 'Task failed');
  } finally {
    // Clean up isolated task IPC directory
    if (options?.taskRunId) {
      const taskRunDir = path.join(
        DATA_DIR,
        'ipc',
        workspace.folder,
        'tasks-run',
        options.taskRunId,
      );
      try {
        fs.rmSync(taskRunDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    // Safety net: finalize run log if not already done by onOutput callback
    finalizeRunLog();
  }

  // 必须在 top-level try/finally 里清理 runningTaskIds：computeNextRun 抛错
  // （损坏 cron / 损坏 next_run 等）+ updateTaskAfterRun 抛错都不能让任务永久
  // 卡在 runningTaskIds 里被 scheduler 跳过。
  try {
    let nextRun: string | null = null;
    let resultSummary = error
      ? `Error: ${error}`
      : result
        ? result.slice(0, 200)
        : 'Completed';
    nextRun = safeComputeNextRun(task, options?.manualRun);
    if (!options?.manualRun && nextRun === null && task.schedule_type !== 'once' && !error) {
      resultSummary = 'Error: failed to compute next_run';
    }
    try {
      updateTaskAfterRun(task.id, nextRun, resultSummary);
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskAfterRun failed',
      );
    }
  } finally {
    runningTaskIds.delete(task.id);
  }

  if (deps.storeResultAndNotify && (result || error)) {
    const text = error
      ? `执行出错: ${error}`
      : stripAgentInternalTags(result!);

    if (text) {
      try {
        await deps.storeResultAndNotify(workspace.jid, text, {
          ownerId: workspaceGroup.created_by || undefined,
          notifyChannels: task.notify_channels,
          sourceKind: 'sdk_final',
          // Use source workspace folder for IM routing — isolated tasks run in
          // ephemeral workspaces (task-xxxxxx) that have no IM group bindings.
          // task.group_folder is the workspace where the task was created.
          workspaceFolder: task.group_folder || undefined,
        });
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'Failed to store/notify task result',
        );
      }
    }
  }

  // Auto-cleanup once-task workspace after completion
  if (task.schedule_type === 'once' && !options?.manualRun && task.workspace_jid && task.workspace_folder) {
    setTimeout(() => {
      try {
        const groups = deps.registeredGroups();
        if (groups[task.workspace_jid!]) {
          deleteGroupData(task.workspace_jid!, task.workspace_folder!);
          delete groups[task.workspace_jid!];
          removeFlowArtifacts(task.workspace_folder!);
          logger.info({ taskId: task.id, folder: task.workspace_folder }, 'Cleaned up once-task workspace');
        }
      } catch (err) {
        logger.error({ taskId: task.id, err }, 'Failed to cleanup once-task workspace');
      }
    }, 60_000);
  }
}

async function runScriptTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
  manualRun = false,
): Promise<void> {
  if (!manualRun && !isTaskStillActive(staleTask.id, 'script task')) return;

  // Refresh task from DB to avoid stale closure data
  const task = getTaskById(staleTask.id);
  if (!task) return;

  runningTaskIds.add(task.id);
  // 顶层兜底 finally（同 runTask）。
  try {
    await runScriptTaskInner(task, deps, groupJid, manualRun);
  } finally {
    runningTaskIds.delete(task.id);
  }
}

async function runScriptTaskInner(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
  manualRun = false,
): Promise<void> {
  const startTime = Date.now();
  const runLogId = logTaskRunStart(task.id);

  logger.info(
    { taskId: task.id, group: task.group_folder, executionType: 'script' },
    'Running script task',
  );

  // Owner gate before running script task: same as the Agent-task path, a
  // disabled/deleted owner's scheduled scripts must stop firing regardless of
  // billing toggle or role. See `src/owner-gate.ts`.
  {
    const ownerId = deps.registeredGroups()[groupJid]?.created_by;
    if (ownerId) {
      const ownerGate = checkOwnerActive(getUserById(ownerId));
      if (!ownerGate.allowed) {
        logger.info(
          { taskId: task.id, userId: ownerId, ownerStatus: ownerGate.status },
          'Owner not active, blocking script task',
        );
        safeUpdateTaskRunLog(task.id, runLogId, {
          duration_ms: Date.now() - startTime,
          status: 'error',
          result: null,
          error: '账户已禁用',
        });
        runningTaskIds.delete(task.id);
        const nextRun = safeComputeNextRun(task, manualRun);
        try {
          updateTaskAfterRun(task.id, nextRun, 'Error: 账户已禁用');
        } catch (err) {
          logger.error({ taskId: task.id, err }, 'updateTaskAfterRun failed in script owner-gate');
        }
        return;
      }
    }
  }

  // Billing quota check before running script task
  if (isBillingEnabled() && task.group_folder) {
    const groups = deps.registeredGroups();
    const group = groups[groupJid];
    if (group?.created_by) {
      const owner = getUserById(group.created_by);
      if (owner && owner.role !== 'admin') {
        const accessResult = checkBillingAccessFresh(group.created_by, owner.role);
        if (!accessResult.allowed) {
          const reason = accessResult.reason || '当前账户不可用';
          logger.info(
            {
              taskId: task.id,
              userId: group.created_by,
              reason,
              blockType: accessResult.blockType,
            },
            'Billing access denied, blocking script task',
          );
          safeUpdateTaskRunLog(task.id, runLogId, {
            duration_ms: Date.now() - startTime,
            status: 'error',
            result: null,
            error: `计费限制: ${reason}`,
          });
          runningTaskIds.delete(task.id);
          const nextRun = safeComputeNextRun(task, manualRun);
          try {
            updateTaskAfterRun(task.id, nextRun, `Error: 计费限制: ${reason}`);
          } catch (err) {
            logger.error({ taskId: task.id, err }, 'updateTaskAfterRun failed in script billing-gate');
          }
          return;
        }
      }
    }
  }

  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  if (!task.script_command) {
    logger.error(
      { taskId: task.id },
      'Script task has no script_command, skipping',
    );
    safeUpdateTaskRunLog(task.id, runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: 'script_command is empty',
    });
    try {
      const nextRun = safeComputeNextRun(task, manualRun);
      updateTaskAfterRun(task.id, nextRun, 'Error: script_command is empty');
    } catch (err) {
      logger.error({ taskId: task.id, err }, 'updateTaskAfterRun failed in script no-command');
    } finally {
      runningTaskIds.delete(task.id);
    }
    return;
  }

  let result: string | null = null;
  let error: string | null = null;

  try {
    const scriptResult = await runScript(
      task.script_command,
      task.group_folder,
    );

    if (scriptResult.timedOut) {
      error = `脚本执行超时 (${Math.round(scriptResult.durationMs / 1000)}s)`;
    } else if (scriptResult.exitCode !== 0) {
      error = scriptResult.stderr.trim() || `退出码: ${scriptResult.exitCode}`;
      result = scriptResult.stdout.trim() || null;
    } else {
      result = scriptResult.stdout.trim() || null;
    }

    // Send result to user (skip if no output and no error)
    if (error || result) {
      const text = error
        ? `[脚本] 执行失败: ${error}${result ? `\n输出:\n${result.slice(0, 500)}` : ''}`
        : `[脚本] ${result!.slice(0, 1000)}`;
      const fullText = `${deps.assistantName}: ${text}`;

      await deps.sendMessage(groupJid, fullText, { source: 'scheduled_task' });

      if (deps.storeResultAndNotify) {
        const groups = deps.registeredGroups();
        const group = groups[groupJid];
        if (group?.created_by) {
          try {
            await deps.storeResultAndNotify(groupJid, fullText, {
              ownerId: group.created_by,
              notifyChannels: task.notify_channels,
              skipStore: true,
              workspaceFolder: task.group_folder,
            });
          } catch (notifyErr) {
            logger.error(
              { taskId: task.id, err: notifyErr },
              'Failed to notify script task result to IM',
            );
          }
        }
      }
    }

    logger.info(
      {
        taskId: task.id,
        durationMs: Date.now() - startTime,
        exitCode: scriptResult.exitCode,
      },
      'Script task completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Script task failed');
  }

  const durationMs = Date.now() - startTime;

  // 顶层 try/finally 兜底：updateTaskRunLog/safeComputeNextRun/updateTaskAfterRun
  // 任一抛错都不能让任务永久卡在 runningTaskIds（scheduler 主循环会一直跳过）。
  try {
    try {
      safeUpdateTaskRunLog(task.id, runLogId, {
        duration_ms: durationMs,
        status: error ? 'error' : 'success',
        result,
        error,
      });
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskRunLog failed in script main path',
      );
    }
    // manualRun: preserve original next_run schedule
    const nextRun = safeComputeNextRun(task, manualRun);
    const resultSummary = error
      ? `Error: ${error}`
      : result
        ? result.slice(0, 200)
        : 'Completed';
    try {
      updateTaskAfterRun(task.id, nextRun, resultSummary);
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskAfterRun failed in script main path',
      );
    }
  } finally {
    runningTaskIds.delete(task.id);
  }
}

/**
 * Group context mode: inject task prompt as a regular message into the source workspace.
 * The message is processed by the existing message pipeline (IPC if running, new container if idle).
 */
async function runGroupModeTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  targetGroupJid: string,
  manualRun = false,
): Promise<void> {
  const startTime = Date.now();
  runningTaskIds.add(task.id);
  let resultSummary = '已注入到源工作区';

  try {
    // Resolve task owner for sender attribution
    const owner = task.created_by ? getUserById(task.created_by) : null;
    const senderName = owner?.display_name || owner?.username || '定时任务';

    if (!deps.storePromptMessage) {
      throw new Error('storePromptMessage dependency not available');
    }

    // Store prompt as a user message in the source workspace chat
    deps.storePromptMessage(
      targetGroupJid,
      owner?.id || 'system',
      senderName,
      task.prompt,
      task.id,
    );

    // Trigger normal message processing for the source workspace
    deps.queue.enqueueMessageCheck(targetGroupJid);

    logger.info(
      { taskId: task.id, targetGroupJid, contextMode: 'group' },
      'Group-mode task injected into source workspace',
    );

    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'success',
      result: '已注入到源工作区',
      error: null,
    });
  } catch (err) {
    resultSummary = `Error: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ taskId: task.id, error: resultSummary }, 'Group-mode task injection failed');

    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: resultSummary,
    });
  } finally {
    try {
      const nextRun = safeComputeNextRun(task, manualRun);
      updateTaskAfterRun(task.id, nextRun, resultSummary);
    } catch (err) {
      logger.error({ taskId: task.id, err }, 'updateTaskAfterRun failed in group-mode');
    } finally {
      runningTaskIds.delete(task.id);
    }
  }
}

let schedulerRunning = false;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let lastCleanupTime = 0;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;

  // Clean up stale state from previous process crash
  runningTaskIds.clear();
  try {
    const cleaned = cleanupStaleRunningLogs();
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale running task logs from previous session');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup stale running task logs');
  }

  // Clean up orphaned workspaces from completed once-tasks
  // (covers the case where process restarted before setTimeout cleanup fired)
  try {
    const allTasks = getAllTasks();
    const groups = deps.registeredGroups();
    let cleaned = 0;
    for (const t of allTasks) {
      if (
        t.schedule_type === 'once' &&
        t.status === 'completed' &&
        t.workspace_jid &&
        t.workspace_folder &&
        groups[t.workspace_jid]
      ) {
        deleteGroupData(t.workspace_jid, t.workspace_folder);
        delete groups[t.workspace_jid];
        removeFlowArtifacts(t.workspace_folder);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up orphaned once-task workspaces from previous session');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup orphaned once-task workspaces');
  }

  logger.info('Scheduler loop started');

  const loop = async () => {
    // Shutdown 自检：grace 期间若有任务到点会 spawn 子进程，孤儿化风险。
    // GroupQueue.isShuttingDown 在 src/index.ts shutdown handler 一开始
    // 就被设为 true（queue.shutdown 内部），所以 scheduler 看到后停 tick。
    if (deps.queue.isShuttingDown?.()) {
      logger.info('Scheduler tick skipped: queue is shutting down');
      // 仍排下一次 tick，让 process exit 退出循环（如果 shutdown 完成可恢复）
      setTimeout(loop, 60_000);
      return;
    }
    try {
      // Periodic cleanup of old task run logs (every 24h)
      const now = Date.now();
      if (now - lastCleanupTime >= CLEANUP_INTERVAL_MS) {
        lastCleanupTime = now;
        try {
          const deleted = cleanupOldTaskRunLogs();
          if (deleted > 0) {
            logger.info({ deleted }, 'Cleaned up old task run logs');
          }
        } catch (err) {
          logger.error({ err }, 'Failed to cleanup old task run logs');
        }
      }

      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      const graceMs = getSystemSettings().taskBackfillGraceMs;

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        if (runningTaskIds.has(currentTask.id)) {
          continue;
        }

        if (shouldSkipBackfill(currentTask.next_run, Date.now(), graceMs)) {
          const overdueMs = Date.now() - new Date(currentTask.next_run!).getTime();
          // Once-tasks 行为：用户明确希望它至少跑一次。跳过 backfill 会让
          // computeNextRun 返回 null，advanceSkippedTask(null) 把 status 翻为
          // completed —— 用户重启系统后 once-task 直接消失，没运行过。改为
          // 直接 fall through 到正常运行路径（让它一次性跑完）；否则按原 backfill
          // 跳过逻辑，cron / interval 推到下一次触发。
          if (currentTask.schedule_type === 'once') {
            logger.info(
              { taskId: currentTask.id, overdueMs, graceMs },
              'Once-task overdue but running it anyway (no auto-complete on skip)',
            );
            // intentional fall-through to normal run below
          } else {
            const advancedNextRun = safeComputeNextRun(currentTask);
            advanceSkippedTask(currentTask.id, advancedNextRun);
            logTaskRun({
              task_id: currentTask.id,
              run_at: new Date().toISOString(),
              duration_ms: 0,
              status: 'success',
              result: `Skipped: overdue by ${Math.round(overdueMs / 1000)}s, exceeds backfill grace window (${Math.round(graceMs / 1000)}s)`,
              error: null,
            });
            logger.info(
              { taskId: currentTask.id, overdueMs, graceMs, nextRun: advancedNextRun },
              'Skipping overdue task: exceeds backfill grace window',
            );
            continue;
          }
        }

        const groups = deps.registeredGroups();
        const targetGroupJid = resolveTargetGroupJid(currentTask, groups);

        if (!targetGroupJid) {
          logger.error(
            { taskId: currentTask.id, groupFolder: currentTask.group_folder },
            'Target group not registered, skipping scheduled task',
          );
          // 对 once-task 主动止损：若目标群组永远找不到，advanceSkippedTask
          // 把它推到 completed，避免每 60s tick 一次反复打 error 日志。
          // cron / interval 不动 next_run（重启后可能群组恢复），只 once 自动收尾。
          if (currentTask.schedule_type === 'once') {
            try {
              advanceSkippedTask(currentTask.id, null);
              logTaskRun({
                task_id: currentTask.id,
                run_at: new Date().toISOString(),
                duration_ms: 0,
                status: 'error',
                result: null,
                error: `Target group not registered: ${currentTask.chat_jid ?? currentTask.group_folder}`,
              });
            } catch (err) {
              logger.error({ taskId: currentTask.id, err }, 'Failed to mark once-task as completed after missing target');
            }
          }
          continue;
        }

        if (currentTask.execution_type === 'script') {
          if (!hasScriptCapacity()) {
            logger.debug(
              { taskId: currentTask.id },
              'Script concurrency limit reached, skipping',
            );
            continue;
          }
          // Script tasks run directly, not through GroupQueue
          runScriptTask(currentTask, deps, targetGroupJid).catch((err) => {
            logger.error(
              { taskId: currentTask.id, err },
              'Unhandled error in runScriptTask',
            );
          });
        } else if (currentTask.context_mode === 'group') {
          // Group mode: inject prompt into source workspace as a regular message
          runGroupModeTask(currentTask, deps, targetGroupJid).catch((err) => {
            logger.error(
              { taskId: currentTask.id, err },
              'Unhandled error in runGroupModeTask',
            );
          });
        } else {
          // Isolated mode (default): each agent task has a dedicated workspace
          const taskQueueJid = currentTask.workspace_jid
            ? `${currentTask.workspace_jid}#task:${currentTask.id}`
            : `${targetGroupJid}#task:${currentTask.id}`;
          deps.queue.enqueueTask(taskQueueJid, currentTask.id, () =>
            runTask(currentTask, deps, {
              taskRunId: currentTask.id,
            }),
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/**
 * Manually trigger a task to run now (fire-and-forget).
 * Does not change next_run — the task continues its normal schedule.
 */
export function triggerTaskNow(
  taskId: string,
  deps: SchedulerDependencies,
): { success: boolean; error?: string } {
  const task = getTaskById(taskId);
  if (!task) return { success: false, error: 'Task not found' };
  if (task.status === 'completed')
    return { success: false, error: 'Task already completed' };
  if (task.status === 'paused')
    return { success: false, error: '任务已暂停，请先恢复后再运行' };
  if (runningTaskIds.has(taskId))
    return { success: false, error: 'Task is already running' };

  const groups = deps.registeredGroups();
  const targetGroupJid = resolveTargetGroupJid(task, groups);
  if (!targetGroupJid)
    return { success: false, error: 'Target group not registered' };

  if (task.execution_type === 'script') {
    if (!hasScriptCapacity())
      return { success: false, error: 'Script concurrency limit reached' };
    runScriptTask(task, deps, targetGroupJid, true).catch((err) =>
      logger.error({ taskId, err }, 'Manual script task failed'),
    );
  } else if (task.context_mode === 'group') {
    runGroupModeTask(task, deps, targetGroupJid, true).catch((err) =>
      logger.error({ taskId, err }, 'Manual group-mode task failed'),
    );
  } else {
    const opts: RunTaskOptions = { manualRun: true, taskRunId: task.id };
    const taskQueueJid = task.workspace_jid
      ? `${task.workspace_jid}#task:${task.id}`
      : `${targetGroupJid}#task:${task.id}`;
    deps.queue.enqueueTask(taskQueueJid, task.id, () =>
      runTask(task, deps, opts),
    );
  }

  return { success: true };
}
