import { create } from 'zustand';
import { api } from '../api/client';
import type { Permission, UserPublic } from './auth';

export type PermissionTemplateKey =
  | 'admin_full'
  | 'member_basic'
  | 'ops_manager'
  | 'user_admin';

export interface PermissionTemplate {
  key: PermissionTemplateKey;
  label: string;
  role: 'admin' | 'member';
  permissions: Permission[];
}

export interface InviteCode {
  code: string;
  created_by: string;
  creator_username: string;
  role: 'admin' | 'member';
  permission_template: PermissionTemplateKey | null;
  permissions: Permission[];
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_at: string;
}

export interface AuditLogEntry {
  id: number;
  event_type: string;
  username: string;
  actor_username: string | null;
  ip_address: string | null;
  user_agent: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface UserQuery {
  q?: string;
  role?: 'all' | 'admin' | 'member' | 'guest';
  status?: 'all' | 'active' | 'disabled' | 'deleted';
  page?: number;
  pageSize?: number;
}

export interface AuditQuery {
  event_type?: string;
  username?: string;
  actor_username?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface UsersState {
  users: UserPublic[];
  invites: InviteCode[];
  auditLogs: AuditLogEntry[];
  totalUsers: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string | null;
  permissions: Permission[];
  templates: PermissionTemplate[];
  fetchPermissionMeta: () => Promise<void>;
  fetchUsers: (query?: UserQuery) => Promise<void>;
  createUser: (data: {
    username: string;
    password: string;
    display_name?: string;
    role?: 'admin' | 'member';
    permissions?: Permission[];
    must_change_password?: boolean;
    notes?: string;
  }) => Promise<void>;
  updateUser: (
    id: string,
    data: {
      role?: 'admin' | 'member';
      status?: 'active' | 'disabled' | 'deleted';
      display_name?: string;
      password?: string;
      permissions?: Permission[];
      disable_reason?: string | null;
      notes?: string | null;
    },
  ) => Promise<void>;
  restoreUser: (id: string) => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
  revokeUserSessions: (id: string) => Promise<void>;
  fetchInvites: () => Promise<void>;
  createInvite: (data: {
    role?: 'admin' | 'member';
    permission_template?: PermissionTemplateKey;
    permissions?: Permission[];
    max_uses?: number;
    expires_in_hours?: number;
  }) => Promise<string>;
  deleteInvite: (code: string) => Promise<void>;
  fetchAuditLogs: (query?: AuditQuery) => Promise<void>;
}

function asMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function toQueryString(
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const useUsersStore = create<UsersState>((set) => ({
  users: [],
  invites: [],
  auditLogs: [],
  totalUsers: 0,
  page: 1,
  pageSize: 50,
  loading: false,
  error: null,
  permissions: [],
  templates: [],

  fetchPermissionMeta: async () => {
    try {
      const data = await api.get<{
        permissions: Permission[];
        templates: PermissionTemplate[];
      }>('/api/admin/permission-templates');
      set({ permissions: data.permissions, templates: data.templates });
    } catch (err) {
      set({ error: asMessage(err, 'Failed to load permission metadata') });
    }
  },

  fetchUsers: async (query) => {
    set({ loading: true, error: null });
    try {
      const q = query || {};
      const qs = toQueryString({
        q: q.q,
        role: q.role,
        status: q.status,
        page: q.page,
        pageSize: q.pageSize,
      });
      const data = await api.get<{
        users: UserPublic[];
        total: number;
        page: number;
        pageSize: number;
      }>(`/api/admin/users${qs}`);
      set({
        users: data.users,
        totalUsers: data.total,
        page: data.page,
        pageSize: data.pageSize,
        loading: false,
      });
    } catch (err) {
      set({ error: asMessage(err, 'Failed to fetch users'), loading: false });
    }
  },

  createUser: async (data) => {
    await api.post('/api/admin/users', data);
  },

  updateUser: async (id, data) => {
    await api.patch(`/api/admin/users/${id}`, data);
  },

  restoreUser: async (id) => {
    await api.post(`/api/admin/users/${id}/restore`);
  },

  deleteUser: async (id) => {
    await api.delete(`/api/admin/users/${id}`);
  },

  revokeUserSessions: async (id) => {
    await api.delete(`/api/admin/users/${id}/sessions`);
  },

  fetchInvites: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ invites: InviteCode[] }>(
        '/api/admin/invites',
      );
      set({ invites: data.invites, loading: false });
    } catch (err) {
      set({ error: asMessage(err, 'Failed to fetch invites'), loading: false });
    }
  },

  createInvite: async (data) => {
    const result = await api.post<{ code: string }>('/api/admin/invites', data);
    return result.code;
  },

  deleteInvite: async (code) => {
    await api.delete(`/api/admin/invites/${code}`);
  },

  fetchAuditLogs: async (query) => {
    set({ loading: true, error: null });
    try {
      const q = query || {};
      const qs = toQueryString({
        event_type: q.event_type,
        username: q.username,
        actor_username: q.actor_username,
        from: q.from,
        to: q.to,
        limit: q.limit,
        offset: q.offset,
      });
      const data = await api.get<{
        logs: AuditLogEntry[];
        total: number;
        limit: number;
        offset: number;
      }>(`/api/admin/audit-log${qs}`);
      set({ auditLogs: data.logs, loading: false });
    } catch (err) {
      set({
        error: asMessage(err, 'Failed to fetch audit logs'),
        loading: false,
      });
    }
  },
}));
