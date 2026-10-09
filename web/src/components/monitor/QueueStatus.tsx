import { ListOrdered } from 'lucide-react';
import { SystemStatus } from '../../stores/monitor';
import { StatTile } from './StatTile';

interface QueueStatusProps {
  status: SystemStatus;
}

export function QueueStatus({ status }: QueueStatusProps) {
  const groupsWithQueue =
    status.groups?.filter((g) => g.pendingMessages || g.pendingTasks > 0) || [];

  return (
    <StatTile label="队列状态" icon={ListOrdered} value={status.queueLength}>
      <div className="text-caption text-muted-foreground">
        {groupsWithQueue.length} 个群组有待处理任务或消息
      </div>

      {groupsWithQueue.length > 0 && (
        <div className="mt-2 space-y-1">
          {groupsWithQueue.slice(0, 3).map((group) => (
            <div
              key={group.jid}
              className="flex items-center justify-between gap-2 text-caption"
            >
              <span className="truncate text-muted-foreground">
                {group.jid}
              </span>
              <span className="shrink-0 font-medium text-foreground tabular-nums">
                {group.pendingTasks}
                {group.pendingMessages ? ' + 消息' : ''}
              </span>
            </div>
          ))}
          {groupsWithQueue.length > 3 && (
            <div className="text-caption text-muted-foreground">
              ... 还有 {groupsWithQueue.length - 3} 个群组
            </div>
          )}
        </div>
      )}
    </StatTile>
  );
}
