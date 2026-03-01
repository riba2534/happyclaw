import { create } from 'zustand';
import { api } from '../api/client';

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
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result?: string | null;
  error?: string | null;
}

interface TasksState {
  tasks: ScheduledTask[];
  logs: Record<string, TaskRunLog[]>;
  loading: boolean;
  error: string | null;
  loadTasks: () => Promise<void>;
  createTask: (
    groupFolder: string,
    chatJid: string,
    prompt: string,
    scheduleType: 'cron' | 'interval' | 'once',
    scheduleValue: string,
    contextMode: 'group' | 'isolated',
    executionType?: 'agent' | 'script',
    scriptCommand?: string,
  ) => Promise<void>;
  updateTaskStatus: (id: string, status: 'active' | 'paused') => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  loadLogs: (taskId: string) => Promise<void>;
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

  loadTasks: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ tasks: ScheduledTask[] }>('/api/tasks');
      set({ tasks: data.tasks, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  createTask: async (
    groupFolder: string,
    chatJid: string,
    prompt: string,
    scheduleType: 'cron' | 'interval' | 'once',
    scheduleValue: string,
    contextMode: 'group' | 'isolated',
    executionType?: 'agent' | 'script',
    scriptCommand?: string,
  ) => {
    try {
      const normalizedScheduleValue =
        scheduleType === 'once'
          ? normalizeOnceScheduleValue(scheduleValue)
          : scheduleValue.trim();

      const body: Record<string, unknown> = {
        group_folder: groupFolder,
        chat_jid: chatJid,
        prompt: prompt.trim(),
        schedule_type: scheduleType,
        schedule_value: normalizedScheduleValue,
        context_mode: contextMode,
      };
      if (executionType) {
        body.execution_type = executionType;
      }
      if (scriptCommand) {
        body.script_command = scriptCommand;
      }
      await api.post('/api/tasks', body);
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  updateTaskStatus: async (id: string, status: 'active' | 'paused') => {
    try {
      await api.patch(`/api/tasks/${id}`, { status });
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteTask: async (id: string) => {
    try {
      await api.delete(`/api/tasks/${id}`);
      set({ error: null });
      await get().loadTasks();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadLogs: async (taskId: string) => {
    try {
      const data = await api.get<{ logs: TaskRunLog[] }>(`/api/tasks/${taskId}/logs`);
      set((s) => ({
        logs: { ...s.logs, [taskId]: data.logs },
        error: null,
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
