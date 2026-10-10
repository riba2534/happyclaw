// Desktop sidebar on mocked stores: the primary agent's home workspace and
// two others, a custom agent with one workspace and one with two, each
// workspace with two sessions. The page shows the current route for
// assertions, and toasts for failures. Nothing here talks to a backend.
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { UnifiedSidebar } from '../../src/components/layout/UnifiedSidebar';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
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

function agentWorkspace(
  folder: string,
  name: string,
  minutesAgo: number,
  agent: { id: string; name: string; emoji: string; color: string },
): GroupInfo {
  return {
    ...workspace(folder, name, minutesAgo),
    agent_profile_id: agent.id,
    agent_profile_name: agent.name,
    agent_profile_avatar_emoji: agent.emoji,
    agent_profile_avatar_color: agent.color,
  } as GroupInfo;
}

const postAgent = {
  id: 'agent-post',
  name: '地址证明助手',
  emoji: '📮',
  color: '#2196F3',
};
const billAgent = {
  id: 'agent-bill',
  name: 'AI账单助手',
  emoji: '🧾',
  color: '#4CAF50',
};

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
const profile = (id: string, name: string, isDefault = false) =>
  ({
    id,
    name,
    is_default: isDefault,
    avatar_emoji: null,
    avatar_color: null,
    avatar_url: null,
    runtime_policy: { skills: {} },
  }) as never;
useAgentProfilesStore.setState({
  profiles: [
    profile('agent-default', 'HappyClaw', true),
    profile(postAgent.id, postAgent.name),
    profile(billAgent.id, billAgent.name),
  ],
  loading: false,
  profilesError: null,
  loadProfiles: async () => undefined,
});
useChatStore.setState({
  groups: {
    'web:main': workspace('main', 'HappyClaw', 30, true),
    'web:alpha': workspace('alpha', 'Alpha 工作区', 10),
    'web:beta': workspace('beta', 'Beta 工作区', 20),
    'web:post': agentWorkspace('post', '邮寄', 40, postAgent),
    'web:bill1': agentWorkspace('bill1', '账单一', 50, billAgent),
    'web:bill2': agentWorkspace('bill2', '账单二', 60, billAgent),
  },
  currentGroup: 'web:alpha',
  agents: {
    'web:main': sessions('main'),
    'web:alpha': sessions('alpha'),
    'web:beta': sessions('beta'),
    'web:post': sessions('post'),
    'web:bill1': sessions('bill1'),
    'web:bill2': sessions('bill2'),
  },
  messages: {},
  loading: false,
  loadGroups: async () => undefined,
  loadMessages: async () => undefined,
  loadAgents: async () => undefined,
  createConversation: async (jid: string) => {
    const state = useChatStore.getState();
    const session: AgentInfo = {
      id: `${state.groups[jid].folder}-new`,
      name: '新会话',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
    };
    useChatStore.setState({
      agents: {
        ...state.agents,
        [jid]: [session, ...(state.agents[jid] ?? [])],
      },
    });
    return session;
  },
  deleteAgentAction: async (jid: string, agentId: string) => {
    const state = useChatStore.getState();
    useChatStore.setState({
      agents: {
        ...state.agents,
        [jid]: (state.agents[jid] ?? []).filter((a) => a.id !== agentId),
      },
    });
    return true;
  },
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
      <ConfirmHost />
    </TooltipProvider>
  </MotionProvider>,
);
