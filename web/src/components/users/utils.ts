import type { Permission } from '../../stores/auth';

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return fallback;
}

export function samePermissions(left: Permission[], right: Permission[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, idx) => value === b[idx]);
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_system_config: '系统配置管理',
  manage_group_env: '工作区环境管理',
  manage_users: '用户管理',
  manage_invites: '邀请码管理',
  view_audit_log: '查看审计日志',
  manage_billing: '计费管理',
};

export const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  member: '普通成员',
};
export interface TabNotification {
  setNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
}
