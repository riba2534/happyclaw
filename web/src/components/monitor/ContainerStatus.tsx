import { Server } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SystemStatus } from '../../stores/monitor';
import { StatTile } from './StatTile';

interface ContainerStatusProps {
  status: SystemStatus;
}

export function ContainerStatus({ status }: ContainerStatusProps) {
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
