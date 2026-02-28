import { create } from 'zustand';
import { api } from '../api/client';

export interface ScriptProcess {
  id: string;
  name: string;
  description: string | null;
  scriptPath: string | null;
  processManager: 'pm2' | 'systemd' | 'manual';
  pm2Name: string | null;
  startCommand: string | null;
  stopCommand: string | null;
  checkCommand: string | null;
  groupFolder: string;
  createdAt: string;
  status: 'online' | 'stopped' | 'errored' | 'registered' | 'unknown' | string;
  pid: number | null;
  cpu: number | null;
  memory: number | null;
  uptime: number | null;
  restarts: number | null;
}

interface ScriptsState {
  scripts: ScriptProcess[];
  loading: boolean;
  actionLoading: string | null; // id of script being acted on
  error: string | null;
  loadScripts: () => Promise<void>;
  startScript: (id: string) => Promise<void>;
  stopScript: (id: string) => Promise<void>;
  restartScript: (id: string) => Promise<void>;
  deleteScript: (id: string) => Promise<void>;
}

export const useScriptsStore = create<ScriptsState>((set, get) => ({
  scripts: [],
  loading: false,
  actionLoading: null,
  error: null,

  loadScripts: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ scripts: ScriptProcess[] }>('/api/scripts');
      set({ scripts: data.scripts, loading: false });
    } catch (err) {
      // Silently ignore 403 (non-admin users)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403') || msg.includes('Admin')) {
        set({ scripts: [], loading: false });
      } else {
        set({ error: msg, loading: false });
      }
    }
  },

  startScript: async (id) => {
    set({ actionLoading: id, error: null });
    try {
      await api.post(`/api/scripts/${encodeURIComponent(id)}/start`);
      await get().loadScripts();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ actionLoading: null });
    }
  },

  stopScript: async (id) => {
    set({ actionLoading: id, error: null });
    try {
      await api.post(`/api/scripts/${encodeURIComponent(id)}/stop`);
      await get().loadScripts();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ actionLoading: null });
    }
  },

  restartScript: async (id) => {
    set({ actionLoading: id, error: null });
    try {
      await api.post(`/api/scripts/${encodeURIComponent(id)}/restart`);
      await get().loadScripts();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ actionLoading: null });
    }
  },

  deleteScript: async (id) => {
    set({ actionLoading: id, error: null });
    try {
      await api.delete(`/api/scripts/${encodeURIComponent(id)}`);
      await get().loadScripts();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ actionLoading: null });
    }
  },
}));
