import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Plus, Link, MessageSquare, Pencil, Trash2, Loader2 } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { AgentInfo } from '../../types';

interface AgentTabBarProps {
  agents: AgentInfo[];
  activeTab: string | null; // null = main conversation
  /** Workspace owner-only ACL (backend `can_modify`). When false, all mutating
   *  affordances (create / rename / delete / bind) are hidden — non-owners get
   *  read-only tabs they can still select and view. Defaults to false so the
   *  loading state and non-owners both render read-only (no button flicker). */
  canModify?: boolean;
  onSelectTab: (agentId: string | null) => void;
  onDeleteAgent: (agentId: string) => void;
  onRenameAgent?: (agentId: string, currentName: string) => void;
  onCreateConversation?: () => void;
  onBindIm?: (agentId: string) => void;
  /** Show bind button on main conversation tab (non-home workspaces) */
  onBindMainIm?: () => void;
  /** Called when conversations are reordered via drag-and-drop */
  onReorder?: (orderedIds: string[]) => void;
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

function ContextMenuOverlay({ menu, onRename, onBindIm, onDelete, onClose }: {
  menu: ContextMenuState;
  onRename?: () => void;
  onBindIm?: () => void;
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
      {onBindIm && (
        <button
          onClick={onBindIm}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
        >
          <Link className="w-3.5 h-3.5" />
          绑定 IM 群组
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

function SortableTab({ agent, isActive, onSelect, onContextMenu, onTouchStart, onTouchEnd }: {
  agent: AgentInfo;
  isActive: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: agent.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : undefined,
  };
  const hasLinked = agent.linked_im_groups && agent.linked_im_groups.length > 0;

  // Merge dnd-kit listeners with custom touch handlers for long-press context menu
  const mergedOnTouchStart = (e: React.TouchEvent) => {
    listeners?.onTouchStart?.(e as unknown as TouchEvent);
    onTouchStart(e);
  };
  const mergedOnTouchEnd = () => {
    onTouchEnd();
  };
  const mergedOnTouchMove = () => {
    onTouchEnd(); // cancel long-press on move
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`${tabClass(isActive)} flex items-center gap-1.5 group`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onTouchStart={mergedOnTouchStart}
      onTouchEnd={mergedOnTouchEnd}
      onTouchMove={mergedOnTouchMove}
    >
      {agent.title_generating ? (
        <Loader2
          className="w-3 h-3 animate-spin text-teal-500 flex-shrink-0"
          aria-label="正在生成标题"
        />
      ) : agent.status === 'running' ? (
        <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse flex-shrink-0" />
      ) : null}
      {hasLinked && (
        <span title={`已绑定: ${agent.linked_im_groups!.map(g => g.name).join(', ')}`}>
          <MessageSquare className="w-3 h-3 text-teal-500 flex-shrink-0" />
        </span>
      )}
      <span className="truncate max-w-[120px]">{agent.name}</span>
    </div>
  );
}

export function AgentTabBar({ agents, activeTab, canModify = false, onSelectTab, onDeleteAgent, onRenameAgent, onCreateConversation, onBindIm, onBindMainIm, onReorder }: AgentTabBarProps) {
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const conversationIds = useMemo(() => conversations.map(a => a.id), [conversations]);

  const handleDragStart = useCallback(() => {
    // Cancel long-press context menu timer when drag starts
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = conversations.findIndex(a => a.id === active.id);
    const newIndex = conversations.findIndex(a => a.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(conversations, oldIndex, newIndex);
    onReorder?.(reordered.map(a => a.id));
  }, [conversations, onReorder]);

  // Show bar if there are agents OR if the owner can create one. Non-owners
  // with no conversation tabs see nothing extra (just the main conversation).
  if (conversations.length === 0 && !(onCreateConversation && canModify)) return null;

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
    // All context-menu actions (rename / bind / delete) mutate the workspace.
    if (!canModify) return;
    openContextMenu(agent.id, agent.name, e.clientX, e.clientY);
  };

  const handleTouchStart = (agent: AgentInfo, e: React.TouchEvent) => {
    if (!canModify) return; // no long-press menu for read-only (non-owner) tabs
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
          {onBindMainIm && canModify && (
            <button
              onClick={(e) => { e.stopPropagation(); onBindMainIm(); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-all cursor-pointer"
              title="绑定 IM 群组"
            >
              <Link className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Conversation tabs — draggable, same visual level as main */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <SortableContext items={conversationIds} strategy={horizontalListSortingStrategy}>
            {conversations.map((agent) => (
              <SortableTab
                key={agent.id}
                agent={agent}
                isActive={activeTab === agent.id}
                onSelect={() => onSelectTab(agent.id)}
                onContextMenu={(e) => handleContextMenu(e, agent)}
                onTouchStart={(e) => handleTouchStart(agent, e)}
                onTouchEnd={handleTouchEnd}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* Create conversation button (owner-only) */}
        {onCreateConversation && canModify && (
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
          onBindIm={onBindIm ? () => {
            onBindIm(contextMenu.agentId);
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
