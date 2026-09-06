import { create } from 'zustand';
import { api } from '../api/client';

export interface PluginWarnings {
  missing: string[];
  note: string;
}

export interface PluginEntry {
  name: string;
  fullId: string;
  enabled: boolean;
  /** Snapshot the user has pinned (if any) or catalog's active snapshot. */
  snapshot?: string;
  /** Catalog's current default snapshot — the one a fresh enable would pin. */
  activeSnapshot?: string;
  version?: string;
  description?: string;
  warnings: PluginWarnings;
}

export interface MarketplaceEntry {
  name: string;
  syncedAt: string;
  version?: string;
  /** Absolute path on the server — only present for admin viewers. */
  hostSourcePath?: string;
  plugins: PluginEntry[];
}

export interface ImportReport {
  marketplacesScanned: number;
  pluginsScanned: number;
  snapshotsCreated: number;
  snapshotsSkipped: number;
  warnings: string[];
}

interface PluginsState {
  marketplaces: MarketplaceEntry[];
  secrets: string[];
  loading: boolean;
  scanning: boolean;
  error: string | null;

  loadPlugins: () => Promise<void>;
  loadSecrets: () => Promise<string[]>;
  setSecret: (key: string, value: string) => Promise<void>;
  revokeSecret: (key: string) => Promise<void>;
  scanCatalog: () => Promise<ImportReport>;
  toggleEnabled: (pluginFullId: string, enabled: boolean) => Promise<void>;
  deactivateImmediately: (
    pluginFullId: string,
  ) => Promise<{ stoppedSessionsCount: number }>;
  deleteMarketplace: (name: string) => Promise<{ removedEnabled: string[] }>;
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  marketplaces: [],
  secrets: [],
  loading: false,
  scanning: false,
  error: null,

  loadPlugins: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ marketplaces: MarketplaceEntry[] }>(
        '/api/plugins',
      );
      set({ marketplaces: data.marketplaces, loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  loadSecrets: async () => {
    try {
      const data = await api.get<{ keys: string[] }>('/api/plugins/secrets');
      set({ secrets: data.keys, error: null });
      return data.keys;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },

  setSecret: async (key: string, value: string) => {
    try {
      await api.put(`/api/plugins/secrets/${encodeURIComponent(key)}`, {
        value,
      });
      await get().loadSecrets();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  revokeSecret: async (key: string) => {
    try {
      await api.delete(`/api/plugins/secrets/${encodeURIComponent(key)}`);
      await get().loadSecrets();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  scanCatalog: async () => {
    set({ scanning: true });
    try {
      const data = await api.post<{ report: ImportReport }>(
        '/api/plugins/catalog/scan',
      );
      set({ scanning: false, error: null });
      await get().loadPlugins();
      return data.report;
    } catch (err) {
      set({
        scanning: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  toggleEnabled: async (pluginFullId, enabled) => {
    try {
      await api.patch(
        `/api/plugins/enabled/${encodeURIComponent(pluginFullId)}`,
        { enabled },
      );
      set({ error: null });
      await get().loadPlugins();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  deactivateImmediately: async (pluginFullId) => {
    try {
      const data = await api.post<{ stoppedSessionsCount: number }>(
        `/api/plugins/deactivate-immediately/${encodeURIComponent(pluginFullId)}`,
      );
      set({ error: null });
      await get().loadPlugins();
      return data;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  deleteMarketplace: async (name) => {
    try {
      const result = await api.delete<{
        success: boolean;
        marketplace: string;
        removedEnabled: string[];
      }>(`/api/plugins/marketplaces/${encodeURIComponent(name)}`);
      await get().loadPlugins();
      return { removedEnabled: result.removedEnabled };
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
}));
