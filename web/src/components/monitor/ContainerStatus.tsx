import { Server } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { SystemStatus } from '../../stores/monitor';

interface ContainerStatusProps {
  status: SystemStatus;
}

export function ContainerStatus({ status }: ContainerStatusProps) {
  const maxConcurrent = Math.max(1, status.maxConcurrentContainers || 20);
  const percentage = (status.activeContainers / maxConcurrent) * 100;
  const progressWidth = Math.min(100, percentage);

  return (
    <Card>
      <CardContent>
        <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-brand-100 rounded-lg">
          <Server className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">活跃工作区</h3>
          <p className="text-2xl font-bold text-foreground">
            {status.activeContainers} / {maxConcurrent}
          </p>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-muted rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${
            percentage > 80
              ? 'bg-error'
              : percentage > 60
              ? 'bg-warning'
              : 'bg-success'
          }`}
          style={{ width: `${progressWidth}%` }}
        />
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        {percentage > 80 && '工作区使用率较高'}
        {percentage > 60 && percentage <= 80 && '工作区使用正常'}
        {percentage <= 60 && '工作区资源充足'}
        </div>
      </CardContent>
    </Card>
  );
}
