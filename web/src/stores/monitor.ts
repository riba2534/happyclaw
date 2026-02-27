import { create } from 'zustand';
import { api } from '../api/client';

export interface SystemStatus {
  activeContainers: number;
  activeHostProcesses?: number;
  activeTotal?: number;
  maxConcurrentContainers: number;
  maxConcurrentHostProcesses?: number;
  queueLength: number;
  uptime: number;
  dockerImageExists: boolean;
  dockerBuildInProgress?: boolean;
  claudeCodeVersion?: string | null;
  dockerBuildLogs?: string[];
  dockerBuildResult?: { success: boolean; error?: string } | null;
  groups: Array<{
    jid: string;
    active: boolean;
    pendingMessages: boolean;
    pendingTasks: number;
    containerName: string | null;
    displayName: string | null;
  }>;
}

interface MonitorState {
  status: SystemStatus | null;
  loading: boolean;
  error: string | null;
  building: boolean;
  buildLogs: string[];
  buildResult: { success: boolean; error?: string; stdout?: string; stderr?: string } | null;
  loadStatus: () => Promise<void>;
  buildDockerImage: () => Promise<void>;
  clearBuildResult: () => void;
}

export const useMonitorStore = create<MonitorState>((set) => ({
  status: null,
  loading: false,
  error: null,
  building: false,
  buildLogs: [],
  buildResult: null,

  loadStatus: async () => {
    set({ loading: true });
    try {
      const status = await api.get<SystemStatus>('/api/status');
      const update: Partial<MonitorState> = { status, loading: false, error: null };
      const state = useMonitorStore.getState();
      if (status.dockerBuildInProgress && !state.building) {
        // 后端正在构建，但前端不知道（页面刷新后恢复）
        update.building = true;
        // 恢复日志（仅当本地无日志时）
        if (state.buildLogs.length === 0 && status.dockerBuildLogs && status.dockerBuildLogs.length > 0) {
          update.buildLogs = status.dockerBuildLogs;
        }
      } else if (!status.dockerBuildInProgress && state.building) {
        // 后端构建已结束，同步重置
        update.building = false;
        // 恢复结果
        if (status.dockerBuildResult) {
          update.buildResult = status.dockerBuildResult;
        }
      }
      set(update);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  buildDockerImage: async () => {
    set({ building: true, buildLogs: [], buildResult: null });
    try {
      await api.post('/api/docker/build', {});
      // POST returns 202 immediately; progress comes via WebSocket
    } catch (err) {
      set({
        building: false,
        buildResult: {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },

  clearBuildResult: () => set({ buildResult: null, buildLogs: [] }),
}));
