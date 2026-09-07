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
  dockerRequired?: boolean;
  adminHostOnlyMode?: boolean;
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

export interface OutboxItem {
  id: string;
  turnRunId: string;
  kind: 'text' | 'image' | 'file';
  ordinal: number;
  revision: number;
  status: string;
  attempt: number;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string | null;
  providerMessageId?: string | null;
  ageMs: number;
  ageSeconds: number;
  ageFormatted: string;
  isOverdue: boolean;
  route: {
    provider: string;
    accountId: string;
    botName?: string | null;
    sourceJid: string;
    chatId?: string | null;
    rootId?: string | null;
    threadId?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    groupFolder?: string | null;
    groupName?: string | null;
    navigationUrl?: string | null;
  };
}

export interface OutboxSummary {
  total: number;
  pending: number;
  retryWait: number;
  claimed: number;
  uncertain: number;
  failed: number;
  delivered: number;
  overdue: number;
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
  outboxSummary: OutboxSummary | null;
  outboxItems: OutboxItem[];
  outboxLoading: boolean;
  loadStatus: () => Promise<void>;
  loadOutbox: (filter?: {
    status?: string;
    overdueOnly?: boolean;
  }) => Promise<void>;
  resolveOutbox: (
    id: string,
    params: {
      resolution: 'delivered' | 'failed';
      expectedRevision: number;
      providerMessageId?: string;
      error?: string;
    },
  ) => Promise<{ ok: boolean; impact?: any }>;
  pullDockerImage: () => Promise<void>;
  clearPullResult: () => void;
}

export const useMonitorStore = create<MonitorState>((set) => ({
  status: null,
  loading: false,
  error: null,
  pulling: false,
  pullLogs: [],
  pullResult: null,
  outboxSummary: null,
  outboxItems: [],
  outboxLoading: false,

  loadOutbox: async (filter) => {
    set({ outboxLoading: true });
    try {
      const params = new URLSearchParams();
      if (filter?.status) params.set('status', filter.status);
      if (filter?.overdueOnly) params.set('overdueOnly', 'true');
      const query = params.toString() ? `?${params.toString()}` : '';
      const res = await api.get<{
        summary: OutboxSummary;
        items: OutboxItem[];
        total: number;
      }>(`/api/status/channel-outbox${query}`);
      set({
        outboxSummary: res.summary,
        outboxItems: res.items,
        outboxLoading: false,
      });
    } catch {
      set({ outboxLoading: false });
    }
  },

  resolveOutbox: async (id, params) => {
    const res = await api.post<{ ok: boolean; impact?: any }>(
      `/api/status/channel-outbox/${id}/resolve`,
      params,
    );
    return res;
  },

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
}));
