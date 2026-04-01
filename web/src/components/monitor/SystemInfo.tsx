import { Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { RuntimeVersionInfo, SystemStatus } from '../../stores/monitor';

interface SystemInfoProps {
  status: SystemStatus;
}

/** Extract semver-like version number from strings like "2.1.81 (Claude Code)" */
function extractVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/** Check if a version string is outdated compared to latest */
function isOutdated(current: string | null | undefined, latest: string | null | undefined): boolean {
  const cv = extractVersion(current);
  const lv = extractVersion(latest);
  if (!cv || !lv) return false;
  return cv !== lv;
}

function VersionBadge({ current, latest }: { current: string | null | undefined; latest: string | null | undefined }) {
  if (!current) return null;
  const outdated = isOutdated(current, latest);
  if (!outdated) {
    return (
      <span className="ml-1.5 inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">
        最新
      </span>
    );
  }
  return (
    <span className="ml-1.5 inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
      可更新
    </span>
  );
}

function RuntimeVersionBlock({
  title,
  info,
}: {
  title: string;
  info: RuntimeVersionInfo;
}) {
  if (!info.host && !info.container && !info.latest) return null;

  return (
    <div className="pt-2 border-t border-border first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="text-muted-foreground">{title}</span>
        <span className="text-foreground font-medium">运行时版本</span>
      </div>
      {info.latest && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">最新版本</span>
          <span className="text-foreground font-medium font-mono text-xs">
            {info.latest}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">宿主机</span>
        <span className="text-foreground font-medium font-mono text-xs flex items-center">
          {extractVersion(info.host) || info.host || '未安装'}
          <VersionBadge current={info.host} latest={info.latest} />
        </span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">容器</span>
        <span className="text-foreground font-medium font-mono text-xs flex items-center">
          {info.container ? extractVersion(info.container) || info.container : '未构建或未安装'}
          {info.container && <VersionBadge current={info.container} latest={info.latest} />}
        </span>
      </div>
    </div>
  );
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

  const versions = status.agentRuntimeVersions;

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

        {versions !== undefined && versions !== null && (
          <>
            <RuntimeVersionBlock title="Claude" info={versions.claude} />
            <RuntimeVersionBlock title="Codex" info={versions.codex} />
          </>

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
