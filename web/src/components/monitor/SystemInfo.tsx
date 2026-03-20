import { Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { SystemStatus } from '../../stores/monitor';

interface SystemInfoProps {
  status: SystemStatus;
}

export function SystemInfo({ status }: SystemInfoProps) {
  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  return (
    <Card>
      <CardContent>
        <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-success-bg rounded-lg">
          <Activity className="w-6 h-6 text-success" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">系统信息</h3>
          <p className="text-2xl font-bold text-foreground">运行中</p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">运行时间</span>
          <span className="text-foreground font-medium">
            {formatUptime(status.uptime)}
          </span>
        </div>

        {status.claudeCodeVersion !== undefined && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Claude Code</span>
            <span className="text-foreground font-medium font-mono text-xs">
              {status.claudeCodeVersion || '未知'}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">飞书连接</span>
          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-success-bg text-success">
            已连接
          </span>
        </div>
        </div>
      </CardContent>
    </Card>
  );
}
