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

export interface HostPluginInfo {
  name: string;
  version?: string;
  description?: string;
  sourcePath: string;
}

export interface HostMarketplaceInfo {
  name: string;
  sourcePath: string;
  plugins: HostPluginInfo[];
  synced: boolean;
}

export interface SyncHostResult {
  marketplace: string;
  copied: string[];
  skipped: string[];
  warnings: string[];
}

interface PluginsState {
  marketplaces: MarketplaceEntry[];
  loading: boolean;
  error: string | null;
  syncing: boolean;

  loadPlugins: () => Promise<void>;
  toggleEnabled: (pluginFullId: string, enabled: boolean) => Promise<void>;
  syncMarketplace: (marketplace: string) => Promise<SyncHostResult>;
  fetchAvailableOnHost: () => Promise<{ marketplaces: HostMarketplaceInfo[]; hostRoot: string }>;
  deleteMarketplace: (name: string) => Promise<{ removedEnabled: string[] }>;
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  marketplaces: [],
  loading: false,
  error: null,
  syncing: false,

  loadPlugins: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ marketplaces: MarketplaceEntry[] }>('/api/plugins');
      set({ marketplaces: data.marketplaces, loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  toggleEnabled: async (pluginFullId, enabled) => {
    try {
      await api.patch(`/api/plugins/enabled/${encodeURIComponent(pluginFullId)}`, { enabled });
      set({ error: null });
      await get().loadPlugins();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  syncMarketplace: async (marketplace) => {
    set({ syncing: true, error: null });
    try {
      const result = await api.post<SyncHostResult>('/api/plugins/sync-host', {
        marketplace,
      });
      await get().loadPlugins();
      return result;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ syncing: false });
    }
  },

  fetchAvailableOnHost: async () => {
    return api.get<{ marketplaces: HostMarketplaceInfo[]; hostRoot: string }>(
      '/api/plugins/available-on-host',
    );
  },

  deleteMarketplace: async (name) => {
    try {
      const result = await api.delete<{
        success: boolean;
        marketplace: string;
        hadMarketplace: boolean;
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
