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
  /** 本地是否有正在飞行的构建请求（区分从后端恢复的状态） */
  _localBuildInFlight: boolean;
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
  _localBuildInFlight: false,
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
      } else if (!status.dockerBuildInProgress && state.building && !state._localBuildInFlight) {
        // 后端构建已结束，且本地没有飞行中的请求（是从后端恢复的状态），同步重置
        update.building = false;
      }
      set(update);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  buildDockerImage: async () => {
    set({ building: true, _localBuildInFlight: true, buildResult: null });
    try {
      const result = await api.post<{ success: boolean; error?: string; stdout?: string; stderr?: string }>(
        '/api/docker/build',
        {},
        10 * 60 * 1000, // 10 分钟超时
      );
      set({ building: false, _localBuildInFlight: false, buildResult: result });
    } catch (err) {
      set({
        building: false,
        _localBuildInFlight: false,
        buildResult: {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },

  clearBuildResult: () => set({ buildResult: null }),
}));
