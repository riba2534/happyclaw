import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { StreamingDisplay } from './StreamingDisplay';

import { FilePanel } from './FilePanel';
import { ContainerEnvPanel } from './ContainerEnvPanel';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ArrowLeft, Link, MessageSquare, MoreHorizontal, PanelRightClose, PanelRightOpen, Terminal, Users, X } from 'lucide-react';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { cn } from '@/lib/utils';
import { wsManager } from '../../api/ws';
import { api } from '../../api/client';
import { TerminalPanel } from './TerminalPanel';
import { GroupSkillsPanel } from './GroupSkillsPanel';
import { GroupMembersPanel } from './GroupMembersPanel';
import { AgentTabBar } from './AgentTabBar';

/** Inline elapsed-time counter for running tasks */
function ElapsedTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startTime]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return <span>{mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}</span>;
}

const POLL_INTERVAL_MS = 2000;
const TERMINAL_MIN_HEIGHT = 150;
const TERMINAL_DEFAULT_HEIGHT = 300;
const TERMINAL_MAX_RATIO = 0.7;

// Stable empty references to avoid infinite re-render loops in Zustand selectors
const EMPTY_AGENTS: import('../../types').AgentInfo[] = [];

type SidebarTab = 'files' | 'env' | 'skills' | 'members';

interface ChatViewProps {
  groupJid: string;
  onBack?: () => void;
}

export function ChatView({ groupJid, onBack }: ChatViewProps) {
  const { mode: displayMode, toggle: toggleDisplayMode } = useDisplayMode();
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
  const [imStatus, setImStatus] = useState<{ feishu: boolean; telegram: boolean } | null>(null);
  const [imBannerDismissed, setImBannerDismissed] = useState(() =>
    localStorage.getItem('im-banner-dismissed') === '1',
  );
  const navigate = useNavigate();

  // Drag state refs (not reactive — only used in event handlers)
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);

  // Individual selectors: avoid re-renders from unrelated store changes (e.g. streaming)
  const group = useChatStore(s => s.groups[groupJid]);
  const groupMessages = useChatStore(s => s.messages[groupJid]);
  const isWaiting = useChatStore(s => !!s.waiting[groupJid]);
  const hasMoreMessages = useChatStore(s => !!s.hasMore[groupJid]);
  const loading = useChatStore(s => s.loading);
  const loadMessages = useChatStore(s => s.loadMessages);
  const refreshMessages = useChatStore(s => s.refreshMessages);
  const sendMessage = useChatStore(s => s.sendMessage);
  const interruptQuery = useChatStore(s => s.interruptQuery);
  const resetSession = useChatStore(s => s.resetSession);
  const handleStreamEvent = useChatStore(s => s.handleStreamEvent);
  const handleWsNewMessage = useChatStore(s => s.handleWsNewMessage);
  const handleAgentStatus = useChatStore(s => s.handleAgentStatus);
  const clearStreaming = useChatStore(s => s.clearStreaming);
  const agents = useChatStore(s => s.agents[groupJid] ?? EMPTY_AGENTS);
  const activeAgentTab = useChatStore(s => s.activeAgentTab[groupJid] ?? null);
  const setActiveAgentTab = useChatStore(s => s.setActiveAgentTab);
  const loadAgents = useChatStore(s => s.loadAgents);
  const deleteAgentAction = useChatStore(s => s.deleteAgentAction);
  const agentStreaming = useChatStore(s => s.agentStreaming);
  const sdkTasks = useChatStore(s => s.sdkTasks);
  const createConversation = useChatStore(s => s.createConversation);
  const loadAgentMessages = useChatStore(s => s.loadAgentMessages);
  const sendAgentMessage = useChatStore(s => s.sendAgentMessage);
  const agentMessages = useChatStore(s => s.agentMessages);
  const agentWaiting = useChatStore(s => s.agentWaiting);
  const agentHasMore = useChatStore(s => s.agentHasMore);

  const currentUser = useAuthStore(s => s.user);
  const canUseTerminal = group?.execution_mode !== 'host';
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Fetch IM connection status for home groups
  const isHome = !!group?.is_home;
  const isOwnHome =
    isHome &&
    (
      (!!group?.created_by && group.created_by === currentUser?.id) ||
      (currentUser?.role === 'admin' && group?.folder === 'main')
    );
  useEffect(() => {
    if (!isOwnHome) { setImStatus(null); return; }
    let active = true;
    const fetchStatus = () => {
      api.get<{ feishu: boolean; telegram: boolean }>('/api/config/user-im/status')
        .then((data) => { if (active) setImStatus(data); })
        .catch(() => {});
    };
    fetchStatus();
    const timer = setInterval(fetchStatus, 30_000); // refresh every 30s
    return () => { active = false; clearInterval(timer); };
  }, [isOwnHome]);

  // Load messages on group select
  const hasMessages = !!groupMessages;
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

  // WS 重连时恢复正在运行的 agent 状态（独立于 groupJid，避免切换会话时重复调用）
  // wsManager.connect() 已提升到 AppLayout 级别
  const restoreActiveState = useChatStore(s => s.restoreActiveState);
  useEffect(() => {
    restoreActiveState();
    const unsub = wsManager.on('connected', () => {
      restoreActiveState();
    });
    return () => { unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived: active agent info and kind
  const activeAgent = activeAgentTab ? agents.find(a => a.id === activeAgentTab) : null;
  const isConversationTab = activeAgent?.kind === 'conversation';
  const isSdkTask = !!activeAgentTab && !!sdkTasks[activeAgentTab];

  // Load sub-agents for this group
  useEffect(() => {
    loadAgents(groupJid);
  }, [groupJid, loadAgents]);

  // Load messages for conversation agent tabs
  useEffect(() => {
    if (activeAgentTab && isConversationTab) {
      const existing = agentMessages[activeAgentTab];
      if (!existing) {
        loadAgentMessages(groupJid, activeAgentTab);
      }
    }
  }, [activeAgentTab, isConversationTab, groupJid, loadAgentMessages, agentMessages]);

  // 监听 WebSocket 流式事件
  useEffect(() => {
    const unsub1 = wsManager.on('stream_event', (data: any) => {
      if (data.chatJid === groupJid) handleStreamEvent(groupJid, data.event, data.agentId);
    });
    // agent_reply 作为 fallback：如果 new_message 已处理则为 no-op
    const unsub2 = wsManager.on('agent_reply', (data: any) => {
      if (data.chatJid === groupJid) clearStreaming(groupJid);
    });
    // 通过 new_message 立即添加消息到本地状态（消除轮询延迟导致的消息"丢失"）
    const unsub3 = wsManager.on('new_message', (data: any) => {
      if (data.chatJid === groupJid && data.message) {
        handleWsNewMessage(groupJid, data.message, data.agentId);
      }
    });
    // 子 Agent 状态变更
    const unsub4 = wsManager.on('agent_status', (data: any) => {
      if (data.chatJid === groupJid) {
        handleAgentStatus(groupJid, data.agentId, data.status, data.name, data.prompt, data.resultSummary, data.kind);
      }
    });
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
  }, [groupJid, handleStreamEvent, handleWsNewMessage, handleAgentStatus, clearStreaming]);

  const [scrollTrigger, setScrollTrigger] = useState(0);

  const handleSend = async (content: string, attachments?: Array<{ data: string; mimeType: string }>) => {
    await sendMessage(groupJid, content, attachments);
    setScrollTrigger(n => n + 1);
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
      <div className="flex items-center gap-3 px-4 py-2.5 border-b lg:bg-white/80 lg:backdrop-blur-sm lg:border-slate-200/60 max-lg:bg-white/60 max-lg:backdrop-blur-xl max-lg:saturate-[1.8] max-lg:border-white/20 max-lg:shadow-[0_8px_32px_rgba(0,0,0,0.06),inset_0_1px_1px_rgba(255,255,255,0.6)]">
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
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <span>{isWaiting ? '正在思考...' : group.is_home ? '主工作区' : '工作区'}</span>
            {!isWaiting && group.is_shared && (
              <>
                <span className="text-slate-300">·</span>
                <span className="inline-flex items-center gap-0.5">
                  <Users className="w-3 h-3" />
                  {group.member_count ?? 0} 人协作
                </span>
              </>
            )}
            {!isWaiting && group.execution_mode && (
              <>
                <span className="text-slate-300">·</span>
                <span className={`inline-flex items-center px-1 py-px rounded text-[10px] font-medium ${group.execution_mode === 'host' ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700'}`}>
                  {group.execution_mode === 'host' ? '宿主机' : 'Docker'}
                </span>
              </>
            )}
            {isOwnHome && imStatus && (imStatus.feishu || imStatus.telegram) && (
              <>
                <span className="text-slate-300">·</span>
                {imStatus.feishu && (
                  <span className="inline-flex items-center gap-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    飞书
                  </span>
                )}
                {imStatus.telegram && (
                  <span className="inline-flex items-center gap-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Telegram
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        {/* Desktop: toggle display mode */}
        <button
          onClick={toggleDisplayMode}
          className="hidden lg:flex p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors cursor-pointer"
          title={displayMode === 'chat' ? '紧凑模式' : '对话模式'}
          aria-label={displayMode === 'chat' ? '切换到紧凑模式' : '切换到对话模式'}
        >
          {displayMode === 'chat' ? <Terminal className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
        </button>
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

      {/* IM channel setup banner for home container without IM */}
      {isOwnHome && imStatus && !imStatus.feishu && !imStatus.telegram && !imBannerDismissed && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-sm">
          <Link className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1 min-w-0">未配置 IM 渠道，飞书 / Telegram 消息无法与主工作区互通</span>
          <button
            onClick={() => navigate('/setup/channels')}
            className="flex-shrink-0 px-3 py-1 text-xs font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors cursor-pointer"
          >
            去配置
          </button>
          <button
            onClick={() => {
              setImBannerDismissed(true);
              localStorage.setItem('im-banner-dismissed', '1');
            }}
            className="flex-shrink-0 p-0.5 rounded hover:bg-amber-200/60 transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Agent tab bar */}
      <AgentTabBar
        agents={agents}
        activeTab={activeAgentTab}
        onSelectTab={(id) => setActiveAgentTab(groupJid, id)}
        onDeleteAgent={(id) => deleteAgentAction(groupJid, id)}
        onCreateConversation={() => {
          const name = prompt('对话名称：');
          if (name?.trim()) {
            createConversation(groupJid, name.trim()).then((agent) => {
              if (agent) setActiveAgentTab(groupJid, agent.id);
            });
          }
        }}
      />

      {/* Main Content: Messages + Sidebar */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Messages Area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
          {activeAgentTab && isConversationTab ? (
            /* Conversation agent tab: interactive — user can send messages */
            <>
              <MessageList
                key={`conv-${activeAgentTab}`}
                messages={agentMessages[activeAgentTab] || []}
                loading={false}
                hasMore={!!agentHasMore[activeAgentTab]}
                onLoadMore={() => loadAgentMessages(groupJid, activeAgentTab, true)}
                scrollTrigger={scrollTrigger}
                groupJid={groupJid}
                isWaiting={!!agentWaiting[activeAgentTab] || !!agentStreaming[activeAgentTab]}
                onInterrupt={() => interruptQuery(`${groupJid}#agent:${activeAgentTab}`)}
                agentId={activeAgentTab}
              />
              <MessageInput
                onSend={async (content) => {
                  sendAgentMessage(groupJid, activeAgentTab, content);
                  setScrollTrigger(n => n + 1);
                }}
                groupJid={groupJid}
              />
            </>
          ) : activeAgentTab ? (
            /* Task agent tab */
            <>
              {isSdkTask ? (
                /* SDK Task: 流式展示或状态反馈 */
                <div className="flex-1 overflow-y-auto p-4">
                  {(() => {
                    const streamState = agentStreaming[activeAgentTab];
                    const hasStreamContent = streamState && (
                      streamState.partialText
                      || streamState.thinkingText
                      || streamState.activeTools.length > 0
                      || !!streamState.activeHook
                      || !!streamState.systemStatus
                      || streamState.recentEvents.length > 0
                    );
                    const task = sdkTasks[activeAgentTab];
                    const taskStatus = task?.status;

                    if (taskStatus === 'completed') {
                      return (
                        <div className="text-center py-8 space-y-2">
                          <div className="text-sm font-medium text-emerald-600">子 Agent 已完成</div>
                          {task?.summary && (
                            <div className="text-xs text-slate-500 max-w-md mx-auto">{task.summary}</div>
                          )}
                        </div>
                      );
                    }

                    if (taskStatus === 'error') {
                      return (
                        <div className="text-center py-8 space-y-2">
                          <div className="text-sm font-medium text-red-600">子 Agent 执行出错</div>
                          {task?.summary && (
                            <div className="text-xs text-slate-500 max-w-md mx-auto">{task.summary}</div>
                          )}
                        </div>
                      );
                    }

                    if (hasStreamContent) {
                      // 有流式数据 → 显示 StreamingDisplay（前台任务场景）
                      return (
                        <StreamingDisplay
                          groupJid={groupJid}
                          isWaiting={taskStatus === 'running'}
                          agentId={activeAgentTab}
                        />
                      );
                    }

                    // running 状态：显示描述 + 实时计时 + 后台任务说明
                    return (
                      <div className="flex flex-col items-center justify-center py-12 px-4 space-y-4">
                        {/* 动画 spinner */}
                        <div className="relative">
                          <div className="w-12 h-12 rounded-full border-2 border-teal-100" />
                          <div className="absolute inset-0 w-12 h-12 rounded-full border-2 border-transparent border-t-teal-500 animate-spin" />
                        </div>

                        <div className="text-center space-y-2 max-w-md">
                          <div className="text-sm font-medium text-slate-700">
                            Teammate 正在后台执行中
                          </div>
                          {task?.description && (
                            <div className="text-xs text-slate-500 leading-relaxed">
                              {task.description}
                            </div>
                          )}
                        </div>

                        {/* 实时计时器 */}
                        {task?.startedAt && (
                          <div className="text-xs text-slate-400 tabular-nums">
                            已运行 <ElapsedTimer startTime={task.startedAt} />
                          </div>
                        )}

                        <div className="text-[11px] text-slate-400 text-center max-w-sm leading-relaxed">
                          后台任务不传播中间过程，完成后将显示结果摘要
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                /* DB Task: read-only — show agent's messages from main chat */
                <MessageList
                  key={`task-${activeAgentTab}`}
                  messages={(groupMessages || []).filter(
                    (m) => m.sender === `agent:${activeAgentTab}`,
                  )}
                  loading={false}
                  hasMore={false}
                  onLoadMore={() => {}}
                  scrollTrigger={scrollTrigger}
                  groupJid={groupJid}
                  isWaiting={!!agentStreaming[activeAgentTab]}
                  onInterrupt={() => interruptQuery(groupJid)}
                  agentId={activeAgentTab}
                />
              )}
              {(() => {
                const activeSdkTask = activeAgentTab ? sdkTasks[activeAgentTab] : null;
                if (isSdkTask && activeSdkTask?.isTeammate && activeSdkTask?.status === 'running') {
                  return (
                    /* Teammate 标签页：通过主对话中转发送消息给 Team Lead */
                    <div className="border-t">
                      <div className="px-4 pt-1.5 pb-0.5 text-[10px] text-amber-600 bg-amber-50/50 text-center">
                        消息将发送到主对话，由 Team Lead 转发
                      </div>
                      <MessageInput
                        onSend={async (content) => {
                          const taskDesc = (activeSdkTask?.description || 'Teammate').replace(/"/g, '\\"');
                          const wrappedContent = `[发送给 Teammate "${taskDesc}"]: ${content}`;
                          await sendMessage(groupJid, wrappedContent);
                          setScrollTrigger(n => n + 1);
                        }}
                        groupJid={groupJid}
                      />
                    </div>
                  );
                }
                return (
                  <div className="px-4 py-2 text-center text-xs text-slate-400 border-t">
                    {isSdkTask
                      ? (activeSdkTask?.status === 'running'
                        ? '子 Agent 独立运行中 — 仅主对话可发送消息'
                        : '子 Agent 已结束 — 仅主对话可发送消息')
                      : '子 Agent 独立运行中 — 仅主对话可发送消息'}
                  </div>
                );
              })()}
            </>
          ) : (
            /* Main conversation tab */
            <>
              <MessageList
                key={`main-${groupJid}`}
                messages={groupMessages || []}
                loading={loading}
                hasMore={hasMoreMessages}
                onLoadMore={handleLoadMore}
                scrollTrigger={scrollTrigger}
                groupJid={groupJid}
                isWaiting={isWaiting}
                onInterrupt={() => interruptQuery(groupJid)}
                agents={agents}
                onAgentClick={(agentId) => setActiveAgentTab(groupJid, agentId)}
                onSend={(content) => handleSend(content)}
              />
              <MessageInput
                onSend={handleSend}
                groupJid={groupJid}
                onResetSession={() => setShowResetConfirm(true)}
                onToggleTerminal={canUseTerminal ? handleTerminalToggle : undefined}
              />
            </>
          )}
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
            <button
              onClick={() => setSidebarTab('skills')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                sidebarTab === 'skills'
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              技能
            </button>
            {(group.is_shared || group.member_role === 'owner') && !group.is_home && (
              <button
                onClick={() => setSidebarTab('members')}
                className={`flex-1 px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                  sidebarTab === 'members'
                    ? 'text-primary border-b-2 border-primary'
                    : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                成员
              </button>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {sidebarTab === 'files' ? (
              <FilePanel groupJid={groupJid} />
            ) : sidebarTab === 'env' ? (
              <ContainerEnvPanel groupJid={groupJid} />
            ) : sidebarTab === 'members' ? (
              <GroupMembersPanel groupJid={groupJid} />
            ) : (
              <GroupSkillsPanel groupJid={groupJid} />
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
            <SheetTitle>工作区环境变量</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <ContainerEnvPanel
              groupJid={groupJid}
              onClose={() => setMobilePanel(null)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: skills sheet */}
      <Sheet open={mobilePanel === 'skills'} onOpenChange={(v) => !v && setMobilePanel(null)}>
        <SheetContent side="bottom" className="h-[80dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>技能管理</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <GroupSkillsPanel
              groupJid={groupJid}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: members sheet */}
      <Sheet open={mobilePanel === 'members'} onOpenChange={(v) => !v && setMobilePanel(null)}>
        <SheetContent side="bottom" className="h-[80dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>成员管理</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <GroupMembersPanel groupJid={groupJid} />
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
            <SheetTitle>工作区操作</SheetTitle>
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
            <button
              onClick={() => { setMobileActionsOpen(false); setMobilePanel('skills'); }}
              className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
            >
              技能
            </button>
            {(group.is_shared || group.member_role === 'owner') && !group.is_home && (
              <button
                onClick={() => { setMobileActionsOpen(false); setMobilePanel('members'); }}
                className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
              >
                成员管理
              </button>
            )}
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
        message="将清除 Claude 会话上下文并停止运行中的工作区进程，下次发送消息时将开始全新会话。聊天记录不受影响。"
        confirmText="清除"
        confirmVariant="danger"
        loading={resetLoading}
      />
    </div>
  );
}
