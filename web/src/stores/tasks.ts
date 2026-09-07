import { create } from 'zustand';
import { api } from '../api/client';
import { extractErrorMessage } from '../utils/error';
import {
  acknowledgeTaskRunKey,
  getPendingTaskRunKey,
} from '../utils/task-run-idempotency';
import { useAuthStore } from './auth';

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  execution_type?: 'agent' | 'script';
  script_command?: string | null;
  next_run: string | null;
  last_run?: string | null;
  last_result?: string | null;
  status: 'active' | 'paused' | 'completed' | 'parsing';
  created_at: string;
  notify_channels?: string[] | null;
  execution_mode?: 'host' | 'container' | null;
  workspace_jid?: string | null;
  workspace_folder?: string | null;
  revision?: number;
  updated_at?: string;
  deleted_at?: string | null;
  current_run?: TaskRun | null;
  last_run_summary?: TaskRun | null;
  permissions?: TaskPermissions;
}

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'recovering'
  | 'retry_wait'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'missed'
  | 'delivered'
  // Legacy task_run_logs compatibility.
  | 'error';

export type TaskRunTrigger = 'scheduled' | 'manual' | 'backfill' | 'retry';

export type TaskNotificationStatus =
  | 'pending'
  | 'success'
  | 'partial_failed'
  | 'failed'
  | 'uncertain'
  | 'skipped';

export interface TaskNotificationSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  failed_channels: string[];
  uncertain?: number;
  uncertain_channels?: string[];
}

export interface TaskPermissions {
  can_edit: boolean;
  can_run: boolean;
  can_pause: boolean;
  can_stop: boolean;
  can_delete: boolean;
  can_restore: boolean;
  can_purge: boolean;
  execution_scope: 'workspace_container' | 'workspace_host';
  risk_level: 'normal' | 'high';
  execution_blocked_reason?: string | null;
}

export interface TaskRun {
  id: string | number;
  task_id: string;
  trigger_type?: TaskRunTrigger;
  scheduled_for?: string | null;
  status: TaskRunStatus;
  attempt?: number;
  available_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
  run_at?: string;
  duration_ms: number;
  result?: string | null;
  error?: string | null;
  notification_status?: TaskNotificationStatus;
  notification_error?: string | null;
  notification_summary?: TaskNotificationSummary | null;
  notification_attempt?: number;
  notification_available_at?: string | null;
  definition_snapshot?: {
    prompt: string;
    group_folder: string;
    chat_jid: string;
    context_mode: 'group' | 'isolated';
    execution_type: 'agent' | 'script';
    execution_mode: 'host' | 'container' | null;
    script_command: string | null;
    notify_channels: string[] | null;
  };
}

export type TaskRunLog = TaskRun;

interface TasksState {
  tasks: ScheduledTask[];
  logs: Record<string, TaskRunLog[]>;
  loading: boolean;
  error: string | null;
  runningTaskIds: Set<string>;
  groupNames: Record<string, string>;
  loadTasks: () => Promise<void>;
  createTask: (
    prompt: string,
    scheduleType: 'cron' | 'interval' | 'once',
    scheduleValue: string,
    executionType?: 'agent' | 'script',
    executionMode?: 'host' | 'container',
    scriptCommand?: string,
    notifyChannels?: string[] | null,
    chatJid?: string,
    contextMode?: 'group' | 'isolated',
  ) => Promise<void>;
  updateTaskStatus: (id: string, status: 'active' | 'paused') => Promise<void>;
  updateTask: (id: string, fields: Record<string, unknown>) => Promise<void>;
  deleteTask: (id: string, revision?: number) => Promise<void>;
  restoreTask: (id: string, revision?: number) => Promise<void>;
  purgeTasks: (ids: string[]) => Promise<number>;
  loadLogs: (taskId: string) => Promise<void>;
  runTaskNow: (id: string, idempotencyKey?: string) => Promise<TaskRun>;
  stopTaskRun: (runId: string | number) => Promise<void>;
}

function normalizeOnceScheduleValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return new Date(parsed).toISOString();
  }
  return new Date(trimmed).toISOString();
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  logs: {},
  loading: false,
  error: null,
  runningTaskIds: new Set<string>(),
  groupNames: {},

  loadTasks: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        tasks: ScheduledTask[];
        runningTaskIds?: string[];
        groupNames?: Record<string, string>;
      }>('/api/tasks?include_deleted=1');
      set({
        tasks: data.tasks,
        runningTaskIds: new Set(data.runningTaskIds || []),
        groupNames: data.groupNames || {},
        loading: false,
        error: null,
      });
    } catch (err) {
      set({ loading: false, error: extractErrorMessage(err) });
    }
  },

  createTask: async (
    prompt: string,
    scheduleType: 'cron' | 'interval' | 'once',
    scheduleValue: string,
    executionType?: 'agent' | 'script',
    executionMode?: 'host' | 'container',
    scriptCommand?: string,
    notifyChannels?: string[] | null,
    chatJid?: string,
    contextMode?: 'group' | 'isolated',
  ) => {
    try {
      const normalizedScheduleValue =
        scheduleType === 'once'
          ? normalizeOnceScheduleValue(scheduleValue)
          : scheduleValue.trim();

      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        schedule_type: scheduleType,
        schedule_value: normalizedScheduleValue,
      };
      if (executionType) {
        body.execution_type = executionType;
      }
      if (executionMode) {
        body.execution_mode = executionMode;
      }
      if (scriptCommand) {
        body.script_command = scriptCommand;
      }
      if (notifyChannels !== undefined) {
        body.notify_channels = notifyChannels;
      }
      if (chatJid) {
        body.chat_jid = chatJid;
      }
      if (contextMode) {
        body.context_mode = contextMode;
      }
      await api.post('/api/tasks', body);
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  updateTaskStatus: async (id: string, status: 'active' | 'paused') => {
    try {
      const task = get().tasks.find((candidate) => candidate.id === id);
      await api.patch(`/api/tasks/${id}`, {
        status,
        expected_revision: task?.revision,
      });
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  updateTask: async (id: string, fields: Record<string, unknown>) => {
    try {
      const task = get().tasks.find((candidate) => candidate.id === id);
      await api.patch(`/api/tasks/${id}`, {
        ...fields,
        expected_revision: task?.revision,
      });
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      // Re-throw so callers (TaskDetail.handleSave) can distinguish failure from
      // success — otherwise a failed save still shows "保存成功".
      throw err;
    }
  },

  deleteTask: async (id: string, revision?: number) => {
    try {
      const task = get().tasks.find((candidate) => candidate.id === id);
      const expectedRevision = revision ?? task?.revision;
      const query =
        expectedRevision === undefined
          ? ''
          : `?expected_revision=${encodeURIComponent(expectedRevision)}`;
      await api.delete(`/api/tasks/${id}${query}`);
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  restoreTask: async (id: string, revision?: number) => {
    try {
      const task = get().tasks.find((candidate) => candidate.id === id);
      await api.post(`/api/tasks/${id}/restore`, {
        expected_revision: revision ?? task?.revision,
      });
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  purgeTasks: async (ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) return 0;
    try {
      const tasksById = new Map(get().tasks.map((task) => [task.id, task]));
      const requestedTasks = uniqueIds.map((id) => {
        const task = tasksById.get(id);
        if (!task?.deleted_at || !task.revision) {
          throw new Error('任务状态已经变化，请刷新后重试。');
        }
        return { id, expected_revision: task.revision };
      });
      const data = await api.post<{ deleted_count: number }>(
        '/api/tasks/purge',
        { tasks: requestedTasks },
      );
      set({ error: null });
      await get().loadTasks();
      return data.deleted_count;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  loadLogs: async (taskId: string) => {
    try {
      const data = await api.get<{ runs?: TaskRunLog[]; logs?: TaskRunLog[] }>(
        `/api/tasks/${taskId}/runs?limit=20`,
      );
      set((s) => ({
        logs: { ...s.logs, [taskId]: data.runs ?? data.logs ?? [] },
        error: null,
      }));
    } catch (err) {
      set({ error: extractErrorMessage(err) });
    }
  },

  runTaskNow: async (id: string, idempotencyKey?: string) => {
    try {
      const userId = useAuthStore.getState().user?.id ?? 'anonymous';
      const key = idempotencyKey ?? getPendingTaskRunKey(userId, id);
      const data = await api.post<{ run?: TaskRun; runId?: string }>(
        `/api/tasks/${id}/runs`,
        { idempotency_key: key },
      );
      set({ error: null });
      acknowledgeTaskRunKey(userId, id, key);
      await get().loadTasks();
      if (data.run) return data.run;
      return {
        id: data.runId ?? key,
        task_id: id,
        trigger_type: 'manual',
        status: 'queued',
        duration_ms: 0,
      };
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  stopTaskRun: async (runId: string | number) => {
    try {
      await api.post(`/api/tasks/runs/${runId}/cancel`);
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },
}));
