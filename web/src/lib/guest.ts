/**
 * Read-only guest accounts: route allowlist shared by the auth guard and
 * navigation. Guests view the workspaces their owner granted and never write.
 */

/** Route prefixes a read-only guest may open; everything else goes to /chat. */
export const GUEST_ALLOWED_PATHS = ['/chat', '/tasks', '/memory', '/settings'];

export function isGuestAllowedPath(pathname: string): boolean {
  return GUEST_ALLOWED_PATHS.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Settings tabs a guest can open (own password, devices, local prefs). */
export const GUEST_SETTINGS_TABS = [
  'preferences',
  'security',
  'about',
] as const;

export const GUEST_READ_ONLY_NOTICE = '访客模式：只读，无法发送消息';

/** What a guest can and cannot do, shown wherever guests are managed. */
export const GUEST_SCOPE_DESCRIPTION =
  '访客只能查看被授权工作区的消息、会话、文件、记忆和定时任务，不能发送消息、修改或执行任何操作。';

/** Same username rule as registration and admin user creation. */
export function validateGuestUsername(username: string): string | null {
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return '用户名须为 3-32 位字母、数字或下划线';
  }
  return null;
}

/** Same password length rule as registration and admin user creation. */
export function validateGuestPassword(password: string): string | null {
  if (password.length < 8) return '密码长度不能少于 8 位';
  if (password.length > 128) return '密码长度不能超过 128 位';
  return null;
}
