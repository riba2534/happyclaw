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
  loading: boolean;
  scanning: boolean;
  error: string | null;

  loadPlugins: () => Promise<void>;
  scanCatalog: () => Promise<ImportReport>;
  toggleEnabled: (pluginFullId: string, enabled: boolean) => Promise<void>;
  deleteMarketplace: (name: string) => Promise<{ removedEnabled: string[] }>;
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  marketplaces: [],
  loading: false,
  scanning: false,
  error: null,

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
      await api.patch(`/api/plugins/enabled/${encodeURIComponent(pluginFullId)}`, { enabled });
      set({ error: null });
      await get().loadPlugins();
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
