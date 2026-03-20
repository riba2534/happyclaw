import { Loader2, Copy, Check, Link, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
    removingJid: string | null;
    load: () => void;
    remove: (jid: string) => void;
  };
}

export function PairingSection({ channelName, pairing, paired }: PairingSectionProps) {
  return (
    <div className="border-t border-slate-100 mt-4 pt-4">
      <div className="flex items-center gap-2 mb-3">
        <Link className="w-4 h-4 text-slate-500" />
        <h4 className="text-sm font-medium text-slate-700">聊天配对</h4>
      </div>

      {pairing.code && pairing.countdown > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <code className="text-2xl font-mono font-bold tracking-widest text-primary bg-primary/5 px-4 py-2 rounded-lg select-all">
              {pairing.code}
            </code>
            <div className="text-sm text-slate-500">
              {Math.floor(pairing.countdown / 60)}:{String(pairing.countdown % 60).padStart(2, '0')} 后过期
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" className="cursor-pointer" onClick={pairing.copyCommand}>
              {pairing.copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
              {pairing.copied ? '已复制' : '复制配对命令'}
            </Button>
            <Button variant="outline" size="sm" onClick={pairing.generate} disabled={pairing.generating}>
              {pairing.generating && <Loader2 className="size-3.5 animate-spin" />}
              重新生成
            </Button>
          </div>
          <p className="text-xs text-slate-400">
            在 {channelName} 中向 Bot 发送 <code className="bg-slate-100 px-1 rounded">/pair {pairing.code}</code> 完成配对
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Button variant="outline" onClick={pairing.generate} disabled={pairing.generating}>
            {pairing.generating && <Loader2 className="size-4 animate-spin" />}
            生成配对码
          </Button>
          <p className="text-xs text-slate-400">
            生成一次性配对码，在 {channelName} 聊天中发送{' '}
            <code className="bg-slate-100 px-1 rounded">/pair &lt;code&gt;</code> 将聊天绑定到此账号
          </p>
        </div>
      )}

      {/* Paired chats list */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-xs font-medium text-slate-600">已配对的聊天</h5>
          <button
            onClick={paired.load}
            disabled={paired.loading}
            className="text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50"
          >
            刷新
          </button>
        </div>
        {paired.loading ? (
          <div className="text-xs text-slate-400">加载中...</div>
        ) : paired.chats.length === 0 ? (
          <div className="text-xs text-muted-foreground">暂无已配对的聊天</div>
        ) : (
          <div className="space-y-1.5">
            {paired.chats.map((chat) => (
              <div key={chat.jid} className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted group">
                <div className="min-w-0">
                  <div className="text-sm text-foreground truncate">{chat.name}</div>
                  <div className="text-xs text-muted-foreground">{new Date(chat.addedAt).toLocaleString('zh-CN')}</div>
                </div>
                <button
                  onClick={() => paired.remove(chat.jid)}
                  disabled={paired.removingJid === chat.jid}
                  className="ml-2 p-1 rounded text-muted-foreground hover:text-error hover:bg-error-bg opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50"
                  title="移除配对"
                >
                  {paired.removingJid === chat.jid ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <X className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
