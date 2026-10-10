// Interaction harness for the chat composer: ChatView over mocked stores with
// a main conversation and two Web sessions in one workspace. Sends, uploads,
// stops and queue actions are recorded on `window.composerHarness`.
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { ChatView } from '../../src/components/chat/ChatView';
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
  queueActions: [] as Array<{ id: string; action: string; content?: string }>,
  sendDelayMs: 0,
  switchTo: (_id: string | null) => {},
  /** Mark the visible conversation as running (or idle). */
  setRunning(running: boolean, agentId: string | null = null) {
    useChatStore.setState((s) =>
      agentId
        ? { agentWaiting: { ...s.agentWaiting, [agentId]: running } }
        : { waiting: { ...s.waiting, [groupJid]: running } },
    );
  },
  setQueue(count: number, agentId: string | null = null, imageOnly = false) {
    const chatJid = agentId ? `${groupJid}#agent:${agentId}` : groupJid;
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
      can_modify: true,
      execution_mode: 'container',
      agent_profile_name: '测试智能体',
    },
  },
  currentGroup: groupJid,
  messages: { [groupJid]: history(groupJid, 'main') },
  waiting: {},
  hasMore: { [groupJid]: false },
  agents: { [groupJid]: [session('a1', '会话 A'), session('a2', '会话 B')] },
  activeAgentTab: { [groupJid]: null },
  agentMessages: {
    a1: history(`${groupJid}#agent:a1`, 'a1'),
    a2: history(`${groupJid}#agent:a2`, 'a2'),
  },
  agentWaiting: {},
  agentHasMore: {},
  followUps: { [groupJid]: [] },
  drafts: {},
  loading: false,
  loadMessages: async () => undefined,
  refreshMessages: async () => undefined,
  restoreActiveState: async () => undefined,
  loadAgents: async () => undefined,
  loadFollowUps: async () => undefined,
  loadAgentMessages: async () => undefined,
  hydrateAgentMessages: async () => undefined,
  refreshAgentMessages: async () => undefined,
  markChatRead: () => undefined,
  sendMessage: async (_jid, content, attachments, mode) =>
    record({ to: 'main', content, images: attachments?.length ?? 0, mode }),
  sendAgentMessage: async (_jid, agentId, content, attachments, mode) =>
    record({ to: agentId, content, images: attachments?.length ?? 0, mode }),
  interruptQuery: async (jid) => {
    harness.stops.push(jid);
    const agentId = jid.includes('#agent:') ? jid.split('#agent:')[1] : null;
    harness.setRunning(false, agentId);
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
  useEffect(() => {
    harness.switchTo = (id) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set('agent', id);
          else next.delete('agent');
          return next;
        },
        { replace: true },
      );
  }, [setSearchParams]);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/chat/e2e-composer']}>
    <SessionSwitcher />
    <main className="h-[100dvh] overflow-hidden bg-background">
      {/* onBack renders the phone header's back button. */}
      <ChatView groupJid={groupJid} onBack={() => undefined} />
    </main>
  </MemoryRouter>,
);
