import { useEffect, useState } from 'react';
import { Archive, Download, Loader2, Trash2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { api, apiFetch } from '../../api/client';
import { getErrorMessage } from './types';
import { withBasePath } from '../../utils/url';

interface SystemBackup {
  filename: string;
  timestamp: string;
  size: number;
  sizeHuman: string;
}

export function SystemBackupSection() {
  const [backups, setBackups] = useState<SystemBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const data = await api.get<SystemBackup[]>('/api/backup');
      setBackups(data);
    } catch (err) {
      toast.error(getErrorMessage(err, '加载备份列表失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    setCreating(true);
    try {
      await apiFetch<SystemBackup>('/api/backup', {
        method: 'POST',
        timeoutMs: 300_000,
      });
      toast.success('系统备份已创建');
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, '创建备份失败'));
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = (filename: string) => {
    const url = withBasePath(`/api/backup/download/${encodeURIComponent(filename)}`);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  };

  const handleDelete = async (filename: string) => {
    if (!confirm('确定要删除此备份？')) return;
    try {
      await api.delete(`/api/backup/${encodeURIComponent(filename)}`);
      toast.success('备份已删除');
      setBackups((prev) => prev.filter((b) => b.filename !== filename));
    } catch (err) {
      toast.error(getErrorMessage(err, '删除备份失败'));
    }
  };

  const handleRestore = async (filename: string) => {
    if (!confirm('⚠️ 恢复备份将覆盖当前数据，确定继续？\n\n恢复后需要重启服务才能生效。')) return;
    try {
      await apiFetch(`/api/backup/restore/${encodeURIComponent(filename)}`, {
        method: 'POST',
        timeoutMs: 300_000,
      });
      toast.success('备份已恢复，请重启服务');
    } catch (err) {
      toast.error(getErrorMessage(err, '恢复备份失败'));
    }
  };

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch { return ts; }
  };

  return (
    <div className="border-t border-border pt-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">系统备份</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            完整备份数据库、配置、工作区和会话数据。最多保留 5 份，可下载到本地。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={handleCreate} disabled={creating}>
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
          {creating ? '备份中...' : '创建备份'}
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : backups.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">暂无系统备份</p>
      ) : (
        <div className="space-y-1.5">
          {backups.map((b) => (
            <div
              key={b.filename}
              className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/50 text-sm"
            >
              <div className="min-w-0">
                <span className="text-foreground">{formatTime(b.timestamp)}</span>
                <span className="text-muted-foreground ml-2">{b.sizeHuman}</span>
              </div>
              <div className="flex items-center gap-1 ml-2 shrink-0">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => handleRestore(b.filename)}
                  title="恢复备份"
                >
                  <RotateCcw className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => handleDownload(b.filename)}
                  title="下载备份"
                >
                  <Download className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(b.filename)}
                  title="删除备份"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
