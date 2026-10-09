import { describe, expect, test } from 'vitest';
import { buildCommandGroups } from '../web/src/lib/command-items';
import type { AgentInfo, GroupInfo } from '../web/src/types';

// Icons are opaque to the builder; any component stands in for lucide here.
const Bot = (() => null) as never;
const Settings = (() => null) as never;

const group = (overrides: Partial<GroupInfo>): GroupInfo =>
  ({
    name: 'Workspace',
    folder: 'ws',
    added_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as GroupInfo;

const session = (id: string, at: string, name = id): AgentInfo => ({
  id,
  name,
  prompt: '',
  status: 'idle',
  kind: 'conversation',
  created_at: at,
});

const base = {
  navItems: [{ path: '/agent-profiles', label: '智能体', icon: Bot }],
  settingsSections: [
    {
      label: '账户设置',
      items: [
        { key: 'profile', label: '个人资料', icon: Settings },
        {
          key: 'security',
          label: '安全与设备',
          icon: Settings,
          keywords: ['密码'],
        },
      ],
    },
  ],
  groups: {
    'web:main': group({
      name: 'admin Home',
      folder: 'main',
      is_my_home: true,
      agent_profile_name: 'Default Agent',
    }),
    'web:b': group({ name: '前端重构', folder: 'flow-b' }),
  },
  agents: {
    'web:main': [
      session('old', '2026-01-01T00:00:00.000Z', '旧会话'),
      session('new', '2026-03-01T00:00:00.000Z', '新会话'),
      { ...session('task', '2026-04-01T00:00:00.000Z'), kind: 'task' as const },
    ],
  },
  canViewMonitor: false,
  canManageUsers: true,
  theme: 'light' as const,
  colorScheme: 'orange' as const,
};

describe('command palette items', () => {
  test('groups actions, workspaces, sessions, pages, settings and appearance', () => {
    const groups = buildCommandGroups(base);
    expect(groups.map((g) => g.heading)).toEqual([
      '操作',
      '工作区',
      '会话',
      '页面',
      '设置',
      '外观与账户',
    ]);
  });

  test('lists conversation sessions newest first and labels the home workspace', () => {
    const sessions = buildCommandGroups(base).find(
      (g) => g.heading === '会话',
    )!;
    expect(sessions.items.map((item) => item.label)).toEqual([
      '新会话',
      '旧会话',
    ]);
    expect(sessions.items[0].hint).toBe('HappyClaw');
    expect(sessions.items[0].action).toEqual({
      type: 'openSession',
      jid: 'web:main',
      folder: 'main',
      sessionId: 'new',
    });
  });

  test('respects permissions and omits the active theme and scheme', () => {
    const groups = buildCommandGroups(base);
    const pages = groups.find((g) => g.heading === '页面')!.items;
    expect(pages.some((item) => item.id === 'page:/users')).toBe(true);
    expect(pages.some((item) => item.id === 'page:/monitor')).toBe(false);
    const appearance = groups.find((g) => g.heading === '外观与账户')!.items;
    expect(appearance.some((item) => item.id === 'theme:light')).toBe(false);
    expect(appearance.some((item) => item.id === 'scheme:orange')).toBe(false);
    const settings = groups.find((g) => g.heading === '设置')!.items;
    expect(settings[0].action).toEqual({
      type: 'navigate',
      to: '/settings?tab=profile',
    });
    // Section keywords make ⌘K find "密码" under 安全与设备.
    expect(
      settings.find((item) => item.id === 'settings:security')?.keywords,
    ).toContain('密码');
  });
});
