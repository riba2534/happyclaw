import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Message, useChatStore } from '../../stores/chat';
import { MessageBubble } from './MessageBubble';
import { Loader2, ChevronUp, ChevronDown, AlertTriangle } from 'lucide-react';

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}

type FlatItem =
  | { type: 'date'; content: string }
  | { type: 'divider'; content: string }
  | { type: 'error'; content: string }
  | { type: 'message'; content: Message };

export function MessageList({ messages, loading, hasMore, onLoadMore }: MessageListProps) {
  const thinkingCache = useChatStore(s => s.thinkingCache ?? {});
  const parentRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [atTop, setAtTop] = useState(false);
  const prevMessageCount = useRef(messages.length);

  // Compute flatMessages (with date headers) before virtualizer
  const flatMessages = useMemo<FlatItem[]>(() => {
    const grouped = messages.reduce((acc, msg) => {
      const date = new Date(msg.timestamp).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      if (!acc[date]) acc[date] = [];
      acc[date].push(msg);
      return acc;
    }, {} as Record<string, Message[]>);

    const items: FlatItem[] = [];
    Object.entries(grouped).forEach(([date, msgs]) => {
      items.push({ type: 'date', content: date });
      msgs.forEach((msg) => {
        if (msg.sender === '__system__') {
          if (msg.content === 'context_reset') {
            items.push({ type: 'divider', content: '上下文已清除' });
          } else if (msg.content.startsWith('agent_error:')) {
            items.push({ type: 'error', content: msg.content.slice('agent_error:'.length) });
          } else if (msg.content.startsWith('agent_max_retries:')) {
            items.push({ type: 'error', content: msg.content.slice('agent_max_retries:'.length) });
          }
        } else {
          items.push({ type: 'message', content: msg });
        }
      });
    });
    return items;
  }, [messages]);

  const virtualizer = useVirtualizer({
    count: flatMessages.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => {
      const item = flatMessages[index];
      if (!item) return index;
      switch (item.type) {
        case 'date': return `date-${item.content}`;
        case 'divider': return `div-${index}`;
        case 'error': return `err-${index}`;
        case 'message': return item.content.id;
      }
    },
    estimateSize: (index) => {
      const item = flatMessages[index];
      if (!item) return 100;
      switch (item.type) {
        case 'date': return 48;
        case 'divider':
        case 'error': return 56;
        case 'message': {
          const len = item.content.content.length;
          if (item.content.is_from_me) {
            return Math.max(80, Math.min(400, Math.ceil(len / 50) * 24 + 60));
          }
          return Math.max(48, Math.min(200, Math.ceil(len / 80) * 24 + 40));
        }
        default: return 100;
      }
    },
    overscan: 8,
  });

  // 检测向上滚动触发 loadMore
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = parent;
      const atBottom = scrollHeight - scrollTop - clientHeight < 100;
      setAutoScroll(atBottom);
      setAtTop(scrollTop < 50);

      if (scrollTop < 100 && hasMore && !loading) {
        onLoadMore();
      }
    };

    parent.addEventListener('scroll', handleScroll);
    return () => parent.removeEventListener('scroll', handleScroll);
  }, [hasMore, loading, onLoadMore]);

  // 新消息自动滚到底部
  useEffect(() => {
    if (autoScroll && messages.length > prevMessageCount.current) {
      parentRef.current?.scrollTo({
        top: parentRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
    prevMessageCount.current = messages.length;
  }, [messages, autoScroll]);

  // 初始滚到底部（首次加载完消息后触发）
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (!initialScrollDone.current && parentRef.current && messages.length > 0) {
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
      initialScrollDone.current = true;
    }
  }, [messages.length]);

  const scrollToTop = useCallback(() => {
    parentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const scrollToBottom = useCallback(() => {
    const parent = parentRef.current;
    if (!parent) return;
    parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
  }, []);

  const showScrollButtons = messages.length > 0;

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={parentRef}
        className="h-full overflow-y-auto py-6 bg-background"
      >
        <div className="max-w-3xl mx-auto px-4">
        {loading && hasMore && (
          <div className="flex justify-center py-4">
            <Loader2 className="animate-spin text-primary" size={24} />
          </div>
        )}

        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = flatMessages[virtualItem.index];
            if (!item) return null;

            if (item.type === 'date') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex justify-center my-6">
                    <span className="bg-white px-4 py-1 rounded-full text-xs text-slate-500 border border-slate-200">
                      {item.content}
                    </span>
                  </div>
                </div>
              );
            }

            if (item.type === 'divider') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex items-center gap-3 my-6 px-4">
                    <div className="flex-1 border-t border-amber-300" />
                    <span className="text-xs text-amber-600 whitespace-nowrap">
                      {item.content}
                    </span>
                    <div className="flex-1 border-t border-amber-300" />
                  </div>
                </div>
              );
            }

            if (item.type === 'error') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex items-center gap-3 my-6 px-4">
                    <div className="flex-1 border-t border-red-300" />
                    <span className="text-xs text-red-600 whitespace-nowrap flex items-center gap-1">
                      <AlertTriangle size={14} />
                      {item.content}
                    </span>
                    <div className="flex-1 border-t border-red-300" />
                  </div>
                </div>
              );
            }

            const message = item.content;
            const showTime = true;

            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
              >
                <MessageBubble message={message} showTime={showTime} thinkingContent={thinkingCache[message.id]} />
              </div>
            );
          })}
        </div>

        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-slate-400">
            <p className="text-sm">暂无消息</p>
            <p className="text-xs mt-2">发送消息开始对话</p>
          </div>
        )}
        </div>
      </div>

      {/* Floating scroll buttons */}
      {showScrollButtons && (
        <div className="absolute right-4 bottom-4 flex flex-col gap-1.5">
          {!atTop && (
            <button
              onClick={scrollToTop}
              className="w-10 h-10 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer"
              title="回到顶部"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          )}
          {!autoScroll && (
            <button
              onClick={scrollToBottom}
              className="w-10 h-10 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer"
              title="回到底部"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
