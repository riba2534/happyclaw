import { useState } from 'react';
import { Download, Globe, LockKeyhole, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  capabilityRowButtonClass,
  capabilityRowClass,
} from '@/components/capabilities/capability-ui';
import type { McpServer } from '../../stores/mcp-servers';
import { useMcpServersStore } from '../../stores/mcp-servers';

interface McpServerCardProps {
  server: McpServer;
  selected: boolean;
  onSelect: () => void;
}

export function McpServerCard({
  server,
  selected,
  onSelect,
}: McpServerCardProps) {
  const toggleServer = useMcpServersStore((s) => s.toggleServer);
  const [toggling, setToggling] = useState(false);

  const isHttpType = server.type === 'http' || server.type === 'sse';
  const TypeIcon = isHttpType ? Globe : Terminal;
  const isImported = server.importedFromHost || server.syncedFromHost;
  const hasConflict = server.conflictSources.length > 1;
  const preview =
    server.runtimeAvailable === false
      ? '仅管理员可用'
      : isHttpType
        ? `${server.type?.toUpperCase()} ${server.url || ''}`
        : [server.command, ...(server.args || [])].join(' ');

  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await toggleServer(server.sourceKey, enabled);
      toast.success(`${server.id} 已${enabled ? '启用' : '停用'}`);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : `${enabled ? '启用' : '停用'} MCP 失败`,
      );
    } finally {
      setToggling(false);
    }
  };

  return (
    <div
      role="listitem"
      data-selected={selected || undefined}
      className={capabilityRowClass(selected)}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`查看 MCP ${server.id}`}
        onClick={onSelect}
        className={capabilityRowButtonClass}
      >
        <TypeIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body font-medium text-foreground">
              {server.id}
            </span>
            {isHttpType && (
              <Badge variant="neutral">{server.type?.toUpperCase()}</Badge>
            )}
            {isImported && (
              <Badge variant="neutral">
                <Download />
                宿主机副本
              </Badge>
            )}
            {server.readonly && (
              <Badge variant="neutral">
                <LockKeyhole /> 只读
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate font-mono text-caption text-muted-foreground">
            {preview}
          </span>
          {server.description && (
            <span className="mt-0.5 line-clamp-1 text-caption text-muted-foreground">
              {server.description}
            </span>
          )}
          {hasConflict && (
            <span className="mt-0.5 block text-caption text-warning">
              同名来源 · {server.effective ? '当前生效' : '由“我的”配置覆盖'}
            </span>
          )}
        </span>
      </button>

      <Switch
        checked={server.enabled}
        disabled={server.readonly || toggling}
        onCheckedChange={(checked) => void handleToggle(checked)}
        aria-label={`${server.enabled ? '禁用' : '启用'} ${server.id}`}
      />
    </div>
  );
}
