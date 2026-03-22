import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
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
  getAllTasks,
  cleanupOldTaskRunLogs,
  getDueTasks,
  getTaskById,
  getUserById,
  logTaskRun,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { hasScriptCapacity, runScript } from './script-runner.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
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
  groupJid: string,
  options?: RunTaskOptions,
): Promise<void> {
  if (!options?.manualRun && !isTaskStillActive(task.id, 'task')) return;

  const effectiveJid = options?.taskRunId
    ? `${groupJid}#task:${options.taskRunId}`
    : groupJid;

  runningTaskIds.add(task.id);
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = groups[groupJid];

  if (!group || group.folder !== task.group_folder) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, groupJid },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    runningTaskIds.delete(task.id);
    return;
  }

  // Billing quota check before running task
  if (isBillingEnabled() && group.created_by) {
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
          'Billing access denied, blocking scheduled task',
        );
        logTaskRun({
          task_id: task.id,
          run_at: new Date().toISOString(),
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
  const isHome = !!group.is_home;
  const isAdminHome = isHome && task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
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

  let result: string | null = null;
  let error: string | null = null;
  // Track the time of last meaningful output from the agent.
  // duration_ms should measure actual work time, not include idle wait.
  let lastOutputTime = startTime;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

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
    // Resolve execution mode: if this group is not is_home but shares a folder
    // with an is_home group, inherit that group's execution mode (same logic as
    // queue.setHostModeResolver). Fixes tasks created from Telegram/IM picking
    // container mode even though admin home folder should run in host mode.
    let executionMode = group.executionMode || 'container';
    if (!group.is_home) {
      const allGroups = deps.registeredGroups();
      const homeSibling = Object.values(allGroups).find(
        (g) => g.folder === group.folder && g.is_home,
      );
      if (homeSibling) {
        executionMode = homeSibling.executionMode || 'container';
      }
    }
    const runAgent =
      executionMode === 'host' ? runHostAgent : runContainerAgent;

    const output = await runAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: groupJid,
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
          task.group_folder,
          identifier,
          options?.taskRunId,
        ),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          lastOutputTime = Date.now();
          // Scheduled tasks should only produce user-visible output via the
          // send_message MCP tool (IPC messages/*.json → index.ts polling).
          // Do NOT forward raw agent text here — it contains intermediate
          // reasoning / status updates that leak to the user as noise.
          resetIdleTimer();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
          lastOutputTime = Date.now();
        }
      },
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
        task.group_folder,
        'tasks-run',
        options.taskRunId,
      );
      try {
        fs.rmSync(taskRunDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // Use lastOutputTime instead of Date.now() to exclude idle wait time
  const durationMs = lastOutputTime - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

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
          logTaskRun({
            task_id: task.id,
            run_at: new Date().toISOString(),
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
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
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
      result = scriptResult.stdout.trim() || '(无输出)';
    }

    // Send result to user
    const text = error
      ? `[脚本] 执行失败: ${error}${result ? `\n输出:\n${result.slice(0, 500)}` : ''}`
      : `[脚本] ${result!.slice(0, 1000)}`;

    await deps.sendMessage(groupJid, `${deps.assistantName}: ${text}`, { source: 'scheduled_task' });

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

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
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
        } else if (currentTask.context_mode === 'isolated') {
          // Isolated tasks use a virtual JID for independent serialization
          const virtualJid = `${targetGroupJid}#task:${currentTask.id}`;
          deps.queue.enqueueTask(virtualJid, currentTask.id, () =>
            runTask(currentTask, deps, targetGroupJid, {
              taskRunId: currentTask.id,
            }),
          );
        } else {
          // Group-mode tasks share the group's serialization key
          deps.queue.enqueueTask(targetGroupJid, currentTask.id, () =>
            runTask(currentTask, deps, targetGroupJid),
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
    const opts: RunTaskOptions = { manualRun: true };
    if (task.context_mode === 'isolated') {
      opts.taskRunId = task.id;
      const virtualJid = `${targetGroupJid}#task:${task.id}`;
      deps.queue.enqueueTask(virtualJid, task.id, () =>
        runTask(task, deps, targetGroupJid, opts),
      );
    } else {
      deps.queue.enqueueTask(targetGroupJid, task.id, () =>
        runTask(task, deps, targetGroupJid, opts),
      );
    }
  }

  return { success: true };
}
