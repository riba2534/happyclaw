// The signed-in app shell (AppLayout + ChatPage) on mocked stores: the
// primary agent's home workspace and two others (one pinned), a custom agent
// with one workspace and one with two. `?route=` picks the first entry;
// other pages are stubs naming their path, except /settings which is real.
// A hidden probe shows the current route. Nothing here talks to a backend.
// `?router=hash` runs on the real browser history (a hash router; the route
// is the URL's hash) for specs that count history entries. The WebSocket
// counts as connected; `window.__shellWs.emit('disconnected')` and
// `('connected')` drive the connection notices.
import { createRoot } from 'react-dom/client';
import {
  HashRouter,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router-dom';
import { AppLayout } from '../../src/components/layout/AppLayout';
import { ChatPage } from '../../src/pages/ChatPage';
import { SettingsPage } from '../../src/pages/SettingsPage';
import { SettingsStickySaveBar } from '../../src/components/settings/SettingsFormControls';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { Toaster } from '../../src/components/ui/sonner';
import { wsManager } from '../../src/api/ws';
import { useAgentProfilesStore } from '../../src/stores/agent-profiles';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import { useBillingStore } from '../../src/stores/billing';
import { useChatStore } from '../../src/stores/chat';
import { useGroupsStore } from '../../src/stores/groups';
import type { AgentInfo, GroupInfo } from '../../src/types';
import '../../src/styles/globals.css';

const params = new URLSearchParams(window.location.search);
const initialRoute = params.get('route') || '/chat';
const billing = params.get('billing') === '1';
const hashRouter = params.get('router') === 'hash';

let wsConnected = true;
wsManager.connect = () => undefined;
wsManager.isConnected = () => wsConnected;
(window as unknown as { __shellWs: unknown }).__shellWs = {
  emit(type: 'connected' | 'disconnected') {
    wsConnected = type === 'connected';
    (wsManager as unknown as { emit: (t: string, d: unknown) => void }).emit(
      type,
      {},
    );
  },
};

const user: UserPublic = {
  id: 'shell-user',
  username: 'shell',
  display_name: '外壳测试',
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

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function workspace(
  folder: string,
  name: string,
  minutes: number,
  extra: Partial<GroupInfo> = {},
): GroupInfo {
  return {
    name,
    folder,
    added_at: '2026-01-01T00:00:00.000Z',
    interaction_mode: 'assistant',
    kind: 'web',
    is_home: false,
    is_my_home: false,
    can_modify: true,
    execution_mode: 'host',
    agent_profile_name: 'HappyClaw',
    lastMessageTime: minutesAgo(minutes),
    ...extra,
  } as GroupInfo;
}

const postAgent = {
  agent_profile_id: 'agent-post',
  agent_profile_name: '地址证明助手',
  agent_profile_avatar_emoji: '📮',
  agent_profile_avatar_color: '#2196F3',
};
const billAgent = {
  agent_profile_id: 'agent-bill',
  agent_profile_name: 'AI账单助手',
  agent_profile_avatar_emoji: '🧾',
  agent_profile_avatar_color: '#4CAF50',
};

function sessions(folder: string, count = 2): AgentInfo[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      id: `${folder}-s${n}`,
      name: `${folder} 会话 ${n}`,
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_at: '2026-01-01T00:00:00.000Z',
      last_active_at: minutesAgo(n * 3),
      latest_message: {
        content: `${folder} 会话 ${n} 的最后一条消息，内容足够长以便在一行内被截断显示`,
        timestamp: minutesAgo(n * 3),
      },
    };
  });
}

useAuthStore.setState({
  authenticated: true,
  user,
  initialized: true,
  checking: false,
});
useBillingStore.setState({
  billingEnabled: billing,
  loadBillingStatus: async () => undefined,
} as never);
useGroupsStore.setState({
  runnerStates: {},
  loadGroups: async () => undefined,
} as never);
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
    profile('agent-post', '地址证明助手'),
    profile('agent-bill', 'AI账单助手'),
  ],
  loading: false,
  profilesError: null,
  loadProfiles: async () => undefined,
});

const groups: Record<string, GroupInfo> = {
  'web:main': workspace('main', 'HappyClaw', 30, {
    is_home: true,
    is_my_home: true,
  }),
  'web:alpha': workspace('alpha', 'Alpha 工作区', 10),
  'web:beta': workspace('beta', 'Beta 工作区', 20, {
    pinned_at: minutesAgo(600),
  }),
  'web:post': workspace('post', '邮寄', 40, postAgent),
  'web:bill1': workspace('bill1', '账单一', 50, billAgent),
  'web:bill2': workspace('bill2', '账单二', 60, billAgent),
};

useChatStore.setState({
  groups,
  currentGroup: null,
  agents: {
    'web:main': sessions('main'),
    'web:alpha': sessions('alpha', 7),
    'web:beta': sessions('beta'),
    'web:post': sessions('post', 1),
    'web:bill1': sessions('bill1'),
    'web:bill2': sessions('bill2'),
  },
  unreadReplies: { 'web:alpha': 2 },
  activeAgentTab: {},
  agentMessages: {},
  agentWaiting: {},
  agentHasMore: {},
  followUps: {},
  loading: false,
  loadGroups: async () => undefined,
  restoreActiveState: async () => undefined,
  loadAgents: async () => undefined,
  loadFollowUps: async () => undefined,
  markChatRead: () => undefined,
  togglePin: async (jid: string) => {
    const state = useChatStore.getState();
    const group = state.groups[jid];
    useChatStore.setState({
      groups: {
        ...state.groups,
        [jid]: {
          ...group,
          pinned_at: group.pinned_at ? undefined : new Date().toISOString(),
        },
      },
    });
  },
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
    <output data-testid="route" className="sr-only">
      {location.pathname + location.search}
    </output>
  );
}

/** A page that names its path; /save-bar adds a settings save footer. */
function StubPage() {
  const location = useLocation();
  const { '*': rest } = useParams();
  const withSaveBar = location.pathname === '/save-bar';
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-title-lg text-foreground">页面 /{rest}</h1>
      {withSaveBar && (
        <>
          {Array.from({ length: 40 }, (_, index) => (
            <p key={index} className="py-2 text-body">
              设置项 {index + 1}
            </p>
          ))}
          <SettingsStickySaveBar status="有未保存的修改">
            <button type="button">保存</button>
          </SettingsStickySaveBar>
        </>
      )}
    </div>
  );
}

const routes = (
  <>
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/chat/:groupFolder?" element={<ChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<StubPage />} />
      </Route>
    </Routes>
    <RouteProbe />
    <Toaster />
    <ConfirmHost />
  </>
);

createRoot(document.getElementById('root')!).render(
  hashRouter ? (
    <HashRouter>{routes}</HashRouter>
  ) : (
    <MemoryRouter initialEntries={[initialRoute]}>{routes}</MemoryRouter>
  ),
);
