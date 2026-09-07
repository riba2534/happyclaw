import type { Permission } from '../../stores/auth';

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return fallback;
}

export function samePermissions(
  left: Permission[],
  right: Permission[],
): boolean {
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

export const EVENT_TYPE_LABELS: Record<string, string> = {
  login_success: '登录成功',
  login_failed: '登录失败',
  logout: '登出',
  password_changed: '修改密码',
  profile_updated: '更新个人信息',
  user_created: '创建用户',
  user_disabled: '禁用用户',
  user_enabled: '启用用户',
  user_deleted: '删除用户',
  user_restored: '恢复用户',
  user_updated: '更新用户',
  role_changed: '变更角色',
  session_revoked: '撤回会话',
  invite_created: '创建邀请码',
  invite_deleted: '删除邀请码',
  invite_used: '使用邀请码',
  recovery_reset: '重置恢复',
  register_success: '注册成功',
  system_settings_updated: '更新系统设置',
  host_integration_updated: '更新宿主机集成',
  plugin_state_changed: '插件状态变更',
  plugin_deactivated_immediately: '插件立即停用',
  plugin_shared: '插件共享变更',
  mcp_shared: 'MCP 共享变更',
  mcp_credential_updated: 'MCP 凭据变更',
  skill_shared: 'Skill 共享变更',
};
export interface TabNotification {
  setNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
}
