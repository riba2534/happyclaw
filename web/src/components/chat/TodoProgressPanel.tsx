import { Check, Loader2, Circle } from 'lucide-react';

interface TodoItem {
  id: string;
  content: string;
  status: string;
}

interface TodoProgressPanelProps {
  todos: TodoItem[];
}

export function TodoProgressPanel({ todos }: TodoProgressPanelProps) {
  const completed = todos.filter(t => t.status === 'completed').length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 mb-2">
      {/* Progress header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] font-medium text-primary">
          {completed}/{total} 已完成
        </span>
        <span className="text-[13px] text-muted-foreground">
          {Math.round(progress)}%
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-primary/10 rounded-full mb-2.5 overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Todo items */}
      <div className="space-y-1">
        {todos.map((todo) => (
          <div key={todo.id} className="flex items-start gap-2 text-[13px]">
            <span className="flex-shrink-0 mt-0.5">
              {todo.status === 'completed' ? (
                <Check className="w-3.5 h-3.5 text-primary" strokeWidth={3} />
              ) : todo.status === 'in_progress' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </span>
            <span className={`break-words ${
              todo.status === 'completed'
                ? 'text-muted-foreground line-through'
                : todo.status === 'in_progress'
                  ? 'text-primary font-medium'
                  : 'text-foreground'
            }`}>
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
