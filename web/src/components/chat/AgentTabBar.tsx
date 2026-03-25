import { useState, useRef, useEffect, useMemo } from 'react';
import { Plus, X, Link, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import type { AgentInfo } from '../../types';

interface AgentTabBarProps {
  agents: AgentInfo[];
  activeTab: string | null; // null = main conversation
  onSelectTab: (agentId: string | null) => void;
  onDeleteAgent: (agentId: string) => void;
  onRenameAgent?: (agentId: string, currentName: string) => void;
  onCreateConversation?: () => void;
  onBindIm?: (agentId: string) => void;
  /** Show bind button on main conversation tab (non-home workspaces) */
  onBindMainIm?: () => void;
}

const tabClass = (active: boolean) =>
  `flex-shrink-0 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
    active
      ? 'border-border bg-accent text-accent-foreground'
      : 'border-border/40 text-muted-foreground hover:border-border hover:bg-accent/60 hover:text-foreground'
  }`;

interface ContextMenuState {
  agentId: string;
  agentName: string;
  x: number;
  y: number;
}

function ContextMenuOverlay({ menu, onRename, onDelete, onClose }: {
  menu: ContextMenuState;
  onRename?: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[120px] rounded-md border border-border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
      style={{ left: menu.x, top: menu.y }}
    >
      {onRename && (
        <button
          onClick={onRename}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
        >
          <Pencil className="w-3.5 h-3.5" />
          重命名
        </button>
      )}
      <button
        onClick={onDelete}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 cursor-pointer"
      >
        <Trash2 className="w-3.5 h-3.5" />
        删除
      </button>
    </div>
  );
}

export function AgentTabBar({ agents, activeTab, onSelectTab, onDeleteAgent, onRenameAgent, onCreateConversation, onBindIm, onBindMainIm }: AgentTabBarProps) {
  // Spawn agents are rendered inline in the main chat, not as separate tabs
  const conversations = useMemo(() => agents.filter(a => a.kind === 'conversation'), [agents]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up long-press timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  // Show bar if there are agents OR if creation is available
  if (conversations.length === 0 && !onCreateConversation) return null;

  const openContextMenu = (agentId: string, agentName: string, x: number, y: number) => {
    // Clamp position to viewport
    const menuWidth = 140;
    const menuHeight = 80;
    const clampedX = Math.min(x, window.innerWidth - menuWidth);
    const clampedY = Math.min(y, window.innerHeight - menuHeight);
    setContextMenu({ agentId, agentName, x: clampedX, y: clampedY });
  };

  const handleContextMenu = (e: React.MouseEvent, agent: AgentInfo) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(agent.id, agent.name, e.clientX, e.clientY);
  };

  const handleTouchStart = (agent: AgentInfo, e: React.TouchEvent) => {
    const touch = e.touches[0];
    const x = touch.clientX;
    const y = touch.clientY;
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      openContextMenu(agent.id, agent.name, x, y);
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  return (
    <>
      <div className="flex items-center gap-1 px-4 pt-1 pb-2 border-b border-border/40 overflow-x-auto scrollbar-none select-none">
        {/* Main conversation tab */}
        <div
          className={`${tabClass(activeTab === null)} flex items-center gap-1.5 group`}
          onClick={() => onSelectTab(null)}
        >
          <span>主对话</span>
          {onBindMainIm && (
            <button
              onClick={(e) => { e.stopPropagation(); onBindMainIm(); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-all cursor-pointer"
              title="绑定 IM 群组"
            >
              <Link className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Conversation tabs — same visual level as main */}
        {conversations.map((agent) => {
          const hasLinked = agent.linked_im_groups && agent.linked_im_groups.length > 0;
          return (
            <div
              key={agent.id}
              className={`${tabClass(activeTab === agent.id)} flex items-center gap-1.5 group`}
              onClick={() => onSelectTab(agent.id)}
              onContextMenu={(e) => handleContextMenu(e, agent)}
              onTouchStart={(e) => handleTouchStart(agent, e)}
              onTouchEnd={handleTouchEnd}
              onTouchMove={handleTouchEnd}
            >
              {agent.status === 'running' && (
                <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse flex-shrink-0" />
              )}
              {hasLinked && (
                <span title={`已绑定: ${agent.linked_im_groups!.map(g => g.name).join(', ')}`}>
                  <MessageSquare className="w-3 h-3 text-teal-500 flex-shrink-0" />
                </span>
              )}
              <span className="truncate max-w-[120px]">{agent.name}</span>
              {onBindIm && (
                <button
                  onClick={(e) => { e.stopPropagation(); onBindIm(agent.id); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-all cursor-pointer"
                  title="绑定 IM 群组"
                >
                  <Link className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-all cursor-pointer"
                title="关闭对话"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}

        {/* Create conversation button */}
        {onCreateConversation && (
          <button
            onClick={onCreateConversation}
            className="flex-shrink-0 flex items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
            title="新建对话"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}

      </div>

      {/* Context menu (right-click / long-press) */}
      {contextMenu && (
        <ContextMenuOverlay
          menu={contextMenu}
          onRename={onRenameAgent ? () => {
            onRenameAgent(contextMenu.agentId, contextMenu.agentName);
            setContextMenu(null);
          } : undefined}
          onDelete={() => {
            onDeleteAgent(contextMenu.agentId);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
