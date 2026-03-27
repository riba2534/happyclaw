import { useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { useGroupsStore } from '../stores/groups';
import { ChatView } from '../components/chat/ChatView';
import { ChatGroupItem } from '../components/chat/ChatGroupItem';
import { useSwipeBack } from '../hooks/useSwipeBack';

export function ChatPage() {
  const { groupFolder } = useParams<{ groupFolder?: string }>();
  const navigate = useNavigate();
  const { groups, currentGroup, selectGroup, loadGroups } = useChatStore();

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
      navigate('/chat', { replace: true });
    }
  }, [groupFolder, routeGroupJid, hasGroups, currentGroup, selectGroup, navigate]);

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
                  executionMode={g.execution_mode}
                  isActive={currentGroup === g.jid}
                  isHome={!!g.is_my_home}
                  isRunning={runnerStates[g.jid] === 'running'}
                  editable={g.editable}
                  onSelect={(jid, folder) => { selectGroup(jid); navigate(`/chat/${folder}`); }}
                  onClearHistory={() => {}}
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
        <div className="hidden lg:flex flex-1 items-center justify-center bg-white dark:bg-background rounded-t-3xl rounded-b-none mt-5 mr-5 mb-0 ml-3 relative">
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
    </div>
  );
}
