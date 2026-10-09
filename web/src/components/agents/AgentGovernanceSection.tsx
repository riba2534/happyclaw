import {
  ArrowRight,
  Link2,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import { ListGroup } from '@/components/common/ListRow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsGroup } from '@/components/settings/SettingsLayout';
import { cn } from '@/lib/utils';
import type { AgentProfile, AgentProfileGovernance } from '@/types';
import { AgentSection } from './AgentSection';

export function AgentGovernanceSection({
  selected,
  profiles,
  governance,
  busy,
  error,
  workspaceMoveTargets,
  movingWorkspaceJid,
  onRefresh,
  onMoveTargetChange,
  onMoveWorkspace,
}: {
  selected: AgentProfile;
  profiles: AgentProfile[];
  governance?: AgentProfileGovernance;
  busy: boolean;
  error?: string;
  workspaceMoveTargets: Record<string, string>;
  movingWorkspaceJid: string | null;
  onRefresh: () => void;
  onMoveTargetChange: (workspaceJid: string, targetProfileId: string) => void;
  onMoveWorkspace: (workspaceJid: string, targetProfileId: string) => void;
}) {
  const runtimeSessionCount =
    governance?.workspaces.reduce(
      (sum, workspace) => sum + workspace.runtime_sessions.length,
      0,
    ) ?? 0;

  return (
    <AgentSection
      title="运行归属"
      description="工作区、运行态会话和渠道绑定的当前归属"
      actions={
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
          <RefreshCw className={cn(busy && 'animate-spin')} />
          刷新
        </Button>
      }
    >
      <SettingsGroup className="grid grid-cols-3 divide-x divide-y-0">
        <SummaryItem
          icon={Workflow}
          label="工作区"
          value={governance?.workspaces.length ?? 0}
        />
        <SummaryItem
          icon={MessagesSquare}
          label="运行态会话"
          value={runtimeSessionCount}
        />
        <SummaryItem
          icon={Link2}
          label="渠道绑定"
          value={governance?.channel_mounts.length ?? 0}
        />
      </SettingsGroup>

      {error && !governance ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg bg-error/10 px-3 py-2 text-caption text-error"
          role="alert"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            重试
          </Button>
        </div>
      ) : busy && !governance ? (
        <div className="flex items-center gap-2 py-2 text-body text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在加载
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <div className="text-caption font-medium text-muted-foreground">
              工作区与运行态会话
            </div>
            <ListGroup className="max-h-72 overflow-y-auto">
              {(governance?.workspaces.length ?? 0) === 0 ? (
                <div
                  role="listitem"
                  className="px-4 py-3 text-caption leading-5 text-muted-foreground"
                >
                  {selected.is_default
                    ? '暂无工作区'
                    : '尚未绑定工作区。该智能体当前没有 Session 或 Memory；请显式为它新建工作区，或迁移一个非 Home 工作区。'}
                </div>
              ) : (
                governance?.workspaces.map((workspace) => (
                  <div
                    key={workspace.jid}
                    role="listitem"
                    className="space-y-2 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-body font-medium text-foreground">
                          {workspace.name}
                        </div>
                        <div className="truncate font-mono text-caption text-muted-foreground">
                          {workspace.folder}
                        </div>
                      </div>
                      <Badge variant="neutral">
                        {workspace.runtime_sessions.length} 个运行态会话
                      </Badge>
                    </div>
                    {workspace.runtime_sessions.length > 0 && (
                      <div className="space-y-0.5">
                        {workspace.runtime_sessions.map((session) => (
                          <div
                            key={`${workspace.jid}:${session.runtime_agent_id || 'main'}`}
                            className="truncate font-mono text-micro text-muted-foreground"
                          >
                            {session.runtime_agent_id || 'main'} ·{' '}
                            {session.sdk_session_id || '-'}
                          </div>
                        ))}
                      </div>
                    )}
                    {workspace.is_home ? (
                      <Badge variant="outline">Home · 固定归属 HappyClaw</Badge>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Select
                          value={workspaceMoveTargets[workspace.jid] || ''}
                          onValueChange={(value) =>
                            onMoveTargetChange(workspace.jid, value)
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="min-w-0 flex-1 text-caption"
                            aria-label={`迁移工作区 ${workspace.name}`}
                          >
                            <SelectValue placeholder="迁移到其他智能体" />
                          </SelectTrigger>
                          <SelectContent>
                            {profiles
                              .filter((profile) => profile.id !== selected.id)
                              .map((profile) => (
                                <SelectItem key={profile.id} value={profile.id}>
                                  {profile.is_default
                                    ? '主智能体'
                                    : profile.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            movingWorkspaceJid === workspace.jid ||
                            !workspaceMoveTargets[workspace.jid]
                          }
                          onClick={() =>
                            onMoveWorkspace(
                              workspace.jid,
                              workspaceMoveTargets[workspace.jid],
                            )
                          }
                        >
                          {movingWorkspaceJid === workspace.jid ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <ArrowRight />
                          )}
                          迁移
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </ListGroup>
          </div>

          <div className="min-w-0 space-y-2">
            <div className="text-caption font-medium text-muted-foreground">
              渠道绑定
            </div>
            <ListGroup className="max-h-72 overflow-y-auto">
              {(governance?.channel_mounts.length ?? 0) === 0 ? (
                <div
                  role="listitem"
                  className="px-4 py-3 text-caption text-muted-foreground"
                >
                  暂无渠道绑定
                </div>
              ) : (
                governance?.channel_mounts.map((mount) => (
                  <div
                    key={mount.channel_jid}
                    role="listitem"
                    className="space-y-1.5 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-body font-medium text-foreground">
                          {mount.channel_jid}
                        </div>
                        <div className="truncate font-mono text-caption text-muted-foreground">
                          {mount.workspace_folder || mount.workspace_jid}
                        </div>
                      </div>
                      <Badge variant="outline">{mount.channel_type}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
                      <span>
                        {mount.session_id
                          ? `session ${mount.session_id}`
                          : 'main'}
                      </span>
                      <span>{mount.routing_mode}</span>
                      <span>{mount.reply_policy}</span>
                    </div>
                  </div>
                ))
              )}
            </ListGroup>
          </div>
        </div>
      )}
    </AgentSection>
  );
}

function SummaryItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Workflow;
  label: string;
  value: number;
}) {
  return (
    <div className="min-w-0 border-surface-border px-4 py-3">
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <Icon className="size-3.5 text-faint-foreground" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-title text-foreground tabular-nums">
        {value}
      </div>
    </div>
  );
}
