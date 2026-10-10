import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatView } from '../../src/components/chat/ChatView';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import { useChatStore } from '../../src/stores/chat';
import { useFileStore, type FileEntry } from '../../src/stores/files';
import '../../src/styles/globals.css';

const params = new URLSearchParams(window.location.search);
const role = params.get('role') === 'member' ? 'member' : 'admin';
const executionMode = params.get('runtime') === 'host' ? 'host' : 'container';
const canModify = params.get('canModify') !== 'false';
// ?sessions=1 opens the phone session list, as ChatView's own URL flag does.
const route =
  params.get('sessions') === '1'
    ? '/chat/e2e-mobile?sessions=1'
    : '/chat/e2e-mobile';
const groupJid = 'web:e2e-mobile';

const user: UserPublic = {
  id: `${role}-user`,
  username: role,
  display_name: role === 'admin' ? '管理员' : '成员',
  role,
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

const previewFiles: FileEntry[] = [
  { name: 'notes.md', path: 'notes.md', type: 'file', size: 4096 },
  { name: 'plain.txt', path: 'plain.txt', type: 'file', size: 2048 },
  { name: 'sample.png', path: 'sample.png', type: 'file', size: 1024 },
  { name: 'manual.pdf', path: 'manual.pdf', type: 'file', size: 8192 },
  { name: 'sample.mp3', path: 'sample.mp3', type: 'file', size: 1024 },
  { name: 'sample.mp4', path: 'sample.mp4', type: 'file', size: 1024 },
].map((file) => ({
  ...file,
  modifiedAt: '2026-01-01T00:00:00.000Z',
  isSystem: false,
}));

const fillerFiles: FileEntry[] = Array.from({ length: 48 }, (_, index) => ({
  name: `document-${String(index + 1).padStart(2, '0')}.txt`,
  path: `document-${String(index + 1).padStart(2, '0')}.txt`,
  type: 'file',
  size: 512 + index,
  modifiedAt: '2026-01-01T00:00:00.000Z',
  isSystem: false,
}));

const longMarkdown = [
  '# 移动预览回归',
  '',
  '![测试图片](/test-image.svg)',
  '',
  ...Array.from(
    { length: 60 },
    (_, index) =>
      `第 ${index + 1} 段：用于验证移动端 Markdown 预览可以持续滚动。`,
  ),
].join('\n\n');

useAuthStore.setState({
  authenticated: true,
  user,
  initialized: true,
  checking: false,
});

useChatStore.setState({
  groups: {
    [groupJid]: {
      name: '移动端测试工作区',
      folder: 'e2e-mobile',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode: 'assistant',
      kind: 'web',
      is_home: false,
      is_my_home: false,
      can_modify: canModify,
      execution_mode: executionMode,
      agent_profile_name: '测试智能体',
    },
  },
  currentGroup: groupJid,
  messages: { [groupJid]: [] },
  waiting: {},
  hasMore: { [groupJid]: false },
  agents: { [groupJid]: [] },
  activeAgentTab: { [groupJid]: null },
  agentMessages: {},
  agentWaiting: {},
  agentHasMore: {},
  followUps: { [groupJid]: [] },
  loading: false,
  loadMessages: async () => undefined,
  refreshMessages: async () => undefined,
  restoreActiveState: async () => undefined,
  loadAgents: async () => undefined,
  loadFollowUps: async () => undefined,
  markChatRead: () => undefined,
});

useFileStore.setState({
  files: { [groupJid]: [...previewFiles, ...fillerFiles] },
  currentPath: { [groupJid]: '' },
  loading: false,
  error: null,
  loadFiles: async () => undefined,
  navigateTo: () => undefined,
  getFileContent: async (_jid, path) =>
    path === 'notes.md'
      ? longMarkdown
      : Array.from(
          { length: 100 },
          (_, index) => `第 ${index + 1} 行：可聚焦并滚动的文本预览。`,
        ).join('\n'),
  saveFileContent: async () => true,
});

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[route]}>
    <main className="h-[100dvh] overflow-hidden bg-background">
      <ChatView groupJid={groupJid} />
    </main>
  </MemoryRouter>,
);
