import {
  Activity,
  FolderPlus,
  Hash,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  PanelLeft,
  Palette,
  SquarePen,
  Sun,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AgentInfo, GroupInfo } from '../types';
import type { ColorScheme, Theme } from '../hooks/useTheme';
import { SHORTCUTS } from './shortcuts';
import { sessionActivityAt } from './session-presentation';
import { getAgentProfileDisplayName } from '../utils/agent-product';

export type CommandAction =
  | { type: 'navigate'; to: string }
  | { type: 'newConversation' }
  | { type: 'createWorkspace' }
  | { type: 'toggleSidebar' }
  | { type: 'logout' }
  | { type: 'theme'; value: Theme }
  | { type: 'scheme'; value: ColorScheme }
  | {
      type: 'openSession';
      jid: string;
      folder: string;
      sessionId: string | null;
    };

export interface CommandItemSpec {
  id: string;
  label: string;
  /** Secondary text, e.g. the owning workspace. */
  hint?: string;
  keywords: string[];
  icon: LucideIcon;
  shortcut?: string;
  action: CommandAction;
}

export interface CommandGroupSpec {
  heading: string;
  items: CommandItemSpec[];
}

export interface CommandSourceInput {
  navItems: { path: string; label: string; icon: LucideIcon }[];
  settingsSections: {
    label: string;
    items: { key: string; label: string; icon: LucideIcon }[];
  }[];
  groups: Record<string, GroupInfo>;
  agents: Record<string, AgentInfo[]>;
  canViewMonitor: boolean;
  canManageUsers: boolean;
  theme: Theme;
  colorScheme: ColorScheme;
  /** Max sessions listed across all workspaces. */
  sessionLimit?: number;
}

const THEME_LABELS: Record<Theme, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};
const THEME_ICONS: Record<Theme, LucideIcon> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};
const SCHEME_LABELS: Record<ColorScheme, string> = {
  default: '经典绿',
  orange: '暖橙',
  neutral: '素白',
};

function workspaceLabel(group: GroupInfo): string {
  return group.is_my_home
    ? getAgentProfileDisplayName(group.agent_profile_name)
    : group.name;
}

/** Everything ⌘K can reach, grouped and ordered for display. */
export function buildCommandGroups(
  input: CommandSourceInput,
): CommandGroupSpec[] {
  const actions: CommandItemSpec[] = [
    {
      id: 'action:new-conversation',
      label: '新对话',
      keywords: ['new', 'chat', '会话', '新建'],
      icon: SquarePen,
      shortcut: SHORTCUTS.newConversation,
      action: { type: 'newConversation' },
    },
    {
      id: 'action:create-workspace',
      label: '新建工作区',
      keywords: ['workspace', 'create'],
      icon: FolderPlus,
      action: { type: 'createWorkspace' },
    },
    {
      id: 'action:toggle-sidebar',
      label: '切换侧边栏',
      keywords: ['sidebar', '收起', '展开'],
      icon: PanelLeft,
      shortcut: SHORTCUTS.toggleSidebar,
      action: { type: 'toggleSidebar' },
    },
  ];

  const pages: CommandItemSpec[] = input.navItems.map((item) => ({
    id: `page:${item.path}`,
    label: item.label,
    keywords: [item.path.replace('/', '')],
    icon: item.icon,
    action: { type: 'navigate', to: item.path },
  }));
  if (input.canViewMonitor) {
    pages.push({
      id: 'page:/monitor',
      label: '运行状态',
      keywords: ['monitor'],
      icon: Activity,
      action: { type: 'navigate', to: '/monitor' },
    });
  }
  if (input.canManageUsers) {
    pages.push({
      id: 'page:/users',
      label: '用户管理',
      keywords: ['users'],
      icon: Users,
      action: { type: 'navigate', to: '/users' },
    });
  }

  const groupEntries = Object.entries(input.groups);
  const workspaces: CommandItemSpec[] = groupEntries.map(([jid, group]) => ({
    id: `workspace:${jid}`,
    label: workspaceLabel(group),
    hint: group.agent_profile_name || undefined,
    keywords: [group.folder, group.name, group.agent_profile_name || ''],
    icon: LayoutGrid,
    action: {
      type: 'openSession',
      jid,
      folder: group.folder,
      sessionId: null,
    },
  }));

  const sessions = groupEntries
    .flatMap(([jid, group]) =>
      (input.agents[jid] || [])
        .filter((agent) => agent.kind === 'conversation')
        .map((agent) => ({ jid, group, agent })),
    )
    .sort(
      (a, b) =>
        new Date(sessionActivityAt(b.agent)).getTime() -
        new Date(sessionActivityAt(a.agent)).getTime(),
    )
    .slice(0, input.sessionLimit ?? 50)
    .map<CommandItemSpec>(({ jid, group, agent }) => ({
      id: `session:${jid}:${agent.id}`,
      label: agent.name || '新会话',
      hint: workspaceLabel(group),
      keywords: [workspaceLabel(group), agent.latest_message?.content ?? ''],
      icon: Hash,
      action: {
        type: 'openSession',
        jid,
        folder: group.folder,
        sessionId: agent.id,
      },
    }));

  const settings: CommandItemSpec[] = input.settingsSections.flatMap(
    (section) =>
      section.items.map((item) => ({
        id: `settings:${item.key}`,
        label: item.label,
        hint: section.label,
        keywords: ['设置', 'settings', item.key],
        icon: item.icon,
        action: {
          type: 'navigate',
          to: `/settings?tab=${item.key}`,
        } as const,
      })),
  );

  const appearance: CommandItemSpec[] = [
    ...(Object.keys(THEME_LABELS) as Theme[])
      .filter((value) => value !== input.theme)
      .map((value) => ({
        id: `theme:${value}`,
        label: `切换到${THEME_LABELS[value]}主题`,
        keywords: ['theme', '主题', '外观', value],
        icon: THEME_ICONS[value],
        action: { type: 'theme', value } as const,
      })),
    ...(Object.keys(SCHEME_LABELS) as ColorScheme[])
      .filter((value) => value !== input.colorScheme)
      .map((value) => ({
        id: `scheme:${value}`,
        label: `使用「${SCHEME_LABELS[value]}」配色`,
        keywords: ['color', '配色', '外观', value],
        icon: Palette,
        action: { type: 'scheme', value } as const,
      })),
    {
      id: 'action:logout',
      label: '退出登录',
      keywords: ['logout', 'sign out'],
      icon: LogOut,
      action: { type: 'logout' },
    },
  ];

  return [
    { heading: '操作', items: actions },
    { heading: '工作区', items: workspaces },
    { heading: '会话', items: sessions },
    { heading: '页面', items: pages },
    { heading: '设置', items: settings },
    { heading: '外观与账户', items: appearance },
  ].filter((group) => group.items.length > 0);
}
