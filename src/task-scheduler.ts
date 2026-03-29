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
import { DailySummaryDeps, runDailySummaryIfNeeded } from './daily-summary.js';
import { getSystemSettings } from './runtime-config.js';
import {
  ContainerOutput,
  runContainerAgent,
  runHostAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  addGroupMember,
  getAllTasks,
  cleanupOldTaskRunLogs,
  cleanupStaleRunningLogs,
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
import { hasScriptCapacity, runScript } from './script-runner.js';
import type { StreamEvent } from './stream-event.types.js';
import { ExecutionMode, RegisteredGroup, ScheduledTask } from './types.js';
import { checkBillingAccessFresh, isBillingEnabled } from './billing.js';

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
  const folder = `task-${idBase.slice(0, 12)}`;
  // 从 prompt 提取简短名称（取第一行前 12 个字符）
  const firstLine = task.prompt.split('\n')[0].trim();
  const shortName = firstLine.slice(0, 12).trim() || task.id.slice(0, 6);
  const name = shortName;

  const executionMode = resolveTaskExecutionMode(task, deps);

  const group: RegisteredGroup = {
    name,
    folder,
    added_at: new Date().toISOString(),
    executionMode,
    created_by: task.created_by,
  };

  setRegisteredGroup(jid, group);
  ensureChatExists(jid);
  updateChatName(jid, name);
  // Resolve owner: prefer task.created_by, fallback to source group's owner
  const ownerId = task.created_by
    || Object.values(deps.registeredGroups()).find((g) => g.folder === task.group_folder)?.created_by
    || null;
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
    { taskId: task.id, folder, jid, executionMode },
    'Created task workspace',
  );

  // Notify frontend via WebSocket so sidebar refreshes (scoped to task owner)
  deps.onWorkspaceCreated?.(jid, folder, name, task.created_by ?? undefined);

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
  ) => void;
  sendMessage: (
    jid: string,
    text: string,
    options?: { source?: string },
  ) => Promise<string | undefined | void>;
  broadcastStreamEvent?: (chatJid: string, event: StreamEvent) => void;
  onWorkspaceCreated?: (jid: string, folder: string, name: string, userId?: string) => void;
  /** Store task prompt as a user-visible message in the workspace chat */
  storePromptMessage?: (chatJid: string, senderId: string, senderName: string, text: string) => void;
  assistantName: string;
  dailySummaryDeps?: DailySummaryDeps;
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

function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    const anchor = task.next_run
      ? new Date(task.next_run).getTime()
      : Date.now();
    let nextTime = anchor + ms;
    while (nextTime <= Date.now()) {
      nextTime += ms;
    }
    return new Date(nextTime).toISOString();
  }
  // 'once' tasks have no next run
  return null;
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
  task: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): Promise<void> {
  if (!options?.manualRun && !isTaskStillActive(task.id, 'task')) return;

  runningTaskIds.add(task.id);
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
    updateTaskRunLog(runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Workspace group not found: ${workspace.jid}`,
    });
    runningTaskIds.delete(task.id);
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
        updateTaskRunLog(runLogId, {
          duration_ms: Date.now() - startTime,
          status: 'error',
          result: null,
          error: `计费限制: ${reason}`,
        });
        runningTaskIds.delete(task.id);
        // Still compute next run so the task isn't stuck
        const nextRun = computeNextRun(task);
        updateTaskAfterRun(task.id, nextRun, `Error: 计费限制: ${reason}`);
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
    deps.storePromptMessage(workspace.jid, owner?.id || 'system', senderName, task.prompt);
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
    runningTaskIds.delete(task.id);
    const durationMs = lastOutputTime - startTime;
    updateTaskRunLog(runLogId, {
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
      (proc, identifier) =>
        deps.onProcess(
          effectiveJid,
          proc,
          executionMode === 'container' ? identifier : null,
          workspace.folder,
          identifier,
          options?.taskRunId,
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
    runningTaskIds.delete(task.id);
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

  // manualRun: preserve original next_run schedule
  const nextRun = options?.manualRun ? task.next_run : computeNextRun(task);

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

async function runScriptTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
  manualRun = false,
): Promise<void> {
  if (!manualRun && !isTaskStillActive(task.id, 'script task')) return;

  runningTaskIds.add(task.id);
  const startTime = Date.now();
  const runLogId = logTaskRunStart(task.id);

  logger.info(
    { taskId: task.id, group: task.group_folder, executionType: 'script' },
    'Running script task',
  );

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
          updateTaskRunLog(runLogId, {
            duration_ms: Date.now() - startTime,
            status: 'error',
            result: null,
            error: `计费限制: ${reason}`,
          });
          runningTaskIds.delete(task.id);
          const nextRun = computeNextRun(task);
          updateTaskAfterRun(task.id, nextRun, `Error: 计费限制: ${reason}`);
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
    updateTaskRunLog(runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: 'script_command is empty',
    });
    runningTaskIds.delete(task.id);
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

      await deps.sendMessage(groupJid, `${deps.assistantName}: ${text}`, { source: 'scheduled_task' });
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
  } finally {
    runningTaskIds.delete(task.id);
  }

  const durationMs = Date.now() - startTime;

  updateTaskRunLog(runLogId, {
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  // manualRun: preserve original next_run schedule
  const nextRun = manualRun ? task.next_run : computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
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

  logger.info('Scheduler loop started');

  const loop = async () => {
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

      // Daily summary generation (runs at most once per hour, 2-3 AM)
      if (deps.dailySummaryDeps) {
        try {
          runDailySummaryIfNeeded(deps.dailySummaryDeps);
        } catch (err) {
          logger.error({ err }, 'Daily summary check failed');
        }
      }

      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        if (runningTaskIds.has(currentTask.id)) {
          continue;
        }

        const groups = deps.registeredGroups();
        const targetGroupJid = resolveTargetGroupJid(currentTask, groups);

        if (!targetGroupJid) {
          logger.error(
            { taskId: currentTask.id, groupFolder: currentTask.group_folder },
            'Target group not registered, skipping scheduled task',
          );
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
        } else {
          // Each agent task has a dedicated workspace; use workspace JID or
          // fallback to targetGroupJid for queue serialization key
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
