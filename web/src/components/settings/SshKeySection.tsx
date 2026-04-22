import { useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, Upload, Trash2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api } from '../../api/client';
import { getErrorMessage } from './types';
import { SettingsCard as Section } from './SettingsCard';

interface SshStatus {
  configured: boolean;
  keyType?: string;
  fingerprint?: string | null;
}

export function SshKeySection() {
  const [status, setStatus] = useState<SshStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [pasteValue, setPasteValue] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const data = await api.get<SshStatus>('/api/config/user-ssh');
      setStatus(data);
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 SSH 配置失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await saveKey(text);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handlePaste = async () => {
    if (!pasteValue.trim()) return;
    await saveKey(pasteValue);
  };

  const saveKey = async (privateKey: string) => {
    setSaving(true);
    try {
      const data = await api.put<SshStatus>('/api/config/user-ssh', { privateKey });
      setStatus(data);
      setPasteValue('');
      toast.success('SSH 密钥已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 SSH 密钥失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.delete('/api/config/user-ssh');
      setStatus({ configured: false });
      toast.success('SSH 密钥已删除');
    } catch (err) {
      toast.error(getErrorMessage(err, '删除 SSH 密钥失败'));
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <Section icon={KeyRound} title="SSH 密钥" desc="用于 Docker 容器内 git clone 私有仓库">
        <div className="flex items-center justify-center py-4">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      </Section>
    );
  }

  return (
    <Section icon={KeyRound} title="SSH 密钥" desc="用于 Docker 容器内 git clone 私有仓库">
      {status?.configured ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
            <CheckCircle2 className="w-4 h-4" />
            <span>已配置（{status.keyType}）</span>
          </div>
          {status.fingerprint && (
            <div className="text-xs text-muted-foreground font-mono bg-muted/50 rounded px-3 py-2 break-all">
              {status.fingerprint}
            </div>
          )}
          <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            删除密钥
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-2 border-b border-border">
            <button
              className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${mode === 'file' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              onClick={() => setMode('file')}
            >
              选择文件
            </button>
            <button
              className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${mode === 'paste' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              onClick={() => setMode('paste')}
            >
              粘贴私钥
            </button>
          </div>

          {mode === 'file' ? (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                选择 SSH 私钥文件（如 ~/.ssh/id_ed25519）
              </Label>
              <input ref={fileRef} type="file" className="hidden" onChange={handleFileSelect} />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                选择私钥文件
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                粘贴 SSH 私钥内容
              </Label>
              <textarea
                className="w-full h-32 text-xs font-mono rounded-md border border-input bg-background px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                value={pasteValue}
                onChange={(e) => setPasteValue(e.target.value)}
              />
              <Button size="sm" onClick={handlePaste} disabled={saving || !pasteValue.trim()}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存密钥
              </Button>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            密钥以只读方式挂载到容器
          </p>
        </div>
      )}
    </Section>
  );
}
