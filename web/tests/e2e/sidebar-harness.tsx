// Desktop sidebar on mocked stores: a home workspace and two others, each
// with two sessions. The page shows the current route for assertions, and
// toasts for failures. Nothing here talks to a backend.
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { UnifiedSidebar } from '../../src/components/layout/UnifiedSidebar';
import { Toaster } from '../../src/components/ui/sonner';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { MotionProvider } from '../../src/lib/motion';
import { useAgentProfilesStore } from '../../src/stores/agent-profiles';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import { useChatStore } from '../../src/stores/chat';
import { useGroupsStore } from '../../src/stores/groups';
import type { AgentInfo, GroupInfo } from '../../src/types';
import '../../src/styles/globals.css';

const user: UserPublic = {
  id: 'sidebar-user',
  username: 'sidebar',
  display_name: '侧栏测试',
  role: 'admin',
  status: 'active',
  permissions: [],
  must_change_password: false,
  disable_reason: null,
  notes: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_login_at: null,
  last_active_at: null,
  deleted_at: null,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  ai_name: null,
  ai_avatar_emoji: null,
  ai_avatar_color: null,
  ai_avatar_url: null,
  default_require_mention: false,
};

function workspace(
  folder: string,
  name: string,
  minutesAgo: number,
  home = false,
): GroupInfo {
  return {
    name,
    folder,
    added_at: '2026-01-01T00:00:00.000Z',
    interaction_mode: 'assistant',
    kind: 'web',
    is_home: home,
    is_my_home: home,
    can_modify: true,
    execution_mode: 'host',
    agent_profile_name: 'HappyClaw',
    lastMessageTime: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  } as GroupInfo;
}

function sessions(folder: string): AgentInfo[] {
  return [1, 2].map((n) => ({
    id: `${folder}-s${n}`,
    name: `${folder} 会话 ${n}`,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_at: '2026-01-01T00:00:00.000Z',
    last_active_at: new Date(Date.now() - n * 60_000).toISOString(),
  }));
}

useAuthStore.setState({
  authenticated: true,
  user,
  initialized: true,
  checking: false,
});
useGroupsStore.setState({ runnerStates: {} } as never);
// The create-workspace dialog loads profiles on open; keep it off the network
// (a real backend answers 401 here and the API client redirects to /login).
useAgentProfilesStore.setState({
  profiles: [],
  loading: false,
  profilesError: null,
  loadProfiles: async () => undefined,
});
useChatStore.setState({
  groups: {
    'web:main': workspace('main', 'HappyClaw', 30, true),
    'web:alpha': workspace('alpha', 'Alpha 工作区', 10),
    'web:beta': workspace('beta', 'Beta 工作区', 20),
  },
  currentGroup: 'web:alpha',
  agents: {
    'web:main': sessions('main'),
    'web:alpha': sessions('alpha'),
    'web:beta': sessions('beta'),
  },
  messages: {},
  loading: false,
  loadGroups: async () => undefined,
  loadMessages: async () => undefined,
  loadAgents: async () => undefined,
});

function RouteProbe() {
  const location = useLocation();
  return (
    <main data-testid="route" className="flex-1 p-4 text-sm">
      {location.pathname + location.search}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <TooltipProvider>
      <MemoryRouter initialEntries={['/chat/alpha']}>
        <div className="flex h-[100dvh] overflow-hidden bg-app-shell">
          <UnifiedSidebar />
          <RouteProbe />
        </div>
      </MemoryRouter>
      <Toaster />
    </TooltipProvider>
  </MotionProvider>,
);
