import { useEffect, useRef } from 'react';
import { useMonitorStore } from '../stores/monitor';
import { useAuthStore } from '../stores/auth';
import { ContainerStatus } from '../components/monitor/ContainerStatus';
import { QueueStatus } from '../components/monitor/QueueStatus';
import { SystemInfo } from '../components/monitor/SystemInfo';
import { GroupStatusCard } from '../components/monitor/GroupStatusCard';
import { RefreshCw, AlertTriangle, CheckCircle, Hammer, Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonStatCards } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import { wsManager } from '../api/ws';

export function MonitorPage() {
  const { status, loading, loadStatus, building, buildLogs, buildResult, buildDockerImage, clearBuildResult } = useMonitorStore();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const logEndRef = useRef<HTMLDivElement>(null);

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

  // Auto-scroll build logs to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [buildLogs]);

  const handleBuild = async () => {
    clearBuildResult();
    await buildDockerImage();
  };

  return (
    <div className="min-h-full bg-slate-50 p-4 lg:p-8">
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
            <div className="bg-white rounded-xl border border-slate-200 p-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-4">
                Docker 镜像
              </h2>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {status.dockerImageExists ? (
                    <>
                      <CheckCircle className="w-5 h-5 text-green-600" />
                      <span className="text-sm text-green-700 font-medium">镜像已就绪</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-5 h-5 text-red-500" />
                      <span className="text-sm text-red-600 font-medium">镜像不存在，Docker 模式的工作区将无法运行</span>
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
                  <div className="bg-slate-900 rounded-lg p-3 max-h-64 overflow-y-auto font-mono text-xs text-green-400">
                    {buildLogs.map((line, i) => (
                      <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                </div>
              )}

              {buildResult && (
                <div className={`mt-4 p-4 rounded-lg border ${buildResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    {buildResult.success ? (
                      <CheckCircle className="w-4 h-4 text-green-600" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-red-500" />
                    )}
                    <span className={`text-sm font-medium ${buildResult.success ? 'text-green-700' : 'text-red-600'}`}>
                      {buildResult.success ? '构建成功（已使用最新 Claude Code SDK/CLI）' : '构建失败'}
                    </span>
                  </div>
                  {buildResult.error && (
                    <pre className="text-xs text-red-700 bg-red-100 rounded p-3 mt-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
                      {buildResult.error}
                    </pre>
                  )}
                </div>
              )}
            </div>

            {/* 统计卡片 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <ContainerStatus status={status} />
              <QueueStatus status={status} />
              <SystemInfo status={status} />
            </div>

            {/* 群组详情 */}
            {status.groups && status.groups.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 p-4 lg:p-6">
                <h2 className="text-lg font-semibold text-slate-900 mb-4">
                  群组状态
                </h2>

                {/* 移动端：卡片列表 */}
                <div className="lg:hidden space-y-3">
                  {status.groups.map((group) => (
                    <GroupStatusCard key={group.jid} group={group} />
                  ))}
                </div>

                {/* 桌面端：表格 */}
                <div className="hidden lg:block overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead>
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                          群组
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                          队列
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                          运行状态
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                          进程标识
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {status.groups.map((group) => (
                        <tr key={group.jid} className="hover:bg-slate-50">
                          <td className="px-4 py-3 text-sm font-medium text-slate-900">
                            {group.jid}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-600">
                            {group.pendingTasks} 个任务 / {group.pendingMessages ? '有新消息' : '无新消息'}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {group.active ? (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-600">
                                运行中
                              </span>
                            ) : (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500">
                                空闲
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-600 font-mono text-xs">
                            {group.displayName || group.containerName || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
