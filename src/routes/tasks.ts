// Task management routes

import { Hono, type Context } from 'hono';
import * as crypto from 'node:crypto';
import { sdkQuery } from '../sdk-query.js';
import { getSystemSettings } from '../runtime-config.js';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  MAX_TASK_PROMPT_LENGTH,
  TaskCreateSchema,
  TaskPatchSchema,
} from '../schemas.js';
import { logger } from '../logger.js';
import {
  getAllTasks,
  getDeletedTasks,
  getTaskById,
  createTaskWithinOwnerLimit,
  getTaskRunLogs,
  updateTaskWithRevision,
  softDeleteTaskWithRevision,
  restoreTaskWithRevision,
  getTaskRunById,
  getActiveTaskRunForTask,
  getTaskRunsForTask,
  getRegisteredGroup,
  getAllRegisteredGroups,
  getUserHomeGroup,
} from '../db.js';
import { getMergedTaskRunHistory } from '../task-run-history.js';
import type { AuthUser, ScheduledTask } from '../types.js';
import { TIMEZONE } from '../config.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
  getWebDeps,
} from '../web-context.js';
import {
  computeNextRunForSchedule,
  computeNextRunForTaskResume,
  getRunningTaskIds,
  notifyTaskSchedulerChanged,
} from '../task-scheduler.js';
import { getChannelType, extractChatId } from '../im-channel.js';
import {
  getScriptTaskHostExecutionError,
  SCRIPT_TASK_HOST_REQUIRED_ERROR,
} from '../script-task-policy.js';

const tasksRoutes = new Hono<{ Variables: Variables }>();

function canViewTask(task: ScheduledTask, authUser: AuthUser): boolean {
  if (task.execution_mode === 'host' && authUser.role !== 'admin') return false;
  const group = getRegisteredGroup(task.chat_jid);
  if (!group) return authUser.role === 'admin';
  return (
    canAccessGroup(
      { id: authUser.id, role: authUser.role },
      { ...group, jid: task.chat_jid },
    ) &&
    (!isHostExecutionGroup(group) || hasHostExecutionPermission(authUser))
  );
}

function taskPermissions(task: ScheduledTask, authUser: AuthUser) {
  const isAdmin = authUser.role === 'admin';
  const canManage = canViewTask(task, authUser);
  const canOperateExecution =
    canManage && (task.execution_type !== 'script' || isAdmin);
  const executionBlockedReason = getScriptTaskHostExecutionError(
    task,
    getAllRegisteredGroups(),
  );
  const activeRun = getActiveTaskRunForTask(task.id);
  return {
    can_edit: canManage && !task.deleted_at && task.status !== 'parsing',
    can_run:
      canOperateExecution &&
      !executionBlockedReason &&
      !task.deleted_at &&
      task.status !== 'parsing',
    can_pause: canManage && !task.deleted_at,
    can_stop: canOperateExecution && !!activeRun,
    can_delete: canOperateExecution && !task.deleted_at,
    can_restore:
      canOperateExecution && !executionBlockedReason && !!task.deleted_at,
    execution_scope:
      task.execution_mode === 'host'
        ? ('workspace_host' as const)
        : ('workspace_container' as const),
    risk_level:
      task.execution_type === 'script'
        ? ('high' as const)
        : ('normal' as const),
    execution_blocked_reason: executionBlockedReason,
    is_admin: isAdmin,
  };
}

function revisionConflict(c: Context, task: ScheduledTask) {
  return c.json(
    {
      error: '任务已被其他页面或 Agent 修改，请刷新后重试。',
      code: 'TASK_REVISION_CONFLICT',
      current_task: task,
    },
    409,
  );
}

// --- Routes ---

tasksRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const allGroups = getAllRegisteredGroups();
  const includeDeleted = c.req.query('include_deleted') === '1';
  const taskDefinitions = includeDeleted
    ? [...getAllTasks(), ...getDeletedTasks()]
    : getAllTasks();
  const visibleDefinitions = taskDefinitions.filter((task) =>
    canViewTask(task, authUser),
  );
  const tasks = visibleDefinitions.map((task) => {
    const recentRuns = getMergedTaskRunHistory(task.id, 1);
    return {
      ...task,
      current_run: getActiveTaskRunForTask(task.id) ?? null,
      last_run_summary: recentRuns[0] ?? null,
      permissions: taskPermissions(task, authUser),
    };
  });
  const visibleTaskIds = new Set(tasks.map((t) => t.id));
  const filteredRunningIds = getRunningTaskIds().filter((id) =>
    visibleTaskIds.has(id),
  );

  // Build jid → name mapping for all registered groups (including IM channels).
  // Mirror the visibility rule used by GET /api/groups (src/routes/groups.ts:190-192):
  // non-admins must not see host workspaces in the task-target dropdown, even
  // though POST /api/tasks would reject them with 403 — rendering them here
  // would be a misleading UI affordance. Authorization is still enforced on
  // write; this filter is purely for surface consistency.
  const groupNames: Record<string, string> = {};
  for (const [jid, group] of Object.entries(allGroups)) {
    if (
      !canAccessGroup(
        { id: authUser.id, role: authUser.role },
        { ...group, jid },
      )
    )
      continue;
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser))
      continue;
    groupNames[jid] = group.name || jid;
  }

  // Enrich Feishu group names with real chat names from API.
  // Only enrich JIDs actually referenced by visible tasks to avoid N+1 calls
  // against Feishu Open API when the user has many registered groups.
  const deps = getWebDeps();
  if (deps?.getFeishuChatInfo) {
    const referencedJids = new Set(tasks.map((t) => t.chat_jid));
    const feishuJids = Object.keys(groupNames).filter(
      (jid) => referencedJids.has(jid) && getChannelType(jid) === 'feishu',
    );
    const enrichPromises = feishuJids.map(async (jid) => {
      try {
        const chatId = extractChatId(jid);
        const info = await deps.getFeishuChatInfo!(authUser.id, chatId);
        if (info?.name) groupNames[jid] = info.name;
      } catch (err) {
        logger.debug({ jid, err }, 'feishu chat name enrichment failed');
      }
    });
    await Promise.allSettled(enrichPromises);
  }

  return c.json({ tasks, runningTaskIds: filteredRunningIds, groupNames });
});

tasksRoutes.post('/', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const validation = TaskCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const {
    prompt,
    schedule_type,
    schedule_value,
    execution_type,
    script_command,
    notify_channels,
  } = validation.data;
  const authUser = c.get('user') as AuthUser;

  // Auto-resolve group_folder/chat_jid from user's home group if not provided
  let groupFolder = validation.data.group_folder;
  let chatJid = validation.data.chat_jid;
  if (!groupFolder || !chatJid) {
    const homeGroup = getUserHomeGroup(authUser.id);
    if (!homeGroup) {
      return c.json({ error: 'User has no home group' }, 400);
    }
    groupFolder = groupFolder || homeGroup.folder;
    chatJid = chatJid || homeGroup.jid;
  }

  const group = getRegisteredGroup(chatJid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (group.folder !== groupFolder) {
    return c.json(
      { error: 'group_folder does not match chat_jid group folder' },
      400,
    );
  }

  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  // Only admin can create script tasks
  const execType = execution_type || 'agent';
  if (execType === 'script' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以创建脚本类型任务' }, 403);
  }

  // Determine execution_mode by inheriting from the source workspace.
  // - Source is host: default host (admin-only via hasHostExecutionPermission
  //   check above), allow explicit container downgrade.
  // - Source is container: default container; explicit host request rejected
  //   even for admins, to keep task execution consistent with its workspace.
  const sourceIsHost = isHostExecutionGroup(group);
  let taskExecutionMode: 'host' | 'container';
  if (validation.data.execution_mode === 'host') {
    if (!sourceIsHost) {
      return c.json(
        { error: '当前工作区运行在容器模式，任务不能使用宿主机执行模式' },
        400,
      );
    }
    // Non-admin already blocked above by isHostExecutionGroup + hasHostExecutionPermission check
    taskExecutionMode = 'host';
  } else if (validation.data.execution_mode === 'container') {
    taskExecutionMode = 'container';
  } else {
    taskExecutionMode = sourceIsHost ? 'host' : 'container';
  }
  if (execType === 'script' && taskExecutionMode !== 'host') {
    return c.json({ error: SCRIPT_TASK_HOST_REQUIRED_ERROR }, 400);
  }

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  const taskCap = getSystemSettings().maxTasksPerUser;

  let nextRun: string;
  try {
    nextRun = computeNextRunForSchedule(schedule_type, schedule_value);
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Invalid schedule',
      },
      400,
    );
  }

  const creation = createTaskWithinOwnerLimit(
    {
      id: taskId,
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: prompt || '',
      schedule_type,
      schedule_value,
      context_mode: validation.data.context_mode || 'isolated',
      execution_type: execType,
      execution_mode: taskExecutionMode,
      script_command: script_command ?? null,
      next_run: nextRun,
      status: 'active',
      created_at: now,
      created_by: authUser.id,
      notify_channels: notify_channels ?? null,
    },
    taskCap,
  );
  if (creation.status === 'limit_reached') {
    return c.json(
      {
        error: `定时任务数量已达上限（${creation.limit}）。请先删除不再需要的任务。`,
        code: 'TASK_LIMIT_REACHED',
      },
      409,
    );
  }
  notifyTaskSchedulerChanged();

  return c.json({ success: true, taskId });
});

tasksRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group = getRegisteredGroup(existing.chat_jid);
  if (!group) {
    if (authUser.role !== 'admin')
      return c.json({ error: 'Task not found' }, 404);
  } else {
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Task not found' }, 404);
    }
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for host execution mode' },
        403,
      );
    }
  }
  const body = await c.req.json().catch(() => ({}));
  const rawExpectedRevision = (body as Record<string, unknown>)
    .expected_revision;
  const expectedRevision =
    typeof rawExpectedRevision === 'number' &&
    Number.isInteger(rawExpectedRevision) &&
    rawExpectedRevision > 0
      ? rawExpectedRevision
      : null;
  if (expectedRevision === null) {
    return c.json(
      {
        error: 'expected_revision is required. Reload the task and retry.',
        code: 'TASK_REVISION_REQUIRED',
        current_task: existing,
      },
      428,
    );
  }
  const { expected_revision: _expectedRevision, ...patchBody } = body as Record<
    string,
    unknown
  >;

  const validation = TaskPatchSchema.safeParse(patchBody);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  if (existing.status === 'parsing') {
    const requestedFields = Object.entries(validation.data).filter(
      ([, value]) => value !== undefined,
    );
    const onlyPause =
      requestedFields.length === 1 && validation.data.status === 'paused';
    if (!onlyPause) {
      return c.json(
        {
          error: '任务正在解析中；可先暂停解析，再修改配置。',
          code: 'TASK_STILL_PARSING',
          current_task: existing,
        },
        409,
      );
    }
  }

  if (getRunningTaskIds().includes(id)) {
    const unsafeWhileRunning: Array<keyof typeof validation.data> = [
      'chat_jid',
      'prompt',
      'schedule_type',
      'schedule_value',
      'context_mode',
      'execution_type',
      'execution_mode',
      'script_command',
      'next_run',
    ];
    if (
      unsafeWhileRunning.some((field) => validation.data[field] !== undefined)
    ) {
      return c.json(
        { error: '任务正在运行中，请等待本次执行完成后再修改配置。' },
        409,
      );
    }
  }

  // Only admin can create/modify script tasks
  const isScriptTask =
    (validation.data.execution_type ?? existing.execution_type) === 'script';
  if (isScriptTask && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以创建或修改脚本类型任务' }, 403);
  }

  // Only admin can set execution_mode to 'host'
  if (validation.data.execution_mode === 'host' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以设置宿主机执行模式' }, 403);
  }

  // Validate chat_jid if being changed
  const patchData = { ...validation.data } as typeof validation.data & {
    group_folder?: string;
    delivery_route_jid?: string;
  };
  let effectiveTargetGroup: ReturnType<typeof getRegisteredGroup> = group;
  if (validation.data.chat_jid !== undefined) {
    const targetGroup = getRegisteredGroup(validation.data.chat_jid);
    if (!targetGroup) {
      return c.json({ error: '目标群组不存在' }, 404);
    }
    if (
      !canAccessGroup({ id: authUser.id, role: authUser.role }, targetGroup)
    ) {
      return c.json({ error: '无权访问目标群组' }, 403);
    }
    // Keep group_folder in sync with chat_jid
    patchData.group_folder = targetGroup.folder;
    // A Web edit has no thread-scoped source context. Rebind delivery to the
    // selected workspace/chat itself instead of retaining the previous route.
    patchData.delivery_route_jid = validation.data.chat_jid;
    effectiveTargetGroup = targetGroup;
  }

  // Final-state consistency: after the patch, if the task runs as 'host', the
  // target workspace must itself be a host workspace. Container workspaces
  // reject host execution for ALL roles (including admin) — execution mode
  // must match the source workspace's capabilities.
  const finalExecutionMode =
    patchData.execution_mode ?? existing.execution_mode;
  if (
    finalExecutionMode === 'host' &&
    effectiveTargetGroup &&
    !isHostExecutionGroup(effectiveTargetGroup)
  ) {
    return c.json(
      {
        error:
          '目标工作区运行在容器模式，任务不能使用宿主机执行模式。请同时把执行模式改为 container。',
      },
      400,
    );
  }

  // Validate the final definition, not only the fields present in this PATCH.
  // Otherwise changing agent→script without a command (or clearing the current
  // command/prompt) persists a task that can only fail at runtime.
  const finalExecutionType =
    patchData.execution_type ?? existing.execution_type;
  const finalPrompt = patchData.prompt ?? existing.prompt;
  const finalScriptCommand =
    patchData.script_command !== undefined
      ? patchData.script_command
      : existing.script_command;
  if (finalExecutionType === 'agent' && !finalPrompt.trim()) {
    return c.json({ error: 'Agent 模式下 prompt 不能为空。' }, 400);
  }
  if (finalExecutionType === 'script' && !finalScriptCommand?.trim()) {
    return c.json({ error: '脚本模式下 script_command 不能为空。' }, 400);
  }
  if (finalExecutionType === 'script' && finalExecutionMode !== 'host') {
    return c.json({ error: SCRIPT_TASK_HOST_REQUIRED_ERROR }, 400);
  }

  // Auto-recalculate next_run when the schedule changes (avoid pulling
  // cron-parser into the frontend), OR when resuming a task whose next_run was
  // cleared. A recurring task that couldn't compute a next run is paused with
  // next_run=NULL; the UI resume sends only {status:'active'}, so without this
  // it would flip to active-but-never-scheduled (getDueTasks requires next_run
  // IS NOT NULL). If the schedule is genuinely corrupt the recompute throws and
  // returns 400, telling the owner to fix schedule_value before resuming.
  const scheduleChanged =
    patchData.schedule_type !== undefined ||
    patchData.schedule_value !== undefined;
  // Rebuild a missing cursor when resuming. This includes future one-shot tasks
  // restored from soft deletion; restore deliberately clears next_run and leaves
  // the definition paused until the user explicitly enables it.
  const resumingWithoutNextRun =
    patchData.status === 'active' &&
    existing.status !== 'active' &&
    existing.next_run == null &&
    patchData.next_run === undefined;
  // A completed once-task can't be "resumed": its schedule is a past one-shot
  // timestamp. Re-activating it would either re-fire the one-shot action or
  // (with the once guard above suppressing recompute) strand it active-but-never
  // -scheduled (getDueTasks needs next_run IS NOT NULL). Reject unless the caller
  // also changes the schedule, which makes it a deliberate fresh run.
  if (
    patchData.status === 'active' &&
    existing.status === 'completed' &&
    existing.schedule_type === 'once' &&
    !scheduleChanged
  ) {
    return c.json(
      { error: '已完成的一次性任务无法重新启用，请修改其调度时间或新建任务。' },
      400,
    );
  }
  const schedType = patchData.schedule_type ?? existing.schedule_type;
  const schedValue = patchData.schedule_value ?? existing.schedule_value;
  const enablingOnce =
    schedType === 'once' &&
    (patchData.status === 'active' ||
      (scheduleChanged && existing.status === 'active'));
  if (scheduleChanged || resumingWithoutNextRun || enablingOnce) {
    try {
      // Keep the existing one-year REST limit while sharing the scheduler's
      // canonical cron/interval frequency validation.
      if (
        schedType === 'interval' &&
        Number(schedValue) > 365 * 24 * 60 * 60 * 1000
      ) {
        throw new Error('Interval exceeds maximum (1 year)');
      }
      patchData.next_run = enablingOnce
        ? computeNextRunForTaskResume(schedType, schedValue)
        : computeNextRunForSchedule(schedType, schedValue);
    } catch (err) {
      return c.json(
        {
          error:
            err instanceof Error
              ? err.message
              : 'Invalid schedule value for the given schedule type',
        },
        400,
      );
    }
  }

  const mutation = updateTaskWithRevision(id, expectedRevision, patchData);
  if (mutation.status === 'not_found') {
    return c.json({ error: 'Task not found' }, 404);
  }
  if (mutation.status === 'conflict') {
    return revisionConflict(c, mutation.task);
  }
  notifyTaskSchedulerChanged();

  return c.json({ success: true, task: mutation.task });
});

tasksRoutes.delete('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group = getRegisteredGroup(existing.chat_jid);
  if (!group) {
    if (authUser.role !== 'admin')
      return c.json({ error: 'Task not found' }, 404);
  } else {
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Task not found' }, 404);
    }
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for host execution mode' },
        403,
      );
    }
  }
  // Only admin can delete script tasks
  if (existing.execution_type === 'script' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以删除脚本类型任务' }, 403);
  }

  const activeRun = getActiveTaskRunForTask(id);
  if (!activeRun && getRunningTaskIds().includes(id)) {
    return c.json(
      {
        error: '任务正在排队或运行中，请先停止当前运行再删除。',
        code: 'TASK_HAS_ACTIVE_RUN',
        current_run: activeRun ?? null,
      },
      409,
    );
  }

  const rawRevision = Number(c.req.query('expected_revision'));
  const expectedRevision =
    Number.isInteger(rawRevision) && rawRevision > 0 ? rawRevision : null;
  if (expectedRevision === null) {
    return c.json(
      {
        error: 'expected_revision is required. Reload the task and retry.',
        code: 'TASK_REVISION_REQUIRED',
        current_task: existing,
      },
      428,
    );
  }
  const mutation = softDeleteTaskWithRevision(id, expectedRevision);
  if (mutation.status === 'not_found') {
    return c.json({ error: 'Task not found' }, 404);
  }
  if (mutation.status === 'conflict') {
    return revisionConflict(c, mutation.task);
  }
  if (mutation.status === 'active_run') {
    return c.json(
      {
        error: '任务正在排队或运行中，请先停止当前运行再删除。',
        code: 'TASK_HAS_ACTIVE_RUN',
        current_run: mutation.run,
      },
      409,
    );
  }
  notifyTaskSchedulerChanged();
  return c.json({ success: true, task: mutation.task });
});

tasksRoutes.post('/:id/restore', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing || !existing.deleted_at) {
    return c.json({ error: 'Task not found' }, 404);
  }
  const authUser = c.get('user') as AuthUser;
  if (!canViewTask(existing, authUser)) {
    return c.json({ error: 'Task not found' }, 404);
  }
  if (existing.execution_type === 'script' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以恢复脚本类型任务' }, 403);
  }
  const restorePolicyError = getScriptTaskHostExecutionError(
    existing,
    getAllRegisteredGroups(),
  );
  if (restorePolicyError) {
    return c.json({ error: restorePolicyError }, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const rawRevision = body.expected_revision;
  const expectedRevision =
    typeof rawRevision === 'number' &&
    Number.isInteger(rawRevision) &&
    rawRevision > 0
      ? rawRevision
      : null;
  if (expectedRevision === null) {
    return c.json(
      {
        error: 'expected_revision is required. Reload the task and retry.',
        code: 'TASK_REVISION_REQUIRED',
        current_task: existing,
      },
      428,
    );
  }
  const mutation = restoreTaskWithRevision(
    id,
    expectedRevision,
    getSystemSettings().maxTasksPerUser,
  );
  if (mutation.status === 'not_found') {
    return c.json({ error: 'Task not found' }, 404);
  }
  if (mutation.status === 'conflict') {
    return revisionConflict(c, mutation.task);
  }
  if (mutation.status === 'limit_reached') {
    return c.json(
      {
        error: `定时任务数量已达上限（${mutation.limit}）。请先删除不再需要的任务。`,
        code: 'TASK_LIMIT_REACHED',
      },
      409,
    );
  }
  notifyTaskSchedulerChanged();
  return c.json({ success: true, task: mutation.task });
});

tasksRoutes.post('/:id/runs', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing || existing.deleted_at) {
    return c.json({ error: 'Task not found' }, 404);
  }
  const authUser = c.get('user') as AuthUser;
  if (!canViewTask(existing, authUser)) {
    return c.json({ error: 'Task not found' }, 404);
  }
  if (existing.execution_type === 'script' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以运行脚本类型任务' }, 403);
  }
  const runPolicyError = getScriptTaskHostExecutionError(
    existing,
    getAllRegisteredGroups(),
  );
  if (runPolicyError) {
    updateTaskWithRevision(existing.id, existing.revision, {
      status: 'paused',
      next_run: null,
    });
    notifyTaskSchedulerChanged();
    return c.json({ error: runPolicyError }, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const idempotencyKey =
    typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
      ? body.idempotency_key.trim().slice(0, 200)
      : crypto.randomUUID();
  const deps = getWebDeps();
  if (!deps?.triggerTaskRun) {
    return c.json({ error: 'Scheduler not available' }, 503);
  }
  const result = deps.triggerTaskRun(id, idempotencyKey);
  if (!result.success) {
    return c.json({ error: result.error, runId: result.runId }, 409);
  }
  const run = result.runId ? getTaskRunById(result.runId) : undefined;
  return c.json({ success: true, runId: result.runId, run }, 202);
});

tasksRoutes.get('/:id/runs', authMiddleware, (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (!canViewTask(existing, authUser)) {
    return c.json({ error: 'Task not found' }, 404);
  }
  const limitRaw = Number.parseInt(c.req.query('limit') || '20', 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) ? Math.max(1, limitRaw) : 20,
    200,
  );
  return c.json({ runs: getMergedTaskRunHistory(id, limit) });
});

tasksRoutes.get('/runs/:runId', authMiddleware, (c) => {
  const run = getTaskRunById(c.req.param('runId'));
  if (!run) return c.json({ error: 'Task run not found' }, 404);
  const task = getTaskById(run.task_id);
  const authUser = c.get('user') as AuthUser;
  if (!task || !canViewTask(task, authUser)) {
    return c.json({ error: 'Task run not found' }, 404);
  }
  return c.json({ run });
});

tasksRoutes.post('/runs/:runId/cancel', authMiddleware, (c) => {
  const run = getTaskRunById(c.req.param('runId'));
  if (!run) return c.json({ error: 'Task run not found' }, 404);
  const task = getTaskById(run.task_id);
  const authUser = c.get('user') as AuthUser;
  if (!task || !canViewTask(task, authUser)) {
    return c.json({ error: 'Task run not found' }, 404);
  }
  if (task.execution_type === 'script' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以停止脚本任务' }, 403);
  }
  const deps = getWebDeps();
  if (!deps?.cancelTaskRun) {
    return c.json({ error: 'Scheduler not available' }, 503);
  }
  const result = deps.cancelTaskRun(run.id);
  if (!result.success) return c.json({ error: result.error }, 409);
  return c.json({ success: true, run: getTaskRunById(run.id) });
});

tasksRoutes.post('/:id/run', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group = getRegisteredGroup(existing.chat_jid);
  if (!group) {
    if (authUser.role !== 'admin')
      return c.json({ error: 'Task not found' }, 404);
  } else {
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Task not found' }, 404);
    }
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for host execution mode' },
        403,
      );
    }
  }
  // Only admin can run script tasks
  if (existing.execution_type === 'script' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以运行脚本类型任务' }, 403);
  }
  const legacyRunPolicyError = getScriptTaskHostExecutionError(
    existing,
    getAllRegisteredGroups(),
  );
  if (legacyRunPolicyError) {
    updateTaskWithRevision(existing.id, existing.revision, {
      status: 'paused',
      next_run: null,
    });
    notifyTaskSchedulerChanged();
    return c.json({ error: legacyRunPolicyError }, 400);
  }

  const deps = getWebDeps();
  if (!deps?.triggerTaskRun)
    return c.json({ error: 'Scheduler not available' }, 503);

  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const suppliedKey =
    c.req.header('Idempotency-Key') ||
    (typeof body.idempotency_key === 'string' ? body.idempotency_key : '');
  // Requests from legacy clients remain compatible; upgraded clients can
  // safely retry by reusing either the header or body key.
  const idempotencyKey =
    suppliedKey.trim().slice(0, 200) || crypto.randomUUID();
  const result = deps.triggerTaskRun(id, idempotencyKey);
  if (!result.success) {
    return c.json({ error: result.error, runId: result.runId }, 409);
  }

  return c.json({ success: true, runId: result.runId, idempotencyKey });
});

tasksRoutes.get('/:id/logs', authMiddleware, (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group = getRegisteredGroup(existing.chat_jid);
  if (!group) {
    if (authUser.role !== 'admin')
      return c.json({ error: 'Task not found' }, 404);
  } else {
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Task not found' }, 404);
    }
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for host execution mode' },
        403,
      );
    }
  }
  const limitRaw = parseInt(c.req.query('limit') || '20', 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) ? Math.max(1, limitRaw) : 20,
    200,
  );
  const logs = getTaskRunLogs(id, limit);
  return c.json({ logs });
});

/** Build the AI parse prompt for a task description */
function buildParsePrompt(description: string): string {
  const now = new Date();
  return `你是一个任务调度解析器。用户会用自然语言描述他们想要创建的定时任务，你需要解析出结构化的任务参数。

当前时间: ${now.toISOString()}
当前时区: ${TIMEZONE}

用户描述: "${description}"

请返回一个 JSON 对象（不要包含任何其他文字），包含以下字段：
- "prompt": string — 任务要执行的 prompt（精炼用户的意图，作为 Agent 的指令）
- "schedule_type": "cron" | "interval" | "once" — 调度类型
- "schedule_value": string — 调度值：
  - cron 类型: cron 表达式（推荐 5 段：分 时 日 月 周，也支持 6 段含秒）
  - interval 类型: 毫秒数字符串（如 "3600000" 表示 1 小时）
  - once 类型: ISO 8601 日期时间字符串
- "context_mode": "group" | "isolated" — 上下文模式（默认推荐 "isolated"，表示工作区内独立任务会话，不影响主会话）
- "summary": string — 用一句话解释你的理解（中文）

注意：
- cron 表达式中的时间为北京时间（UTC+8）
- 推荐使用 5 段格式：分 时 日 月 星期
- 支持特殊字符：*/n（步长）、a-b（范围）、a,b,c（列表）、L（最后）、W（工作日）、#（第N个）
- 支持预定义表达式：@daily, @hourly, @weekly, @monthly, @yearly
- "每天早上 9 点" → cron "0 9 * * *"
- "每小时" → interval "3600000"
- "每 30 分钟" → interval "1800000"
- "明天下午 3 点" → once，计算出具体的 ISO 时间
- "每周一早上 10 点" → cron "0 10 * * 1"
- "每月最后一天" → cron "0 0 L * *"
- "每 5 分钟" → cron "*/5 * * * *"

只返回 JSON，不要返回其他任何内容。`;
}

/** Parse AI response text into structured task params */
function parseAiResult(
  result: string,
  description: string,
): {
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  summary: string;
} | null {
  try {
    let jsonStr = result;
    const fenced = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) jsonStr = fenced[1].trim();
    const parsed = JSON.parse(jsonStr);
    return {
      prompt:
        typeof parsed.prompt === 'string' && parsed.prompt
          ? parsed.prompt
          : description,
      schedule_type: parsed.schedule_type || 'cron',
      schedule_value: parsed.schedule_value || '',
      summary: parsed.summary || '',
    };
  } catch {
    return null;
  }
}

/**
 * AI create: immediately create task in 'parsing' status, resolve schedule in background.
 */
tasksRoutes.post('/ai', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) {
    return c.json({ error: '请输入任务描述' }, 400);
  }
  if (description.length > MAX_TASK_PROMPT_LENGTH) {
    return c.json(
      {
        error: `任务描述不能超过 ${MAX_TASK_PROMPT_LENGTH} 个字符`,
        code: 'TASK_PROMPT_TOO_LONG',
      },
      400,
    );
  }
  const notifyChannels: string[] | null = body.notify_channels ?? null;

  // Optional user-supplied target workspace. If absent, fall back to the
  // user's home group for backward compatibility.
  const requestedChatJid =
    typeof body.chat_jid === 'string' && body.chat_jid ? body.chat_jid : null;
  const requestedContextMode =
    body.context_mode === 'group' || body.context_mode === 'isolated'
      ? (body.context_mode as 'group' | 'isolated')
      : null;

  let groupFolder: string;
  let chatJid: string;
  let sourceIsHost: boolean;

  if (requestedChatJid) {
    // User-selected workspace: run the same validation chain as POST /api/tasks
    // so the AI path cannot be used to bypass group-access / host-exec checks.
    const group = getRegisteredGroup(requestedChatJid);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for host execution mode' },
        403,
      );
    }
    groupFolder = group.folder;
    chatJid = requestedChatJid;
    sourceIsHost = isHostExecutionGroup(group);
  } else {
    const homeGroup = getUserHomeGroup(authUser.id);
    if (!homeGroup) return c.json({ error: 'Home group not found' }, 400);
    groupFolder = homeGroup.folder;
    chatJid = homeGroup.jid;
    const registered = getRegisteredGroup(homeGroup.jid);
    sourceIsHost = registered ? isHostExecutionGroup(registered) : false;
  }

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Inherit execution_mode from the resolved source workspace (same rule as
  // POST /api/tasks). Previously hard-coded to admin=host / member=container,
  // which would misattribute tasks whose target workspace is container-mode
  // even for admin, or vice-versa.
  const taskExecutionMode: 'host' | 'container' = sourceIsHost
    ? 'host'
    : 'container';

  // Create task immediately with 'parsing' status and description as prompt.
  // AI creation is the default UI path, so it must share the same atomic
  // capacity boundary as manual REST and Agent/MCP creation.
  const creation = createTaskWithinOwnerLimit(
    {
      id: taskId,
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: description,
      schedule_type: 'cron',
      schedule_value: '0 0 * * *', // placeholder, will be updated after parsing
      context_mode: requestedContextMode ?? 'isolated',
      execution_type: 'agent',
      execution_mode: taskExecutionMode,
      script_command: null,
      next_run: null,
      status: 'parsing',
      created_at: now,
      created_by: authUser.id,
      notify_channels: notifyChannels,
    },
    getSystemSettings().maxTasksPerUser,
  );
  if (creation.status === 'limit_reached') {
    return c.json(
      {
        error: `定时任务数量已达上限（${creation.limit}）。请先删除不再需要的任务。`,
        code: 'TASK_LIMIT_REACHED',
      },
      409,
    );
  }
  const parsingRevision = getTaskById(taskId)?.revision ?? 1;

  const updateParsedTask = (
    updates: Parameters<typeof updateTaskWithRevision>[2],
  ): boolean => {
    const mutation = updateTaskWithRevision(taskId, parsingRevision, updates);
    if (mutation.status === 'updated') return true;
    if (mutation.status === 'conflict') {
      logger.info(
        {
          taskId,
          expectedRevision: parsingRevision,
          currentRevision: mutation.task.revision,
        },
        'AI task parse result discarded because the task was edited',
      );
    }
    return false;
  };

  logger.info(
    { taskId, description: description.slice(0, 80) },
    'AI task created, parsing in background',
  );

  // Background: parse with SDK and update task
  void (async () => {
    try {
      const parsePrompt = buildParsePrompt(description);
      const model = process.env.RECALL_MODEL || undefined;
      const result = await sdkQuery(parsePrompt, { model, timeout: 60_000 });

      if (!result) {
        updateParsedTask({
          status: 'paused',
          prompt: description,
        });
        logger.warn({ taskId }, 'AI parse returned null, task paused');
        return;
      }

      const parsed = parseAiResult(result, description);
      if (!parsed || !parsed.schedule_value) {
        updateParsedTask({
          status: 'paused',
          prompt: description,
        });
        logger.warn({ taskId }, 'AI parse result invalid, task paused');
        return;
      }
      if (parsed.prompt.length > MAX_TASK_PROMPT_LENGTH) {
        updateParsedTask({
          status: 'paused',
          prompt: description,
        });
        logger.warn(
          {
            taskId,
            promptLength: parsed.prompt.length,
            maxPromptLength: MAX_TASK_PROMPT_LENGTH,
          },
          'AI parsed prompt exceeded the task prompt limit; task paused',
        );
        return;
      }

      // Compute next_run using the same validation as REST/MCP. This rejects
      // sub-minute cron schedules before the task can become active.
      let nextRun: string | null = null;
      try {
        if (!['cron', 'interval', 'once'].includes(parsed.schedule_type)) {
          throw new Error('Invalid schedule type');
        }
        nextRun = computeNextRunForSchedule(
          parsed.schedule_type as 'cron' | 'interval' | 'once',
          parsed.schedule_value,
        );
      } catch {
        // Invalid schedule, keep paused
        updateParsedTask({
          status: 'paused',
          prompt: parsed.prompt,
        });
        logger.warn(
          { taskId, scheduleValue: parsed.schedule_value },
          'AI parsed schedule invalid, task paused',
        );
        return;
      }

      if (
        !updateParsedTask({
          prompt: parsed.prompt,
          schedule_type: parsed.schedule_type as 'cron' | 'interval' | 'once',
          schedule_value: parsed.schedule_value,
          next_run: nextRun,
          status: 'active',
        })
      ) {
        return;
      }
      notifyTaskSchedulerChanged();

      logger.info(
        {
          taskId,
          scheduleType: parsed.schedule_type,
          scheduleValue: parsed.schedule_value,
        },
        'AI task parse complete, activated',
      );
    } catch (err) {
      logger.error({ taskId, err }, 'AI task background parse failed');
      updateParsedTask({ status: 'paused' });
    }
  })().catch((err) =>
    logger.error({ taskId, err }, 'Unhandled AI task parse error'),
  );

  return c.json({ success: true, taskId });
});

/**
 * Parse natural language task description (synchronous, kept for backward compat).
 */
tasksRoutes.post('/parse', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) {
    return c.json({ error: '请输入任务描述' }, 400);
  }

  try {
    const model = process.env.RECALL_MODEL || undefined;
    const result = await sdkQuery(buildParsePrompt(description), {
      model,
      timeout: 30_000,
    });

    if (!result) {
      return c.json({ error: 'AI 解析失败，请重试或切换到手动模式' }, 502);
    }

    const parsed = parseAiResult(result, description);
    if (!parsed) {
      return c.json({ error: 'AI 返回格式异常，请重试或切换到手动模式' }, 502);
    }

    return c.json({ success: true, parsed });
  } catch (err) {
    logger.warn({ err }, 'task-parse: failed to parse AI response');
    return c.json({ error: 'AI 返回格式异常，请重试或切换到手动模式' }, 502);
  }
});

export default tasksRoutes;
