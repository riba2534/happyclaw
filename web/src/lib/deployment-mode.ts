/**
 * What single-user host mode hides. The server refuses registration, other
 * users, guests, billing, storage source writes and Docker itself; these only
 * keep them out of view.
 */
import type { SettingsTab } from '../components/settings/types';
import { useAuthStore } from '../stores/auth';

/** Whether the instance runs in single-user host mode. */
export function useIsSingleUserHost(): boolean {
  return useAuthStore((state) => state.deploymentMode) === 'single_user_host';
}

/**
 * Signed-in routes single-user host mode has no use for; AuthGuard sends
 * them to /settings. The public /register redirects in RegisterPage.
 */
const SINGLE_USER_HOST_HIDDEN_PATHS = ['/users', '/billing'];

export function isSingleUserHostHiddenPath(pathname: string): boolean {
  return SINGLE_USER_HOST_HIDDEN_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * Settings sections about other people or money, and storage sources (Docker
 * volumes, which this mode never mounts).
 */
const SINGLE_USER_HOST_HIDDEN_TABS: readonly SettingsTab[] = [
  'registration',
  'users',
  'guests',
  'billing',
  'storage-sources',
];

export function isSingleUserHostHiddenTab(tab: SettingsTab): boolean {
  return SINGLE_USER_HOST_HIDDEN_TABS.includes(tab);
}
