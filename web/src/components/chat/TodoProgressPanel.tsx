import { memo } from 'react';
import { Check, Circle, ListChecks, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TodoItem {
  id: string;
  content: string;
  status: string;
}

interface TodoProgressPanelProps {
  todos: TodoItem[];
}

/** The agent's plan as a neutral checklist (Codex-style), progress on top. */
export const TodoProgressPanel = memo(function TodoProgressPanel({
  todos,
}: TodoProgressPanelProps) {
  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className="mb-2 rounded-lg bg-surface-raised px-3 py-2.5 font-sans ring-1 ring-surface-border">
      <div className="mb-2 flex items-center gap-2 text-caption text-muted-foreground">
        <ListChecks className="size-3.5" />
        <span className="font-medium text-foreground">计划</span>
        <span className="tabular-nums">
          {completed}/{total}
        </span>
        <div className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-surface-selected">
          <div
            className="h-full rounded-full bg-foreground/50 transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <ul className="space-y-1">
        {todos.map((todo) => {
          const done = todo.status === 'completed';
          const active = todo.status === 'in_progress';
          return (
            <li key={todo.id} className="flex items-start gap-2 text-label">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                {done ? (
                  <Check className="size-3.5 text-success" strokeWidth={2.5} />
                ) : active ? (
                  <Loader2 className="size-3.5 animate-spin text-foreground" />
                ) : (
                  <Circle className="size-3 text-faint-foreground" />
                )}
              </span>
              <span
                className={cn(
                  'break-words',
                  done &&
                    'text-muted-foreground line-through decoration-faint-foreground',
                  active && 'font-medium text-foreground',
                  !done && !active && 'text-muted-foreground',
                )}
              >
                {todo.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
});
