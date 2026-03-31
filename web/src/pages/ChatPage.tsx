import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { useGroupsStore } from '../stores/groups';
import { ChatView } from '../components/chat/ChatView';
import { ChatGroupItem } from '../components/chat/ChatGroupItem';
import { ConfirmDialog } from '../components/common';
import { useSwipeBack } from '../hooks/useSwipeBack';

export function ChatPage() {
  const { groupFolder } = useParams<{ groupFolder?: string }>();
  const navigate = useNavigate();
  const { groups, currentGroup, selectGroup, loadGroups, clearHistory } = useChatStore();

  const [clearState, setClearState] = useState({ open: false, jid: '', name: '' });
  const [clearLoading, setClearLoading] = useState(false);

  const handleClearConfirm = async () => {
    setClearLoading(true);
    try {
      const ok = await clearHistory(clearState.jid);
      if (ok) {
        setClearState({ open: false, jid: '', name: '' });
      } else {
        alert('重建工作区失败，请稍后重试');
        setClearState({ open: false, jid: '', name: '' });
      }
    } catch {
      alert('重建工作区失败，请稍后重试');
      setClearState({ open: false, jid: '', name: '' });
    } finally {
      setClearLoading(false);
    }
  };

  // Load groups on mount (needed for mobile workspace list)
  useEffect(() => { loadGroups(); }, [loadGroups]);
  const routeGroupJid = useMemo(() => {
    if (!groupFolder) return null;
    const entry =
      Object.entries(groups).find(
        ([jid, info]) =>
          info.folder === groupFolder && jid.startsWith('web:') && !!info.is_home,
      ) ||
      Object.entries(groups).find(
        ([jid, info]) => info.folder === groupFolder && jid.startsWith('web:'),
      ) ||
      Object.entries(groups).find(([_, info]) => info.folder === groupFolder);
    return entry?.[0] || null;
  }, [groupFolder, groups]);
  const appearance = useAuthStore((s) => s.appearance);
  const runnerStates = useGroupsStore((s) => s.runnerStates);
  const hasGroups = Object.keys(groups).length > 0;

  // Build sorted group list for mobile view
  const sortedGroups = useMemo(() => {
    const entries = Object.entries(groups).map(([jid, info]) => ({ jid, ...info }));
    const home = entries.filter((g) => g.is_my_home);
    const rest = entries.filter((g) => !g.is_my_home);
    rest.sort((a, b) => new Date(b.lastMessageTime || b.added_at).getTime() - new Date(a.lastMessageTime || a.added_at).getTime());
    return [...home, ...rest];
  }, [groups]);

  // Sync URL param to store selection. No auto-redirect to home container —
  // users land on the welcome screen and choose a container manually.
  useEffect(() => {
    if (!groupFolder) return;
    if (routeGroupJid && currentGroup !== routeGroupJid) {
      selectGroup(routeGroupJid);
      return;
    }
    if (hasGroups && !routeGroupJid) {
      // Group not found — may be newly created (task workspace). Retry once after refresh.
      loadGroups().then(() => {
        const freshGroups = useChatStore.getState().groups;
        const found = Object.entries(freshGroups).find(
          ([jid, info]) => info.folder === groupFolder && jid.startsWith('web:'),
        );
        if (found) {
          selectGroup(found[0]);
        } else {
          navigate('/chat', { replace: true });
        }
      });
    }
  }, [groupFolder, routeGroupJid, hasGroups, currentGroup, selectGroup, navigate, loadGroups]);

  const activeGroupJid = groupFolder ? routeGroupJid : currentGroup;
  const chatViewRef = useRef<HTMLDivElement>(null);

  const handleBackToList = () => {
    navigate('/chat');
  };

  useSwipeBack(chatViewRef, handleBackToList);

  return (
    <div className="h-full flex bg-muted/30">
      {/* Mobile workspace list when no group selected */}
      {!groupFolder && (
        <div className="block lg:hidden w-full overflow-y-auto">
          <div className="px-4 pt-4 pb-2">
            <h2 className="text-lg font-semibold text-foreground">工作台</h2>
          </div>
          {sortedGroups.length > 0 ? (
            <div className="px-2 pb-28">
              {sortedGroups.map((g) => (
                <ChatGroupItem
                  key={g.jid}
                  jid={g.jid}
                  name={g.name}
                  folder={g.folder}
                  lastMessage={g.lastMessage}

                  isActive={currentGroup === g.jid}
                  isHome={!!g.is_my_home}
                  isRunning={runnerStates[g.jid] === 'running'}
                  editable={g.editable}
                  onSelect={(jid, folder) => { selectGroup(jid); navigate(`/chat/${folder}`); }}
                  onClearHistory={(jid, name) => setClearState({ open: true, jid, name })}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-64 px-4">
              <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6">
                <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
              </div>
              <h2 className="text-xl font-semibold text-foreground mb-2">
                欢迎使用 {appearance?.appName || 'HappyClaw'}
              </h2>
              <p className="text-muted-foreground text-sm">暂无工作区</p>
            </div>
          )}
        </div>
      )}

      {/* Chat View - Desktop: visible when active group exists, Mobile: only in detail route */}
      {activeGroupJid ? (
        <div ref={chatViewRef} className={`${groupFolder ? 'flex-1 min-w-0 h-full overflow-hidden lg:pt-4' : 'hidden lg:block flex-1 min-w-0 h-full overflow-hidden lg:pt-4'}`}>
          <ChatView
            groupJid={activeGroupJid}
            onBack={handleBackToList}
            headerLeft={undefined}
          />
        </div>
      ) : (
        <div className="hidden lg:flex flex-1 items-center justify-center bg-background rounded-t-3xl rounded-b-none mt-5 mr-5 mb-0 ml-3 relative">
          <div className="text-center max-w-sm">
            {/* Logo */}
            <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6">
              <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
            </div>
            <h2 className="text-xl font-semibold text-foreground mb-2">
              欢迎使用 {appearance?.appName || 'HappyClaw'}
            </h2>
            <p className="text-muted-foreground text-sm">
              从左侧选择一个工作区开始对话
            </p>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={clearState.open}
        onClose={() => setClearState({ open: false, jid: '', name: '' })}
        onConfirm={handleClearConfirm}
        title="重建工作区"
        message={`确认重建工作区「${clearState.name}」吗？这会清除全部聊天记录、上下文，并删除工作目录中的所有文件。此操作不可撤销。`}
        confirmText="确认重建"
        cancelText="取消"
        confirmVariant="danger"
        loading={clearLoading}
      />
    </div>
  );
}
