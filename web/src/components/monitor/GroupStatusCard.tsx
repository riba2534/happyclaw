import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { ProviderSwitcher, type SimpleProvider } from './ProviderSwitcher';

export interface MonitorGroupStatus {
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
}

interface GroupStatusCardProps {
  group: MonitorGroupStatus;
  providers: SimpleProvider[];
}

export function GroupRunBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge variant="outline" dot="success">
      运行中
    </Badge>
  ) : (
    <Badge variant="outline" dot="muted">
      空闲
    </Badge>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-foreground">
        {children}
      </dd>
    </div>
  );
}

/** Compact list row used for the group table on narrow screens. */
export function GroupStatusCard({ group, providers }: GroupStatusCardProps) {
  return (
    <div role="listitem" className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-body font-medium text-foreground">
          {group.jid}
        </span>
        <GroupRunBadge active={group.active} />
      </div>

      <dl className="mt-2 space-y-1 text-caption">
        {group.ownerUsername && (
          <Field label="账号">{group.ownerUsername}</Field>
        )}
        <Field label="队列">
          {group.pendingTasks} 个任务 /{' '}
          {group.pendingMessages ? '有新消息' : '无新消息'}
        </Field>
        <Field label="进程标识">
          <span className="font-mono">
            {group.displayName || group.containerName || '-'}
          </span>
        </Field>
        <Field label="Provider">
          <ProviderSwitcher
            groupFolder={group.groupFolder}
            currentProviderId={group.selectedProviderId}
            currentProviderName={group.selectedProviderName}
            providers={providers}
          />
        </Field>
      </dl>
    </div>
  );
}
