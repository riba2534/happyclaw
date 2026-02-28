import { Play, Square, RotateCw, FileCode, Trash2 } from 'lucide-react';
import type { ScriptProcess } from '../../stores/scripts';

interface ScriptCardProps {
  script: ScriptProcess;
  actionLoading: string | null;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatUptime(ms: number): string {
  if (!ms) return '-';
  const now = Date.now();
  const diff = now - ms;
  if (diff < 0) return '-';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatMemory(bytes: number): string {
  if (!bytes) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PM_LABELS: Record<string, string> = {
  pm2: 'PM2',
  systemd: 'systemd',
  manual: '手动',
};

export function ScriptCard({
  script,
  actionLoading,
  onStart,
  onStop,
  onRestart,
  onDelete,
}: ScriptCardProps) {
  const isOnline = script.status === 'online';
  const isStopped = script.status === 'stopped';
  const isRegistered = script.status === 'registered';
  const isActing = actionLoading === script.id;

  const statusColor = isOnline
    ? 'bg-green-100 text-green-600'
    : isStopped
      ? 'bg-slate-100 text-slate-500'
      : isRegistered
        ? 'bg-blue-100 text-blue-500'
        : 'bg-red-100 text-red-600';

  const statusLabel = isOnline
    ? '运行中'
    : isStopped
      ? '已停止'
      : isRegistered
        ? '已注册'
        : script.status === 'errored'
          ? '异常'
          : script.status;

  const canStart = script.processManager === 'pm2' || !!script.startCommand;
  const canStop = script.processManager === 'pm2' || !!script.stopCommand;
  const canRestart = script.processManager === 'pm2' || (!!script.startCommand && !!script.stopCommand);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3">
        {/* Left: info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <FileCode size={16} className="text-slate-400 shrink-0" />
            <span className="font-medium text-sm text-slate-800 truncate">
              {script.name}
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusColor}`}
            >
              {statusLabel}
            </span>
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs text-slate-400 bg-slate-50 border border-slate-100">
              {PM_LABELS[script.processManager] || script.processManager}
            </span>
          </div>

          {script.description && (
            <p className="text-xs text-slate-500 mb-1.5 line-clamp-1">
              {script.description}
            </p>
          )}

          <div className="flex items-center gap-3 text-xs text-slate-400">
            {script.processManager === 'pm2' && isOnline && script.pid != null && (
              <>
                <span>PID {script.pid}</span>
                {script.uptime != null && <span>{formatUptime(script.uptime)}</span>}
                {script.memory != null && <span>{formatMemory(script.memory)}</span>}
                {script.cpu != null && <span>CPU {script.cpu}%</span>}
              </>
            )}
            {script.processManager === 'pm2' && script.restarts != null && script.restarts > 0 && (
              <span className="text-amber-500">
                重启 {script.restarts} 次
              </span>
            )}
            {script.processManager !== 'pm2' && script.startCommand && (
              <span className="truncate text-slate-300" title={script.startCommand}>
                {script.startCommand.length > 60
                  ? script.startCommand.slice(0, 60) + '...'
                  : script.startCommand}
              </span>
            )}
            {script.scriptPath && (
              <span className="truncate text-slate-300" title={script.scriptPath}>
                {script.scriptPath.split('/').pop()}
              </span>
            )}
          </div>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-1 shrink-0">
          {isOnline ? (
            <>
              {canRestart && (
                <button
                  onClick={() => onRestart(script.id)}
                  disabled={isActing}
                  className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
                  title="重启"
                >
                  <RotateCw size={15} className={isActing ? 'animate-spin' : ''} />
                </button>
              )}
              {canStop && (
                <button
                  onClick={() => onStop(script.id)}
                  disabled={isActing}
                  className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                  title="停止"
                >
                  <Square size={15} />
                </button>
              )}
            </>
          ) : canStart ? (
            <button
              onClick={() => onStart(script.id)}
              disabled={isActing}
              className="p-1.5 text-slate-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50"
              title="启动"
            >
              <Play size={15} />
            </button>
          ) : null}
          <button
            onClick={() => onDelete(script.id)}
            disabled={isActing}
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
            title="删除"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
