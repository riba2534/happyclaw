// Scroll-position harness for the chat transcript: mocked stores, synthetic
// history, an older-page loader and hooks for pushing new messages.
//   ?n=60            messages in the first page
//   &late=1          first page arrives 400ms after mount
//   &hasMore=1       older pages are available (30 per page, 3 pages)
//   &slowImage=1     the newest reply embeds an image served late by the test
// window.__chatScroll also drives a streamed reply: startStreaming() appends a
// sentence every intervalMs, finishStreaming() swaps the stream for its final
// message in one store update, as a completed reply does.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatView } from '../../src/components/chat/ChatView';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import {
  useChatStore,
  type Message,
  type StreamingState,
} from '../../src/stores/chat';
import { useFileStore } from '../../src/stores/files';
import '../../src/styles/globals.css';

const params = new URLSearchParams(window.location.search);
const pageSize = Number(params.get('n') ?? 60);
const late = params.get('late') === '1';
const slowImage = params.get('slowImage') === '1';
const olderPages = params.get('hasMore') === '1' ? 3 : 0;
const groupJid = 'web:e2e-scroll';
const userId = 'scroll-user';

const user: UserPublic = {
  id: userId,
  username: 'scroll',
  display_name: '滚动测试',
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

const base = Date.parse('2026-06-01T08:00:00.000Z');
let sequence = 1_000;

function makeMessage(index: number, page: number): Message {
  const fromAgent = index % 2 === 1;
  const id = `p${page}-m${index}`;
  return {
    id,
    chat_jid: groupJid,
    sender: fromAgent ? 'happyclaw-agent' : userId,
    sender_name: fromAgent ? '测试智能体' : '滚动测试',
    content: fromAgent
      ? `第 ${page} 页第 ${index} 条回复。\n\n${'回复正文用于撑开行高。'.repeat(8)}`
      : `第 ${page} 页第 ${index} 条提问`,
    // Older pages sit before the first page in time.
    timestamp: new Date(
      base - page * 86_400_000 + index * 60_000,
    ).toISOString(),
    is_from_me: fromAgent,
    ingest_sequence: page * -100 + index + 500,
    ...(fromAgent
      ? { source_kind: 'sdk_final', finalization_reason: 'completed' }
      : {}),
  } as Message;
}

function page(pageIndex: number, count: number): Message[] {
  return Array.from({ length: count }, (_, index) =>
    makeMessage(index, pageIndex),
  );
}

function firstPage(): Message[] {
  const messages = page(0, pageSize);
  if (slowImage) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = {
      ...last,
      is_from_me: true,
      sender: 'happyclaw-agent',
      content: '附上图表：\n\n![图表](https://e2e.invalid/slow-chart.svg)',
    };
  }
  return messages;
}

const emptyStream: StreamingState = {
  partialText: '',
  thinkingText: '',
  isThinking: false,
  activeTools: [],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [],
  taskStates: {},
  todos: [],
};
let streamTimer: number | null = null;
let streamedSentences = 0;

function appendStreamText(text: string) {
  useChatStore.setState((s) => {
    const current = s.streaming[groupJid] ?? emptyStream;
    return {
      streaming: {
        ...s.streaming,
        [groupJid]: { ...current, partialText: current.partialText + text },
      },
    };
  });
}

let loadedOlderPages = 0;
const state = {
  loadedOlderPages: () => loadedOlderPages,
  /** Appends an agent reply, or a system row (e.g. `agent_error:…`). */
  pushMessage(content: string, sender = 'happyclaw-agent') {
    useChatStore.setState((s) => ({
      messages: {
        ...s.messages,
        [groupJid]: [
          ...(s.messages[groupJid] ?? []),
          {
            id: `new-${sequence++}`,
            chat_jid: groupJid,
            sender,
            sender_name: '测试智能体',
            content,
            timestamp: new Date(base + 86_400_000).toISOString(),
            is_from_me: true,
            source_kind: 'sdk_final',
            finalization_reason: 'completed',
          } as Message,
        ],
      },
    }));
  },
  startStreaming(intervalMs = 100, initialText = '') {
    if (streamTimer !== null) window.clearInterval(streamTimer);
    streamedSentences = 0;
    useChatStore.setState((s) => ({
      waiting: { ...s.waiting, [groupJid]: true },
      activeRuns: {
        ...s.activeRuns,
        [groupJid]: {
          chatJid: groupJid,
          runId: 'e2e-run',
          startedAt: new Date().toISOString(),
          phase: 'running',
        },
      },
      streaming: {
        ...s.streaming,
        [groupJid]: { ...emptyStream, partialText: initialText },
      },
    }));
    if (intervalMs <= 0) return;
    streamTimer = window.setInterval(() => {
      streamedSentences += 1;
      appendStreamText(`第 ${streamedSentences} 句流式输出内容。\n\n`);
    }, intervalMs);
  },
  /** Ends the stream; with finalize, its text becomes the final reply. */
  finishStreaming(finalize = true) {
    if (streamTimer !== null) window.clearInterval(streamTimer);
    streamTimer = null;
    useChatStore.setState((s) => {
      const text = s.streaming[groupJid]?.partialText ?? '';
      const streaming = { ...s.streaming };
      delete streaming[groupJid];
      const activeRuns = { ...s.activeRuns };
      delete activeRuns[groupJid];
      return {
        waiting: { ...s.waiting, [groupJid]: false },
        activeRuns,
        streaming,
        messages:
          finalize && text
            ? {
                ...s.messages,
                [groupJid]: [
                  ...(s.messages[groupJid] ?? []),
                  {
                    id: `final-${sequence++}`,
                    chat_jid: groupJid,
                    sender: 'happyclaw-agent',
                    sender_name: '测试智能体',
                    content: text,
                    timestamp: new Date(base + 86_400_000).toISOString(),
                    is_from_me: true,
                    source_kind: 'sdk_final',
                    finalization_reason: 'completed',
                  } as Message,
                ],
              }
            : s.messages,
      };
    });
  },
};
Object.assign(window, { __chatScroll: state });

useAuthStore.setState({
  authenticated: true,
  user,
  initialized: true,
  checking: false,
});

useChatStore.setState({
  groups: {
    [groupJid]: {
      name: '滚动测试工作区',
      folder: 'e2e-scroll',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode: 'assistant',
      kind: 'web',
      is_home: false,
      is_my_home: false,
      can_modify: true,
      execution_mode: 'host',
      agent_profile_name: '测试智能体',
    },
  },
  currentGroup: groupJid,
  messages: late ? {} : { [groupJid]: firstPage() },
  waiting: {},
  hasMore: { [groupJid]: olderPages > 0 },
  agents: { [groupJid]: [] },
  activeAgentTab: { [groupJid]: null },
  agentMessages: {},
  agentWaiting: {},
  agentHasMore: {},
  followUps: { [groupJid]: [] },
  loading: false,
  loadMessages: async (jid: string, loadMore?: boolean) => {
    if (!loadMore) {
      if (!late) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
      useChatStore.setState((s) => ({
        messages: { ...s.messages, [jid]: firstPage() },
      }));
      return;
    }
    if (loadedOlderPages >= olderPages) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    loadedOlderPages += 1;
    const older = page(loadedOlderPages, 30);
    useChatStore.setState((s) => ({
      messages: {
        ...s.messages,
        [jid]: [...older, ...(s.messages[jid] ?? [])],
      },
      hasMore: { ...s.hasMore, [jid]: loadedOlderPages < olderPages },
    }));
  },
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
  <MemoryRouter initialEntries={['/chat/e2e-scroll']}>
    <main className="h-[100dvh] overflow-hidden bg-background">
      <ChatView groupJid={groupJid} />
    </main>
  </MemoryRouter>,
);
