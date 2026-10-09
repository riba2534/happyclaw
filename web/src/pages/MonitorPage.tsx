import { useEffect, useRef, useState } from 'react';
import { useMonitorStore } from '../stores/monitor';
import { useAuthStore } from '../stores/auth';
import { ContainerStatus } from '../components/monitor/ContainerStatus';
import { QueueStatus } from '../components/monitor/QueueStatus';
import { SystemInfo } from '../components/monitor/SystemInfo';
import {
  GroupRunBadge,
  GroupStatusCard,
  type MonitorGroupStatus,
} from '../components/monitor/GroupStatusCard';
import {
  ProviderSwitcher,
  type SimpleProvider,
} from '../components/monitor/ProviderSwitcher';
import {
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Download,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import {
  DataTable,
  ListGroup,
  PageContainer,
  PageHeader,
  type DataTableColumn,
} from '@/components/common';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { wsManager } from '../api/ws';
import { api } from '@/api/client';

type ClaudeStatusIndicator = 'none' | 'minor' | 'major' | 'critical';

const CLAUDE_STATUS_DOT: Record<
  ClaudeStatusIndicator,
  'success' | 'warning' | 'error'
> = {
  none: 'success',
  minor: 'warning',
  major: 'error',
  critical: 'error',
};

/** Refresh control, also rendered in the settings header when embedded. */
export function MonitorRefreshButton() {
  const loading = useMonitorStore((s) => s.loading);
  const loadStatus = useMonitorStore((s) => s.loadStatus);
  return (
    <Button variant="outline" onClick={loadStatus} disabled={loading}>
      <RefreshCw className={cn(loading && 'animate-spin')} />
      刷新
    </Button>
  );
}

interface MonitorPageProps {
  /** Rendered inside settings, which supplies the page frame and header. */
  embedded?: boolean;
}

export function MonitorPage({ embedded = false }: MonitorPageProps) {
  const {
    status,
    loading,
    loadStatus,
    pulling,
    pullLogs,
    pullResult,
    pullDockerImage,
    clearPullResult,
  } = useMonitorStore();
  const canManageSystem = useAuthStore((s) =>
    s.hasPermission('manage_system_config'),
  );
  const logEndRef = useRef<HTMLDivElement>(null);
  const [providers, setProviders] = useState<SimpleProvider[]>([]);
  const [claudeStatus, setClaudeStatus] = useState<{
    description: string;
    indicator: ClaudeStatusIndicator | null;
  } | null>(null);

  useEffect(() => {
    loadStatus();

    const interval = setInterval(() => {
      loadStatus();
    }, 10000);

    return () => clearInterval(interval);
  }, [loadStatus]);

  useEffect(() => {
    let cancelled = false;
    const loadClaudeStatus = async () => {
      try {
        const response = await fetch(
          'https://status.claude.com/api/v2/status.json',
        );
        if (!response.ok) return;
        const data = (await response.json()) as {
          status?: { indicator?: string; description?: string };
        };
        if (!cancelled) {
          const indicator = data.status?.indicator;
          const description = data.status?.description || indicator;
          setClaudeStatus(
            description
              ? {
                  description,
                  indicator:
                    indicator && indicator in CLAUDE_STATUS_DOT
                      ? (indicator as ClaudeStatusIndicator)
                      : null,
                }
              : null,
          );
        }
      } catch {
        if (!cancelled) setClaudeStatus(null);
      }
    };
    void loadClaudeStatus();
    const timer = window.setInterval(loadClaudeStatus, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // WebSocket listeners for Docker Hub pull progress
  useEffect(() => {
    const unsubLog = wsManager.on(
      'docker_pull_log',
      (data: { line: string }) => {
        useMonitorStore.setState((s) => ({
          pullLogs: [...s.pullLogs.slice(-199), data.line],
        }));
      },
    );
    const unsubComplete = wsManager.on(
      'docker_pull_complete',
      (data: { success: boolean; error?: string }) => {
        useMonitorStore.setState({
          pulling: false,
          pullResult: { success: data.success, error: data.error },
        });
        loadStatus();
      },
    );

    return () => {
      unsubLog();
      unsubComplete();
    };
  }, [loadStatus]);

  // Fetch providers once for all ProviderSwitcher instances
  useEffect(() => {
    api
      .get<{
        providers: Array<{ id: string; name: string; enabled: boolean }>;
      }>('/api/config/claude/providers')
      .then((data) =>
        setProviders(
          data.providers
            .filter((p) => p.enabled)
            .map(({ id, name }) => ({ id, name })),
        ),
      )
      .catch(() => {});
  }, []);

  // Auto-scroll pull logs to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [pullLogs]);

  const handlePull = async () => {
    clearPullResult();
    await pullDockerImage();
  };

  const groupColumns: DataTableColumn<MonitorGroupStatus>[] = [
    {
      key: 'jid',
      header: '群组',
      cell: (group) => (
        <span className="font-medium text-foreground">{group.jid}</span>
      ),
    },
    {
      key: 'owner',
      header: '账号',
      cell: (group) => group.ownerUsername || '-',
      className: 'text-muted-foreground',
    },
    {
      key: 'queue',
      header: '队列',
      cell: (group) => (
        <>
          {group.pendingTasks} 个任务 /{' '}
          {group.pendingMessages ? '有新消息' : '无新消息'}
        </>
      ),
      className: 'text-muted-foreground',
    },
    {
      key: 'state',
      header: '运行状态',
      cell: (group) => <GroupRunBadge active={group.active} />,
    },
    {
      key: 'process',
      header: '进程标识',
      cell: (group) => group.displayName || group.containerName || '-',
      className: 'font-mono text-caption text-muted-foreground',
    },
    {
      key: 'provider',
      header: 'Provider',
      cell: (group) =>
        group.active ? (
          <ProviderSwitcher
            groupFolder={group.groupFolder}
            currentProviderId={group.selectedProviderId}
            currentProviderName={group.selectedProviderName}
            providers={providers}
          />
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
  ];

  const showPullLogs = pulling && pullLogs.length > 0;

  const content = (
    <div className="space-y-6">
      {loading && !status && (
        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="space-y-3 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border"
            >
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-7 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      )}

      {status && (
        <>
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
            <ContainerStatus status={status} />
            <QueueStatus status={status} />
            <SystemInfo status={status} />
          </div>

          <SettingsSection title="服务状态">
            <SettingsGroup>
              <SettingsRow
                label="Anthropic 服务状态"
                description={
                  claudeStatus ? (
                    <Badge
                      variant="outline"
                      dot={
                        claudeStatus.indicator
                          ? CLAUDE_STATUS_DOT[claudeStatus.indicator]
                          : 'muted'
                      }
                      className="mt-0.5"
                    >
                      {claudeStatus.description}
                    </Badge>
                  ) : (
                    '暂时无法读取外部状态，请打开官方状态页确认。'
                  )
                }
                control={
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href="https://status.claude.com"
                      target="_blank"
                      rel="noreferrer"
                    >
                      官方状态页
                      <ExternalLink />
                    </a>
                  </Button>
                }
              />

              {/* Docker 镜像状态 */}
              {status.dockerRequired === false ? (
                <SettingsRow
                  label="Docker 镜像"
                  description={
                    <span className="flex items-center gap-1.5">
                      <CheckCircle className="size-3.5 shrink-0 text-success" />
                      {status.adminHostOnlyMode
                        ? '管理员纯宿主机模式已开启，当前工作区无需 Docker。'
                        : '当前没有 Docker 模式的工作区，无需检查镜像。'}
                    </span>
                  }
                />
              ) : (
                <SettingsRow
                  label="Docker 镜像"
                  description={
                    status.dockerImageExists ? (
                      <span className="flex items-center gap-1.5 text-success">
                        <CheckCircle className="size-3.5 shrink-0" />
                        镜像已就绪
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-error">
                        <AlertTriangle className="size-3.5 shrink-0" />
                        镜像不存在，Docker 模式的工作区将无法运行
                      </span>
                    )
                  }
                  control={
                    <Button
                      size="sm"
                      onClick={handlePull}
                      disabled={pulling || !canManageSystem}
                      title={!canManageSystem ? '需要系统配置权限' : undefined}
                    >
                      {pulling ? (
                        <>
                          <Loader2 className="animate-spin" />
                          拉取中...
                        </>
                      ) : (
                        <>
                          <Download />
                          {status.dockerImageExists
                            ? '拉取最新镜像'
                            : '拉取镜像'}
                        </>
                      )}
                    </Button>
                  }
                >
                  {(showPullLogs || pullResult) && (
                    <div className="space-y-3">
                      {/* Pull logs */}
                      {showPullLogs && (
                        <div className="max-h-64 overflow-y-auto rounded-lg bg-(--code-block-bg) p-3 font-mono text-caption text-foreground ring-1 ring-surface-border">
                          {pullLogs.map((line, i) => (
                            <div
                              key={i}
                              className="whitespace-pre-wrap break-all"
                            >
                              {line}
                            </div>
                          ))}
                          <div ref={logEndRef} />
                        </div>
                      )}

                      {pullResult && (
                        <div
                          className={cn(
                            'rounded-lg px-3 py-2.5',
                            pullResult.success
                              ? 'bg-success/10'
                              : 'bg-error/10',
                          )}
                        >
                          <div
                            className={cn(
                              'flex items-center gap-2 text-label',
                              pullResult.success
                                ? 'text-success'
                                : 'text-error',
                            )}
                          >
                            {pullResult.success ? (
                              <CheckCircle className="size-4" />
                            ) : (
                              <AlertTriangle className="size-4" />
                            )}
                            {pullResult.success
                              ? '镜像拉取成功'
                              : '镜像拉取失败'}
                          </div>
                          {pullResult.error && (
                            <pre className="mt-2 max-h-48 overflow-auto font-mono text-caption whitespace-pre-wrap text-error">
                              {pullResult.error}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </SettingsRow>
              )}
            </SettingsGroup>
          </SettingsSection>

          {/* 群组详情 */}
          {status.groups && status.groups.length > 0 && (
            <SettingsSection title="群组状态">
              {/* 移动端：列表 */}
              <ListGroup className="lg:hidden">
                {status.groups.map((group) => (
                  <GroupStatusCard
                    key={group.jid}
                    group={group}
                    providers={providers}
                  />
                ))}
              </ListGroup>

              {/* 桌面端：表格 */}
              <DataTable
                className="hidden lg:block"
                columns={groupColumns}
                rows={status.groups}
                rowKey={(group) => group.jid}
              />
            </SettingsSection>
          )}
        </>
      )}
    </div>
  );

  if (embedded) return content;

  return (
    <PageContainer size="wide" className="space-y-6">
      <PageHeader
        title="系统监控"
        subtitle="实时监控系统状态（10秒自动刷新）"
        actions={<MonitorRefreshButton />}
      />
      {content}
    </PageContainer>
  );
}
