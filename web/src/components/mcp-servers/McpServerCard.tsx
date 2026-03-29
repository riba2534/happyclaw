import { Download } from 'lucide-react';
import type { McpServer } from '../../stores/mcp-servers';
import { useMcpServersStore } from '../../stores/mcp-servers';

interface McpServerCardProps {
  server: McpServer;
  selected: boolean;
  onSelect: () => void;
}

export function McpServerCard({ server, selected, onSelect }: McpServerCardProps) {
  const toggleServer = useMcpServersStore((s) => s.toggleServer);

  const isHttpType = server.type === 'http' || server.type === 'sse';
  const preview = isHttpType
    ? `${server.type?.toUpperCase()} ${server.url || ''}`
    : [server.command, ...(server.args || [])].join(' ');

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-4 transition-all ${
        selected
          ? 'ring-2 ring-ring bg-brand-50 border-primary'
          : 'border-border hover:bg-muted'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{server.id}</h3>
            {isHttpType && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                {server.type?.toUpperCase()}
              </span>
            )}
            {server.syncedFromHost && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-warning-bg text-warning inline-flex items-center gap-1">
                <Download size={10} />
                已同步
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground truncate font-mono">{preview}</p>
          {server.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{server.description}</p>
          )}
        </div>

        <div
          className="flex items-center"
          onClick={(e) => {
            e.stopPropagation();
            toggleServer(server.id, !server.enabled);
          }}
        >
          <div
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
              server.enabled ? 'bg-primary' : 'bg-muted-foreground/40'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                server.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
