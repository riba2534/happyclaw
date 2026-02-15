import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { ChatSidebar } from '../components/chat/ChatSidebar';
import { ChatView } from '../components/chat/ChatView';

export function ChatPage() {
  const { groupFolder } = useParams<{ groupFolder?: string }>();
  const navigate = useNavigate();
  const { groups, currentGroup, selectGroup } = useChatStore();
  const routeGroupEntry = groupFolder
    ? Object.entries(groups).find(([_, info]) => info.folder === groupFolder)
    : null;
  const routeGroupJid = routeGroupEntry?.[0] || null;
  const appearance = useAuthStore((s) => s.appearance);
  const hasGroups = Object.keys(groups).length > 0;

  // Sync URL param to store
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

  const handleBackToList = () => {
    navigate('/chat');
  };

  return (
    <div className="h-full flex">
      {/* Sidebar - Desktop: always visible, Mobile: visible in list route */}
      <div className={`${groupFolder ? 'hidden lg:block' : 'block'} w-full lg:w-72 flex-shrink-0`}>
        <ChatSidebar />
      </div>

      {/* Chat View - Desktop: visible when active group exists, Mobile: only in detail route */}
      {activeGroupJid ? (
        <div className={`${groupFolder ? 'flex-1' : 'hidden lg:block flex-1'}`}>
          <ChatView groupJid={activeGroupJid} onBack={handleBackToList} />
        </div>
      ) : (
        <div className="hidden lg:flex flex-1 items-center justify-center bg-background">
          <div className="text-center max-w-sm">
            {/* Logo */}
            <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6">
              <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
            </div>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              欢迎使用 {appearance?.aiName || 'HappyClaw'}
            </h2>
            <p className="text-slate-500 text-sm">
              从左侧选择一个容器开始对话
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
