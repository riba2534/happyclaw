import { create } from 'zustand';
import { api } from '../api/client';

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project';
  enabled: boolean;
  syncedFromHost?: boolean;
  packageName?: string;
  installedAt?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

export interface SkillDetail extends Skill {
  content: string;
}

export interface SearchResult {
  package: string;
  url: string;
  description?: string;
  installs?: number;
  skillId?: string;
  source?: string;
}

export interface SearchResultDetail {
  description: string;
  skillName?: string;
  readme?: string;
  installs: string;
  age: string;
  features: string[];
}

interface SyncHostResult {
  stats: { added: number; updated: number; deleted: number; skipped: number };
  total: number;
}

interface SkillsState {
  skills: Skill[];
  loading: boolean;
  error: string | null;
  installing: boolean;
  syncing: boolean;
  searching: boolean;
  searchResults: SearchResult[];
  searchDetails: Record<string, SearchResultDetail | null>;
  searchDetailLoading: Record<string, boolean>;

  loadSkills: () => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  installSkill: (pkg: string) => Promise<void>;
  reinstallSkill: (id: string) => Promise<void>;
  syncHostSkills: () => Promise<SyncHostResult>;
  getSkillDetail: (id: string) => Promise<SkillDetail>;
  searchSkills: (query: string) => Promise<void>;
  fetchSearchDetail: (result: SearchResult) => Promise<void>;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  loading: false,
  error: null,
  installing: false,
  syncing: false,
  searching: false,
  searchResults: [],
  searchDetails: {},
  searchDetailLoading: {},

  loadSkills: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ skills: Skill[] }>('/api/skills');
      set({ skills: data.skills, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  toggleSkill: async (id: string, enabled: boolean) => {
    try {
      await api.patch(`/api/skills/${id}`, { enabled });
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteSkill: async (id: string) => {
    try {
      await api.delete(`/api/skills/${id}`);
      set({ error: null });
      await get().loadSkills();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  installSkill: async (pkg: string) => {
    set({ installing: true, error: null });
    try {
      await api.post('/api/skills/install', { package: pkg }, 60_000);
      await get().loadSkills();
    } catch (err: any) {
      set({ error: err?.message || (err instanceof Error ? err.message : '安装失败，请稍后重试') });
      throw err;
    } finally {
      set({ installing: false });
    }
  },

  reinstallSkill: async (id: string) => {
    set({ installing: true, error: null });
    try {
      await api.post(`/api/skills/${id}/reinstall`, {}, 60_000);
      await get().loadSkills();
    } catch (err: any) {
      set({ error: err?.message || '重新安装失败，请稍后重试' });
      throw err;
    } finally {
      set({ installing: false });
    }
  },

  syncHostSkills: async () => {
    set({ syncing: true, error: null });
    try {
      const result = await api.post<SyncHostResult>('/api/skills/sync-host', {});
      await get().loadSkills();
      return result;
    } catch (err: any) {
      set({ error: err?.message || '同步失败，请稍后重试' });
      throw err;
    } finally {
      set({ syncing: false });
    }
  },

  getSkillDetail: async (id: string) => {
    const data = await api.get<{ skill: SkillDetail }>(`/api/skills/${id}`);
    return data.skill;
  },

  searchSkills: async (query: string) => {
    set({ searching: true, searchResults: [], searchDetails: {}, searchDetailLoading: {} });
    try {
      const data = await api.get<{ results: SearchResult[] }>(
        `/api/skills/search?q=${encodeURIComponent(query)}`,
      );
      set({ searching: false, searchResults: data.results });
    } catch {
      set({ searching: false, searchResults: [] });
    }
  },

  fetchSearchDetail: async (result: SearchResult) => {
    const key = result.package;
    const { searchDetails, searchDetailLoading } = get();
    if (key in searchDetails || searchDetailLoading[key]) return;

    set({ searchDetailLoading: { ...get().searchDetailLoading, [key]: true } });
    try {
      // Use source/skillId params if available (new API), fallback to url
      const params = result.source && result.skillId
        ? `source=${encodeURIComponent(result.source)}&skillId=${encodeURIComponent(result.skillId)}`
        : result.url
          ? `url=${encodeURIComponent(result.url)}`
          : '';

      if (!params) {
        set({
          searchDetails: { ...get().searchDetails, [key]: null },
          searchDetailLoading: { ...get().searchDetailLoading, [key]: false },
        });
        return;
      }

      const data = await api.get<{ detail: SearchResultDetail | null }>(
        `/api/skills/search/detail?${params}`,
      );
      set({
        searchDetails: { ...get().searchDetails, [key]: data.detail },
        searchDetailLoading: { ...get().searchDetailLoading, [key]: false },
      });
    } catch {
      set({
        searchDetails: { ...get().searchDetails, [key]: null },
        searchDetailLoading: { ...get().searchDetailLoading, [key]: false },
      });
    }
  },
}));
