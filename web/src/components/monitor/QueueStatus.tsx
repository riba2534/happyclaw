import { ListOrdered } from 'lucide-react';
import { SystemStatus } from '../../stores/monitor';

interface QueueStatusProps {
  status: SystemStatus;
}

export function QueueStatus({ status }: QueueStatusProps) {
  const groupsWithQueue = status.groups?.filter((g) => g.pendingMessages || g.pendingTasks > 0) || [];

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-amber-100 rounded-lg">
          <ListOrdered className="w-6 h-6 text-amber-600" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">队列状态</h3>
          <p className="text-2xl font-bold text-foreground">
            {status.queueLength}
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          {groupsWithQueue.length} 个群组有待处理任务或消息
        </div>

        {groupsWithQueue.length > 0 && (
          <div className="mt-3 space-y-1">
            {groupsWithQueue.slice(0, 3).map((group) => (
              <div
                key={group.jid}
                className="flex items-center justify-between text-xs"
              >
                <span className="text-muted-foreground truncate">{group.jid}</span>
                <span className="text-foreground font-medium ml-2">
                  {group.pendingTasks}{group.pendingMessages ? ' + 消息' : ''}
                </span>
              </div>
            ))}
            {groupsWithQueue.length > 3 && (
              <div className="text-xs text-muted-foreground/60">
                ... 还有 {groupsWithQueue.length - 3} 个群组
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
