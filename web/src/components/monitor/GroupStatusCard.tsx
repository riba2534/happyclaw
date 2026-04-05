import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ProviderSwitcher, type SimpleProvider } from './ProviderSwitcher';

interface GroupStatusCardProps {
  group: {
    jid: string;
    active: boolean;
    pendingMessages: boolean;
    pendingTasks: number;
    containerName: string | null;
    displayName: string | null;
    groupFolder: string | null;
    ownerUsername: string | null;
    selectedProviderId: string | null;
    selectedProviderName: string | null;
  };
  providers: SimpleProvider[];
}

export function GroupStatusCard({ group, providers }: GroupStatusCardProps) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-foreground truncate mr-2">
          {group.jid}
        </span>
        {group.active ? (
          <Badge variant="default" className="bg-success-bg text-success hover:bg-success-bg shrink-0">
            运行中
          </Badge>
        ) : (
          <Badge variant="secondary" className="shrink-0">
            空闲
          </Badge>
        )}
      </div>

      <div className="space-y-1.5 text-xs text-muted-foreground">
        {group.ownerUsername && (
          <div className="flex items-center justify-between">
            <span>账号</span>
            <span className="text-foreground">{group.ownerUsername}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span>队列</span>
          <span className="text-foreground">
            {group.pendingTasks} 个任务 / {group.pendingMessages ? '有新消息' : '无新消息'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>进程标识</span>
          <span className="text-foreground font-mono truncate ml-2 max-w-[60%] text-right">
            {group.displayName || group.containerName || '-'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>Provider</span>
          <ProviderSwitcher
            groupFolder={group.groupFolder}
            currentProviderId={group.selectedProviderId}
            currentProviderName={group.selectedProviderName}
            providers={providers}
          />
        </div>
        </div>
      </CardContent>
    </Card>
  );
}
