// Interaction harness for the chat composer: ChatView over mocked stores with
// a main conversation and two Web sessions in one workspace. Sends, uploads,
// stops and queue actions are recorded on `window.composerHarness`.
//   ?empty=1   the first session (m0) starts with no messages
//   ?statusbar=1  the composer alone over a stub list, with a status bar
//                 that shows while setStatusRunning(true)
//   ?readonly=1   the user may not change the workspace's configuration
//   ?ask=1     the composer alone under two AskUserQuestion cards
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { wsManager } from '../../src/api/ws';
import { AskUserQuestionCard } from '../../src/components/chat/AskUserQuestionCard';
import { ChatView } from '../../src/components/chat/ChatView';
import { MessageInput } from '../../src/components/chat/MessageInput';
import { Toaster } from '../../src/components/ui/sonner';
import { useVisualViewportVars } from '../../src/hooks/useVisualViewport';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import {
  useChatStore,
  type Message,
  type QueuedFollowUp,
} from '../../src/stores/chat';
import { useFileStore } from '../../src/stores/files';
import type { AgentInfo } from '../../src/types';
import '../../src/styles/globals.css';

const groupJid = 'web:e2e-composer';
/** The session the harness opens first (others: a1, a2). */
const FIRST = 'm0';
const startsEmpty =
  new URLSearchParams(window.location.search).get('empty') === '1';
const readOnly =
  new URLSearchParams(window.location.search).get('readonly') === '1';
const userId = 'composer-user';

const user: UserPublic = {
  id: userId,
  username: 'composer',
  display_name: '测试用户',
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

const at = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const history = (chatJid: string, prefix: string): Message[] =>
  Array.from({ length: 12 }, (_, index) => {
    const fromAgent = index % 2 === 1;
    return {
      id: `${prefix}-${index}`,
      chat_jid: chatJid,
      sender: fromAgent ? 'happyclaw-agent' : userId,
      sender_name: fromAgent ? 'HappyClaw' : '测试用户',
      content: fromAgent
        ? `第 ${index} 条回复：这是一段用于撑开消息区的回复内容，确认队列和输入框不会把对话挤没。`
        : `第 ${index} 条提问`,
      timestamp: at(60 - index),
      is_from_me: fromAgent,
      ...(fromAgent
        ? { source_kind: 'sdk_final', finalization_reason: 'completed' }
        : {}),
    } as Message;
  });

const session = (id: string, name: string): AgentInfo => ({
  id,
  name,
  prompt: '',
  status: 'idle',
  kind: 'conversation',
  source_kind: 'manual',
  created_at: '2026-01-01T00:00:00.000Z',
});

interface SentRecord {
  to: string;
  content: string;
  images: number;
  mode?: string;
}

const harness = {
  sent: [] as SentRecord[],
  uploads: [] as string[][],
  stops: [] as string[],
  resets: [] as Array<{ jid: string; agentId: string }>,
  /** Times ChatView handed back to the page (ChatPage's list). */
  backs: 0,
  queueActions: [] as Array<{ id: string; action: string; content?: string }>,
  sendDelayMs: 0,
  /** Open a session; null opens the first one (m0). */
  switchTo: (_id: string | null) => {},
  /** The bare composer's run state (?statusbar=1). */
  setStatusRunning: (_running: boolean) => {},
  /** Mark the visible conversation as running (or idle). */
  setRunning(running: boolean, agentId: string | null = null) {
    useChatStore.setState((s) => ({
      agentWaiting: { ...s.agentWaiting, [agentId ?? FIRST]: running },
    }));
  },
  setQueue(count: number, agentId: string | null = null, imageOnly = false) {
    const chatJid = `${groupJid}#agent:${agentId ?? FIRST}`;
    const items: QueuedFollowUp[] = Array.from({ length: count }, (_, i) => ({
      id: `q${i + 1}`,
      chat_jid: chatJid,
      sender: userId,
      sender_name: '测试用户',
      content:
        imageOnly && i === 0
          ? ''
          : `排队消息 ${i + 1}：做完以后顺便检查一下第 ${i + 1} 个模块`,
      ...(imageOnly && i === 0
        ? {
            attachments: JSON.stringify([
              {
                type: 'image',
                mimeType: 'image/svg+xml',
                data: btoa(
                  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#db2777"/></svg>',
                ),
              },
            ]),
          }
        : {}),
      timestamp: at(1),
      delivery_mode: 'queue',
      delivery_status: 'queued',
      delivery_priority: i,
    }));
    useChatStore.setState((s) => ({
      followUps: { ...s.followUps, [chatJid]: items },
    }));
  },
  drafts: () => useChatStore.getState().drafts,
  /** The server's `context_usage` push after a turn. */
  pushContextUsage(data: Record<string, unknown>) {
    (wsManager as unknown as { emit(t: string, d: unknown): void }).emit(
      'context_usage',
      { type: 'context_usage', chatJid: groupJid, agentId: FIRST, ...data },
    );
  },
  /** Adds a message from this user to the first session. */
  pushMessage(content: string) {
    useChatStore.setState((s) => ({
      agentMessages: {
        ...s.agentMessages,
        [FIRST]: [
          ...(s.agentMessages[FIRST] ?? []),
          {
            id: `pushed-${Date.now()}`,
            chat_jid: `${groupJid}#agent:${FIRST}`,
            sender: userId,
            sender_name: '测试用户',
            content,
            timestamp: new Date().toISOString(),
            is_from_me: false,
          } as Message,
        ],
      },
    }));
  },
};

const record = async (entry: SentRecord) => {
  harness.sent.push(entry);
  if (harness.sendDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, harness.sendDelayMs));
  }
  return true;
};

Object.assign(window, { composerHarness: harness });

useAuthStore.setState({
  authenticated: true,
  user,
  initialized: true,
  checking: false,
});

useChatStore.setState({
  groups: {
    [groupJid]: {
      name: '输入框测试工作区',
      folder: 'e2e-composer',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode: 'assistant',
      kind: 'web',
      is_home: false,
      is_my_home: false,
      can_modify: !readOnly,
      execution_mode: 'container',
      agent_profile_name: '测试智能体',
    },
  },
  currentGroup: groupJid,
  agents: {
    [groupJid]: [
      session(FIRST, '会话 M'),
      session('a1', '会话 A'),
      session('a2', '会话 B'),
    ],
  },
  activeAgentTab: { [groupJid]: FIRST },
  agentMessages: {
    [FIRST]: startsEmpty ? [] : history(`${groupJid}#agent:${FIRST}`, FIRST),
    a1: history(`${groupJid}#agent:a1`, 'a1'),
    a2: history(`${groupJid}#agent:a2`, 'a2'),
  },
  agentWaiting: {},
  agentHasMore: {},
  followUps: {},
  drafts: {},
  loading: false,
  restoreActiveState: async () => undefined,
  loadAgents: async () => undefined,
  loadFollowUps: async () => undefined,
  loadAgentMessages: async () => undefined,
  hydrateAgentMessages: async () => undefined,
  refreshAgentMessages: async () => undefined,
  markChatRead: () => undefined,
  sendAgentMessage: async (_jid, agentId, content, attachments, mode) =>
    record({ to: agentId, content, images: attachments?.length ?? 0, mode }),
  interruptQuery: async (jid) => {
    harness.stops.push(jid);
    harness.setRunning(false, jid.split('#agent:')[1]);
    return true;
  },
  resetSession: async (jid, agentId) => {
    harness.resets.push({ jid, agentId });
    return true;
  },
  actOnFollowUp: async (_chatJid, id, action, _runId, content) => {
    harness.queueActions.push({ id, action, content });
    return true;
  },
});

useFileStore.setState({
  files: { [groupJid]: [] },
  currentPath: { [groupJid]: '' },
  loading: false,
  error: null,
  loadFiles: async () => undefined,
  navigateTo: () => undefined,
  uploadFiles: async (_jid, files) => {
    harness.uploads.push(files.map((file) => file.name));
    return true;
  },
});

/** Switches sessions through `?agent=`, the way the sidebar does. */
function SessionSwitcher() {
  const [, setSearchParams] = useSearchParams();
  useVisualViewportVars(); // AppLayout publishes the keyboard vars in the app
  useEffect(() => {
    harness.switchTo = (id) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('agent', id ?? FIRST);
          return next;
        },
        { replace: true },
      );
  }, [setSearchParams]);
  return null;
}

/**
 * The composer over a stub list, as ChatView hosts it, with a status bar
 * for the run. ChatView does not pass one yet.
 */
function BareComposer() {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    harness.setStatusRunning = setRunning;
  }, []);
  return (
    <div
      data-composer-dock-host
      className="relative flex h-full min-w-0 flex-col overflow-x-hidden"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {askCards && (
          <div className="mx-auto max-w-3xl pt-4">
            <AskUserQuestionCard
              toolUseId="ask-single"
              questions={[
                {
                  question: '用哪个方案？',
                  options: ['窄 selector', '宽 selector'],
                },
              ]}
            />
            <AskUserQuestionCard
              toolUseId="ask-steps"
              questions={[
                { question: '周末去哪？', options: ['爬山', '看展', '在家'] },
                {
                  question: '带什么？',
                  multiSelect: true,
                  options: ['水', '相机', '伞', '充电宝'],
                },
                { question: '几点出发？', options: ['8 点', '10 点'] },
              ]}
            />
          </div>
        )}
      </div>
      <MessageInput
        groupJid={groupJid}
        onSend={(content) => record({ to: 'composer', content, images: 0 })}
        isRunning={running}
        onStop={() => {
          setRunning(false);
          return true;
        }}
        statusBar={<StatusProbe running={running} />}
      />
    </div>
  );
}

/** Like RunStatusBar: pills while a run is active, nothing when idle. */
function StatusProbe({ running }: { running: boolean }) {
  if (!running) return null;
  return (
    <div
      data-testid="status-bar-probe"
      className="flex h-7 items-center justify-between rounded-full border border-surface-border px-3 text-caption"
    >
      <span>思考中</span>
      <span>12s</span>
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
const askCards = params.get('ask') === '1';
const bareComposer = params.get('statusbar') === '1' || askCards;

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[`/chat/e2e-composer?agent=${FIRST}`]}>
    <SessionSwitcher />
    {/* showToast renders through the app's sonner Toaster. */}
    <Toaster position="top-center" />
    <main className="h-[100dvh] overflow-hidden bg-background">
      {bareComposer ? (
        <BareComposer />
      ) : (
        // onBack renders the phone header's back button.
        <ChatView
          groupJid={groupJid}
          onBack={() => {
            harness.backs += 1;
          }}
        />
      )}
    </main>
  </MemoryRouter>,
);
