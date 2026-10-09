// Visual harness for the chat canvas: renders ChatView with representative
// history, streaming and queue states from mocked stores (no backend).
//   ?scenario=history | streaming | waiting | empty | proactive
//   &display=compact   &theme=dark   &scheme=default|neutral
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatView } from '../../src/components/chat/ChatView';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { MotionProvider } from '../../src/lib/motion';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import {
  useChatStore,
  type Message,
  type QueuedFollowUp,
  type StreamingState,
} from '../../src/stores/chat';
import { useFileStore } from '../../src/stores/files';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import '../../src/styles/globals.css';

const params = new URLSearchParams(window.location.search);
const scenario = params.get('scenario') ?? 'streaming';
const theme = params.get('theme');
const scheme = params.get('scheme');
const root = document.documentElement;
root.classList.toggle('dark', theme === 'dark');
root.classList.toggle('theme-neutral', scheme === 'neutral');
root.classList.toggle('theme-orange', !scheme || scheme === 'orange');

const groupJid = 'web:render-harness';
const userId = 'harness-user';
if (params.get('display') === 'compact') {
  localStorage.setItem(`happyclaw-display-mode:${userId}`, 'compact');
} else {
  localStorage.removeItem(`happyclaw-display-mode:${userId}`);
}

const user: UserPublic = {
  id: userId,
  username: 'riba2534',
  display_name: 'riba2534',
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

const now = Date.now();
const at = (minutesAgo: number) =>
  new Date(now - minutesAgo * 60_000).toISOString();

const swatch = btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#e9e5dc"/><circle cx="110" cy="100" r="54" fill="#d97757"/><rect x="180" y="58" width="100" height="84" rx="12" fill="#6b7f8f"/></svg>',
);

const richMarkdown = [
  '已定位到问题：侧栏订阅了整个 `useChatStore`，流式 delta 每帧都会触发重渲染。',
  '',
  '## 修复方案',
  '',
  '1. 改为**窄 selector**，只订阅需要的字段',
  '2. 运行中会话 id 拼成字符串比较，避免引用变化',
  '3. 为会话行加 `memo`',
  '',
  '```ts',
  'const groups = useChatStore((s) => s.groups);',
  'const activeIds = useChatStore((s) =>',
  '  agents.filter((a) => s.agentWaiting[a.id]).map((a) => a.id).join(","),',
  ');',
  '```',
  '',
  '| 方案 | 重渲染次数 | 复杂度 |',
  '| --- | --- | --- |',
  '| 整 store 订阅 | 每帧 | 低 |',
  '| 窄 selector | 仅相关变化 | 低 |',
  '| 拆分 store | 最少 | 高 |',
  '',
  '> 窄 selector 改动最小，收益最明显。',
  '',
  '验证命令：',
  '',
  '```bash',
  'npx vitest run tests/frontend-session-sidebar-copy.test.ts',
  'make typecheck && make build',
  '```',
  '',
  '复杂度从 $O(n \\cdot k)$ 降到 $O(k)$，其中 $k$ 为变化的会话数。参考 [React 文档](https://react.dev)。',
  '',
  '- [x] 侧栏改为窄订阅',
  '- [ ] 会话列表虚拟滚动',
].join('\n');

const workflowRun = {
  taskId: 'wf-1',
  workflowName: 'code-review',
  summary: '并行审查 3 个模块并汇总结论',
  status: 'completed' as const,
  durationMs: 94_000,
  agentCount: 3,
  totalTokens: 48_200,
  totalToolCalls: 37,
  phases: [
    { index: 0, title: '分析变更' },
    { index: 1, title: '并行审查' },
    { index: 2, title: '汇总' },
  ],
  agents: [
    {
      index: 0,
      label: '架构审查',
      phaseIndex: 1,
      state: 'done' as const,
      resultPreview: '未发现结构问题',
    },
    {
      index: 1,
      label: '安全审查',
      phaseIndex: 1,
      state: 'done' as const,
      resultPreview: '1 处输入未转义',
    },
    {
      index: 2,
      label: '性能审查',
      phaseIndex: 1,
      state: 'done' as const,
      resultPreview: '列表渲染可虚拟化',
    },
  ],
};

const msg = (
  id: string,
  minutesAgo: number,
  fromAgent: boolean,
  content: string,
  extra: Partial<Message> = {},
): Message => ({
  id,
  chat_jid: groupJid,
  sender: fromAgent ? 'happyclaw-agent' : userId,
  sender_name: fromAgent ? 'HappyClaw' : 'riba2534',
  content,
  timestamp: at(minutesAgo),
  is_from_me: fromAgent,
  ...(fromAgent
    ? { source_kind: 'sdk_final', finalization_reason: 'completed' }
    : {}),
  ...extra,
});

const usage = (input: number, output: number, durationMs: number) =>
  JSON.stringify({ inputTokens: input, outputTokens: output, durationMs });

const history: Message[] =
  scenario === 'empty'
    ? []
    : [
        msg('m1', 60 * 26, false, '昨天那个侧栏重渲染的问题有结论了吗？'),
        msg('m2', 60 * 26 - 1, true, '有的，结论见下一条。', {
          token_usage: usage(1200, 80, 2100),
        }),
        msg(
          'm3',
          42,
          false,
          '帮我看看侧栏组件为什么在流式输出时会频繁重渲染？顺便看下这张截图里的布局问题。',
          {
            attachments: JSON.stringify([
              {
                type: 'image',
                data: swatch,
                mimeType: 'image/svg+xml',
                name: 'layout.svg',
              },
            ]),
          },
        ),
        msg('m4', 41, true, richMarkdown, {
          token_usage: usage(18_200, 4_120, 48_400),
          workflow_runs: [workflowRun],
        }),
        msg('sys1', 30, false, 'context_reset', { sender: '__system__' }),
        msg('m5', 29, false, '/spawn 并行检查所有页面的暗色模式对比度'),
        msg(
          'm6',
          20,
          true,
          'context_overflow: 上下文超过模型上限（212k / 200k tokens），请使用 /fresh 开启新窗口。',
          {
            sender: '__system__',
          },
        ),
        msg(
          'err1',
          19,
          false,
          'agent_error:Container exited with code 137 (OOM)',
          {
            sender: '__system__',
          },
        ),
        msg(
          'm7',
          12,
          false,
          '那继续把会话列表也改成虚拟滚动吧，注意保持现在的排序规则，另外移动端也要同步验证一下滚动性能，长列表大概会有 1000 个会话。',
        ),
        msg(
          'm8',
          11,
          true,
          '已经完成：会话列表现在使用 `@tanstack/react-virtual`，预估行高 48px。\n\n- 1000 个会话时首屏渲染从 **320ms** 降到 **18ms**\n- 滚动帧率稳定在 60fps',
          {
            token_usage: usage(2_310, 188, 5_200),
          },
        ),
      ];

const streaming: StreamingState = {
  partialText:
    '正在把会话列表改成虚拟滚动。目前已经替换了 `SessionSidebar` 的渲染循环，接下来验证',
  thinkingText:
    '用户希望保持排序。现有排序基于 last_active_at，虚拟列表只负责渲染，不影响排序。需要注意行高估算与实际高度不一致时的滚动跳动……',
  isThinking: scenario === 'streaming',
  thinkingDurationMs: 7_800,
  activeTools: [
    {
      toolName: 'Bash',
      toolUseId: 't1',
      startTime: now - 12_000,
      toolInputSummary:
        "bash -lc 'npx vitest run tests/frontend-session-sidebar-copy.test.ts'",
    },
    {
      toolName: 'Read',
      toolUseId: 't2',
      startTime: now - 3_000,
      toolInputSummary:
        '/workspace/group/happyclaw/web/src/components/chat/SessionSidebar.tsx',
    },
    {
      toolName: 'Skill',
      skillName: 'ui-optimizer',
      toolUseId: 't3',
      startTime: now - 1_000,
      isNested: true,
    },
  ],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [
    {
      id: 'tr1',
      timestamp: now - 30_000,
      kind: 'tool',
      title: 'Grep',
      summary: 'useVirtualizer in web/src',
    },
    {
      id: 'tr2',
      timestamp: now - 25_000,
      kind: 'tool',
      title: 'Edit',
      summary: 'SessionSidebar.tsx (+42 −18)',
    },
    {
      id: 'tr3',
      timestamp: now - 20_000,
      kind: 'permission',
      title: 'Bash',
      summary: 'rm -rf node_modules',
      detail: '被权限策略拒绝',
    },
  ],
  taskStates: {
    task1: {
      id: 'task1',
      title: '检查移动端滚动性能',
      status: 'running',
      subagentType: 'general-purpose',
      thinkingTail: '',
      textTail: '正在用 Playwright 录制 390×844 下的滚动帧率…',
      activeTools: [],
      recentTools: [],
      lastToolName: 'Bash',
      updatedAt: now - 2_000,
    },
  },
  todos: [
    { id: '1', content: '替换渲染循环为虚拟列表', status: 'completed' },
    { id: '2', content: '保持 last_active_at 排序', status: 'completed' },
    { id: '3', content: '移动端滚动性能验证', status: 'in_progress' },
    { id: '4', content: '补充回归测试', status: 'pending' },
  ],
};

const followUps: QueuedFollowUp[] =
  scenario === 'streaming'
    ? [
        {
          id: 'q1',
          chat_jid: groupJid,
          sender: userId,
          sender_name: 'riba2534',
          content: '做完以后顺便把 FilePanel 的列表也检查一下',
          timestamp: at(1),
          delivery_mode: 'queue',
          delivery_status: 'queued',
          delivery_priority: 0,
        },
        {
          id: 'q2',
          chat_jid: groupJid,
          sender: userId,
          sender_name: 'riba2534',
          content: '还有暗色模式下的对比度',
          timestamp: at(0),
          delivery_mode: 'queue',
          delivery_status: 'queued',
          delivery_priority: 0,
        },
      ]
    : [];

useAuthStore.setState({
  authenticated: true,
  user,
  initialized: true,
  checking: false,
});

const isRunning =
  scenario === 'streaming' ||
  scenario === 'waiting' ||
  scenario === 'proactive';

useChatStore.setState({
  groups: {
    [groupJid]: {
      name: '前端重构',
      folder: 'render-harness',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode: scenario === 'proactive' ? 'proactive' : 'assistant',
      kind: 'web',
      is_home: false,
      is_my_home: false,
      can_modify: true,
      execution_mode: 'host',
      agent_profile_name: 'HappyClaw',
    },
  },
  currentGroup: groupJid,
  messages: { [groupJid]: history },
  waiting: isRunning ? { [groupJid]: true } : {},
  activeRuns: isRunning
    ? {
        [groupJid]: {
          chatJid: groupJid,
          runId: 'run-harness',
          startedAt: new Date(now - 47_000).toISOString(),
          phase: 'running',
        },
      }
    : {},
  streaming: scenario === 'streaming' ? { [groupJid]: streaming } : {},
  thinkingCache: { m4: '先确认订阅范围，再比较几种方案的复杂度与收益。' },
  thinkingDurationCache: { m4: 12_400 },
  hasMore: { [groupJid]: false },
  agents: { [groupJid]: [] },
  activeAgentTab: { [groupJid]: null },
  agentMessages: {},
  agentWaiting: {},
  agentHasMore: {},
  followUps: { [groupJid]: followUps },
  loading: false,
  loadMessages: async () => undefined,
  refreshMessages: async () => undefined,
  restoreActiveState: async () => undefined,
  loadAgents: async () => undefined,
  loadFollowUps: async () => undefined,
  markChatRead: () => undefined,
});

useFileStore.setState({
  files: { [groupJid]: [] },
  currentPath: { [groupJid]: '' },
  loading: false,
  error: null,
  loadFiles: async () => undefined,
  navigateTo: () => undefined,
});

createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <TooltipProvider>
      <MemoryRouter initialEntries={['/chat/render-harness']}>
        <main className="h-[100dvh] overflow-hidden bg-background">
          <ChatView groupJid={groupJid} />
        </main>
      </MemoryRouter>
      <ConfirmHost />
    </TooltipProvider>
  </MotionProvider>,
);
