import { create } from 'zustand';
import { api, apiFetch } from '../api/client';
import { clearMessageSnapshotCache } from '../utils/messageSnapshotCache';
import { useUsageStore } from './usage';

export type Permission =
  | 'manage_system_config'
  | 'manage_group_env'
  | 'manage_users'
  | 'manage_invites'
  | 'view_audit_log'
  | 'manage_billing';

export interface UserPublic {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled' | 'deleted';
  permissions: Permission[];
  must_change_password: boolean;
  disable_reason: string | null;
  notes: string | null;
  created_at: string;
  last_login_at: string | null;
  last_active_at: string | null;
  deleted_at: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  avatar_url: string | null;
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
  default_require_mention: boolean;
}

export interface AppearanceConfig {
  appName: string;
  aiName: string;
  aiAvatarEmoji: string;
  aiAvatarColor: string;
  aiAvatarUrl: string | null;
  aiAvatarMode: 'brand' | 'emoji';
  // 400x400 square mark shown in the collapsed sidebar rail.
  brandIconUrl: string | null;
  // 600x200 left-aligned wordmark shown above the workspace list.
  brandBannerUrl: string | null;
}

export interface SetupStatus {
  needsSetup: boolean;
  claudeConfigured: boolean;
  feishuConfigured: boolean;
}

interface AuthState {
  authenticated: boolean;
  user: UserPublic | null;
  setupStatus: SetupStatus | null;
  appearance: AppearanceConfig | null;
  initialized: boolean | null; // null = not checked yet
  checking: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: {
    username: string;
    password: string;
    display_name?: string;
    invite_code?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  checkStatus: () => Promise<void>;
  setupAdmin: (username: string, password: string) => Promise<void>;
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  updateProfile: (payload: {
    username?: string;
    display_name?: string;
    avatar_emoji?: string | null;
    avatar_color?: string | null;
    avatar_url?: string | null;
    ai_name?: string | null;
    ai_avatar_emoji?: string | null;
    ai_avatar_color?: string | null;
    ai_avatar_url?: string | null;
    default_require_mention?: boolean;
  }) => Promise<void>;
  uploadAvatar: (file: File, target?: 'user' | 'ai') => Promise<string>;
  fetchAppearance: () => Promise<void>;
  hasPermission: (permission: Permission) => boolean;
}

let checkAuthInFlight: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  authenticated: false,
  user: null,
  setupStatus: null,
  appearance: null,
  initialized: null,
  checking: true,

  login: async (username: string, password: string) => {
    // Message snapshots are user-scoped application data. Clear them before
    // switching users on a shared browser.
    useUsageStore.getState().reset();
    await clearMessageSnapshotCache();
    const data = await api.post<{
      success: boolean;
      user: UserPublic;
      setupStatus?: SetupStatus;
      appearance?: AppearanceConfig;
    }>('/api/auth/login', { username, password });
    set({
      authenticated: true,
      user: data.user,
      setupStatus: data.setupStatus ?? null,
      appearance: data.appearance ?? null,
      initialized: true,
    });
  },

  register: async (payload) => {
    // Same rationale as login: clear user-scoped message snapshots.
    useUsageStore.getState().reset();
    await clearMessageSnapshotCache();
    const data = await api.post<{ success: boolean; user: UserPublic }>(
      '/api/auth/register',
      payload,
    );
    set({
      authenticated: true,
      user: data.user,
      setupStatus: null,
      initialized: true,
    });
  },

  logout: async () => {
    await api.post('/api/auth/logout');
    // Clear AFTER server-side session invalidation so the next user on this
    // device cannot see this user's message snapshots.
    useUsageStore.getState().reset();
    await clearMessageSnapshotCache();
    set({
      authenticated: false,
      user: null,
      setupStatus: null,
      appearance: null,
      initialized: true,
    });
  },

  checkStatus: async () => {
    try {
      const data = await api.get<{ initialized: boolean }>('/api/auth/status');
      set({ initialized: data.initialized });
    } catch {
      // If status endpoint fails, assume initialized (safe default)
      set({ initialized: true });
    }
  },

  setupAdmin: async (username: string, password: string) => {
    const data = await api.post<{
      success: boolean;
      user: UserPublic;
      setupStatus?: SetupStatus;
      appearance?: AppearanceConfig;
    }>('/api/auth/setup', { username, password });
    set({
      authenticated: true,
      user: data.user,
      setupStatus: data.setupStatus ?? null,
      appearance: data.appearance ?? null,
      initialized: true,
    });
  },

  checkAuth: async () => {
    if (checkAuthInFlight) return checkAuthInFlight;

    checkAuthInFlight = (async () => {
      set({ checking: true });
      // index.html 在 HTML 解析阶段预发了 /api/auth/me（见 web/index.html），
      // 这里一次性消费，省掉「入口 JS 执行完才发认证请求」的整跳串行。
      // 任何异常都静默回落到下面的常规重试流程。
      const prewarm = (window as { __authPrewarm?: Promise<Response | null> })
        .__authPrewarm;
      if (prewarm) {
        (window as { __authPrewarm?: unknown }).__authPrewarm = undefined;
        try {
          const res = await prewarm;
          if (res?.ok) {
            const data = (await res.json()) as {
              user: UserPublic;
              setupStatus?: SetupStatus;
              appearance?: AppearanceConfig;
            };
            set({
              authenticated: true,
              user: data.user,
              setupStatus: data.setupStatus ?? null,
              appearance: data.appearance ?? null,
              initialized: true,
              checking: false,
            });
            return;
          }
          if (res?.status === 401) {
            await get().checkStatus();
            set({
              authenticated: false,
              user: null,
              setupStatus: null,
              checking: false,
            });
            return;
          }
        } catch {
          /* fall through to the regular retry flow */
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await api.get<{
            user: UserPublic;
            setupStatus?: SetupStatus;
            appearance?: AppearanceConfig;
          }>('/api/auth/me');
          set({
            authenticated: true,
            user: data.user,
            setupStatus: data.setupStatus ?? null,
            appearance: data.appearance ?? null,
            initialized: true,
            checking: false,
          });
          return;
        } catch (err) {
          const status =
            typeof err === 'object' && err !== null && 'status' in err
              ? Number((err as { status?: unknown }).status)
              : NaN;
          const retryable = status === 0 || status === 408;
          if (!retryable || attempt === 2) {
            // On auth failure, check if system is initialized
            await get().checkStatus();
            set({
              authenticated: false,
              user: null,
              setupStatus: null,
              checking: false,
            });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      }
    })().finally(() => {
      checkAuthInFlight = null;
    });

    return checkAuthInFlight;
  },

  changePassword: async (currentPassword: string, newPassword: string) => {
    const data = await api.put<{ success: boolean; user: UserPublic }>(
      '/api/auth/password',
      {
        current_password: currentPassword,
        new_password: newPassword,
      },
    );
    set({ user: data.user });
  },

  updateProfile: async (payload) => {
    const data = await api.put<{ success: boolean; user: UserPublic }>(
      '/api/auth/profile',
      payload,
    );
    set({ user: data.user });
  },

  uploadAvatar: async (file: File, target: 'user' | 'ai' = 'ai') => {
    const formData = new FormData();
    formData.append('avatar', file);
    const url =
      target === 'user' ? '/api/auth/avatar?target=user' : '/api/auth/avatar';
    const data = await apiFetch<{
      success: boolean;
      avatarUrl: string;
      user: UserPublic;
    }>(url, {
      method: 'POST',
      body: formData,
      headers: {},
    });
    set({ user: data.user });
    return data.avatarUrl;
  },

  fetchAppearance: async () => {
    try {
      const data = await api.get<AppearanceConfig>(
        '/api/config/appearance/public',
      );
      set({ appearance: data });
    } catch {
      // API not yet available, keep current state
    }
  },

  hasPermission: (permission: Permission): boolean => {
    const user = get().user;
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissions.includes(permission);
  },
}));
