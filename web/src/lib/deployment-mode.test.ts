import { describe, expect, test } from 'vitest';
import { getSettingsSections } from '../components/settings/SettingsNav';
import { isSingleUserHostHiddenPath } from './deployment-mode';
import { parseDeploymentMode } from '../stores/auth';
import { workspaceDirPlaceholder } from './workspace-root';

const admin = {
  canManageSystemConfig: true,
  canManageBilling: true,
  canManageUsers: true,
  isAdmin: true,
};

const tabsOf = (singleUserHost?: boolean) =>
  getSettingsSections({ ...admin, singleUserHost }).flatMap((section) =>
    section.items.map((item) => item.key),
  );

describe('deployment mode', () => {
  test('an absent or unknown mode is multi_user', () => {
    expect(parseDeploymentMode(undefined)).toBe('multi_user');
    expect(parseDeploymentMode('team')).toBe('multi_user');
    expect(parseDeploymentMode('single_user_host')).toBe('single_user_host');
  });

  test('single-user host mode drops registration, users, guests, billing and storage sources', () => {
    const hidden = [
      'registration',
      'users',
      'guests',
      'billing',
      'storage-sources',
    ];
    expect(tabsOf()).toEqual(expect.arrayContaining(hidden));
    const single = tabsOf(true);
    for (const tab of hidden) expect(single).not.toContain(tab);
    expect(single).toEqual(
      expect.arrayContaining(['system', 'host-integration', 'monitor']),
    );
  });

  test('the routes it redirects', () => {
    for (const path of ['/users', '/billing', '/users/x']) {
      expect(isSingleUserHostHiddenPath(path)).toBe(true);
    }
    for (const path of ['/settings', '/usage', '/userspace']) {
      expect(isSingleUserHostHiddenPath(path)).toBe(false);
    }
  });

  test('the Host workspace placeholder names the workspace root', () => {
    expect(workspaceDirPlaceholder('/home/me/happyclaw/')).toBe(
      '默认: /home/me/happyclaw/<文件夹>',
    );
    expect(workspaceDirPlaceholder(null)).toBe('默认: data/groups/{folder}/');
  });
});
