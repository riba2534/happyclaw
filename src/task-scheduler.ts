import { ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';
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
import { channelConversationJid } from './channel-address.js';
import {
  ContainerOutput,
  cleanupContainerTaskRuntimeEnvDirs,
  runContainerAgent,
  runHostAgent,
  runAgentWithModelFallback,
  writeTasksSnapshot,
} from './container-runner.js';
import { PROVIDER_FAILURE_USER_NOTICE } from './provider-failure.js';
import {
  advanceSkippedTask,
  cancelTaskRun,
  claimNextTaskRunNotification,
  ClaimedTaskRunNotification,
  claimNextTaskRun,
  completeIsolatedTaskRunWithWorkspaceResultIntent,
  completeTaskRunNotificationAttempt,
  completeTaskRun,
  createTaskRun,
  failExpiredStartedTaskRuns,
  finalizeDeliveredGroupTaskRun,
  finalizeExpiredTaskRunNotificationAttempts,
  finalizeTaskRunNotificationIfPending,
  getAllTasks,
  cleanupOldTaskRunLogs,
  cleanupStaleRunningLogs,
  clearStaleTaskLeases,
  claimTaskForRun,
  deleteGroupData,
  getDueTasks,
  getDueTaskDefinitionsV2,
  getNextScheduledTaskWakeAt,
  getNextTaskRunWakeAt,
  getTaskRunById,
  getTaskRunLogs,
  getTaskRunsByStatus,
  getSession,
  getTaskById,
  getUserById,
  getUserHomeGroup,
  getAgentProfileForWorkspace,
  getSessionAgentIdentity,
  logTaskRun,
  logTaskRunStart,
  markTaskRunExecutionStarted,
  materializeTaskOccurrence,
  releaseTaskRunForRetry,
  recordTaskRunNotificationReceipt,
  replaceTaskRunNotificationReceipt,
  renewTaskRunNotificationLease,
  renewTaskRunLease,
  TaskRunNotificationPayload,
  TaskRunAtomicNotificationPayload,
  TaskRunNotificationReceipt,
  updateTaskRunLog,
  pauseTaskAfterRun,
  setSession,
  deleteSession,
  deleteMessagesForChatJid,
  updateTaskAfterRun,
  updateTask,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { removeFlowArtifacts } from './file-manager.js';
import { runScript } from './script-runner.js';
import type { StreamEvent } from './stream-event.types.js';
import {
  AgentProfile,
  ClaimedTaskRun,
  ExecutionMode,
  MessageSourceKind,
  RegisteredGroup,
  ScheduledTask,
  TaskRun,
  TaskRunLog,
  TaskRunNotificationSummary,
} from './types.js';
import { checkBillingAccessFresh, isBillingEnabled } from './billing.js';
import { checkOwnerActive } from './owner-gate.js';
import {
  canExecuteOnHost,
  HOST_EXECUTION_FORBIDDEN_ERROR,
} from './host-execution-policy.js';
import { resolveEffectiveAgentProfile } from './agent-profile-runtime.js';
import {
  buildAgentProfilePrompt,
  hasAgentProfilePrompts,
} from './agent-profile-prompts.js';
import { stripAgentInternalTags } from './utils.js';
import {
  markIsolatedTaskRunIpcComplete,
  tryCleanupCompletedIsolatedTaskRunIpc,
} from './isolated-task-ipc.js';
import { getScriptTaskHostExecutionError } from './script-task-policy.js';

export function shouldFinalizeScheduledRunOutput(
  output: Pick<
    ContainerOutput,
    'status' | 'inputTurnCompleted' | 'providerFailureTerminal'
  >,
  inputPreviouslyCompleted = false,
): boolean {
  return (
    output.status === 'error' ||
    output.providerFailureTerminal === true ||
    (output.status === 'success' && output.inputTurnCompleted === true) ||
    (output.status === 'closed' && inputPreviouslyCompleted)
  );
}

/**
 * Resolve the actual group JID to send a task to.
 * Falls back from the task's stored chat_jid to any group matching the same folder.
 */
/**
 * Resolve where this task delivers, or nothing.
 *
 * This used to fall back to "any group in the same folder, preferring `web:`"
 * when the stored target did not resolve, so a task bound to one Feishu group
 * could silently start answering in another group — or on the Web — after a
 * rebind or folder migration. CLAUDE.md section 6.4 forbids exactly that: the
 * response target must not degrade to a default. A run now either reaches its
 * recorded binding or fails terminally, which the caller surfaces.
 *
 * The binding may carry Feishu thread/root fragments while `registered_groups`
 * is keyed by the conversation JID, so both spellings are accepted.
 */
function resolveTargetGroupJid(
  task: ScheduledTask,
  groups: Record<string, RegisteredGroup>,
): string {
  const route = task.delivery_route_jid || task.chat_jid;
  if (!route) return '';
  const bound = groups[route] ?? groups[channelConversationJid(route)];
  if (bound && bound.folder === task.group_folder) return route;
  return '';
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

function scriptTaskRuntimePolicyError(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): string | null {
  const groups = deps.registeredGroups();
  const definitionError = getScriptTaskHostExecutionError(task, groups);
  if (definitionError) return definitionError;
  if (task.execution_type !== 'script') return null;
  const ownerId = groups[task.chat_jid]?.created_by;
  return canExecuteOnHost(ownerId ? getUserById(ownerId) : undefined)
    ? null
    : HOST_EXECUTION_FORBIDDEN_ERROR;
}

function pauseUnsafeScriptTask(
  taskId: string,
  deps: SchedulerDependencies,
): void {
  const current = getTaskById(taskId);
  if (!current || !scriptTaskRuntimePolicyError(current, deps)) return;
  updateTask(taskId, { status: 'paused', next_run: null });
  notifyTaskSchedulerChanged();
}

function toRunnerAgentProfile(profile: AgentProfile | undefined) {
  profile = resolveEffectiveAgentProfile(profile);
  if (!profile) return undefined;
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    isDefault: profile.is_default,
    identityHash: profile.identity_hash,
    identityPrompt: buildAgentProfilePrompt(profile),
    includeClaudePreset: profile.prompt_mode === 'append',
    runtimePolicy: profile.runtime_policy,
  };
}

function taskSessionNeedsAgentProfileReset(
  groupFolder: string,
  profile: AgentProfile | undefined,
  sessionAgentId?: string | null,
): boolean {
  if (!profile) return false;
  const current = getSessionAgentIdentity(groupFolder, sessionAgentId);
  if (!current) return false;
  if (
    !current.agent_profile_id &&
    !current.identity_hash &&
    !hasAgentProfilePrompts(profile) &&
    profile.prompt_mode === 'append'
  ) {
    return false;
  }
  if (current.identity_hash !== profile.identity_hash) return true;
  if (
    current.agent_profile_version != null &&
    current.agent_profile_version !== profile.version
  ) {
    return true;
  }
  return !!current.agent_profile_id && current.agent_profile_id !== profile.id;
}

function resolveTaskWorkspace(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): { jid: string; folder: string; group: RegisteredGroup } | null {
  const groups = deps.registeredGroups();
  const sameFolder = Object.entries(groups).filter(
    ([, g]) => g.folder === task.group_folder,
  );
  const preferred =
    sameFolder.find(([jid]) => jid.startsWith('web:')) ||
    (groups[task.chat_jid]
      ? ([task.chat_jid, groups[task.chat_jid]] as const)
      : undefined) ||
    sameFolder[0];
  if (!preferred) return null;
  const [jid, group] = preferred;
  return { jid, folder: group.folder, group };
}

function resolveTaskRunWorkspace(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): { jid: string; folder: string; group: RegisteredGroup } | null {
  if (options?.sourceWorkspaceJid && options.sourceWorkspaceFolder) {
    const group = deps.registeredGroups()[options.sourceWorkspaceJid];
    if (!group || group.folder !== options.sourceWorkspaceFolder) {
      logger.error(
        {
          taskId: task.id,
          workspaceJid: options.sourceWorkspaceJid,
          workspaceFolder: options.sourceWorkspaceFolder,
        },
        'Pinned task workspace disappeared before queued run started',
      );
      return null;
    }
    return {
      jid: options.sourceWorkspaceJid,
      folder: options.sourceWorkspaceFolder,
      group,
    };
  }
  return resolveTaskWorkspace(task, deps);
}

/**
 * Compute the queue JID for an isolated (non-group, non-script) task run.
 * The queue key is a virtual task chat under the source workspace. That keeps
 * scheduler execution out of the main session while still using the same
 * workspace directory and environment.
 *
 * Returns null when the source workspace cannot be resolved. The caller skips
 * the run and retries later instead of falling back to another workspace.
 */
function prepareIsolatedTaskRun(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  manualRun = false,
  explicitTaskRunId?: string,
): { queueJid: string; options: RunTaskOptions } | null {
  const workspace = resolveTaskWorkspace(task, deps);
  if (!workspace) {
    logger.error(
      {
        taskId: task.id,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
      },
      'Failed to resolve task workspace before enqueue; skipping this run (retries next tick)',
    );
    return null;
  }
  const taskRunId = explicitTaskRunId
    ? explicitTaskRunId
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120)
    : createIsolatedTaskRunId(task.id);
  return {
    queueJid: `${workspace.jid}#task:${taskRunId}`,
    options: {
      taskRunId,
      manualRun,
      sourceWorkspaceJid: workspace.jid,
      sourceWorkspaceFolder: workspace.folder,
    },
  };
}

function createIsolatedTaskRunId(taskId: string): string {
  const safeTaskId = taskId
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `task-${safeTaskId || 'run'}-${randomUUID()}`;
}

function createTaskSessionAgentId(taskRunId: string): string {
  return `task-${taskRunId}`;
}

function cleanupIsolatedTaskRun(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): void {
  const taskRunId = options?.taskRunId;
  if (!taskRunId) return;

  // Only generated, Docker-safe identifiers may reach filesystem cleanup.
  // This guard prevents a future caller from turning RunTaskOptions into a
  // path traversal primitive.
  if (!/^[a-zA-Z0-9_-]+$/.test(taskRunId)) {
    logger.error(
      { taskId: task.id, taskRunId },
      'Refusing to clean unsafe isolated task run id',
    );
    return;
  }

  const resolvedWorkspace = resolveTaskRunWorkspace(task, deps, options);
  const workspace =
    resolvedWorkspace ??
    (options.sourceWorkspaceJid && options.sourceWorkspaceFolder
      ? {
          jid: options.sourceWorkspaceJid,
          folder: options.sourceWorkspaceFolder,
        }
      : null);
  if (!workspace) return;
  const sessionAgentId = createTaskSessionAgentId(taskRunId);
  const virtualChatJid = `${workspace.jid}#task:${taskRunId}`;

  const sessionPath = path.join(
    DATA_DIR,
    'sessions',
    workspace.folder,
    'agents',
    sessionAgentId,
  );
  const cleanupRuntimeArtifacts = () => {
    deleteSession(workspace.folder, sessionAgentId);
    deleteMessagesForChatJid(virtualChatJid);
    fs.rmSync(sessionPath, { recursive: true, force: true });
    cleanupContainerTaskRuntimeEnvDirs(workspace.folder, taskRunId);
  };

  // send_message writes happen before the runner returns, but the host watcher
  // consumes them asynchronously.  Mark the producer complete and only remove
  // the IPC namespace when the watcher has ACKed every file by unlinking it.
  // If anything is still pending, leave the directory for the normal/startup
  // IPC scan; that scan performs the same cleanup once delivery succeeds.
  const ipcRunPath = path.join(
    DATA_DIR,
    'ipc',
    workspace.folder,
    'tasks-run',
    taskRunId,
  );
  try {
    markIsolatedTaskRunIpcComplete(ipcRunPath, {
      taskId: task.id,
      taskRunId,
      durableRunId: options?.durableRun?.id,
      workspaceFolder: workspace.folder,
      virtualChatJid,
      sessionAgentId,
    });
    const cleaned = tryCleanupCompletedIsolatedTaskRunIpc(
      ipcRunPath,
      cleanupRuntimeArtifacts,
    );
    if (cleaned && options?.durableRun?.id) {
      finalizeTaskRunNotificationIfPending(options.durableRun.id);
    }
  } catch (err) {
    logger.warn(
      { taskId: task.id, taskRunId, runPath: ipcRunPath, err },
      'Failed to mark/clean completed isolated task IPC directory',
    );
  }
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
  onWorkspaceCreated?: (
    jid: string,
    folder: string,
    name: string,
    userId?: string,
  ) => void;
  /** Store task prompt as a user-visible message in the workspace chat */
  storePromptMessage?: (
    chatJid: string,
    senderId: string,
    senderName: string,
    text: string,
    taskId?: string,
    taskRunId?: string,
  ) => string | void;
  /**
   * Atomically persist a group-mode prompt and fence the durable run into its
   * delivered hand-off state. Required for V2 group occurrences.
   */
  storeGroupPromptAndDeliverRun?: (input: {
    run: ClaimedTaskRun;
    messageId: string;
    chatJid: string;
    senderId: string;
    senderName: string;
    text: string;
    taskId: string;
    queuedResult: string;
  }) => string;
  /** Store task result in workspace chat and push to owner's IM channels */
  storeResultAndNotify?: (
    chatJid: string,
    text: string,
    options: {
      ownerId?: string;
      notifyChannels?: string[] | null;
      sourceKind?: MessageSourceKind;
      /** Stable id for replay-safe Web workspace projection. */
      messageId?: string;
      skipStore?: boolean;
      workspaceFolder?: string;
      /** Skip the source channel only after its connector strictly ACKed. */
      sourceAlreadyDelivered?: boolean;
      /**
       * The task's recorded delivery binding. Framework-sent notices go here
       * rather than being resolved by scanning the owner's groups.
       */
      deliveryRouteJid?: string | null;
    },
  ) => Promise<void | TaskRunNotificationReceipt>;
  /** Retry one concrete IM delivery without replaying Agent work/Web writes. */
  retryTaskNotification?: (
    payload: TaskRunAtomicNotificationPayload,
  ) => Promise<TaskRunNotificationReceipt>;
  assistantName: string;
}

function scheduledTaskDisplayName(task: ScheduledTask): string {
  const firstLine =
    task.prompt
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || task.id;
  const normalized = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 120
    ? `${normalized.slice(0, 117)}...`
    : normalized;
}

export function formatScheduledTaskWorkspaceResult(input: {
  task: ScheduledTask;
  runId: string;
  result: string | null;
  error: string | null;
}): string {
  const title = input.error
    ? '## ❌ 定时任务执行失败'
    : '## ✅ 定时任务执行完成';
  const metadata = [
    `**任务**：${scheduledTaskDisplayName(input.task)}`,
    `**运行 ID**：\`${input.runId}\``,
  ];
  if (input.error) metadata.push(`**错误**：${input.error}`);

  const content = input.result?.trim();
  if (content) {
    return `${title}\n\n${metadata.join('\n')}\n\n---\n\n${content}`;
  }
  const emptyNotice = input.error
    ? '本次运行没有留下可展示的业务结果，请查看执行日志。'
    : '本次运行已结束，但 Agent 没有返回可展示的业务结果。';
  return `${title}\n\n${metadata.join('\n')}\n\n${emptyNotice}`;
}

export interface RunTaskOptions {
  /** Unique ID for isolated task IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  /** Manual trigger — don't update next_run, skip isTaskStillActive check */
  manualRun?: boolean;
  /** Workspace pinned when this run entered GroupQueue. */
  sourceWorkspaceJid?: string;
  sourceWorkspaceFolder?: string;
  /** V2 occurrence already owns a fenced task_runs lease. */
  durableRun?: ClaimedTaskRun;
  /**
   * Exposes the exact isolated terminal hand-off to the owning queue callback
   * so it can retry one synchronous DB failure without falling back to a
   * non-atomic legacy completion.
   */
  onDurableTerminalHandoffPrepared?: (commit: () => boolean) => void;
}

const runningTaskIds = new Set<string>();
const pendingManualTaskIds = new Set<string>();
const pendingScheduledTaskIds = new Set<string>();
const activeDurableTaskIds = new Set<string>();

function isTaskReserved(taskId: string): boolean {
  return (
    runningTaskIds.has(taskId) ||
    pendingManualTaskIds.has(taskId) ||
    pendingScheduledTaskIds.has(taskId)
  );
}

export function getRunningTaskIds(): string[] {
  let durableTaskIds: string[] = [];
  try {
    durableTaskIds = getTaskRunsByStatus([
      'queued',
      'running',
      'retry_wait',
    ]).map((run) => run.task_id);
  } catch {
    // Database may not be initialized in small unit tests/import-time callers.
  }
  return [
    ...new Set([
      ...runningTaskIds,
      ...pendingManualTaskIds,
      ...pendingScheduledTaskIds,
      ...durableTaskIds,
    ]),
  ];
}

/**
 * Recurring work that became due before this scheduler process started is
 * recorded as missed instead of replayed. One-time work is handled separately
 * and still runs after a restart. Exported for direct policy coverage.
 */
export function shouldSkipBackfill(
  nextRunIso: string | null | undefined,
  schedulerStartedAtMs: number,
): boolean {
  if (schedulerStartedAtMs <= 0 || !nextRunIso) return false;
  const scheduledAtMs = new Date(nextRunIso).getTime();
  return Number.isFinite(scheduledAtMs) && scheduledAtMs < schedulerStartedAtMs;
}

/**
 * Deterministic minimum-frequency validation. Five-field cron is minute based;
 * six-field cron is safe only when its seconds field resolves to one value.
 * Inspecting two future occurrences is insufficient for irregular calendars.
 */
export function validateCronMinimumInterval(value: string): void {
  const parsed = CronExpressionParser.parse(value, { tz: TIMEZONE });
  if (parsed.fields.second.values.length !== 1) {
    throw new Error('Cron frequency must be at least 60 seconds');
  }
}

function nextValidatedCronRun(value: string, fromMs = Date.now()): string {
  validateCronMinimumInterval(value);
  const interval = CronExpressionParser.parse(value, {
    tz: TIMEZONE,
    currentDate: new Date(fromMs),
  });
  const first = interval.next().toDate();
  return first.toISOString();
}

function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    return nextValidatedCronRun(task.schedule_value);
  } else if (task.schedule_type === 'interval') {
    const ms = Number(task.schedule_value);
    // Legacy/manual DB rows bypassing modern REST/MCP validation must fail
    // closed too. Throwing sends the occurrence through materialize's
    // missed+pause path instead of admitting a millisecond-frequency loop.
    if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) {
      throw new Error(
        `Invalid interval (must be at least ${MIN_INTERVAL_MS} milliseconds): ${task.schedule_value}`,
      );
    }
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

/**
 * 为「新建 / 修改任务」计算 next_run（now 为锚点）。与上面的 computeNextRun 不同：
 * 后者按 task.next_run 为锚点推进周期（调度循环用），这里是从当前时刻起算第一次触发
 * （创建/更新时用）。非法 schedule 抛错，由调用方决定如何回执。
 */
export function computeNextRunForSchedule(
  type: 'cron' | 'interval' | 'once',
  value: string,
): string {
  if (type === 'cron') {
    const iso = nextValidatedCronRun(value);
    if (!iso) throw new Error(`Invalid cron expression: ${value}`);
    return iso;
  }
  if (type === 'interval') {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) {
      throw new Error(
        `Invalid interval (must be at least ${MIN_INTERVAL_MS} milliseconds): ${value}`,
      );
    }
    return new Date(Date.now() + ms).toISOString();
  }
  // once：value 为不带 Z 的本地时间串，按进程本地时区解释再转 UTC 存储。
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return d.toISOString();
}

/** Rebuild a cleared cursor when a paused task is explicitly enabled. */
export function computeNextRunForTaskResume(
  type: 'cron' | 'interval' | 'once',
  value: string,
  now = Date.now(),
): string {
  const nextRun = computeNextRunForSchedule(type, value);
  if (type === 'once' && new Date(nextRun).getTime() <= now) {
    throw new Error('一次性任务的执行时间已过，请先修改为未来时间后再启用。');
  }
  return nextRun;
}

function safeComputeNextRun(
  task: ScheduledTask,
  manualRun?: boolean,
): string | null {
  if (manualRun) {
    if (
      task.schedule_type === 'once' &&
      task.next_run &&
      new Date(task.next_run).getTime() <= Date.now()
    ) {
      return null;
    }
    return task.next_run ?? null;
  }
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
 * Persist a finished task run. The single rule for every run path (normal,
 * error early-exit, manual, script, group-mode): a RECURRING task that can't
 * compute a next run is PAUSED, never silently 'completed'. updateTaskAfterRun
 * flips status to 'completed' when nextRun is null — correct for once-tasks, but
 * for a recurring task (corrupted schedule_value, transient cron parse failure)
 * it permanently disables it. Pausing records this run's last_run/last_result
 * and lets PATCH /api/tasks/:id recompute next_run on resume. Routing ALL finalize
 * sites through here keeps error/manual/script/group paths from re-introducing
 * the silent-disable this batch set out to remove.
 */
function finalizeRecurringRun(
  task: ScheduledTask,
  nextRun: string | null,
  resultSummary: string,
  preserveDefinitionCursor = false,
): void {
  // V2 advances the definition cursor when it materializes an occurrence.
  // Letting the legacy executor advance again would skip or resurrect runs.
  if (preserveDefinitionCursor || activeDurableTaskIds.has(task.id)) return;
  if (nextRun === null && task.schedule_type !== 'once') {
    logger.error(
      {
        taskId: task.id,
        scheduleType: task.schedule_type,
        scheduleValue: task.schedule_value,
      },
      'Recurring task has null next_run; pausing instead of completing (fix schedule to resume)',
    );
    pauseTaskAfterRun(task.id, resultSummary);
  } else {
    updateTaskAfterRun(task.id, nextRun, resultSummary);
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

const SCHEDULER_RUNNER_ID = `${process.pid}:${randomUUID()}`;
const MIN_INTERVAL_MS = 60 * 1000;

function getTaskLeaseMs(): number {
  const settings = getSystemSettings();
  return (
    Math.max(settings.containerTimeout, settings.idleTimeout) +
    SCHEDULER_POLL_INTERVAL
  );
}

function claimScheduledRun(taskId: string, label: string): boolean {
  const claimed = claimTaskForRun(
    taskId,
    SCHEDULER_RUNNER_ID,
    getTaskLeaseMs(),
  );
  if (!claimed) {
    logger.info(
      { taskId, runnerId: SCHEDULER_RUNNER_ID },
      `Skipping ${label}: another scheduler runner already claimed it`,
    );
  }
  return claimed;
}

async function runTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): Promise<void> {
  if (
    !options?.manualRun &&
    !options?.durableRun &&
    !isTaskStillActive(staleTask.id, 'task')
  )
    return;

  // Refresh task from DB to avoid stale closure data
  const task = getTaskById(staleTask.id);
  if (!task) return;
  if (
    !options?.manualRun &&
    !options?.durableRun &&
    !claimScheduledRun(task.id, 'task')
  )
    return;

  runningTaskIds.add(task.id);
  // 顶层兜底 finally：runningTaskIds.add 之后到 inner runTask 真正进入 try
  // 之间还有 logTaskRunStart / ensureTaskWorkspace / mkdirSync / getUserById /
  // checkBilling / writeTasksSnapshot 等多次 DB/FS 调用，任意一处抛错都会
  // 让 task.id 永久挂在 runningTaskIds（scheduler 跳过该任务直到进程重启）。
  // 内层 try/finally 仍照常处理 next_run / 计费等逻辑；这层只兜底删 set。
  try {
    await runTaskInner(task, deps, options);
  } finally {
    cleanupIsolatedTaskRun(task, deps, options);
    runningTaskIds.delete(task.id);
  }
}

export function enqueueIsolatedScheduledTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): boolean {
  if (isTaskReserved(task.id)) return false;

  const prepared = prepareIsolatedTaskRun(task, deps);
  if (!prepared) return false;

  pendingScheduledTaskIds.add(task.id);
  const releaseReservation = () => {
    pendingScheduledTaskIds.delete(task.id);
  };

  try {
    const accepted = deps.queue.enqueueTask(
      prepared.queueJid,
      task.id,
      async () => {
        try {
          await runTask(task, deps, prepared.options);
        } finally {
          releaseReservation();
        }
      },
      { onDropped: releaseReservation },
    );
    if (accepted === false) {
      releaseReservation();
      return false;
    }
    return true;
  } catch (err) {
    releaseReservation();
    throw err;
  }
}

async function runTaskInner(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  options?: RunTaskOptions,
): Promise<void> {
  const startTime = Date.now();
  const preserveDefinitionCursor = !!options?.durableRun;
  const runLogId = logTaskRunStart(task.id);

  // Agent tasks run in the source workspace directory, but use a task-scoped
  // virtual chat/session so scheduled automation does not pollute the main chat.
  const workspace = resolveTaskRunWorkspace(task, deps, options);
  const workspaceGroup = workspace?.group;

  if (!workspace || !workspaceGroup) {
    logger.error(
      {
        taskId: task.id,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
      },
      'Workspace group not found for scheduled task',
    );
    safeUpdateTaskRunLog(task.id, runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Workspace group not found: ${task.chat_jid}`,
    });
    try {
      const nextRun = safeComputeNextRun(task, options?.manualRun);
      finalizeRecurringRun(
        task,
        nextRun,
        `Error: Workspace group not found: ${task.chat_jid}`,
        preserveDefinitionCursor,
      );
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskAfterRun failed in early-exit',
      );
    } finally {
      runningTaskIds.delete(task.id);
    }
    return;
  }

  const effectiveJid = options?.taskRunId
    ? `${workspace.jid}#task:${options.taskRunId}`
    : workspace.jid;
  const taskOwnerId = task.created_by || workspaceGroup.created_by || null;
  // The task's creator (taskOwnerId) can legitimately differ from the
  // workspace's actual owner for admin-initiated cross-group tasks
  // (hasCrossGroupAccess in mcp-tools.ts lets an admin home target another
  // user's workspace via target_group_jid). Every check that decides what
  // privileges/mounts/gates apply to the *execution context* must be scoped
  // to the workspace being executed in, not to whoever scheduled the task —
  // otherwise an admin-created task targeting a member's workspace would
  // inherit admin privileges (isAdminHome mount, owner-active bypass,
  // billing bypass) inside that member's own container. taskOwnerId is kept
  // only for display/audit attribution (who scheduled this run).
  const workspaceOwnerId = workspaceGroup.created_by || null;

  const groupDir = path.join(GROUPS_DIR, workspace.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: workspace.folder },
    'Running scheduled task',
  );

  // Owner gate before running task: a disabled/deleted owner's scheduled
  // tasks must stop firing (billing only checks balance, not status, and is
  // skipped for admins — so it can't cover this). See `src/owner-gate.ts`.
  if (workspaceOwnerId) {
    const ownerGate = checkOwnerActive(getUserById(workspaceOwnerId));
    if (!ownerGate.allowed) {
      logger.info(
        {
          taskId: task.id,
          userId: workspaceOwnerId,
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
        finalizeRecurringRun(
          task,
          nextRun,
          'Error: 账户已禁用',
          preserveDefinitionCursor,
        );
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'updateTaskAfterRun failed in owner-gate',
        );
      } finally {
        runningTaskIds.delete(task.id);
      }
      return;
    }
  }

  // Billing quota check before running task. Gated on the workspace's real
  // owner so an admin-created cross-group task still charges/limits the
  // member workspace it actually runs in and consumes resources for.
  if (isBillingEnabled() && workspaceOwnerId) {
    const owner = getUserById(workspaceOwnerId);
    if (owner && owner.role !== 'admin') {
      const accessResult = checkBillingAccessFresh(
        workspaceOwnerId,
        owner.role,
      );
      if (!accessResult.allowed) {
        const reason = accessResult.reason || '当前账户不可用';
        logger.info(
          {
            taskId: task.id,
            userId: workspaceOwnerId,
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
          finalizeRecurringRun(
            task,
            nextRun,
            `Error: 计费限制: ${reason}`,
            preserveDefinitionCursor,
          );
        } catch (err) {
          logger.error(
            { taskId: task.id, err },
            'updateTaskAfterRun failed in billing-gate',
          );
        } finally {
          runningTaskIds.delete(task.id);
        }
        return;
      }
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isHome = !!workspaceGroup.is_home;
  const workspaceOwner = workspaceOwnerId
    ? getUserById(workspaceOwnerId)
    : null;
  const isAdminHome = isHome && workspaceOwner?.role === 'admin';
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

  // Store task prompt as a user message in workspace chat so it's visible in
  // conversation. Sender attribution/audit must use the task's actual
  // creator (taskOwnerId), NOT workspaceOwner — otherwise an admin-created
  // cross-group task would be misattributed in the chat history and audit
  // trail as if the target workspace's own member had typed the prompt
  // themselves.
  if (deps.storePromptMessage) {
    const taskCreator = taskOwnerId ? getUserById(taskOwnerId) : null;
    const senderName =
      taskCreator?.display_name || taskCreator?.username || '定时任务';
    deps.storePromptMessage(
      effectiveJid,
      taskCreator?.id || 'system',
      senderName,
      task.prompt,
      task.id,
    );
  }

  let result: string | null = null;
  let error: string | null = null;
  let scheduledInputCompleted = false;
  // Track the time of last meaningful output from the agent.
  // duration_ms should measure actual work time, not include idle wait.
  let lastOutputTime = startTime;
  let runLogFinalized = false;
  let durableWorkspaceIntentStored = false;
  let preparedDurableWorkspaceCommit: (() => boolean) | null = null;

  const commitDurableWorkspaceIntent = (): boolean => {
    if (durableWorkspaceIntentStored) return true;
    if (
      !deps.storeResultAndNotify ||
      !options?.durableRun ||
      !options.taskRunId ||
      effectiveJid === workspace.jid
    ) {
      return false;
    }
    if (!preparedDurableWorkspaceCommit) {
      const durableRun = options.durableRun;
      const runId = durableRun.id;
      const cleanedResult = result ? stripAgentInternalTags(result) : null;
      const durableOutcomeError =
        error ||
        (cleanedResult?.trim()
          ? null
          : '定时任务已结束，但 Agent 没有返回可展示的完整业务结果。');
      const workspaceResult = formatScheduledTaskWorkspaceResult({
        task,
        runId,
        result: cleanedResult,
        error: durableOutcomeError,
      });
      preparedDurableWorkspaceCommit = () =>
        completeIsolatedTaskRunWithWorkspaceResultIntent({
          runId,
          taskId: task.id,
          leaseOwner: durableRun.lease_owner,
          leaseToken: durableRun.lease_token,
          status: durableOutcomeError ? 'failed' : 'success',
          result: cleanedResult,
          error: durableOutcomeError,
          payload: {
            kind: 'workspace_result',
            chatJid: workspace.jid,
            text: workspaceResult,
            options: {
              sourceKind: 'scheduled_task_result',
              messageId: `scheduled-task-result:${runId}`,
              skipStore: false,
              workspaceFolder: workspace.folder || undefined,
            },
          },
        });
      options.onDurableTerminalHandoffPrepared?.(
        preparedDurableWorkspaceCommit,
      );
    }
    try {
      durableWorkspaceIntentStored = preparedDurableWorkspaceCommit();
    } catch (err) {
      logger.error(
        { taskId: task.id, runId: options.durableRun.id, err },
        'Isolated task workspace-result hand-off transaction failed',
      );
    }
    if (!durableWorkspaceIntentStored) {
      logger.error(
        { taskId: task.id, runId: options.durableRun.id },
        'Failed to atomically terminalize isolated task with its workspace result intent',
      );
    }
    return durableWorkspaceIntentStored;
  };

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

  // Use a run-scoped Claude session in the same workspace folder. Reusing
  // `task:${task.id}` would let isolated scheduled tasks accumulate context
  // across runs, which contradicts the default isolated semantics.
  const taskSessionAgentId = options?.taskRunId
    ? createTaskSessionAgentId(options.taskRunId)
    : `task-${task.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
  const agentProfile = resolveEffectiveAgentProfile(
    getAgentProfileForWorkspace(workspace.folder, workspaceOwnerId),
  );
  if (
    taskSessionNeedsAgentProfileReset(
      workspace.folder,
      agentProfile,
      taskSessionAgentId,
    )
  ) {
    deleteSession(workspace.folder, taskSessionAgentId);
    logger.info(
      {
        taskId: task.id,
        groupFolder: workspace.folder,
        sessionAgentId: taskSessionAgentId,
        agentProfileId: agentProfile?.id,
      },
      'Cleared scheduled task Claude session after AgentProfile identity changed',
    );
  }
  const sessionId = getSession(workspace.folder, taskSessionAgentId);

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
    if (
      executionMode === 'host' &&
      !canExecuteOnHost(
        workspaceOwnerId ? getUserById(workspaceOwnerId) : undefined,
      )
    ) {
      throw new Error(HOST_EXECUTION_FORBIDDEN_ERROR);
    }
    const runAgent =
      executionMode === 'host' ? runHostAgent : runContainerAgent;

    // Resolve the workspace owner's home folder for correct volume mounts
    // (skills, memory, CLAUDE.md). Must be the workspace's real owner, not
    // the task creator — otherwise an admin-created cross-group task would
    // mount the admin's own global skills/memory into a member's container.
    const ownerHomeFolder = workspaceOwnerId
      ? getUserHomeGroup(workspaceOwnerId)?.folder || workspace.folder
      : workspace.folder;

    const output = await runAgentWithModelFallback(
      runAgent,
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
        // The run ID is only an IPC/session namespace.  Routing must use the
        // stable scheduled-task ID so notify_channels and chat_jid resolve.
        messageTaskId: task.id,
        sessionAgentId: taskSessionAgentId,
        agentProfile: toRunnerAgentProfile(agentProfile),
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
          deps.broadcastStreamEvent?.(effectiveJid, streamedOutput.streamEvent);
        }
        if (streamedOutput.providerFailure) {
          if (streamedOutput.providerFailureTerminal === true) {
            error = PROVIDER_FAILURE_USER_NOTICE;
            lastOutputTime = Date.now();
          }
        } else if (streamedOutput.result) {
          result = streamedOutput.result;
          lastOutputTime = Date.now();
          resetIdleTimer();
        }
        if (
          !streamedOutput.providerFailure &&
          streamedOutput.inputTurnCompleted === true
        ) {
          scheduledInputCompleted = true;
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
          lastOutputTime = Date.now();
        }
        if (
          streamedOutput.newSessionId &&
          streamedOutput.status !== 'error' &&
          !streamedOutput.providerFailure
        ) {
          setSession(
            workspace.folder,
            streamedOutput.newSessionId,
            taskSessionAgentId,
            {
              agentProfileId: agentProfile?.id,
              agentProfileVersion: agentProfile?.version,
              identityHash: agentProfile?.identity_hash,
            },
          );
        }
        const closedBeforeCompletion =
          streamedOutput.status === 'closed' && !scheduledInputCompleted;
        if (closedBeforeCompletion) {
          error = 'Agent closed before completing the scheduled task input';
          lastOutputTime = Date.now();
        }
        // A non-stream frame can still be an incomplete partial (context
        // compaction/truncation). Only finalize after the durable scheduled
        // input reaches a real terminal boundary.
        if (
          closedBeforeCompletion ||
          shouldFinalizeScheduledRunOutput(
            streamedOutput,
            scheduledInputCompleted,
          )
        ) {
          // Cross the durable business/workspace boundary as soon as the SDK
          // emits the genuine terminal frame. Waiting for the runner promise,
          // recurrence bookkeeping, or session cleanup would reopen a window
          // where a host crash replays already-completed Agent/tool work.
          commitDurableWorkspaceIntent();
          finalizeRunLog();
        }
      },
      ownerHomeFolder,
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (!output.providerFailure && output.inputTurnCompleted === true) {
      scheduledInputCompleted = true;
    }
    if (output.providerFailure) {
      error = PROVIDER_FAILURE_USER_NOTICE;
      lastOutputTime = Date.now();
    } else if (output.status === 'closed' && !scheduledInputCompleted) {
      error = 'Agent closed before completing the scheduled task input';
      lastOutputTime = Date.now();
    } else if (output.status === 'error') {
      error = output.error || 'Unknown error';
      lastOutputTime = Date.now();
    } else if (
      output.status === 'success' &&
      !scheduledInputCompleted &&
      output.inputTurnCompleted !== true
    ) {
      error = 'Agent exited before completing the scheduled task input';
      lastOutputTime = Date.now();
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
      lastOutputTime = Date.now();
    }
    if (
      output.newSessionId &&
      output.status !== 'error' &&
      !output.providerFailure
    ) {
      setSession(workspace.folder, output.newSessionId, taskSessionAgentId, {
        agentProfileId: agentProfile?.id,
        agentProfileVersion: agentProfile?.version,
        identityHash: agentProfile?.identity_hash,
      });
    }

    // Finalize if not already done by onOutput callback
    commitDurableWorkspaceIntent();
    finalizeRunLog();

    logger.info(
      { taskId: task.id, durationMs: lastOutputTime - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    lastOutputTime = Date.now();
    commitDurableWorkspaceIntent();
    logger.error({ taskId: task.id, error }, 'Task failed');
  } finally {
    // Safety net: finalize run log if not already done by onOutput callback
    if (runLogFinalized || error || scheduledInputCompleted) {
      commitDurableWorkspaceIntent();
    }
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
    try {
      // Routes through finalizeRecurringRun so an error/manual run that yields a
      // null next_run for a recurring task is paused, not silently completed.
      finalizeRecurringRun(
        task,
        nextRun,
        resultSummary,
        preserveDefinitionCursor,
      );
    } catch (err) {
      logger.error({ taskId: task.id, err }, 'Failed to finalize task run');
    }
  } finally {
    runningTaskIds.delete(task.id);
  }

  const cleanedResult = result ? stripAgentInternalTags(result) : null;
  if (deps.storeResultAndNotify) {
    const taskSessionText = error
      ? `执行出错: ${error}`
      : cleanedResult?.trim() || null;

    if (taskSessionText) {
      try {
        await deps.storeResultAndNotify(effectiveJid, taskSessionText, {
          // Successful scheduled Agent runs deliver user-visible output via
          // send_message/send_image.  Their IPC payload carries task.id and is
          // routed to chat_jid/notify_channels by the host watcher.  Keep the
          // SDK final in the web task session for audit, but do not broadcast
          // it a second time.  Failures still need the scheduler fallback.
          ownerId: error ? taskOwnerId || undefined : undefined,
          notifyChannels: task.notify_channels,
          deliveryRouteJid: task.delivery_route_jid ?? task.chat_jid,
          sourceKind: 'sdk_final',
          // Use source workspace folder for IM routing; task sessions are virtual
          // chats under that workspace and should inherit its channel bindings.
          workspaceFolder: workspace.folder || undefined,
        });
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'Failed to store/notify task result',
        );
      }
    }

    // Isolated runs execute in a short-lived #task session. Preserve their
    // complete SDK final (or terminal error) in the canonical Web workspace as
    // a durable, user-visible result. External delivery remains owned by the
    // Agent's chosen tool (send_message, feishu-cli, etc.); this projection is
    // Web-only and therefore never duplicates an IM mutation.
    if (
      options?.taskRunId &&
      effectiveJid !== workspace.jid &&
      !options.durableRun
    ) {
      const runId = String(runLogId);
      const workspaceResult = formatScheduledTaskWorkspaceResult({
        task,
        runId,
        result: cleanedResult,
        error,
      });
      try {
        await deps.storeResultAndNotify(workspace.jid, workspaceResult, {
          sourceKind: 'scheduled_task_result',
          messageId: `scheduled-task-result:${runId}`,
          workspaceFolder: workspace.folder || undefined,
        });
      } catch (err) {
        logger.error(
          { taskId: task.id, runId, err },
          'Failed to project scheduled task result to source workspace',
        );
      }
    }
  }

  // Legacy cleanup: old isolated tasks may still point at task-* workspaces.
  // New tasks run inside the source workspace, which must never be deleted here.
  if (
    task.schedule_type === 'once' &&
    !options?.manualRun &&
    task.workspace_jid &&
    task.workspace_folder &&
    task.workspace_folder.startsWith('task-')
  ) {
    setTimeout(() => {
      try {
        const groups = deps.registeredGroups();
        if (groups[task.workspace_jid!]) {
          deleteGroupData(task.workspace_jid!, task.workspace_folder!);
          delete groups[task.workspace_jid!];
          removeFlowArtifacts(task.workspace_folder!);
          logger.info(
            { taskId: task.id, folder: task.workspace_folder },
            'Cleaned up once-task workspace',
          );
        }
      } catch (err) {
        logger.error(
          { taskId: task.id, err },
          'Failed to cleanup once-task workspace',
        );
      }
    }, 60_000);
  }
}

async function runScriptTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
  manualRun = false,
  durableRun?: ClaimedTaskRun,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (
    !manualRun &&
    !durableRun &&
    !isTaskStillActive(staleTask.id, 'script task')
  )
    return;

  // Refresh task from DB to avoid stale closure data
  const task = getTaskById(staleTask.id);
  if (!task) return;
  if (!manualRun && !durableRun && !claimScheduledRun(task.id, 'script task'))
    return;

  runningTaskIds.add(task.id);
  // 顶层兜底 finally（同 runTask）。
  try {
    await runScriptTaskInner(
      task,
      deps,
      groupJid,
      manualRun,
      !!durableRun,
      abortSignal,
    );
  } finally {
    runningTaskIds.delete(task.id);
  }
}

async function runScriptTaskInner(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
  manualRun = false,
  preserveDefinitionCursor = false,
  abortSignal?: AbortSignal,
): Promise<void> {
  const startTime = Date.now();
  const runLogId = logTaskRunStart(task.id);

  logger.info(
    { taskId: task.id, group: task.group_folder, executionType: 'script' },
    'Running script task',
  );

  const runtimePolicyError = scriptTaskRuntimePolicyError(task, deps);
  if (runtimePolicyError) {
    safeUpdateTaskRunLog(task.id, runLogId, {
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: runtimePolicyError,
    });
    pauseUnsafeScriptTask(task.id, deps);
    logger.error(
      { taskId: task.id, error: runtimePolicyError },
      'Blocked unsafe script task before host execution',
    );
    return;
  }

  // Owner gate before running script task: same as the Agent-task path, a
  // disabled/deleted owner's scheduled scripts must stop firing regardless of
  // billing toggle or role. See `src/owner-gate.ts`. Must key off the
  // group's actual owner, not the task's creator — a cross-group script
  // task created by an admin must still stop when the target group's real
  // owner is disabled, not when the admin is.
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
          finalizeRecurringRun(
            task,
            nextRun,
            'Error: 账户已禁用',
            preserveDefinitionCursor,
          );
        } catch (err) {
          logger.error(
            { taskId: task.id, err },
            'updateTaskAfterRun failed in script owner-gate',
          );
        }
        return;
      }
    }
  }

  // Billing quota check before running script task. Gated on the group's
  // real owner so a cross-group admin-created script task still charges
  // the target group's own quota rather than silently skipping because the
  // task's creator happens to be an admin.
  if (isBillingEnabled() && task.group_folder) {
    const groups = deps.registeredGroups();
    const group = groups[groupJid];
    const ownerId = group?.created_by;
    if (ownerId) {
      const owner = getUserById(ownerId);
      if (owner && owner.role !== 'admin') {
        const accessResult = checkBillingAccessFresh(ownerId, owner.role);
        if (!accessResult.allowed) {
          const reason = accessResult.reason || '当前账户不可用';
          logger.info(
            {
              taskId: task.id,
              userId: ownerId,
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
            finalizeRecurringRun(
              task,
              nextRun,
              `Error: 计费限制: ${reason}`,
              preserveDefinitionCursor,
            );
          } catch (err) {
            logger.error(
              { taskId: task.id, err },
              'updateTaskAfterRun failed in script billing-gate',
            );
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
      finalizeRecurringRun(
        task,
        nextRun,
        'Error: script_command is empty',
        preserveDefinitionCursor,
      );
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskAfterRun failed in script no-command',
      );
    } finally {
      runningTaskIds.delete(task.id);
    }
    return;
  }

  let result: string | null = null;
  let error: string | null = null;

  try {
    // Script tasks execute directly on the host even when their source
    // workspace is container-backed. Re-authorize against the current DB role
    // immediately before spawning the process.
    const currentOwnerId = deps.registeredGroups()[groupJid]?.created_by;
    if (
      !canExecuteOnHost(
        currentOwnerId ? getUserById(currentOwnerId) : undefined,
      )
    ) {
      throw new Error(HOST_EXECUTION_FORBIDDEN_ERROR);
    }
    const scriptResult = await runScript(
      task.script_command,
      task.group_folder,
      { ownerId: currentOwnerId, signal: abortSignal },
    );

    if (scriptResult.aborted) {
      error = '脚本执行已取消';
    } else if (scriptResult.timedOut) {
      error = `脚本执行超时 (${Math.round(scriptResult.durationMs / 1000)}s)`;
    } else if (scriptResult.exitCode !== 0) {
      error = scriptResult.stderr.trim() || `退出码: ${scriptResult.exitCode}`;
      result = scriptResult.stdout.trim() || null;
    } else {
      result = scriptResult.stdout.trim() || null;
    }

    // Send result to user (skip if no output and no error)
    if (!scriptResult.aborted && (error || result)) {
      const text = error
        ? `[脚本] 执行失败: ${error}${result ? `\n输出:\n${result.slice(0, 500)}` : ''}`
        : `[脚本] ${result!.slice(0, 1000)}`;
      const fullText = `${deps.assistantName}: ${text}`;

      await deps.sendMessage(groupJid, fullText, { source: 'scheduled_task' });

      if (deps.storeResultAndNotify) {
        const groups = deps.registeredGroups();
        const group = groups[groupJid];
        const ownerId = task.created_by || group?.created_by;
        if (ownerId) {
          try {
            await deps.storeResultAndNotify(groupJid, fullText, {
              ownerId,
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
      finalizeRecurringRun(
        task,
        nextRun,
        resultSummary,
        preserveDefinitionCursor,
      );
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
 * group 模式定时任务触发时，task.prompt 会作为一条普通用户消息回放进工作区。给它前置
 * 这段框定，明确「这是已有定时任务到点自动执行、不是用户新指令，不要再 schedule_task」，
 * 否则当 prompt 含「每隔/每天/提醒」等措辞时，agent 会按 CLAUDE.md 的定时任务规则再建一个
 * 任务而递归增殖（#564）。标记串 [定时任务自动触发] 与 global CLAUDE.md 的兜底 guard 一致。
 */
const SCHEDULED_GROUP_TRIGGER_FRAMING = [
  '[定时任务自动触发] 以下内容是你此前创建的定时任务到点自动执行的触发，不是用户新发来的指令。',
  '请直接执行该任务对应的动作。',
  '你的最终 SDK Assistant 文本会作为正式任务结果归档到所属 Web 工作区，因此必须包含一份完整、可独立阅读的业务结果；所有结论、报告和数据都要写在最终文本中，不得只回复“已完成”“已发送”、消息 ID、文件路径或简短摘要。',
  '如果任务要求调用 feishu-cli 或其他外部发送工具，请照常调用；但工具投递不能替代上述完整最终文本，工具报错时也不要声称发送成功。',
  '重要：这条只是触发信号，对应的定时任务已在调度中。即使下面内容里出现「每隔/每天/定期/提醒我」等字样，也不要再调用 schedule_task 创建或重复该定时任务（除非内容明确要求你另外新建一个不同的任务）。',
].join('\n');

const SCHEDULED_GROUP_PROMPT_ID_PREFIX = 'scheduled-task-prompt:';

/** Stable prompt identity used to correlate a group turn with one durable run. */
export function scheduledGroupPromptMessageId(runId: string): string {
  return `${SCHEDULED_GROUP_PROMPT_ID_PREFIX}${runId}`;
}

/** Return a durable run id only for scheduler-owned prompt identities. */
export function scheduledGroupRunIdFromPromptMessageId(
  messageId: string,
): string | null {
  if (!messageId.startsWith(SCHEDULED_GROUP_PROMPT_ID_PREFIX)) return null;
  const runId = messageId.slice(SCHEDULED_GROUP_PROMPT_ID_PREFIX.length);
  return runId && /^[a-zA-Z0-9-]+$/.test(runId) ? runId : null;
}

interface ScheduledGroupPromptMessage {
  id: string;
  chat_jid: string;
  timestamp?: string;
  source_kind?: string | null;
  task_id?: string | null;
}

/**
 * Return the exact terminal run owned by a scheduler prompt, if any.
 *
 * A prompt can remain behind the committed cursor after bounded retry
 * exhaustion. Treating it as ordinary input on the next incoming message
 * would execute the same occurrence twice. Stable prompt identity and task
 * ownership make the skip safe without suppressing unrelated/new prompts.
 */
export function resolveTerminalScheduledGroupPromptRun(
  message: ScheduledGroupPromptMessage,
  getRun: (runId: string) => TaskRun | undefined,
): TaskRun | null {
  if (message.source_kind !== 'scheduled_task_prompt' || !message.task_id) {
    return null;
  }
  const runId = scheduledGroupRunIdFromPromptMessageId(message.id);
  if (!runId) return null;
  const run = getRun(runId);
  if (
    !run ||
    run.task_id !== message.task_id ||
    run.definition_snapshot.context_mode !== 'group' ||
    !['success', 'failed', 'cancelled', 'missed'].includes(run.status)
  ) {
    return null;
  }
  return run;
}

/**
 * Resolve every durable group run covered by one genuine Assistant output.
 *
 * Cold starts correlate through the stable prompt id(s) in the initial batch;
 * warm-runner turns correlate through IPC covered cursors. No lookup by
 * definition task id or "latest run" is allowed, so ordinary conversation
 * outputs and a later occurrence cannot be attached to the wrong run.
 */
export function resolveScheduledGroupRunsForOutput(input: {
  chatJid: string;
  fallbackInputTurnId: string;
  coldMessages: ReadonlyArray<ScheduledGroupPromptMessage>;
  output: Pick<ContainerOutput, 'inputTurnId' | 'ipcReceipts'>;
  getMessage: (
    chatJid: string,
    messageId: string,
  ) => ScheduledGroupPromptMessage | null;
  getRun: (runId: string) => TaskRun | undefined;
}): TaskRun[] {
  const refs: Array<{ chatJid: string; messageId: string }> = [];
  if (input.output.ipcReceipts?.length) {
    for (const receipt of input.output.ipcReceipts) {
      for (const cursor of receipt.coveredCursors ?? [receipt.cursor]) {
        refs.push({ chatJid: receipt.chatJid, messageId: cursor.id });
      }
    }
  } else if (
    (input.output.inputTurnId ?? input.fallbackInputTurnId) ===
    input.fallbackInputTurnId
  ) {
    for (const message of input.coldMessages) {
      refs.push({ chatJid: message.chat_jid, messageId: message.id });
    }
  } else if (input.output.inputTurnId) {
    refs.push({
      chatJid: input.chatJid,
      messageId: input.output.inputTurnId,
    });
  }

  const runIds = new Set<string>();
  const runs: TaskRun[] = [];
  for (const ref of refs) {
    if (ref.chatJid !== input.chatJid) continue;
    const message =
      input.coldMessages.find(
        (candidate) =>
          candidate.chat_jid === ref.chatJid && candidate.id === ref.messageId,
      ) ?? input.getMessage(ref.chatJid, ref.messageId);
    if (
      !message ||
      message.source_kind !== 'scheduled_task_prompt' ||
      !message.task_id
    ) {
      continue;
    }
    const runId = scheduledGroupRunIdFromPromptMessageId(message.id);
    if (!runId || runIds.has(runId)) continue;
    const run = input.getRun(runId);
    if (
      !run ||
      run.task_id !== message.task_id ||
      run.definition_snapshot.context_mode !== 'group' ||
      !['delivered', 'success', 'failed'].includes(run.status)
    ) {
      continue;
    }
    runIds.add(runId);
    runs.push(run);
  }
  return runs;
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
  durableRun?: ClaimedTaskRun,
): Promise<void> {
  const startTime = Date.now();
  if (
    !manualRun &&
    !durableRun &&
    !claimScheduledRun(task.id, 'group-mode task')
  )
    return;
  runningTaskIds.add(task.id);
  let resultSummary = '已排队到源工作区，等待智能体执行';

  try {
    // Resolve task owner for sender attribution
    const owner = task.created_by ? getUserById(task.created_by) : null;
    const senderName = owner?.display_name || owner?.username || '定时任务';

    const promptText = `${SCHEDULED_GROUP_TRIGGER_FRAMING}\n\n${task.prompt}`;
    if (durableRun) {
      if (!deps.storeGroupPromptAndDeliverRun) {
        throw new Error(
          'storeGroupPromptAndDeliverRun dependency not available',
        );
      }
      deps.storeGroupPromptAndDeliverRun({
        run: durableRun,
        messageId: scheduledGroupPromptMessageId(durableRun.id),
        chatJid: targetGroupJid,
        senderId: owner?.id || 'system',
        senderName,
        text: promptText,
        taskId: task.id,
        queuedResult: resultSummary,
      });
    } else {
      if (!deps.storePromptMessage) {
        throw new Error('storePromptMessage dependency not available');
      }
      // Legacy, non-durable callers retain the ordinary prompt write.
      deps.storePromptMessage(
        targetGroupJid,
        owner?.id || 'system',
        senderName,
        promptText,
        task.id,
      );
    }

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
      status: 'queued',
      result: resultSummary,
      error: null,
    });
  } catch (err) {
    resultSummary = `Error: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(
      { taskId: task.id, error: resultSummary },
      'Group-mode task injection failed',
    );

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
      finalizeRecurringRun(task, nextRun, resultSummary, !!durableRun);
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'updateTaskAfterRun failed in group-mode',
      );
    } finally {
      runningTaskIds.delete(task.id);
    }
  }
}

let schedulerRunning = false;
let schedulerStartedAtMs = 0;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let lastCleanupTime = 0;
const TASK_RUN_LEASE_MS = 60_000;
const SCHEDULER_RECONCILE_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_CLAIMS_PER_PUMP = 32;
const MAX_SAFE_PRESTART_ATTEMPTS = 5;
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerPumping = false;
let schedulerDepsRef: SchedulerDependencies | null = null;

interface ActiveDurableExecution {
  taskId: string;
  kind: 'isolated' | 'group' | 'script';
  /** Claim generation that registered this entry; see clearActiveDurableExecution. */
  attempt: number;
  stop?: () => void | Promise<void>;
}

const activeDurableExecutions = new Map<string, ActiveDurableExecution>();

/**
 * Compare-and-delete keyed on the claim generation.
 *
 * The map is keyed by run id so `cancelTaskRunNow` can find a stopper without
 * knowing the attempt. If a lapsed lease lets the same run be claimed a second
 * time, the losing attempt's cleanup must not evict the winning attempt's
 * stopper — that produced an execution nothing could cancel, with the DB marked
 * cancelled while the process kept running.
 */
function clearActiveDurableExecution(runId: string, attempt: number): void {
  const current = activeDurableExecutions.get(runId);
  if (current && current.attempt === attempt) {
    activeDurableExecutions.delete(runId);
  }
}

/**
 * Scheduler work the group queue cannot see: script runs and notification
 * retries are started detached, so `queue.shutdown()` neither waits for nor
 * cancels them. Tracking them here lets `stopSchedulerLoop` drain them.
 */
const detachedSchedulerWork = new Set<Promise<unknown>>();

function trackDetachedSchedulerWork(work: Promise<unknown>): void {
  detachedSchedulerWork.add(work);
  void work.finally(() => detachedSchedulerWork.delete(work));
}

function taskFromRunSnapshot(
  current: ScheduledTask,
  run: ClaimedTaskRun,
): ScheduledTask {
  return {
    ...current,
    ...run.definition_snapshot,
    revision: run.definition_revision,
  };
}

function clearSchedulerTimer(): void {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
}

function armScheduler(delayMs: number): void {
  if (!schedulerRunning || !schedulerDepsRef) return;
  if (schedulerDepsRef.queue.isShuttingDown?.()) {
    clearSchedulerTimer();
    return;
  }
  clearSchedulerTimer();
  schedulerTimer = setTimeout(
    () => {
      schedulerTimer = null;
      pumpTaskScheduler(schedulerDepsRef!);
    },
    Math.max(0, Math.min(MAX_TIMER_DELAY_MS, delayMs)),
  );
  schedulerTimer.unref?.();
}

function armSchedulerFromStore(): void {
  if (!schedulerRunning || !schedulerDepsRef) return;
  const now = Date.now();
  const wakeCandidates = [getNextScheduledTaskWakeAt(), getNextTaskRunWakeAt()]
    .filter((value): value is string => !!value)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  const exactDelay =
    wakeCandidates.length > 0
      ? Math.max(0, Math.min(...wakeCandidates) - now)
      : Infinity;
  // Reconcile remains a safety net for mutations from not-yet-migrated callers,
  // clock jumps and a lost in-process wake notification.
  armScheduler(Math.min(exactDelay, SCHEDULER_RECONCILE_MS));
}

/** Call after task definition mutations so newly-earlier schedules wake now. */
export function notifyTaskSchedulerChanged(): void {
  if (schedulerRunning) armScheduler(0);
}

/**
 * Release a run that never crossed the execution boundary.
 *
 * `countsAsAttempt: false` is for releases caused by us rather than by the run
 * — currently process shutdown. Those return the claim's budget so a rolling
 * restart cannot exhaust `MAX_SAFE_PRESTART_ATTEMPTS` on an occurrence that has
 * not executed even once, and they skip the terminal-failure branch entirely.
 */
function scheduleSafePrestartRetry(
  claim: ClaimedTaskRun,
  reason: string,
  options: { countsAsAttempt?: boolean; retryDelayMs?: number } = {},
): void {
  const countsAsAttempt = options.countsAsAttempt !== false;
  if (countsAsAttempt && claim.attempt >= MAX_SAFE_PRESTART_ATTEMPTS) {
    completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
      status: 'failed',
      error: `${reason}; safe pre-execution retry limit reached`,
      notificationStatus: 'skipped',
    });
    return;
  }
  const exponent = Math.max(0, claim.attempt - 1);
  const delayMs =
    options.retryDelayMs ??
    (countsAsAttempt ? Math.min(60_000, 1_000 * 2 ** exponent) : 0);
  releaseTaskRunForRetry(
    claim.id,
    claim.lease_owner,
    claim.lease_token,
    new Date(Date.now() + delayMs).toISOString(),
    reason,
    { countsAsAttempt },
  );
}

function startTaskRunHeartbeat(
  claim: ClaimedTaskRun,
  onLeaseLost: () => void,
): ReturnType<typeof setInterval> {
  const timer = setInterval(
    () => {
      try {
        if (
          renewTaskRunLease(
            claim.id,
            claim.lease_owner,
            claim.lease_token,
            TASK_RUN_LEASE_MS,
          )
        ) {
          return;
        }
        clearInterval(timer);
        onLeaseLost();
      } catch (err) {
        clearInterval(timer);
        logger.error(
          { runId: claim.id, taskId: claim.task_id, err },
          'Task-run lease renewal failed; stopping execution',
        );
        onLeaseLost();
      }
    },
    Math.max(1_000, Math.floor(TASK_RUN_LEASE_MS / 3)),
  );
  timer.unref?.();
  return timer;
}

function latestLegacyRunOutcome(
  taskId: string,
  notBeforeMs: number,
): TaskRunLog | undefined {
  return getTaskRunLogs(taskId, 10).find(
    (log) => new Date(log.run_at).getTime() >= notBeforeMs,
  );
}

function mergeNotificationReceipts(
  current: TaskRunNotificationReceipt | null,
  next: TaskRunNotificationReceipt,
): TaskRunNotificationReceipt {
  if (!current) return next;
  const failedChannels = [
    ...new Set([
      ...current.summary.failed_channels,
      ...next.summary.failed_channels,
    ]),
  ];
  const summary: TaskRunNotificationSummary = {
    attempted: current.summary.attempted + next.summary.attempted,
    succeeded: current.summary.succeeded + next.summary.succeeded,
    failed: current.summary.failed + next.summary.failed,
    failed_channels: failedChannels,
  };
  const status =
    summary.failed === 0
      ? summary.attempted === 0
        ? 'skipped'
        : 'success'
      : summary.succeeded > 0
        ? 'partial_failed'
        : 'failed';
  return {
    status,
    summary,
    error: [current.error, next.error].filter(Boolean).join('; ') || null,
  };
}

function failedNotificationReceipt(
  channel: string,
  error: unknown,
): TaskRunNotificationReceipt {
  return {
    status: 'failed',
    summary: {
      attempted: 1,
      succeeded: 0,
      failed: 1,
      failed_channels: [channel],
    },
    error: error instanceof Error ? error.message : String(error),
  };
}

function trackTaskRunNotifications(
  claim: ClaimedTaskRun,
  deps: SchedulerDependencies,
): {
  deps: SchedulerDependencies;
  receipt: () => TaskRunNotificationReceipt | null;
  deferredReceipt: () => TaskRunNotificationReceipt | null;
  hasUnconfirmedAttempt: () => boolean;
} {
  let aggregate: TaskRunNotificationReceipt | null = null;
  let deferred: TaskRunNotificationReceipt | null = null;
  let unconfirmed = false;
  const directlyDeliveredJids = new Set<string>();
  let pendingDirectFailure:
    | {
        jid: string;
        receipt: TaskRunNotificationReceipt;
        payload: TaskRunNotificationPayload;
      }
    | undefined;
  const record = (
    receipt: TaskRunNotificationReceipt,
    payload?: TaskRunNotificationPayload,
  ) => {
    aggregate = mergeNotificationReceipts(aggregate, receipt);
    if (receipt.status === 'failed' || receipt.status === 'partial_failed') {
      const retryPayload = payload
        ? payload.kind === 'batch'
          ? payload
          : retryPayloadForReceipt(payload, receipt)
        : undefined;
      // Failure recovery must survive a process crash before the execution
      // lease is finalized. Generation-aware completion will preserve this
      // payload and merge any later success receipt instead of overwriting it.
      recordTaskRunNotificationReceipt(claim.id, receipt, retryPayload);
    } else {
      deferred = mergeNotificationReceipts(deferred, receipt);
    }
  };
  const trackPersistedReceipt = (receipt: TaskRunNotificationReceipt) => {
    aggregate = mergeNotificationReceipts(aggregate, receipt);
  };

  const trackedDeps: SchedulerDependencies = {
    ...deps,
    sendMessage: async (jid, text, options) => {
      const payload: TaskRunNotificationPayload = {
        kind: 'send_message',
        chatJid: jid,
        text,
        sendOptions: options,
      };
      try {
        const result = await deps.sendMessage(jid, text, options);
        directlyDeliveredJids.add(jid);
        if (pendingDirectFailure?.jid === jid) pendingDirectFailure = undefined;
        record({
          status: 'success',
          summary: {
            attempted: 1,
            succeeded: 1,
            failed: 0,
            failed_channels: [],
          },
        });
        return result;
      } catch (err) {
        directlyDeliveredJids.delete(jid);
        const receipt = failedNotificationReceipt(jid, err);
        // Persist before returning to Agent/script work: the process may crash
        // or continue running for a long time before the owner fallback/finish.
        recordTaskRunNotificationReceipt(claim.id, receipt, payload);
        pendingDirectFailure = {
          jid,
          receipt,
          payload,
        };
        // Notification transport is independent of execution. The durable
        // retry payload above owns recovery; do not turn successful script or
        // Agent work into an execution failure.
        return undefined;
      }
    },
    storeResultAndNotify: deps.storeResultAndNotify
      ? async (chatJid, text, options) => {
          // ownerId is the signal that this call performs external task
          // notification. The scheduled_task_result call is the canonical Web
          // projection: it is still a durable side effect, but it must never
          // trigger or validate an Agent-owned external tool such as
          // feishu-cli. Other ownerless writes are ephemeral task-session
          // audit rows and are cleaned with that isolated session.
          if (
            !options.ownerId &&
            options.sourceKind === 'scheduled_task_result'
          ) {
            const payload: TaskRunNotificationPayload = {
              kind: 'workspace_result',
              chatJid,
              text,
              options: {
                ...options,
                sourceKind: options.sourceKind,
                // Unlike an IM-only retry, a workspace projection retry must
                // replay the idempotent DB/Web write.
                skipStore: false,
              },
            };
            try {
              await deps.storeResultAndNotify!(chatJid, text, options);
              // A normal Web projection is not an external notification, so
              // keep the notification ledger's usual `skipped` semantics.
              // Only failures enter the ledger because they carry durable
              // repair work that operators must be able to observe.
              return undefined;
            } catch (err) {
              const receipt = failedNotificationReceipt(
                `workspace:${chatJid}`,
                err,
              );
              record(receipt, payload);
              throw err;
            }
          }
          if (!options.ownerId) {
            return deps.storeResultAndNotify!(chatJid, text, options);
          }
          const payload: TaskRunNotificationPayload = {
            kind: 'store_result_and_notify',
            chatJid,
            text,
            options: {
              ...options,
              sourceKind: options.sourceKind,
              // The first attempt already persisted the task result. Durable
              // retry must only redeliver notification, never duplicate chat.
              skipStore: true,
              sourceAlreadyDelivered: directlyDeliveredJids.has(chatJid),
            },
          };
          try {
            const receipt = await deps.storeResultAndNotify!(chatJid, text, {
              ...options,
              sourceAlreadyDelivered: directlyDeliveredJids.has(chatJid),
            });
            const directFailure =
              pendingDirectFailure?.jid === chatJid
                ? pendingDirectFailure
                : undefined;
            if (directFailure) pendingDirectFailure = undefined;
            if (receipt && receipt.summary.attempted > 0) {
              if (directFailure) {
                // Atomically consume only the provisional source retry item.
                // Unrelated IPC/channel failures remain durable.
                const replaced = replaceTaskRunNotificationReceipt(
                  claim.id,
                  directFailure.receipt,
                  directFailure.payload,
                  receipt,
                  receipt.status === 'failed' ||
                    receipt.status === 'partial_failed'
                    ? retryPayloadForReceipt(payload, receipt)
                    : undefined,
                );
                if (!replaced) {
                  logger.warn(
                    { runId: claim.id, chatJid },
                    'Failed to atomically replace provisional source notification failure',
                  );
                }
                trackPersistedReceipt(receipt);
              } else {
                record(receipt, payload);
              }
            } else if (directFailure) {
              // No fallback attempt occurred; the source failure was already
              // persisted at catch time and remains the exact retry work.
              trackPersistedReceipt(directFailure.receipt);
            } else if (receipt) {
              record(receipt, payload);
            } else {
              unconfirmed = true;
            }
            return receipt;
          } catch (err) {
            const directFailure =
              pendingDirectFailure?.jid === chatJid
                ? pendingDirectFailure
                : undefined;
            if (directFailure) {
              pendingDirectFailure = undefined;
            }
            const receipt = failedNotificationReceipt(chatJid, err);
            if (directFailure) {
              replaceTaskRunNotificationReceipt(
                claim.id,
                directFailure.receipt,
                directFailure.payload,
                receipt,
                retryPayloadForReceipt(payload, receipt),
              );
              trackPersistedReceipt(receipt);
            } else {
              record(receipt, payload);
            }
            throw err;
          }
        }
      : undefined,
  };
  return {
    deps: trackedDeps,
    receipt: () => {
      if (pendingDirectFailure) {
        const pending = pendingDirectFailure;
        pendingDirectFailure = undefined;
        // Already durable from sendMessage's catch; only add it to the
        // execution-local aggregate used to choose the final run state.
        trackPersistedReceipt(pending.receipt);
      }
      return aggregate;
    },
    deferredReceipt: () => deferred,
    hasUnconfirmedAttempt: () => unconfirmed,
  };
}

function finishDurableRunFromLegacyLog(
  claim: ClaimedTaskRun,
  mode: 'isolated' | 'group' | 'script',
  receipt: TaskRunNotificationReceipt | null,
  deferredReceipt: TaskRunNotificationReceipt | null,
  hasUnconfirmedAttempt: boolean,
  executionStartedAtMs: number,
  atomicHandoffAttempted = false,
): void {
  const current = getTaskRunById(claim.id);
  if (current && current.status !== 'running') {
    // Group prompt hand-off and isolated workspace-result intent both cross
    // their durable occurrence boundary before this outer queue callback.
    // Merge only deferred delivery receipts; never perform a second legacy
    // completion after that boundary.
    if (deferredReceipt) {
      recordTaskRunNotificationReceipt(claim.id, deferredReceipt);
    }
    return;
  }
  if (atomicHandoffAttempted) {
    logger.error(
      { runId: claim.id, taskId: claim.task_id },
      'Leaving isolated run fenced after atomic terminal hand-off failed; refusing non-atomic legacy completion',
    );
    return;
  }
  const log = latestLegacyRunOutcome(claim.task_id, executionStartedAtMs);
  const delivered = mode === 'group' && log?.status === 'queued';
  const failed = !log || log.status === 'error';
  const completed = completeTaskRun(
    claim.id,
    claim.lease_owner,
    claim.lease_token,
    {
      status: delivered ? 'delivered' : failed ? 'failed' : 'success',
      result: log?.result ?? null,
      error: failed
        ? log?.error || 'Execution ended without a durable result'
        : null,
      notificationStatus:
        mode === 'group'
          ? 'skipped'
          : receipt || hasUnconfirmedAttempt || mode === 'isolated'
            ? 'pending'
            : 'skipped',
      notificationError: null,
    },
  );
  if (completed && deferredReceipt) {
    recordTaskRunNotificationReceipt(claim.id, deferredReceipt);
  }
}

function executeClaimedTaskRun(
  claim: ClaimedTaskRun,
  deps: SchedulerDependencies,
): void {
  const current = getTaskById(claim.task_id);
  if (!current || current.deleted_at) {
    completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
      status: 'cancelled',
      error: 'Task definition was deleted before execution',
      notificationStatus: 'skipped',
    });
    return;
  }
  const task = taskFromRunSnapshot(current, claim);
  const targetGroupJid = resolveTargetGroupJid(task, deps.registeredGroups());
  if (!targetGroupJid) {
    completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
      status: 'failed',
      error: `Target group not registered: ${task.chat_jid}`,
      notificationStatus: 'skipped',
    });
    return;
  }
  // Script runs bypass GroupQueue.enqueueTask(), so checking only at enqueue
  // would let a detached process start while a workspace mutation is moving or
  // replacing its filesystem. Retry without consuming an attempt; the caller
  // holding the gate decides whether the task will survive the mutation.
  if (deps.queue.isGroupMutationPaused?.(targetGroupJid)) {
    scheduleSafePrestartRetry(claim, 'Workspace mutation is in progress', {
      countsAsAttempt: false,
      retryDelayMs: 1_000,
    });
    return;
  }
  const notificationTracker = trackTaskRunNotifications(claim, deps);
  const executionDeps = notificationTracker.deps;
  let executionStartedAtMs = Date.now();
  let isolatedTerminalHandoff: (() => boolean) | null = null;

  const finish = (
    heartbeat: ReturnType<typeof setInterval>,
    mode: 'isolated' | 'group' | 'script',
  ) => {
    clearInterval(heartbeat);
    activeDurableTaskIds.delete(task.id);
    clearActiveDurableExecution(claim.id, claim.attempt);
    let atomicHandoffAttempted = false;
    if (
      mode === 'isolated' &&
      isolatedTerminalHandoff &&
      getTaskRunById(claim.id)?.status === 'running'
    ) {
      atomicHandoffAttempted = true;
      try {
        isolatedTerminalHandoff();
      } catch (err) {
        logger.error(
          { runId: claim.id, taskId: task.id, err },
          'Retrying isolated atomic terminal hand-off failed',
        );
      }
    }
    finishDurableRunFromLegacyLog(
      claim,
      mode,
      notificationTracker.receipt(),
      notificationTracker.deferredReceipt(),
      notificationTracker.hasUnconfirmedAttempt(),
      executionStartedAtMs,
      atomicHandoffAttempted,
    );
    armScheduler(0);
  };

  if (task.execution_type === 'script') {
    const runtimePolicyError = scriptTaskRuntimePolicyError(task, deps);
    if (runtimePolicyError) {
      pauseUnsafeScriptTask(task.id, deps);
      completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'failed',
        error: runtimePolicyError,
        notificationStatus: 'skipped',
      });
      return;
    }
    let leaseLost = false;
    const abortController = new AbortController();
    const heartbeat = startTaskRunHeartbeat(claim, () => {
      leaseLost = true;
      activeDurableExecutions.get(claim.id)?.stop?.();
    });
    activeDurableExecutions.set(claim.id, {
      taskId: task.id,
      kind: 'script',
      attempt: claim.attempt,
      stop: () => abortController.abort('task_run_cancelled_or_fenced'),
    });
    if (
      !markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      )
    ) {
      clearInterval(heartbeat);
      clearActiveDurableExecution(claim.id, claim.attempt);
      return;
    }
    executionStartedAtMs = Date.now();
    activeDurableTaskIds.add(task.id);
    trackDetachedSchedulerWork(
      runScriptTask(
        task,
        executionDeps,
        targetGroupJid,
        claim.trigger_type === 'manual',
        claim,
        abortController.signal,
      )
        .catch((err) =>
          logger.error(
            { runId: claim.id, taskId: task.id, err },
            'V2 script run failed',
          ),
        )
        .finally(() => {
          if (!leaseLost) finish(heartbeat, 'script');
          else {
            activeDurableTaskIds.delete(task.id);
            clearActiveDurableExecution(claim.id, claim.attempt);
          }
        }),
    );
    return;
  }

  if (task.context_mode === 'group') {
    let leaseLost = false;
    const heartbeat = startTaskRunHeartbeat(claim, () => {
      leaseLost = true;
    });
    activeDurableExecutions.set(claim.id, {
      taskId: task.id,
      kind: 'group',
      attempt: claim.attempt,
    });
    if (
      !markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      )
    ) {
      clearInterval(heartbeat);
      clearActiveDurableExecution(claim.id, claim.attempt);
      return;
    }
    executionStartedAtMs = Date.now();
    activeDurableTaskIds.add(task.id);
    void runGroupModeTask(
      task,
      executionDeps,
      targetGroupJid,
      claim.trigger_type === 'manual',
      claim,
    )
      .catch((err) =>
        logger.error(
          { runId: claim.id, taskId: task.id, err },
          'V2 group run failed',
        ),
      )
      .finally(() => {
        if (!leaseLost) finish(heartbeat, 'group');
        else {
          activeDurableTaskIds.delete(task.id);
          clearActiveDurableExecution(claim.id, claim.attempt);
        }
      });
    return;
  }

  const executionNamespace = `task-run-${claim.id}-attempt-${claim.attempt}`;
  const prepared = prepareIsolatedTaskRun(
    task,
    executionDeps,
    claim.trigger_type === 'manual',
    executionNamespace,
  );
  if (!prepared) {
    completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
      status: 'failed',
      error: 'Failed to resolve task workspace',
      notificationStatus: 'skipped',
    });
    return;
  }

  let started = false;
  let settled = false;
  const stop = () => {
    void deps.queue
      .stopGroup(prepared.queueJid, { force: true })
      .catch((err) =>
        logger.error(
          { runId: claim.id, queueJid: prepared.queueJid, err },
          'Failed to stop fenced scheduled-task runner',
        ),
      );
  };
  const heartbeat = startTaskRunHeartbeat(claim, stop);
  activeDurableExecutions.set(claim.id, {
    taskId: task.id,
    kind: 'isolated',
    attempt: claim.attempt,
    stop,
  });
  const onDropped = () => {
    if (settled) return;
    settled = true;
    clearInterval(heartbeat);
    clearActiveDurableExecution(claim.id, claim.attempt);
    if (!started) {
      const shuttingDown = deps.queue.isShuttingDown?.() === true;
      if (claim.trigger_type === 'manual' && !shuttingDown) {
        // A manual Run Now request that never crossed the execution boundary is
        // safe to terminate; the user may immediately press Run Now again.
        completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
          status: 'cancelled',
          error: 'Task queue dropped the manual run before it started',
          notificationStatus: 'skipped',
        });
      } else {
        // Shutdown is not the run's failure: keep the budget and let the next
        // process pick it straight back up.
        scheduleSafePrestartRetry(
          claim,
          shuttingDown
            ? 'Process shut down before the run started'
            : 'Task queue dropped the run',
          { countsAsAttempt: !shuttingDown },
        );
      }
    }
    armScheduler(0);
  };
  try {
    const accepted = deps.queue.enqueueTask(
      prepared.queueJid,
      task.id,
      async () => {
        if (settled) return;
        started = markTaskRunExecutionStarted(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
        );
        if (!started) {
          settled = true;
          clearInterval(heartbeat);
          clearActiveDurableExecution(claim.id, claim.attempt);
          return;
        }
        executionStartedAtMs = Date.now();
        activeDurableTaskIds.add(task.id);
        try {
          await runTask(task, executionDeps, {
            ...prepared.options,
            durableRun: claim,
            onDurableTerminalHandoffPrepared: (commit) => {
              isolatedTerminalHandoff = commit;
            },
          });
        } finally {
          if (!settled) {
            settled = true;
            finish(heartbeat, 'isolated');
          }
        }
      },
      { allowInactive: true, onDropped },
    );
    if (!accepted) onDropped();
  } catch (err) {
    logger.error({ runId: claim.id, err }, 'Failed to enqueue V2 task run');
    onDropped();
  }
}

function materializeDueOccurrences(): void {
  for (const task of getDueTaskDefinitionsV2(100)) {
    if (!task.next_run) continue;
    const scheduledFor = task.next_run;
    const overdueMs = Date.now() - new Date(scheduledFor).getTime();
    let nextRun: string | null;
    try {
      nextRun = computeNextRun(task);
    } catch (err) {
      const reason = `Invalid schedule: ${err instanceof Error ? err.message : String(err)}`;
      materializeTaskOccurrence({
        taskId: task.id,
        scheduledFor,
        nextRun: null,
        triggerType: 'backfill',
        missedReason: reason,
      });
      updateTask(task.id, { status: 'paused', next_run: null });
      continue;
    }
    const recurringMisfire =
      task.schedule_type !== 'once' &&
      shouldSkipBackfill(scheduledFor, schedulerStartedAtMs);
    materializeTaskOccurrence({
      taskId: task.id,
      scheduledFor,
      nextRun,
      triggerType:
        recurringMisfire || (task.schedule_type === 'once' && overdueMs > 0)
          ? 'backfill'
          : 'scheduled',
      missedReason: recurringMisfire
        ? `Missed while scheduler was offline by ${Math.round(overdueMs / 1000)}s`
        : undefined,
    });
  }
}

function retryPayloadForReceipt(
  payload: TaskRunAtomicNotificationPayload,
  receipt: TaskRunNotificationReceipt,
): TaskRunAtomicNotificationPayload {
  if (
    payload.kind !== 'store_result_and_notify' ||
    !payload.options ||
    receipt.summary.failed_channels.length === 0
  ) {
    return payload;
  }
  const knownChannelTypes = new Set([
    'feishu',
    'telegram',
    'qq',
    'wechat',
    'dingtalk',
    'discord',
    'whatsapp',
  ]);
  let failedChannels = receipt.summary.failed_channels.filter((channel) =>
    knownChannelTypes.has(channel),
  );
  const originalChannels = payload.options.notifyChannels;
  if (Array.isArray(originalChannels)) {
    const allowed = new Set(originalChannels);
    failedChannels = failedChannels.filter((channel) => allowed.has(channel));
  }
  // Generic exceptions identify the source with a concrete JID (or an
  // internal label), while broadcast filtering expects channel *types*.
  // Preserve the original selection rather than narrowing to an unusable JID.
  if (failedChannels.length === 0) return payload;
  return {
    ...payload,
    options: {
      ...payload.options,
      notifyChannels: failedChannels,
    },
  };
}

export async function deliverPersistedNotificationPayload(
  payload: TaskRunNotificationPayload,
  deps: SchedulerDependencies,
): Promise<{
  receipt: TaskRunNotificationReceipt;
  retryPayload?: TaskRunNotificationPayload;
}> {
  const items = payload.kind === 'batch' ? payload.items : [payload];
  let aggregate: TaskRunNotificationReceipt | null = null;
  const failedItems: TaskRunAtomicNotificationPayload[] = [];

  for (const item of items) {
    let receipt: TaskRunNotificationReceipt;
    try {
      if (item.kind === 'send_message') {
        // The initial source send already persisted the script result for Web.
        // A durable retry must perform only the physical IM notification.
        if (deps.retryTaskNotification) {
          receipt = await deps.retryTaskNotification({
            kind: 'im_message',
            targetJid: item.chatJid,
            text: item.text,
            localImagePaths: [],
          });
        } else {
          await deps.sendMessage(item.chatJid, item.text, item.sendOptions);
          receipt = {
            status: 'success',
            summary: {
              attempted: 1,
              succeeded: 1,
              failed: 0,
              failed_channels: [],
            },
          };
        }
      } else if (
        item.kind === 'workspace_result' &&
        deps.storeResultAndNotify &&
        item.options
      ) {
        await deps.storeResultAndNotify(item.chatJid, item.text, {
          ...item.options,
          sourceKind: item.options.sourceKind as ContainerOutput['sourceKind'],
          // messageId is stable, so the canonical workspace write is safe to
          // replay after either a DB failure or a post-commit broadcast error.
          skipStore: false,
        });
        if (
          item.groupRunId &&
          item.groupTaskId &&
          !finalizeDeliveredGroupTaskRun(item.groupRunId, item.groupTaskId, {
            status: item.groupStatus,
            result: item.groupResult,
            error: item.groupError,
          })
        ) {
          throw new Error(
            `Group task run ${item.groupRunId} no longer accepts its workspace result`,
          );
        }
        receipt = {
          status: 'success',
          summary: {
            attempted: 1,
            succeeded: 1,
            failed: 0,
            failed_channels: [],
          },
        };
      } else if (
        item.kind === 'store_result_and_notify' &&
        deps.storeResultAndNotify &&
        item.options
      ) {
        const result = await deps.storeResultAndNotify(
          item.chatJid,
          item.text,
          {
            ...item.options,
            sourceKind: item.options
              .sourceKind as ContainerOutput['sourceKind'],
            // Persisted retries never write the Web result a second time.
            skipStore: true,
          },
        );
        receipt =
          result ??
          failedNotificationReceipt(
            item.chatJid,
            'Notification transport returned no delivery receipt',
          );
      } else if (deps.retryTaskNotification) {
        receipt = await deps.retryTaskNotification(item);
      } else {
        receipt = failedNotificationReceipt(
          'notification',
          'Notification dependency is unavailable',
        );
      }
    } catch (err) {
      const channel =
        'targetJid' in item
          ? item.targetJid
          : 'chatJid' in item
            ? item.chatJid
            : 'notification';
      receipt = failedNotificationReceipt(channel, err);
    }
    aggregate = mergeNotificationReceipts(aggregate, receipt);
    if (receipt.status === 'failed' || receipt.status === 'partial_failed') {
      const retry = retryPayloadForReceipt(item, receipt);
      failedItems.push(retry);
    }
  }

  const retryPayload =
    failedItems.length === 0
      ? undefined
      : failedItems.length === 1
        ? failedItems[0]
        : ({ kind: 'batch', items: failedItems } as const);
  return {
    receipt: aggregate ?? {
      status: 'skipped',
      summary: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failed_channels: [],
      },
    },
    retryPayload,
  };
}

export async function processClaimedTaskRunNotification(
  claim: ClaimedTaskRunNotification,
  deps: SchedulerDependencies,
  leaseMs = TASK_RUN_LEASE_MS,
): Promise<boolean> {
  let leaseOwned = true;
  const heartbeat = setInterval(
    () => {
      try {
        if (!renewTaskRunNotificationLease(claim, leaseMs)) {
          leaseOwned = false;
        }
      } catch (err) {
        leaseOwned = false;
        logger.error(
          { runId: claim.runId, err },
          'Failed to renew task notification lease',
        );
      }
    },
    Math.max(10, Math.floor(leaseMs / 3)),
  );
  heartbeat.unref?.();
  try {
    const delivered = await deliverPersistedNotificationPayload(
      claim.payload,
      deps,
    );
    // Renew once immediately before the fenced completion write. This closes
    // the small race between the final periodic heartbeat and completion.
    if (!leaseOwned || !renewTaskRunNotificationLease(claim, leaseMs)) {
      return false;
    }
    return completeTaskRunNotificationAttempt(
      claim,
      delivered.receipt,
      delivered.retryPayload,
    );
  } finally {
    clearInterval(heartbeat);
  }
}

function pumpTaskNotificationRetries(deps: SchedulerDependencies): void {
  for (let count = 0; count < 8; count++) {
    const claim = claimNextTaskRunNotification(
      SCHEDULER_RUNNER_ID,
      TASK_RUN_LEASE_MS,
    );
    if (!claim) break;
    trackDetachedSchedulerWork(
      processClaimedTaskRunNotification(claim, deps, TASK_RUN_LEASE_MS)
        .catch((err) =>
          logger.error(
            { runId: claim.runId, err },
            'Task notification retry crashed',
          ),
        )
        .finally(() => armScheduler(0)),
    );
  }
}

function pumpTaskScheduler(deps: SchedulerDependencies): void {
  if (schedulerPumping) return;
  if (deps.queue.isShuttingDown?.()) {
    clearSchedulerTimer();
    return;
  }
  schedulerPumping = true;
  try {
    failExpiredStartedTaskRuns();
    finalizeExpiredTaskRunNotificationAttempts();
    materializeDueOccurrences();
    pumpTaskNotificationRetries(deps);
    for (let count = 0; count < MAX_CLAIMS_PER_PUMP; count++) {
      const claim = claimNextTaskRun(SCHEDULER_RUNNER_ID, TASK_RUN_LEASE_MS);
      if (!claim) break;
      executeClaimedTaskRun(claim, deps);
    }
    const now = Date.now();
    if (now - lastCleanupTime >= CLEANUP_INTERVAL_MS) {
      lastCleanupTime = now;
      cleanupOldTaskRunLogs();
    }
  } catch (err) {
    logger.error({ err }, 'Task Scheduler V2 pump failed');
  } finally {
    schedulerPumping = false;
    if (deps.queue.isShuttingDown?.()) {
      clearSchedulerTimer();
    } else {
      armSchedulerFromStore();
    }
  }
}

/**
 * Stop materializing new occurrences and drain scheduler-owned detached work.
 *
 * Shutdown order is a contract: external intake stops first, then the scheduler
 * stops taking new work while delivery is still available, and only then are
 * transports and watchers closed. Without this step `queue.shutdown()` returned
 * while script runs and notification retries were still in flight, and the
 * process exited mid-write.
 *
 * The drain re-reads the live set each round because settling one item can
 * enqueue its follow-up (a finished run schedules its notification). Rounds and
 * wall clock are both bounded so a wedged item cannot block shutdown.
 */
export async function stopSchedulerLoop(
  options: { drainMs?: number } = {},
): Promise<void> {
  schedulerRunning = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  const deadline = Date.now() + (options.drainMs ?? 10_000);
  for (let round = 0; round < 8; round++) {
    if (detachedSchedulerWork.size === 0) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Promise.race([
      Promise.allSettled([...detachedSchedulerWork]),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        timer.unref?.();
      }),
    ]);
  }
  if (detachedSchedulerWork.size > 0) {
    logger.warn(
      { pending: detachedSchedulerWork.size },
      'Scheduler drain timed out with detached work still pending',
    );
  }
  schedulerDepsRef = null;
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  schedulerStartedAtMs = Date.now();
  schedulerDepsRef = deps;

  // Process-local reservations are never authoritative after restart. Durable
  // task-run leases expire/recover naturally; do NOT clear all DB leases.
  runningTaskIds.clear();
  pendingManualTaskIds.clear();
  pendingScheduledTaskIds.clear();

  // Durable V2 leases recover by expiry and must remain untouched. Legacy
  // running logs have no lease/owner, so after startup they are necessarily
  // crash orphans and should not remain "running" in the UI forever.
  const staleLegacyLogs = cleanupStaleRunningLogs();
  if (staleLegacyLogs > 0) {
    logger.info(
      { staleLegacyLogs },
      'Marked crash-interrupted legacy task logs as failed',
    );
  }

  // Clean up orphaned legacy task-* workspaces from completed once-tasks
  // (covers the case where process restarted before setTimeout cleanup fired).
  // New scheduled tasks run inside the source workspace and must never delete
  // the source workspace during task cleanup.
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
        t.workspace_folder.startsWith('task-') &&
        groups[t.workspace_jid]
      ) {
        deleteGroupData(t.workspace_jid, t.workspace_folder);
        delete groups[t.workspace_jid];
        removeFlowArtifacts(t.workspace_folder);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(
        { cleaned },
        'Cleaned up orphaned once-task workspaces from previous session',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup orphaned once-task workspaces');
  }

  logger.info('Task Scheduler V2 started');
  pumpTaskScheduler(deps);
}

/**
 * Manually trigger a task to run now (fire-and-forget).
 * Does not change next_run — the task continues its normal schedule.
 */
export function triggerTaskNow(
  taskId: string,
  deps: SchedulerDependencies,
  idempotencyKey?: string,
): { success: boolean; error?: string; runId?: string } {
  const task = getTaskById(taskId);
  if (!task || task.deleted_at)
    return { success: false, error: 'Task not found' };
  if (task.status === 'completed')
    return { success: false, error: 'Task already completed' };
  if (task.status === 'parsing')
    return { success: false, error: '任务仍在解析中，请稍后再运行' };
  const runtimePolicyError = scriptTaskRuntimePolicyError(task, deps);
  if (runtimePolicyError) {
    pauseUnsafeScriptTask(task.id, deps);
    return { success: false, error: runtimePolicyError };
  }
  const created = createTaskRun({
    task,
    triggerType: 'manual',
    idempotencyKey,
  });
  if (!created.created && created.reason === 'active_conflict') {
    return {
      success: false,
      error: 'Task is already running',
      runId: created.run.id,
    };
  }
  // Pump synchronously through claim/admission so callers immediately observe
  // queued/running state and existing tests/clients retain fire-now semantics.
  pumpTaskScheduler(deps);
  return { success: true, runId: created.run.id };
}

/**
 * Stop one durable occurrence. DB cancellation fences late completion first;
 * the process-specific stopper then aborts the active isolated/script worker.
 */
export function cancelTaskRunNow(runId: string): {
  success: boolean;
  error?: string;
} {
  const run = getTaskRunById(runId);
  if (!run) return { success: false, error: 'Task run not found' };
  if (!['queued', 'running', 'retry_wait'].includes(run.status)) {
    return { success: false, error: `Task run is already ${run.status}` };
  }
  if (!cancelTaskRun(runId)) {
    return {
      success: false,
      error: 'Task run state changed; refresh and retry',
    };
  }
  const active = activeDurableExecutions.get(runId);
  try {
    void active?.stop?.();
  } catch (err) {
    logger.error({ runId, err }, 'Failed to stop cancelled task-run process');
  }
  notifyTaskSchedulerChanged();
  return { success: true };
}

/**
 * Wait until the process-side execution records disappear after cancellation.
 * DB cancellation alone is not enough for workspace rebuild: a script process
 * may still be unwinding and writing to the workspace directory.
 */
export async function waitForTaskRunsToStop(
  runIds: string[],
  timeoutMs = 30_000,
): Promise<boolean> {
  const pending = new Set(runIds);
  if (pending.size === 0) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    for (const runId of pending) {
      if (!activeDurableExecutions.has(runId)) pending.delete(runId);
    }
    if (pending.size === 0) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remainingMs)),
    );
  }
}
