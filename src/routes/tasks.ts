// Task management routes

import { Hono } from 'hono';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { CronExpressionParser } from 'cron-parser';
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

const tasksRoutes = new Hono<{ Variables: Variables }>();

// --- Routes ---

tasksRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const allGroups = getAllRegisteredGroups();
  const tasks = getAllTasks().filter((task) => {
    const group = allGroups[task.chat_jid];
    // Conservative: if group can't be resolved, only admin can see (may be orphaned task)
    if (!group) return authUser.role === 'admin';
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, { ...group, jid: task.chat_jid }))
      return false;
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser))
      return false;
    return true;
  });
  return c.json({ tasks, runningTaskIds: getRunningTaskIds() });
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
    group_folder,
    chat_jid,
    prompt,
    schedule_type,
    schedule_value,
    context_mode,
    execution_type,
    script_command,
    notify_channels,
  } = validation.data;
  const group = getRegisteredGroup(chat_jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (group.folder !== group_folder) {
    return c.json(
      { error: 'group_folder does not match chat_jid group folder' },
      400,
    );
  }
  const authUser = c.get('user') as AuthUser;
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

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  let nextRun: string;
  if (schedule_type === 'cron') {
    nextRun =
      CronExpressionParser.parse(schedule_value, { tz: TIMEZONE })
        .next()
        .toISOString() ?? new Date().toISOString();
  } else if (schedule_type === 'interval') {
    nextRun = new Date(Date.now() + parseInt(schedule_value, 10)).toISOString();
  } else {
    // once — use the target time from schedule_value
    nextRun = new Date(schedule_value).toISOString();
  }

  createTask({
    id: taskId,
    group_folder,
    chat_jid,
    prompt: prompt || '',
    schedule_type,
    schedule_value,
    context_mode: context_mode || 'isolated',
    execution_type: execType,
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

  // Auto-recalculate next_run when schedule changes (avoid pulling cron-parser into frontend)
  const patchData = { ...validation.data };
  if (patchData.schedule_type !== undefined || patchData.schedule_value !== undefined) {
    const schedType = patchData.schedule_type ?? existing.schedule_type;
    const schedValue = patchData.schedule_value ?? existing.schedule_value;
    try {
      if (schedType === 'cron') {
        patchData.next_run = CronExpressionParser.parse(schedValue, { tz: TIMEZONE })
          .next()
          .toISOString() ?? new Date().toISOString();
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

/**
 * Parse natural language task description into structured task parameters using Claude CLI.
 */
tasksRoutes.post('/parse', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) {
    return c.json({ error: '请输入任务描述' }, 400);
  }

  const now = new Date();
  const tzOffset = TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const prompt = `你是一个任务调度解析器。用户会用自然语言描述他们想要创建的定时任务，你需要解析出结构化的任务参数。

当前时间: ${now.toISOString()}
当前时区: ${tzOffset}

用户描述: "${description}"

请返回一个 JSON 对象（不要包含任何其他文字），包含以下字段：
- "prompt": string — 任务要执行的 prompt（精炼用户的意图，作为 Agent 的指令）
- "schedule_type": "cron" | "interval" | "once" — 调度类型
- "schedule_value": string — 调度值：
  - cron 类型: cron 表达式（5 段，如 "0 9 * * *"）
  - interval 类型: 毫秒数字符串（如 "3600000" 表示 1 小时）
  - once 类型: ISO 8601 日期时间字符串
- "context_mode": "group" | "isolated" — 上下文模式（大多数情况推荐 "isolated"）
- "summary": string — 用一句话解释你的理解（中文）

注意：
- cron 表达式使用 5 段格式：分 时 日 月 星期
- "每天早上 9 点" → cron "0 9 * * *"
- "每小时" → interval "3600000"
- "每 30 分钟" → interval "1800000"
- "明天下午 3 点" → once，计算出具体的 ISO 时间
- "每周一早上 10 点" → cron "0 10 * * 1"

只返回 JSON，不要返回其他任何内容。`;

  try {
    const result = await new Promise<string | null>((resolve) => {
      const model = process.env.RECALL_MODEL || '';
      const args = ['--print'];
      if (model) args.push('--model', model);

      const child = execFile(
        'claude',
        args,
        {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, CLAUDECODE: '' },
        },
        (err, stdout, stderr) => {
          if (err) {
            logger.warn(
              { err: (err as Error).message?.slice(0, 200), stderr: stderr?.slice(0, 300) },
              'task-parse: Claude CLI failed',
            );
            resolve(null);
            return;
          }
          resolve(stdout.trim() || null);
        },
      );
      child.stdin?.write(prompt);
      child.stdin?.end();
    });

    if (!result) {
      return c.json({ error: 'AI 解析失败，请重试或切换到手动模式' }, 502);
    }

    // Extract JSON from response (may be wrapped in ```json ... ```)
    let jsonStr = result;
    const fenced = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) jsonStr = fenced[1].trim();

    const parsed = JSON.parse(jsonStr);
    return c.json({
      success: true,
      parsed: {
        prompt: parsed.prompt || description,
        schedule_type: parsed.schedule_type || 'cron',
        schedule_value: parsed.schedule_value || '',
        context_mode: parsed.context_mode || 'isolated',
        summary: parsed.summary || '',
      },
    });
  } catch (err) {
    logger.warn({ err }, 'task-parse: failed to parse AI response');
    return c.json({ error: 'AI 返回格式异常，请重试或切换到手动模式' }, 502);
  }
});

export default tasksRoutes;
