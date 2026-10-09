import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { Command } from '@/components/ui/command';
import { defaultFilter } from 'cmdk';
import { Kbd } from '@/components/ui/kbd';
import { Shortcut } from '@/components/common/Shortcut';
import { useAuthStore } from '../../stores/auth';
import { useBillingStore } from '../../stores/billing';
import { useChatStore } from '../../stores/chat';
import { useShellStore } from '../../stores/shell';
import { useTheme } from '../../hooks/useTheme';
import { useNewConversation } from '../../hooks/useNewConversation';
import { filterNavItems } from '../layout/nav-items';
import { getSettingsSections } from '../settings/SettingsNav';
import {
  buildCommandGroups,
  type CommandAction,
} from '../../lib/command-items';
import { openWorkspaceSession } from '../../lib/chat-navigation';

/** ⌘K palette: jump to pages, workspaces, sessions and settings, or run actions. */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const billingEnabled = useBillingStore((s) => s.billingEnabled);
  const groups = useChatStore((s) => s.groups);
  const agents = useChatStore((s) => s.agents);
  const currentGroup = useChatStore((s) => s.currentGroup);
  const loadAgents = useChatStore((s) => s.loadAgents);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  const setCreateWorkspaceOpen = useShellStore((s) => s.setCreateWorkspaceOpen);
  const { theme, colorScheme, setTheme, setColorScheme } = useTheme();
  const { startNewConversation } = useNewConversation();

  // Sessions load lazily per workspace; make sure the likely targets
  // (current and home workspace) are searchable when the palette opens.
  useEffect(() => {
    if (!open) return;
    const home = Object.entries(groups).find(([, g]) => g.is_my_home)?.[0];
    for (const jid of new Set([currentGroup, home])) {
      if (jid) void loadAgents(jid);
    }
  }, [open, currentGroup, groups, loadAgents]);

  const commandGroups = useMemo(() => {
    const isAdmin = user?.role === 'admin';
    return buildCommandGroups({
      navItems: filterNavItems(billingEnabled),
      settingsSections: getSettingsSections({
        canManageSystemConfig: hasPermission('manage_system_config'),
        canManageBilling: hasPermission('manage_billing'),
        canManageUsers: hasPermission('manage_users'),
        isAdmin,
      }),
      groups,
      agents,
      canViewMonitor: hasPermission('manage_system_config'),
      canManageUsers: hasPermission('manage_users'),
      theme,
      colorScheme,
    });
  }, [
    agents,
    billingEnabled,
    colorScheme,
    groups,
    hasPermission,
    theme,
    user?.role,
  ]);

  const run = (action: CommandAction) => {
    onOpenChange(false);
    switch (action.type) {
      case 'navigate':
        navigate(action.to);
        break;
      case 'openSession':
        openWorkspaceSession(
          navigate,
          { jid: action.jid, folder: action.folder },
          action.sessionId,
        );
        break;
      case 'newConversation':
        void startNewConversation();
        break;
      case 'createWorkspace':
        setCreateWorkspaceOpen(true);
        break;
      case 'toggleSidebar':
        toggleSidebar();
        break;
      case 'theme':
        setTheme(action.value);
        break;
      case 'scheme':
        setColorScheme(action.value);
        break;
      case 'logout':
        void useAuthStore
          .getState()
          .logout()
          .then(() => navigate('/login'));
        break;
    }
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      {/* Match on labels and keywords only, never on the internal ids. */}
      <Command
        loop
        filter={(_value, search, keywords) =>
          defaultFilter(keywords?.join(' ') ?? '', search)
        }
      >
        <CommandInput
          placeholder="搜索页面、工作区、会话或操作…"
          trailing={<Kbd>Esc</Kbd>}
        />
        <CommandList>
          <CommandEmpty>没有找到匹配的结果</CommandEmpty>
          {commandGroups.map((group) => (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  keywords={[item.label, ...item.keywords]}
                  onSelect={() => run(item.action)}
                >
                  <item.icon />
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.hint && (
                    <span className="min-w-0 truncate text-caption text-faint-foreground">
                      {item.hint}
                    </span>
                  )}
                  {item.shortcut && (
                    <CommandShortcut>
                      <Shortcut keys={item.shortcut} />
                    </CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        <div className="flex h-9 shrink-0 items-center gap-4 border-t border-surface-border px-4 text-caption text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            选择
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            打开
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Shortcut keys="mod+k" />
            打开/关闭
          </span>
        </div>
      </Command>
    </CommandDialog>
  );
}
