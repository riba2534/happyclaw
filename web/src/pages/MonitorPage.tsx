import { useEffect, useRef, useState } from 'react';
import { useMonitorStore } from '../stores/monitor';
import { useAuthStore } from '../stores/auth';
import { ContainerStatus } from '../components/monitor/ContainerStatus';
import { QueueStatus } from '../components/monitor/QueueStatus';
import { SystemInfo } from '../components/monitor/SystemInfo';
import { GroupStatusCard } from '../components/monitor/GroupStatusCard';
import { ProviderSwitcher, type SimpleProvider } from '../components/monitor/ProviderSwitcher';
import { RefreshCw, AlertTriangle, CheckCircle, Hammer, Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonStatCards } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { wsManager } from '../api/ws';
import { api } from '@/api/client';

export function MonitorPage() {
  const { status, loading, loadStatus, building, buildLogs, buildResult, buildDockerImage, clearBuildResult } = useMonitorStore();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const logEndRef = useRef<HTMLDivElement>(null);
  const [providers, setProviders] = useState<SimpleProvider[]>([]);

  useEffect(() => {
    loadStatus();

    const interval = setInterval(() => {
      loadStatus();
    }, 10000);

    return () => clearInterval(interval);
  }, [loadStatus]);

  // WebSocket listeners for docker build progress
  useEffect(() => {
    const unsubLog = wsManager.on('docker_build_log', (data: { line: string }) => {
      useMonitorStore.setState((s) => ({
        buildLogs: [...s.buildLogs.slice(-199), data.line],
      }));
    });
    const unsubComplete = wsManager.on('docker_build_complete', (data: { success: boolean; error?: string }) => {
      useMonitorStore.setState({
        building: false,
        buildResult: { success: data.success, error: data.error },
      });
      loadStatus();
    });

    return () => {
      unsubLog();
      unsubComplete();
    };
  }, [loadStatus]);

  // Fetch providers once for all ProviderSwitcher instances
  useEffect(() => {
    api
      .get<{ providers: Array<{ id: string; name: string; enabled: boolean }> }>('/api/config/claude/providers')
      .then((data) => setProviders(data.providers.filter((p) => p.enabled).map(({ id, name }) => ({ id, name }))))
      .catch(() => {});
  }, []);

  // Auto-scroll build logs to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [buildLogs]);

  const handleBuild = async () => {
    clearBuildResult();
    await buildDockerImage();
  };

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <PageHeader
          title="系统监控"
          subtitle="实时监控系统状态（10秒自动刷新）"
          className="mb-6"
          actions={
            <Button variant="outline" onClick={loadStatus} disabled={loading}>
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          }
        />

        {loading && !status && (
          <SkeletonStatCards />
        )}

        {status && (
          <div className="space-y-6">
            {/* Docker 镜像状态 */}
            <Card>
              <CardContent>
                <h2 className="text-lg font-semibold text-foreground mb-4">
                  Docker 镜像
                </h2>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {status.dockerImageExists ? (
                    <>
                      <CheckCircle className="w-5 h-5 text-success" />
                      <span className="text-sm text-success font-medium">镜像已就绪</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-5 h-5 text-error" />
                      <span className="text-sm text-error font-medium">镜像不存在，Docker 模式的工作区将无法运行</span>
                    </>
                  )}
                </div>
                <Button
                  onClick={handleBuild}
                  disabled={building || !isAdmin}
                  title={!isAdmin ? '仅管理员可构建镜像' : undefined}
                >
                  {building ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      构建中...
                    </>
                  ) : (
                    <>
                      <Hammer className="w-4 h-4" />
                      {status.dockerImageExists ? '重新构建' : '构建镜像'}
                    </>
                  )}
                </Button>
              </div>

              {/* Build logs */}
              {building && buildLogs.length > 0 && (
                <div className="mt-4">
                  <div className="bg-[#0f172a] dark:bg-[#0a0f1a] rounded-lg p-3 max-h-64 overflow-y-auto font-mono text-xs text-green-400">
                    {buildLogs.map((line, i) => (
                      <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                </div>
              )}

              {buildResult && (
                <div className={`mt-4 p-4 rounded-lg border ${buildResult.success ? 'bg-success-bg border-success/20' : 'bg-error-bg border-error/20'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    {buildResult.success ? (
                      <CheckCircle className="w-4 h-4 text-success" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-error" />
                    )}
                    <span className={`text-sm font-medium ${buildResult.success ? 'text-success' : 'text-error'}`}>
                      {buildResult.success ? '构建成功（已使用最新 Claude Code SDK/CLI）' : '构建失败'}
                    </span>
                  </div>
                  {buildResult.error && (
                    <pre className="text-xs text-error bg-error-bg rounded p-3 mt-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
                      {buildResult.error}
                    </pre>
                  )}
                </div>
              )}
              </CardContent>
            </Card>

            {/* 统计卡片 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <ContainerStatus status={status} />
              <QueueStatus status={status} />
              <SystemInfo status={status} />
            </div>

            {/* 群组详情 */}
            {status.groups && status.groups.length > 0 && (
              <Card>
                <CardContent>
                  <h2 className="text-lg font-semibold text-foreground mb-4">
                    群组状态
                  </h2>

                {/* 移动端：卡片列表 */}
                <div className="lg:hidden space-y-3">
                  {status.groups.map((group) => (
                    <GroupStatusCard key={group.jid} group={group} providers={providers} />
                  ))}
                </div>

                {/* 桌面端：表格 */}
                <div className="hidden lg:block overflow-x-auto">
                  <table className="min-w-full divide-y divide-border">
                    <thead>
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          群组
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          账号
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          队列
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          运行状态
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          进程标识
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          Provider
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {status.groups.map((group) => (
                        <tr key={group.jid} className="hover:bg-muted/50">
                          <td className="px-4 py-3 text-sm font-medium text-foreground">
                            {group.jid}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {group.ownerUsername || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {group.pendingTasks} 个任务 / {group.pendingMessages ? '有新消息' : '无新消息'}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {group.active ? (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-success-bg text-success">
                                运行中
                              </span>
                            ) : (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
                                空闲
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground font-mono text-xs">
                            {group.displayName || group.containerName || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {group.active ? (
                              <ProviderSwitcher
                                groupFolder={group.groupFolder}
                                currentProviderId={group.selectedProviderId}
                                currentProviderName={group.selectedProviderName}
                                providers={providers}
                              />
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
