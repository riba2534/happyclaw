import { create } from 'zustand';
import { api } from '../api/client';

export interface McpServer {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  syncedFromHost?: boolean;
  description?: string;
  addedAt: string;
}

interface SyncHostResult {
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
}

interface McpServersState {
  servers: McpServer[];
  loading: boolean;
  error: string | null;
  syncing: boolean;

  loadServers: () => Promise<void>;
  addServer: (server: {
    id: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    description?: string;
  }) => Promise<void>;
  updateServer: (id: string, updates: Partial<McpServer>) => Promise<void>;
  toggleServer: (id: string, enabled: boolean) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  syncHostServers: () => Promise<SyncHostResult>;
}

export const useMcpServersStore = create<McpServersState>((set, get) => ({
  servers: [],
  loading: false,
  error: null,
  syncing: false,

  loadServers: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ servers: McpServer[] }>('/api/mcp-servers');
      set({ servers: data.servers, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  addServer: async (server) => {
    try {
      await api.post('/api/mcp-servers', server);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  updateServer: async (id, updates) => {
    try {
      await api.patch(`/api/mcp-servers/${encodeURIComponent(id)}`, updates);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  toggleServer: async (id, enabled) => {
    try {
      await api.patch(`/api/mcp-servers/${encodeURIComponent(id)}`, { enabled });
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteServer: async (id) => {
    try {
      await api.delete(`/api/mcp-servers/${encodeURIComponent(id)}`);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  syncHostServers: async () => {
    set({ syncing: true, error: null });
    try {
      const result = await api.post<SyncHostResult>('/api/mcp-servers/sync-host', {});
      await get().loadServers();
      return result;
    } catch (err: any) {
      set({ error: err?.message || '同步失败，请稍后重试' });
      throw err;
    } finally {
      set({ syncing: false });
    }
  },
}));
