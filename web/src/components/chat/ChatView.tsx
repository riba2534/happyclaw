import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { StreamingDisplay } from './StreamingDisplay';
import { FilePanel } from './FilePanel';
import { ContainerEnvPanel } from './ContainerEnvPanel';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ArrowLeft, MoreHorizontal, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { wsManager } from '../../api/ws';
import { TerminalPanel } from './TerminalPanel';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_MIN_HEIGHT = 150;
const TERMINAL_DEFAULT_HEIGHT = 300;
const TERMINAL_MAX_RATIO = 0.7;

type SidebarTab = 'files' | 'env';

interface ChatViewProps {
  groupJid: string;
  onBack?: () => void;
}

export function ChatView({ groupJid, onBack }: ChatViewProps) {
  const [mobilePanel, setMobilePanel] = useState<SidebarTab | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files');
  const [panelOpen, setPanelOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  // Desktop: visible controls panel height, mounted controls terminal lifecycle.
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT);
  const [mobileTerminal, setMobileTerminal] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);

  // Drag state refs (not reactive — only used in event handlers)
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);

  const {
    groups,
    messages,
    waiting,
    hasMore,
    loading,
    loadMessages,
    refreshMessages,
    sendMessage,
    resetSession,
    handleStreamEvent,
    handleWsNewMessage,
    clearStreaming,
  } = useChatStore();

  const appearance = useAuthStore(s => s.appearance);
  const group = groups[groupJid];
  const canUseTerminal = group?.execution_mode !== 'host';
  const groupMessages = messages[groupJid] || [];
  const isWaiting = waiting[groupJid] || false;
  const hasMoreMessages = hasMore[groupJid] || false;
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load messages on group select
  const hasMessages = !!messages[groupJid];
  useEffect(() => {
    if (groupJid && !hasMessages) {
      loadMessages(groupJid);
    }
  }, [groupJid, hasMessages, loadMessages]);

  // Poll for new messages — use setTimeout recursion to avoid request piling up
  // Pauses when the page is not visible to save resources
  useEffect(() => {
    let active = true;

    const schedulePoll = () => {
      if (!active || document.hidden) return;
      pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    };

    const poll = async () => {
      if (!active) return;
      try {
        await refreshMessages(groupJid);
      } catch { /* handled in store */ }
      schedulePoll();
    };

    const handleVisibility = () => {
      if (!document.hidden && active) {
        // Resume polling immediately when page becomes visible
        if (pollRef.current) clearTimeout(pollRef.current);
        poll();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    schedulePoll();

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (pollRef.current) clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // 监听 WebSocket 流式事件
  useEffect(() => {
    wsManager.connect();
    const unsub1 = wsManager.on('stream_event', (data: any) => {
      if (data.chatJid === groupJid) handleStreamEvent(groupJid, data.event);
    });
    // agent_reply 作为 fallback：如果 new_message 已处理则为 no-op
    const unsub2 = wsManager.on('agent_reply', (data: any) => {
      if (data.chatJid === groupJid) clearStreaming(groupJid);
    });
    // 通过 new_message 立即添加消息到本地状态（消除轮询延迟导致的消息"丢失"）
    const unsub3 = wsManager.on('new_message', (data: any) => {
      if (data.chatJid === groupJid && data.message) {
        handleWsNewMessage(groupJid, data.message);
      }
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [groupJid, handleStreamEvent, handleWsNewMessage, clearStreaming]);

  const handleSend = async (content: string, attachments?: Array<{ data: string; mimeType: string }>) => {
    await sendMessage(groupJid, content, attachments);
  };

  const handleLoadMore = () => {
    if (hasMoreMessages && !loading) {
      loadMessages(groupJid, true);
    }
  };

  const handleResetSession = async () => {
    setResetLoading(true);
    await resetSession(groupJid);
    setResetLoading(false);
    setShowResetConfirm(false);
  };

  // --- Drag resize handlers (mouse + touch) ---
  const startDrag = useCallback((startY: number) => {
    isDraggingRef.current = true;
    dragStartYRef.current = startY;
    dragStartHeightRef.current = terminalHeight;

    const calcHeight = (currentY: number) => {
      const delta = dragStartYRef.current - currentY;
      const maxHeight = containerRef.current
        ? containerRef.current.clientHeight * TERMINAL_MAX_RATIO
        : 600;
      return Math.min(maxHeight, Math.max(TERMINAL_MIN_HEIGHT, dragStartHeightRef.current + delta));
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      setTerminalHeight(calcHeight(e.clientY));
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (!isDraggingRef.current) return;
      setTerminalHeight(calcHeight(e.touches[0].clientY));
    };

    const cleanup = () => {
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', cleanup);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', cleanup);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', cleanup);
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', cleanup);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [terminalHeight]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startDrag(e.clientY);
  }, [startDrag]);

  const handleTouchDragStart = useCallback((e: React.TouchEvent) => {
    startDrag(e.touches[0].clientY);
  }, [startDrag]);

  // Toggle terminal: desktop = bottom panel, mobile = modal
  const handleTerminalToggle = useCallback(() => {
    if (!canUseTerminal) return;
    // Use matchMedia to detect desktop vs mobile
    if (window.matchMedia('(min-width: 1024px)').matches) {
      if (!terminalMounted) {
        setTerminalMounted(true);
        setTerminalVisible(true);
      } else {
        setTerminalVisible(prev => !prev);
      }
    } else {
      setMobileTerminal(true);
    }
  }, [canUseTerminal, terminalMounted]);

  // Switching groups should not carry terminal UI/session into the next page.
  useEffect(() => {
    setTerminalVisible(false);
    setTerminalMounted(false);
    setMobileTerminal(false);
  }, [groupJid]);

  // If current group is host mode, force-close any mounted terminal.
  useEffect(() => {
    if (canUseTerminal) return;
    setTerminalVisible(false);
    setTerminalMounted(false);
    setMobileTerminal(false);
  }, [canUseTerminal]);

  const openMobileFiles = () => {
    setMobileActionsOpen(false);
    setMobilePanel('files');
  };

  const openMobileEnv = () => {
    setMobileActionsOpen(false);
    setMobilePanel('env');
  };

  if (!group) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-slate-500">群组不存在</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-white/80 backdrop-blur-sm border-b border-slate-200/60">
        {onBack && (
          <button
            onClick={onBack}
            className="lg:hidden p-2 -ml-2 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            aria-label="返回"
          >
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-slate-900 text-[15px] truncate">{group.name}</h2>
          <p className="text-xs text-slate-500">
            {isWaiting ? '正在思考...' : group.folder === 'main' ? '主容器' : '容器'}
          </p>
        </div>
        {/* Desktop: toggle side panel */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          className="hidden lg:flex p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors cursor-pointer"
          title={panelOpen ? '收起面板' : '展开面板'}
          aria-label={panelOpen ? '收起面板' : '展开面板'}
        >
          {panelOpen ? <PanelRightClose className="w-5 h-5" /> : <PanelRightOpen className="w-5 h-5" />}
        </button>
        {/* Mobile only: condensed actions */}
        <div className="lg:hidden">
          <button
            onClick={() => setMobileActionsOpen(true)}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors cursor-pointer"
            title="更多操作"
            aria-label="更多操作"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Content: Messages + Sidebar */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Messages Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <MessageList
            messages={groupMessages}
            loading={loading}
            hasMore={hasMoreMessages}
            onLoadMore={handleLoadMore}
          />
          <StreamingDisplay groupJid={groupJid} isWaiting={isWaiting} senderName={appearance?.aiName || group?.name || 'AI'} />
          <MessageInput
            onSend={handleSend}
            groupJid={groupJid}
            onResetSession={() => setShowResetConfirm(true)}
            onToggleTerminal={canUseTerminal ? handleTerminalToggle : undefined}
          />
        </div>

        {/* Desktop: sidebar with tabs (collapsible) */}
        <div className={cn(
          "hidden lg:flex lg:flex-col flex-shrink-0 border-l border-border bg-white transition-[width] duration-200",
          panelOpen ? "w-80" : "w-0 overflow-hidden border-l-0"
        )}>
          {/* Tab bar */}
          <div className="flex border-b border-border">
            <button
              onClick={() => setSidebarTab('files')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                sidebarTab === 'files'
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              文件管理
            </button>
            <button
              onClick={() => setSidebarTab('env')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                sidebarTab === 'env'
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              环境变量
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {sidebarTab === 'files' ? (
              <FilePanel groupJid={groupJid} />
            ) : (
              <ContainerEnvPanel groupJid={groupJid} />
            )}
          </div>
        </div>
      </div>

      {/* Desktop: Bottom terminal panel with drag handle */}
      {canUseTerminal && terminalMounted && (
        <>
          {/* Drag handle */}
          {terminalVisible && (
            <div
              onMouseDown={handleDragStart}
              onTouchStart={handleTouchDragStart}
              className="hidden lg:flex h-1 bg-muted hover:bg-brand-400 cursor-row-resize items-center justify-center transition-colors group"
            >
              <div className="w-8 h-0.5 rounded-full bg-slate-400 group-hover:bg-primary transition-colors" />
            </div>
          )}
          {/* Terminal panel */}
          <div
            className={`hidden lg:block flex-shrink-0 overflow-hidden transition-[height] duration-200 ${
              terminalVisible ? 'border-t border-slate-300' : 'border-t-0'
            }`}
            style={{ height: terminalVisible ? terminalHeight : 0 }}
          >
            <TerminalPanel
              groupJid={groupJid}
              visible={terminalVisible}
              onHide={() => setTerminalVisible(false)}
              onDelete={() => {
                setTerminalVisible(false);
                setTerminalMounted(false);
              }}
            />
          </div>
        </>
      )}

      {/* Mobile: file panel sheet */}
      <Sheet open={mobilePanel === 'files'} onOpenChange={(v) => !v && setMobilePanel(null)}>
        <SheetContent side="bottom" className="h-[80dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>工作区文件管理</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <FilePanel
              groupJid={groupJid}
              onClose={() => setMobilePanel(null)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: env config sheet */}
      <Sheet open={mobilePanel === 'env'} onOpenChange={(v) => !v && setMobilePanel(null)}>
        <SheetContent side="bottom" className="h-[80dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>容器环境变量</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <ContainerEnvPanel
              groupJid={groupJid}
              onClose={() => setMobilePanel(null)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: Terminal sheet */}
      <Sheet open={mobileTerminal} onOpenChange={(v) => !v && setMobileTerminal(false)}>
        <SheetContent side="bottom" className="h-[85dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>终端</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(85dvh-56px)]">
            <TerminalPanel
              groupJid={groupJid}
              visible
              onHide={() => setMobileTerminal(false)}
              onDelete={() => setMobileTerminal(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: Action Sheet */}
      <Sheet open={mobileActionsOpen} onOpenChange={(v) => !v && setMobileActionsOpen(false)}>
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>容器操作</SheetTitle>
          </SheetHeader>
          <div className="space-y-2 pt-2">
            <button
              onClick={openMobileFiles}
              className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
            >
              工作区文件
            </button>
            <button
              onClick={openMobileEnv}
              className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
            >
              环境变量
            </button>
            {canUseTerminal && (
              <button
                onClick={() => {
                  setMobileActionsOpen(false);
                  setMobileTerminal(true);
                }}
                className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
              >
                终端
              </button>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Reset session confirm dialog */}
      <ConfirmDialog
        open={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={handleResetSession}
        title="清除上下文"
        message="将清除 Claude 会话上下文并停止运行中的容器，下次发送消息时将开始全新会话。聊天记录不受影响。"
        confirmText="清除"
        confirmVariant="danger"
        loading={resetLoading}
      />
    </div>
  );
}
