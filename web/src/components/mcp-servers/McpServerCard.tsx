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

  const commandPreview = [server.command, ...(server.args || [])].join(' ');

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-4 transition-all ${
        selected
          ? 'ring-2 ring-ring bg-brand-50 border-primary'
          : 'border-slate-200 hover:bg-slate-50'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-slate-900 truncate">{server.id}</h3>
            {server.syncedFromHost && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 inline-flex items-center gap-1">
                <Download size={10} />
                已同步
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500 truncate font-mono">{commandPreview}</p>
          {server.description && (
            <p className="text-xs text-slate-400 mt-1 line-clamp-1">{server.description}</p>
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
              server.enabled ? 'bg-primary' : 'bg-slate-300'
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
