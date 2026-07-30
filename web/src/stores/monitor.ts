import { create } from 'zustand';
import { api } from '../api/client';

export interface SystemStatus {
  activeContainers: number;
  activeHostProcesses?: number;
  activeTotal?: number;
  maxConcurrentContainers: number;
  queueLength: number;
  uptime: number;
  dockerImageExists: boolean;
  dockerPullInProgress?: boolean;
  claudeCodeVersions?: {
    host: string | null;
    container: string | null;
    latest: string | null;
  } | null;
  dockerPullLogs?: string[];
  dockerPullResult?: { success: boolean; error?: string } | null;
  groups: Array<{
    jid: string;
    active: boolean;
    pendingMessages: boolean;
    pendingTasks: number;
    containerName: string | null;
    displayName: string | null;
    groupFolder: string | null;
    ownerUsername: string | null;
    selectedProviderId: string | null;
    selectedProviderName: string | null;
  }>;
}

interface MonitorState {
  status: SystemStatus | null;
  loading: boolean;
  error: string | null;
  pulling: boolean;
  pullLogs: string[];
  pullResult: {
    success: boolean;
    error?: string;
    stdout?: string;
    stderr?: string;
  } | null;
  loadStatus: () => Promise<void>;
  pullDockerImage: () => Promise<void>;
  clearPullResult: () => void;
  switchProvider: (
    folder: string,
    providerId: string,
  ) => Promise<{ ok: boolean; restarted: boolean }>;
}

export const useMonitorStore = create<MonitorState>((set) => ({
  status: null,
  loading: false,
  error: null,
  pulling: false,
  pullLogs: [],
  pullResult: null,

  loadStatus: async () => {
    set({ loading: true });
    try {
      const status = await api.get<SystemStatus>('/api/status');
      const update: Partial<MonitorState> = {
        status,
        loading: false,
        error: null,
      };
      const state = useMonitorStore.getState();
      if (status.dockerPullInProgress && !state.pulling) {
        // 后端正在拉取，但前端不知道（页面刷新后恢复）
        update.pulling = true;
        // 恢复日志（仅当本地无日志时）
        if (
          state.pullLogs.length === 0 &&
          status.dockerPullLogs &&
          status.dockerPullLogs.length > 0
        ) {
          update.pullLogs = status.dockerPullLogs;
        }
      } else if (!status.dockerPullInProgress && state.pulling) {
        // 后端拉取已结束，同步重置
        update.pulling = false;
        // 恢复结果
        if (status.dockerPullResult) {
          update.pullResult = status.dockerPullResult;
        }
      }
      set(update);
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  pullDockerImage: async () => {
    set({ pulling: true, pullLogs: [], pullResult: null });
    try {
      await api.post('/api/docker/pull', {});
      // POST returns 202 immediately; progress comes via WebSocket
    } catch (err) {
      set({
        pulling: false,
        pullResult: {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },

  clearPullResult: () => set({ pullResult: null, pullLogs: [] }),

  switchProvider: async (folder: string, providerId: string) => {
    const res = await api.post<{ ok: boolean; restarted: boolean }>(
      `/api/status/groups/${encodeURIComponent(folder)}/switch-provider`,
      { providerId },
    );
    return res;
  },
}));
