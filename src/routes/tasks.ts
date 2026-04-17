// Task management routes

import { Hono } from 'hono';
import * as crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { sdkQuery } from '../sdk-query.js';
import { GROUPS_DIR } from '../config.js';
import { removeFlowArtifacts } from '../file-manager.js';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { TaskCreateSchema, TaskPatchSchema } from '../schemas.js';
import { logger } from '../logger.js';
import {
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  getTaskRunLogs,
  getRegisteredGroup,
  getAllRegisteredGroups,
  getUserHomeGroup,
  deleteGroupData,
} from '../db.js';
import type { AuthUser } from '../types.js';
import { TIMEZONE } from '../config.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
  getWebDeps,
} from '../web-context.js';
import { getRunningTaskIds } from '../task-scheduler.js';
import { getChannelType, extractChatId } from '../im-channel.js';

const tasksRoutes = new Hono<{ Variables: Variables }>();

// --- Routes ---

tasksRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const allGroups = getAllRegisteredGroups();
  const tasks = getAllTasks().filter((task) => {
    // Host-mode tasks are only visible to admin
    if (task.execution_mode === 'host' && authUser.role !== 'admin') {
      return false;
    }
    const group = allGroups[task.chat_jid];
    // Conservative: if group can't be resolved, only admin can see (may be orphaned task)
    if (!group) return authUser.role === 'admin';
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, { ...group, jid: task.chat_jid }))
      return false;
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser))
      return false;
    return true;
  });
  const visibleTaskIds = new Set(tasks.map((t) => t.id));
  const filteredRunningIds = getRunningTaskIds().filter((id) => visibleTaskIds.has(id));

  // Build jid → name mapping for all registered groups (including IM channels).
  // Mirror the visibility rule used by GET /api/groups (src/routes/groups.ts:190-192):
  // non-admins must not see host workspaces in the task-target dropdown, even
  // though POST /api/tasks would reject them with 403 — rendering them here
  // would be a misleading UI affordance. Authorization is still enforced on
  // write; this filter is purely for surface consistency.
  const groupNames: Record<string, string> = {};
  for (const [jid, group] of Object.entries(allGroups)) {
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, { ...group, jid })) continue;
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) continue;
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

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  let nextRun: string;
  if (schedule_type === 'cron') {
    try {
      const cronNext = CronExpressionParser.parse(schedule_value, { tz: TIMEZONE })
        .next()
        .toISOString();
      if (!cronNext) {
        return c.json({ error: 'Cron expression produced no next run time' }, 400);
      }
      nextRun = cronNext;
    } catch {
      return c.json({ error: 'Invalid cron expression' }, 400);
    }
  } else if (schedule_type === 'interval') {
    nextRun = new Date(Date.now() + Number(schedule_value)).toISOString();
  } else {
    // once — use the target time from schedule_value
    nextRun = new Date(schedule_value).toISOString();
  }

  createTask({
    id: taskId,
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: prompt || '',
    schedule_type,
    schedule_value,
    context_mode: validation.data.context_mode || 'group',
    execution_type: execType,
    execution_mode: taskExecutionMode,
    script_command: script_command ?? null,
    next_run: nextRun,
    status: 'active',
    created_at: now,
    created_by: authUser.id,
    notify_channels: notify_channels ?? null,
  });

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

  const validation = TaskPatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Only admin can create/modify script tasks
  const isScriptTask =
    validation.data.execution_type === 'script' ||
    (existing.execution_type === 'script' &&
      validation.data.script_command !== undefined);
  if (isScriptTask && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以创建或修改脚本类型任务' }, 403);
  }

  // Only admin can set execution_mode to 'host'
  if (validation.data.execution_mode === 'host' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以设置宿主机执行模式' }, 403);
  }

  // Validate chat_jid if being changed
  const patchData = { ...validation.data } as typeof validation.data & { group_folder?: string };
  let effectiveTargetGroup: ReturnType<typeof getRegisteredGroup> = group;
  if (validation.data.chat_jid !== undefined) {
    const targetGroup = getRegisteredGroup(validation.data.chat_jid);
    if (!targetGroup) {
      return c.json({ error: '目标群组不存在' }, 404);
    }
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, targetGroup)) {
      return c.json({ error: '无权访问目标群组' }, 403);
    }
    // Keep group_folder in sync with chat_jid
    patchData.group_folder = targetGroup.folder;
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

  // Auto-recalculate next_run when schedule changes (avoid pulling cron-parser into frontend)
  if (patchData.schedule_type !== undefined || patchData.schedule_value !== undefined) {
    const schedType = patchData.schedule_type ?? existing.schedule_type;
    const schedValue = patchData.schedule_value ?? existing.schedule_value;
    try {
      if (schedType === 'cron') {
        patchData.next_run = CronExpressionParser.parse(schedValue, { tz: TIMEZONE })
          .next()
          .toISOString() || new Date().toISOString();
      } else if (schedType === 'interval') {
        const ms = parseInt(schedValue, 10);
        if (!Number.isFinite(ms) || ms <= 0) {
          return c.json({ error: 'Invalid interval value' }, 400);
        }
        patchData.next_run = new Date(Date.now() + ms).toISOString();
      } else if (schedType === 'once') {
        const ts = Date.parse(schedValue);
        if (isNaN(ts)) {
          return c.json({ error: 'Invalid once schedule value' }, 400);
        }
        patchData.next_run = new Date(ts).toISOString();
      }
    } catch {
      return c.json({ error: 'Invalid schedule value for the given schedule type' }, 400);
    }
  }

  updateTask(id, patchData);

  return c.json({ success: true });
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

  // Prevent deleting a running task
  if (getRunningTaskIds().includes(id)) {
    return c.json({ error: '任务正在运行中，请先等待完成或停止任务' }, 409);
  }

  // Clean up dedicated workspace if exists
  if (existing.workspace_jid && existing.workspace_folder) {
    const wsGroup = getRegisteredGroup(existing.workspace_jid);
    if (wsGroup) {
      deleteGroupData(existing.workspace_jid, existing.workspace_folder);
    }
    // Remove all flow artifacts (groups/, sessions/, ipc/, env/, memory/)
    removeFlowArtifacts(existing.workspace_folder);
    const deps = getWebDeps();
    if (deps) {
      delete deps.getRegisteredGroups()[existing.workspace_jid];
      delete deps.getSessions()[existing.workspace_folder];
    }
    logger.info(
      {
        taskId: id,
        workspaceJid: existing.workspace_jid,
        workspaceFolder: existing.workspace_folder,
      },
      'Task workspace deleted',
    );
  }

  deleteTask(id);
  return c.json({ success: true });
});

tasksRoutes.post('/:id/run', authMiddleware, (c) => {
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

  const deps = getWebDeps();
  if (!deps?.triggerTaskRun)
    return c.json({ error: 'Scheduler not available' }, 503);

  const result = deps.triggerTaskRun(id);
  if (!result.success) return c.json({ error: result.error }, 409);

  return c.json({ success: true });
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
- "context_mode": "group" | "isolated" — 上下文模式（大多数情况推荐 "group"）
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
): { prompt: string; schedule_type: string; schedule_value: string; summary: string } | null {
  try {
    let jsonStr = result;
    const fenced = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) jsonStr = fenced[1].trim();
    const parsed = JSON.parse(jsonStr);
    return {
      prompt: parsed.prompt || description,
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
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) {
    return c.json({ error: '请输入任务描述' }, 400);
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

  // Create task immediately with 'parsing' status and description as prompt
  createTask({
    id: taskId,
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: description,
    schedule_type: 'cron',
    schedule_value: '0 0 * * *', // placeholder, will be updated after parsing
    context_mode: requestedContextMode ?? 'group',
    execution_type: 'agent',
    execution_mode: taskExecutionMode,
    script_command: null,
    next_run: null,
    status: 'parsing',
    created_at: now,
    created_by: authUser.id,
    notify_channels: notifyChannels,
  });

  logger.info({ taskId, description: description.slice(0, 80) }, 'AI task created, parsing in background');

  // Background: parse with SDK and update task
  void (async () => {
    try {
      const parsePrompt = buildParsePrompt(description);
      const model = process.env.RECALL_MODEL || undefined;
      const result = await sdkQuery(parsePrompt, { model, timeout: 60_000 });

      if (!result) {
        const cur = getTaskById(taskId);
        if (!cur || cur.status !== 'parsing') return;
        updateTask(taskId, {
          status: 'paused',
          prompt: description,
        });
        logger.warn({ taskId }, 'AI parse returned null, task paused');
        return;
      }

      const parsed = parseAiResult(result, description);
      if (!parsed || !parsed.schedule_value) {
        const cur = getTaskById(taskId);
        if (!cur || cur.status !== 'parsing') return;
        updateTask(taskId, {
          status: 'paused',
          prompt: description,
        });
        logger.warn({ taskId }, 'AI parse result invalid, task paused');
        return;
      }

      // Compute next_run from parsed schedule
      let nextRun: string | null = null;
      try {
        if (parsed.schedule_type === 'cron') {
          nextRun = CronExpressionParser.parse(parsed.schedule_value, { tz: TIMEZONE })
            .next()
            .toISOString();
        } else if (parsed.schedule_type === 'interval') {
          nextRun = new Date(Date.now() + Number(parsed.schedule_value)).toISOString();
        } else {
          nextRun = new Date(parsed.schedule_value).toISOString();
        }
      } catch {
        // Invalid schedule, keep paused
        const cur = getTaskById(taskId);
        if (!cur || cur.status !== 'parsing') return;
        updateTask(taskId, {
          status: 'paused',
          prompt: parsed.prompt,
        });
        logger.warn({ taskId, scheduleValue: parsed.schedule_value }, 'AI parsed schedule invalid, task paused');
        return;
      }

      const cur = getTaskById(taskId);
      if (!cur || cur.status !== 'parsing') return;
      updateTask(taskId, {
        prompt: parsed.prompt,
        schedule_type: parsed.schedule_type as 'cron' | 'interval' | 'once',
        schedule_value: parsed.schedule_value,
        next_run: nextRun,
        status: 'active',
      });

      logger.info(
        { taskId, scheduleType: parsed.schedule_type, scheduleValue: parsed.schedule_value },
        'AI task parse complete, activated',
      );
    } catch (err) {
      logger.error({ taskId, err }, 'AI task background parse failed');
      const cur = getTaskById(taskId);
      if (cur && cur.status === 'parsing') {
        updateTask(taskId, { status: 'paused' });
      }
    }
  })().catch((err) => logger.error({ taskId, err }, 'Unhandled AI task parse error'));

  return c.json({ success: true, taskId });
});

/**
 * Parse natural language task description (synchronous, kept for backward compat).
 */
tasksRoutes.post('/parse', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) {
    return c.json({ error: '请输入任务描述' }, 400);
  }

  try {
    const model = process.env.RECALL_MODEL || undefined;
    const result = await sdkQuery(buildParsePrompt(description), { model, timeout: 30_000 });

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
