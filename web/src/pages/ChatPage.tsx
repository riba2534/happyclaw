import { useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { ChatView } from '../components/chat/ChatView';
import { useSwipeBack } from '../hooks/useSwipeBack';

export function ChatPage() {
  const { groupFolder } = useParams<{ groupFolder?: string }>();
  const navigate = useNavigate();
  const { groups, currentGroup, selectGroup } = useChatStore();
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
  const hasGroups = Object.keys(groups).length > 0;

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
      {/* On mobile without groupFolder, show empty state (sidebar is in UnifiedSidebar on desktop) */}
      {!groupFolder && (
        <div className="block lg:hidden w-full">
          {/* Mobile list view — handled by BottomTabBar navigation */}
          <div className="flex flex-col items-center justify-center h-full px-4">
            <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6">
              <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
            </div>
            <h2 className="text-xl font-semibold text-foreground mb-2">
              欢迎使用 {appearance?.appName || 'HappyClaw'}
            </h2>
            <p className="text-muted-foreground text-sm">
              从侧边栏选择一个工作区开始对话
            </p>
          </div>
        </div>
      )}

      {/* Chat View - Desktop: visible when active group exists, Mobile: only in detail route */}
      {activeGroupJid ? (
        <div ref={chatViewRef} className={`${groupFolder ? 'flex-1 min-w-0' : 'hidden lg:block flex-1 min-w-0'}`}>
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
