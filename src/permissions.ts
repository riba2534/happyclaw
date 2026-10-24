import { Permission, PermissionTemplateKey, UserRole } from './types.js';

export const ALL_PERMISSIONS: Permission[] = [
  'manage_system_config',
  'manage_group_env',
  'manage_users',
  'manage_invites',
  'view_audit_log',
  'manage_billing',
];

export const PERMISSION_TEMPLATES: Record<
  PermissionTemplateKey,
  {
    key: PermissionTemplateKey;
    label: string;
    role: UserRole;
    permissions: Permission[];
  }
> = {
  admin_full: {
    key: 'admin_full',
    label: '管理员（全权限）',
    role: 'admin',
    permissions: [...ALL_PERMISSIONS],
  },
  member_basic: {
    key: 'member_basic',
    label: '普通成员（基础权限）',
    role: 'member',
    permissions: [],
  },
  ops_manager: {
    key: 'ops_manager',
    label: '运维管理员（配置+工作区环境）',
    role: 'member',
    permissions: ['manage_system_config', 'manage_group_env'],
  },
  user_admin: {
    key: 'user_admin',
    label: '用户管理员（用户+邀请码+审计）',
    role: 'member',
    permissions: ['manage_users', 'manage_invites', 'view_audit_log'],
  },
};

export const ROLE_DEFAULT_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  member: [],
  guest: [],
};

export function normalizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  const set = new Set<Permission>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    if ((ALL_PERMISSIONS as string[]).includes(value)) {
      set.add(value as Permission);
    }
  }
  return Array.from(set);
}

export function getDefaultPermissions(role: UserRole): Permission[] {
  return [...(ROLE_DEFAULT_PERMISSIONS[role] || [])];
}

export function resolveTemplate(
  template: PermissionTemplateKey | undefined,
): { role: UserRole; permissions: Permission[] } | null {
  if (!template) return null;
  const item = PERMISSION_TEMPLATES[template];
  if (!item) return null;
  return { role: item.role, permissions: [...item.permissions] };
}

export function hasPermission(
  user: { role: UserRole; permissions: Permission[] },
  permission: Permission,
): boolean {
  if (user.role === 'admin') return true;
  return user.permissions.includes(permission);
}
