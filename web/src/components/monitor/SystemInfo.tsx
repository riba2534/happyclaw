import type { ReactNode } from 'react';
import { Activity } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SystemStatus } from '../../stores/monitor';
import { StatTile } from './StatTile';

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
function isOutdated(
  current: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  const cv = extractVersion(current);
  const lv = extractVersion(latest);
  if (!cv || !lv) return false;
  return cv !== lv;
}

function VersionBadge({
  current,
  latest,
}: {
  current: string | null | undefined;
  latest: string | null | undefined;
}) {
  if (!current) return null;
  return isOutdated(current, latest) ? (
    <Badge variant="warning">可更新</Badge>
  ) : (
    <Badge variant="success">最新</Badge>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-5 items-center justify-between gap-2 text-caption">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        {children}
      </span>
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

  const versions = status.claudeCodeVersions;

  return (
    <StatTile label="系统信息" icon={Activity} value="运行中">
      <div className="space-y-1.5">
        <InfoRow label="运行时间">
          <span className="tabular-nums">{formatUptime(status.uptime)}</span>
        </InfoRow>

        {versions !== undefined && (
          <>
            {versions?.latest && (
              <InfoRow label="最新版本">
                <span className="font-mono">{versions.latest}</span>
              </InfoRow>
            )}
            <InfoRow label="宿主机">
              <span className="font-mono">
                {extractVersion(versions?.host) || '未知'}
              </span>
              <VersionBadge
                current={versions?.host}
                latest={versions?.latest}
              />
            </InfoRow>
            <InfoRow label="容器">
              <span className="font-mono">
                {versions?.container
                  ? extractVersion(versions.container) || versions.container
                  : '未构建'}
              </span>
              {versions?.container && (
                <VersionBadge
                  current={versions.container}
                  latest={versions?.latest}
                />
              )}
            </InfoRow>
          </>
        )}

        <InfoRow label="飞书连接">
          <Badge variant="outline" dot="success">
            已连接
          </Badge>
        </InfoRow>
      </div>
    </StatTile>
  );
}
