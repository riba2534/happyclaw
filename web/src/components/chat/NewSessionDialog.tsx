import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '../../api/client';
import type { NewSessionOptions } from '../../hooks/useSessionActions';
import type { ModelChoice } from '../../lib/session-model-choice';
import { SessionModelChoiceField } from './SessionModelChoiceField';

type WorktreeSupport =
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; message: string };

interface NewSessionDialogProps {
  open: boolean;
  groupJid: string;
  /**
   * Offer the session its own git worktree (checked when the workspace can
   * have one). Off: a name and a model only, for those who cannot run on
   * the host or want no worktree.
   */
  offerWorktree?: boolean;
  onClose: () => void;
  /**
   * Create the session; resolves false when it was not created. A refusal
   * the server explains comes back through `onError`, shown in the dialog.
   */
  onCreate: (
    options: NewSessionOptions & { name: string; worktree: boolean },
  ) => Promise<boolean>;
}

/**
 * New session with options: a name, the model it runs (the default unless
 * one is picked) and, for Host workspaces whose directory is a git
 * repository, its own git worktree; otherwise the worktree option is
 * disabled with the server's reason.
 */
export function NewSessionDialog({
  open,
  groupJid,
  offerWorktree = true,
  onClose,
  onCreate,
}: NewSessionDialogProps) {
  const [name, setName] = useState('');
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [worktree, setWorktree] = useState(true);
  const [support, setSupport] = useState<WorktreeSupport>({
    state: 'checking',
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setModel(null);
    setError(null);
    setWorktree(true);
    setSupport({ state: 'checking' });
    if (!offerWorktree) return;
    let active = true;
    api
      .get<{ available: boolean; message?: string }>(
        `/api/groups/${encodeURIComponent(groupJid)}/git/worktree-support`,
      )
      .then((result) => {
        if (!active) return;
        setSupport(
          result.available
            ? { state: 'available' }
            : {
                state: 'unavailable',
                message: result.message || '这个工作区不能创建 worktree',
              },
        );
      })
      .catch(() => {
        if (active) {
          setSupport({
            state: 'unavailable',
            message: '无法检查工作目录，请稍后重试',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [open, groupJid, offerWorktree]);

  const useWorktree =
    offerWorktree && worktree && support.state === 'available';
  // Creating waits for the worktree check only where one is offered.
  const checking = offerWorktree && support.state === 'checking';
  const handleCreate = async () => {
    if (creating || checking) return;
    setCreating(true);
    setError(null);
    try {
      const created = await onCreate({
        name: name.trim(),
        worktree: useWorktree,
        // Nothing is sent for the default: a session without a choice runs it.
        ...(model ? { model } : {}),
        onError: setError,
      });
      if (created) onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
          <DialogDescription>
            {offerWorktree
              ? '会话有独立的对话上下文；勾选独立 worktree 后，文件改动也和其他会话分开。'
              : '会话有独立的对话上下文，和工作区的其他会话共用文件目录。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="new-session-name" className="mb-2">
              名称
            </Label>
            <Input
              id="new-session-name"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // Enter that confirms an IME candidate is not a submit.
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder="留空则根据第一条消息自动命名"
            />
          </div>
          <div>
            <Label htmlFor="new-session-model" className="mb-2">
              模型
            </Label>
            <SessionModelChoiceField
              id="new-session-model"
              workspaceJid={groupJid}
              value={model}
              onChange={(next) => {
                setModel(next);
                setError(null);
              }}
              disabled={creating}
            />
          </div>
          {offerWorktree && (
            <div className="flex items-start gap-3 rounded-lg border border-surface-border p-3">
              <Checkbox
                id="new-session-worktree"
                className="mt-0.5"
                checked={useWorktree}
                disabled={support.state !== 'available'}
                onCheckedChange={(value) => setWorktree(value === true)}
              />
              <div className="min-w-0 space-y-1">
                <Label htmlFor="new-session-worktree" className="text-label">
                  独立 worktree
                </Label>
                {support.state === 'checking' ? (
                  <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    正在检查工作目录…
                  </p>
                ) : support.state === 'unavailable' ? (
                  <p className="text-caption text-warning">{support.message}</p>
                ) : (
                  <p className="text-caption text-muted-foreground">
                    在新分支 happyclaw/… 的独立 git worktree
                    中工作，和其他会话的改动互不覆盖。删除会话时移除 worktree
                    目录，分支保留。
                  </p>
                )}
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-caption text-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={creating}>
            取消
          </Button>
          <Button
            onClick={() => void handleCreate()}
            disabled={creating || checking}
          >
            {creating && <Loader2 className="size-4 animate-spin" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
