// The workspace pages (智能体, 记忆, 自动化) and the file panel inside the
// signed-in app shell, on a hash router so system back walks real history.
// Agents, automations and files come from mocked stores; the memory page
// talks to /api, which the spec answers. A hidden probe shows the route.
//   ?automations=0  the automations page starts with none (its empty state)
import { createRoot } from 'react-dom/client';
import {
  RouterProvider,
  createHashRouter,
  useLocation,
} from 'react-router-dom';
import { AppLayout } from '../../src/components/layout/AppLayout';
import { AgentProfilesPage } from '../../src/pages/AgentProfilesPage';
import { MemoryPage } from '../../src/pages/MemoryPage';
import { AutomationsPage } from '../../src/pages/AutomationsPage';
import { FilePanel } from '../../src/components/chat/FilePanel';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { Toaster } from '../../src/components/ui/sonner';
import { wsManager } from '../../src/api/ws';
import { useAgentProfilesStore } from '../../src/stores/agent-profiles';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import { useAutomationsStore } from '../../src/stores/automations';
import { useBillingStore } from '../../src/stores/billing';
import { useChatStore } from '../../src/stores/chat';
import { useFileStore, type FileEntry } from '../../src/stores/files';
import { useGroupsStore } from '../../src/stores/groups';
import { useMcpServersStore } from '../../src/stores/mcp-servers';
import { useSkillsStore } from '../../src/stores/skills';
import type { Automation } from '../../src/lib/automation';
import type { GroupInfo } from '../../src/types';
import '../../src/styles/globals.css';

wsManager.connect = () => undefined;

useAuthStore.setState({
  authenticated: true,
  user: {
    id: 'pages-user',
    username: 'pages',
    display_name: '页面测试',
    role: 'admin',
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

const group = {
  name: 'Alpha 工作区',
  folder: 'alpha',
  added_at: '2026-01-01T00:00:00.000Z',
  interaction_mode: 'assistant',
  kind: 'web',
  is_home: true,
  is_my_home: true,
  can_modify: true,
  execution_mode: 'host',
} as GroupInfo;
useChatStore.setState({
  groups: { 'web:alpha': group },
  agents: { 'web:alpha': [] },
  loadGroups: async () => undefined,
  loadAgents: async () => undefined,
});

// ─── Agents ──────────────────────────────────────────────────────

function agentProfile(id: string, name: string, identity: string) {
  return {
    id,
    owner_user_id: 'pages-user',
    name,
    identity_prompt: identity,
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
    prompt_mode: 'append',
    include_claude_preset: true,
    avatar_emoji: null,
    avatar_color: null,
    avatar_url: null,
    model_config_id: null,
    model: null,
    runtime_policy: {
      reasoning: { effort: 'inherit' },
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 80,
      },
      skills: { mode: 'inherit', ids: [], host: { mode: 'custom', ids: [] } },
      mcp: { mode: 'inherit', ids: [] },
    },
    identity_hash: `hash-${id}`,
    version: 1,
    is_default: false,
    status: 'active',
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
  };
}
const profiles = [
  { ...agentProfile('main', 'HappyClaw', ''), is_default: true },
  agentProfile(
    'research',
    '调研智能体',
    '负责收集公开资料，整理成带出处的调研报告，并标出仍需核实的结论。',
  ),
  agentProfile('billing', '账单助手', '核对每月账单和发票。'),
  ...Array.from({ length: 8 }, (_, index) =>
    agentProfile(`extra-${index}`, `备用智能体 ${index + 1}`, ''),
  ),
];
const governance = (id: string) => ({
  profile: profiles.find((profile) => profile.id === id),
  workspaces: [],
  channel_mounts: [],
  runtime_cleanup_pending: false,
});
useAgentProfilesStore.setState({
  profiles: profiles as never,
  modelConfigs: [],
  loading: false,
  profilesError: null,
  loadProfiles: async () => undefined,
  loadProfileGovernance: (async (id: string) => {
    const value = governance(id);
    useAgentProfilesStore.setState((state) => ({
      governanceByProfile: { ...state.governanceByProfile, [id]: value },
    }));
    return value;
  }) as never,
} as never);

// ─── Automations ─────────────────────────────────────────────────

function automation(id: string, name: string): Automation {
  return {
    id,
    workspaceJid: 'web:alpha',
    workspaceFolder: 'alpha',
    workspaceName: 'Alpha 工作区',
    createdBy: 'pages-user',
    name,
    prompt: '检查仓库里新的 issue',
    stopWhen: null,
    schedule: {
      kind: 'cron',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    },
    endAt: null,
    sessionMode: 'fresh',
    targetSessionJid: null,
    deliveryRouteJid: null,
    silentWhenIdle: false,
    preRunCheck: null,
    execution: 'agent',
    scriptCommand: null,
    status: 'active',
    statusReason: null,
    nextFireAt: '2026-11-01T01:00:00.000Z',
    lastFiredAt: null,
    lastFinishedAt: null,
    revision: 1,
    createdAt: `2026-10-0${id.length % 9}T00:00:00.000Z`,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}
const runNowCalls: string[] = [];
(window as unknown as { runNowCalls: string[] }).runNowCalls = runNowCalls;
const noAutomations =
  new URLSearchParams(window.location.search).get('automations') === '0';
useAutomationsStore.setState({
  automations: noAutomations
    ? []
    : [
        automation(
          'daily-issues',
          '每天早上汇总仓库里新的 issue 和待处理的 PR',
        ),
        automation('weekly', '每周账单'),
      ],
  loaded: true,
  loading: false,
  error: null,
  loadAutomations: async () => undefined,
  loadDetail: async (id: string) => {
    useAutomationsStore.setState((state) => ({
      runs: { ...state.runs, [id]: [] },
    }));
  },
  markRead: async () => undefined,
  runNow: async (id: string) => {
    runNowCalls.push(id);
  },
} as never);

// ─── Files ───────────────────────────────────────────────────────

const files: FileEntry[] = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    size: 0,
    modifiedAt: '2026-10-01T00:00:00.000Z',
    isSystem: false,
  },
  {
    name: 'a-really-long-file-name-that-needs-truncation-on-phones.md',
    path: 'a-really-long-file-name-that-needs-truncation-on-phones.md',
    type: 'file',
    size: 2048,
    modifiedAt: '2026-10-01T00:00:00.000Z',
    isSystem: false,
    editable: true,
  },
  {
    name: 'notes.txt',
    path: 'notes.txt',
    type: 'file',
    size: 12,
    modifiedAt: '2026-10-01T00:00:00.000Z',
    isSystem: false,
    editable: true,
  },
];
useFileStore.setState({
  files: { 'web:alpha': files },
  currentPath: { 'web:alpha': '' },
  loadFiles: async () => undefined,
} as never);

function FilesPage() {
  return (
    <div className="h-(--app-canvas-h) max-h-[40rem]">
      <FilePanel groupJid="web:alpha" />
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
    children: [
      { path: '/agent-profiles', element: <AgentProfilesPage /> },
      { path: '/memory', element: <MemoryPage /> },
      { path: '/automations/:automationId?', element: <AutomationsPage /> },
      { path: '/files', element: <FilesPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <>
    <RouterProvider router={router} />
    <Toaster />
    <ConfirmHost />
  </>,
);
