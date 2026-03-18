import { X } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';

interface BtwBubbleProps {
  id: string;
  question: string;
  answer: string;
  timestamp: string;
  onDismiss: () => void;
}

export function BtwBubble({ question, answer, timestamp, onDismiss }: BtwBubbleProps) {
  if (!answer?.trim()) return null;

  const time = new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="my-3 mx-1 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-700 p-3 relative">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
          旁路提问 · {time}
        </span>
        <button
          onClick={onDismiss}
          className="text-amber-400 hover:text-amber-600 dark:hover:text-amber-300 transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>
      <div className="text-xs text-amber-700/80 dark:text-amber-300/80 mb-1.5 italic">
        {question}
      </div>
      <div className="text-sm text-foreground prose prose-sm dark:prose-invert max-w-none">
        <MarkdownRenderer content={answer} variant="chat" />
      </div>
    </div>
  );
}
