import { Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SystemStatus } from '../../stores/monitor';
import { StatTile } from './StatTile';

interface ContainerStatusProps {
  status: SystemStatus;
  /** Single-user host mode: every runner is a host process, with no cap. */
  hostOnly?: boolean;
}

export function ContainerStatus({ status, hostOnly }: ContainerStatusProps) {
  if (hostOnly) {
    return (
      <StatTile
        label="活跃工作区"
        icon={Server}
        value={String(status.activeHostProcesses ?? status.activeTotal ?? 0)}
      >
        <div className="text-caption text-muted-foreground">
          宿主机进程，不限制不同会话并发
        </div>
      </StatTile>
    );
  }
  const maxConcurrent = Math.max(1, status.maxConcurrentContainers || 20);
  const percentage = (status.activeContainers / maxConcurrent) * 100;
  const progressWidth = Math.min(100, percentage);

  return (
    <StatTile
      label="活跃工作区"
      icon={Server}
      value={`${status.activeContainers} / ${maxConcurrent}`}
    >
      <div className="h-1.5 w-full rounded-full bg-muted">
        <div
          className={cn(
            'h-1.5 rounded-full transition-all duration-300',
            percentage > 80
              ? 'bg-error'
              : percentage > 60
                ? 'bg-warning'
                : 'bg-success',
          )}
          style={{ width: `${progressWidth}%` }}
        />
      </div>

      <div className="mt-2 text-caption text-muted-foreground">
        {percentage > 80 && '工作区使用率较高'}
        {percentage > 60 && percentage <= 80 && '工作区使用正常'}
        {percentage <= 60 && '工作区资源充足'}
      </div>
    </StatTile>
  );
}
