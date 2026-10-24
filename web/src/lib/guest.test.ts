import { describe, expect, test } from 'vitest';
import {
  isGuestAllowedPath,
  validateGuestPassword,
  validateGuestUsername,
} from './guest';
import { buildCommandGroups } from './command-items';
import { getSettingsSections } from '../components/settings/SettingsNav';
import { filterNavItems } from '../components/layout/nav-items';

describe('read-only guest routes', () => {
  test.each([
    ['/chat', true],
    ['/chat/flow-x', true],
    ['/tasks', true],
    ['/memory', true],
    ['/settings', true],
    ['/setup/providers', false],
    ['/setup/channels', false],
    ['/agent-profiles', false],
    ['/capabilities/skills', false],
    ['/usage', false],
    ['/billing', false],
    ['/monitor', false],
    ['/users', false],
    ['/chatty', false],
  ])('%s allowed=%s', (path, allowed) => {
    expect(isGuestAllowedPath(path)).toBe(allowed);
  });

  test('navigation only lists guest pages', () => {
    expect(filterNavItems(true, true).map((item) => item.path)).toEqual([
      '/chat',
      '/tasks',
      '/memory',
      '/settings',
    ]);
  });
});

describe('guest settings and palette', () => {
  test('guests only see their own account sections', () => {
    const sections = getSettingsSections({
      canManageSystemConfig: false,
      canManageBilling: false,
      canManageUsers: false,
      isAdmin: false,
      isGuest: true,
    });
    expect(sections.flatMap((s) => s.items.map((item) => item.key))).toEqual([
      'preferences',
      'security',
    ]);
  });

  test('regular users can manage their guests', () => {
    const keys = getSettingsSections({
      canManageSystemConfig: false,
      canManageBilling: false,
      canManageUsers: false,
      isAdmin: false,
    }).flatMap((s) => s.items.map((item) => item.key));
    expect(keys).toContain('guests');
  });

  test('the palette offers no create actions to guests', () => {
    const ids = buildCommandGroups({
      navItems: [],
      settingsSections: [],
      groups: {},
      agents: {},
      canViewMonitor: false,
      canManageUsers: false,
      theme: 'system',
      colorScheme: 'default',
      canCreate: false,
    }).flatMap((group) => group.items.map((item) => item.id));
    expect(ids).not.toContain('action:new-conversation');
    expect(ids).not.toContain('action:create-workspace');
  });
});

describe('guest credential rules', () => {
  test('username matches the registration rule', () => {
    expect(validateGuestUsername('guest_1')).toBeNull();
    expect(validateGuestUsername('g')).not.toBeNull();
    expect(validateGuestUsername('bad name')).not.toBeNull();
  });

  test('password length matches the registration rule', () => {
    expect(validateGuestPassword('12345678')).toBeNull();
    expect(validateGuestPassword('short')).not.toBeNull();
    expect(validateGuestPassword('x'.repeat(129))).not.toBeNull();
  });
});
