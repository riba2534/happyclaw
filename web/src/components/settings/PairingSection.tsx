import { Link as RouterLink } from 'react-router-dom';
import {
  Loader2,
  Copy,
  Check,
  ArrowRight,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/common/IconButton';
import { confirmDialog } from '@/stores/confirm';
import type { PairedChat } from './hooks/usePairedChats';

interface PairingSectionProps {
  channelName: string;
  pairing: {
    code: string | null;
    countdown: number;
    generating: boolean;
    copied: boolean;
    generate: () => void;
    copyCommand: () => void;
  };
  paired: {
    chats: PairedChat[];
    loading: boolean;
    error?: string | null;
    removingJid: string | null;
    renamingJid?: string | null;
    load: () => void;
    remove: (jid: string) => void;
    rename?: (jid: string, name: string) => void;
  };
}

export function PairingSection({
  channelName,
  pairing,
  paired,
}: PairingSectionProps) {
  const handleRemove = async (chat: PairedChat) => {
    const confirmed = await confirmDialog({
      title: '解除配对',
      message: `解除「${chat.name}」与这个 ${channelName} 账号的配对？`,
      confirmText: '解除配对',
      variant: 'danger',
    });
    if (confirmed) paired.remove(chat.jid);
  };

  return (
    <section className="space-y-3 border-t border-surface-border pt-4">
      <h4 className="text-title-sm text-foreground">聊天配对</h4>

      {pairing.code && pairing.countdown > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-muted/60 px-4 py-3 ring-1 ring-surface-border">
            <code className="font-mono text-display-sm font-semibold tracking-widest text-foreground select-all">
              {pairing.code}
            </code>
            <span className="text-caption text-muted-foreground tabular-nums">
              {Math.floor(pairing.countdown / 60)}:
              {String(pairing.countdown % 60).padStart(2, '0')} 后过期
            </span>
            <div className="flex items-center gap-2 sm:ml-auto">
              <Button variant="outline" size="sm" onClick={pairing.copyCommand}>
                {pairing.copied ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {pairing.copied ? '已复制' : '复制配对命令'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={pairing.generate}
                disabled={pairing.generating}
              >
                {pairing.generating && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                重新生成
              </Button>
            </div>
          </div>
          <p className="text-caption text-muted-foreground">
            在 {channelName} 中向 Bot 发送{' '}
            <code className="rounded bg-muted px-1 font-mono text-foreground">
              /pair {pairing.code}
            </code>{' '}
            完成配对
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={pairing.generate}
            disabled={pairing.generating}
          >
            {pairing.generating && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            生成配对码
          </Button>
          <p className="text-caption text-muted-foreground">
            生成一次性配对码，在 {channelName} 聊天中发送{' '}
            <code className="rounded bg-muted px-1 font-mono text-foreground">
              /pair &lt;code&gt;
            </code>{' '}
            将聊天绑定到此账号
          </p>
        </div>
      )}

      {/* Paired chats list */}
      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between gap-2">
          <h5 className="text-caption font-medium text-muted-foreground">
            已配对的聊天
          </h5>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => paired.load()}
            disabled={paired.loading}
            className="text-muted-foreground"
            aria-label={`刷新 ${channelName} 已配对聊天`}
          >
            <RefreshCw
              className={paired.loading ? 'motion-safe:animate-spin' : ''}
            />
            {paired.loading ? '加载中…' : '刷新'}
          </Button>
        </div>
        {paired.error && (
          <p role="alert" className="text-caption text-error">
            {paired.error}
          </p>
        )}
        {paired.loading ? (
          <div className="text-caption text-muted-foreground">加载中...</div>
        ) : paired.chats.length === 0 ? (
          <div className="rounded-lg px-3 py-3 text-caption text-muted-foreground ring-1 ring-surface-border ring-inset">
            暂无已配对的聊天
          </div>
        ) : (
          <div className="space-y-2">
            <div
              role="list"
              className="divide-y divide-surface-border overflow-hidden rounded-lg ring-1 ring-surface-border"
            >
              {paired.chats.map((chat) => (
                <div
                  key={chat.jid}
                  role="listitem"
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body text-foreground">
                      {chat.name}
                    </div>
                    <div className="text-caption text-muted-foreground tabular-nums">
                      {new Date(chat.addedAt).toLocaleString('zh-CN')}
                    </div>
                  </div>
                  <IconButton
                    label={`解除配对 ${chat.name}`}
                    className="text-muted-foreground hover:text-error"
                    disabled={paired.removingJid === chat.jid}
                    onClick={() => void handleRemove(chat)}
                    icon={
                      paired.removingJid === chat.jid ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )
                    }
                  />
                </div>
              ))}
            </div>
            <RouterLink
              to="/settings?tab=my-channels&view=bindings"
              className="inline-flex items-center gap-1.5 rounded-md text-caption font-medium text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-11"
            >
              到“已接入会话”管理路由、响应方式和删除
              <ArrowRight className="size-3.5" />
            </RouterLink>
          </div>
        )}
      </div>
    </section>
  );
}
