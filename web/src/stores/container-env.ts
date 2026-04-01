import { create } from 'zustand';
import { api } from '../api/client';

export interface ContainerEnvPublicConfig {
  runtime: 'claude' | 'codex' | null;
  anthropicBaseUrl: string;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  anthropicModel: string;
  openaiBaseUrl: string;
  openaiApiKeyMasked: string | null;
  hasOpenAIApiKey: boolean;
  codexModel: string;
  customEnv: Record<string, string>;
}

interface ContainerEnvState {
  configs: Record<string, ContainerEnvPublicConfig>;
  loading: boolean;
  saving: boolean;
  error: string | null;

  loadConfig: (jid: string) => Promise<void>;
  saveConfig: (jid: string, data: {
    runtime?: 'claude' | 'codex';
    anthropicBaseUrl?: string;
    anthropicAuthToken?: string;
    anthropicApiKey?: string;
    claudeCodeOauthToken?: string;
    anthropicModel?: string;
    openaiBaseUrl?: string;
    openaiApiKey?: string;
    codexModel?: string;
    customEnv?: Record<string, string>;
  }) => Promise<boolean>;
}

export const useContainerEnvStore = create<ContainerEnvState>((set) => ({
  configs: {},
  loading: false,
  saving: false,
  error: null,

  loadConfig: async (jid: string) => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<ContainerEnvPublicConfig>(
        `/api/groups/${encodeURIComponent(jid)}/env`
      );
      set((s) => ({
        configs: { ...s.configs, [jid]: data },
        loading: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load config';
      console.error('Failed to load container env config:', err);
      set({ loading: false, error: msg });
    }
  },

  saveConfig: async (jid, data) => {
    set({ saving: true });
    try {
      const result = await api.put<ContainerEnvPublicConfig>(
        `/api/groups/${encodeURIComponent(jid)}/env`,
        data,
      );
      set((s) => ({
        configs: { ...s.configs, [jid]: result },
        saving: false,
      }));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save config';
      console.error('Failed to save container env config:', err);
      set({ saving: false, error: msg });
      return false;
    }
  },
}));
