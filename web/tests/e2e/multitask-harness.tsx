// Multi-task mode (多任务模式) on a hash router: a multi-task workspace's
// chat with the tasks its session delegated, a single-task workspace beside
// it, the 工作项 page in the app shell and the create-workspace dialog. Work
// items, stops and saves go to /api, which the spec answers. A hidden probe
// shows the route.
//   ?role=guest   a read-only guest
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RouterProvider,
  createHashRouter,
  useLocation,
  useParams,
} from 'react-router-dom';
import { wsManager } from '../../src/api/ws';
import { ChatView } from '../../src/components/chat/ChatView';
import { CreateContainerDialog } from '../../src/components/chat/CreateContainerDialog';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { AppLayout } from '../../src/components/layout/AppLayout';
import { Toaster } from '../../src/components/ui/sonner';
import { MotionProvider } from '../../src/lib/motion';
import { WorkItemsPage } from '../../src/pages/WorkItemsPage';
import { useAgentProfilesStore } from '../../src/stores/agent-profiles';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import { useAutomationsStore } from '../../src/stores/automations';
import { useBillingStore } from '../../src/stores/billing';
import { useChatStore, type Message } from '../../src/stores/chat';
import { useGroupsStore } from '../../src/stores/groups';
import { useMcpServersStore } from '../../src/stores/mcp-servers';
import { useSkillsStore } from '../../src/stores/skills';
import type { AgentInfo, AgentProfile, GroupInfo } from '../../src/types';
import '../../src/styles/globals.css';

wsManager.connect = () => undefined;

const guest =
  new URLSearchParams(window.location.search).get('role') === 'guest';

useAuthStore.setState({
  authenticated: true,
  user: {
    id: 'mt-user',
    username: 'owner',
    display_name: '多任务测试',
    role: guest ? 'guest' : 'member',
    status: 'active',
    permissions: [],
  } as unknown as UserPublic,
  initialized: true,
  checking: false,
});
useBillingStore.setState({
  billingEnabled: false,
  loadBillingStatus: async () => undefined,
} as never);
useGroupsStore.setState({
  runnerStates: {},
  loadGroups: async () => undefined,
} as never);
useSkillsStore.setState({ skills: [], loadSkills: async () => undefined });
useMcpServersStore.setState({ loadServers: async () => undefined } as never);
useAutomationsStore.setState({
  automations: [],
  loaded: true,
  loadAutomations: async () => undefined,
} as never);
useAgentProfilesStore.setState({
  profiles: [
    {
      id: 'main-profile',
      name: '主智能体',
      is_default: true,
      identity_prompt: '',
      runtime_policy: { skills: {} },
    } as unknown as AgentProfile,
  ],
  loading: false,
  profilesError: null,
  loadProfiles: async () => undefined,
} as never);

const workspace = (
  name: string,
  folder: string,
  work_mode: 'single' | 'multi',
): GroupInfo => ({
  name,
  folder,
  added_at: '2026-01-01T00:00:00.000Z',
  interaction_mode: 'assistant',
  work_mode,
  kind: 'web',
  is_home: false,
  can_modify: !guest,
  read_only: guest,
  execution_mode: 'container',
  agent_profile_name: '主智能体',
});

const session = (
  id: string,
  name: string,
  source_kind?: AgentInfo['source_kind'],
): AgentInfo => ({
  id,
  name,
  prompt: '',
  status: 'idle',
  kind: 'conversation',
  created_at: '2026-11-01T00:00:00.000Z',
  source_kind,
});

const turn = (jid: string, ask: string, answer: string): Message[] => [
  {
    id: `${jid}-ask`,
    chat_jid: jid,
    sender: 'mt-user',
    sender_name: '多任务测试',
    content: ask,
    timestamp: '2026-11-01T04:00:00.000Z',
    is_from_me: false,
  },
  {
    id: `${jid}-answer`,
    chat_jid: jid,
    sender: 'happyclaw-agent',
    sender_name: '主智能体',
    content: answer,
    timestamp: '2026-11-01T04:01:00.000Z',
    is_from_me: true,
    source_kind: 'sdk_final',
  },
];

const JIDS: Record<string, string> = { alpha: 'web:alpha', solo: 'web:solo' };

useChatStore.setState({
  groups: {
    'web:alpha': workspace('Alpha 工作区', 'alpha', 'multi'),
    'web:solo': workspace('单任务工作区', 'solo', 'single'),
  },
  agents: {
    'web:alpha': [
      session('main', '需求梳理'),
      session('worker-3', '整理接口文档', 'work_item'),
      session('worker-4', '对比两套方案', 'work_item'),
    ],
    'web:solo': [session('solo-main', '日常')],
  },
  agentMessages: {
    main: turn(
      'web:alpha#agent:main',
      '把接口文档整理一下，再对比两套缓存方案',
      '已派出 #3 整理接口文档、#4 对比两套方案，完成后我来汇报。',
    ),
    'worker-3': [],
    'solo-main': turn('web:solo#agent:solo-main', '你好', '你好！'),
  },
  agentWaiting: {},
  agentHasMore: { main: false, 'worker-3': false, 'solo-main': false },
  followUps: {},
  loading: false,
  loadGroups: async () => undefined,
  loadAgents: async () => undefined,
  loadAgentMessages: async () => undefined,
  hydrateAgentMessages: async () => undefined,
  refreshAgentMessages: async () => undefined,
  restoreActiveState: async () => undefined,
  loadFollowUps: async () => undefined,
  markChatRead: () => undefined,
});

function ChatRoute() {
  const { groupFolder = 'alpha' } = useParams();
  const jid = JIDS[groupFolder];
  return (
    <main className="h-[100dvh] overflow-hidden bg-background">
      <ChatView key={jid} groupJid={jid} />
    </main>
  );
}

function CreateRoute() {
  const [created, setCreated] = useState('');
  return (
    <div className="p-4">
      <output data-testid="created">{created}</output>
      <CreateContainerDialog
        open={!created}
        onClose={() => undefined}
        onCreated={(jid) => setCreated(jid)}
      />
    </div>
  );
}

function RouteProbe() {
  const location = useLocation();
  return (
    <output data-testid="route" className="sr-only">
      {location.pathname + location.search}
    </output>
  );
}

function Shell() {
  return (
    <>
      <AppLayout />
      <RouteProbe />
    </>
  );
}

const router = createHashRouter([
  {
    element: <Shell />,
    children: [{ path: '/work/:itemId?', element: <WorkItemsPage /> }],
  },
  {
    path: '/chat/:groupFolder?',
    element: (
      <>
        <ChatRoute />
        <RouteProbe />
      </>
    ),
  },
  { path: '/create', element: <CreateRoute /> },
]);

createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <RouterProvider router={router} />
    <Toaster />
    <ConfirmHost />
  </MotionProvider>,
);
