import { useEffect } from 'react';
import { ArrowRight, MessageSquare, SkipForward } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { PageContainer } from '@/components/common';
import { Button } from '@/components/ui/button';
import { ChannelAccountsManager } from '../components/settings/ChannelAccountsManager';
import { useAuthStore } from '../stores/auth';

/**
 * First-run setup intentionally reuses the same account-level onboarding as
 * Settings. Maintaining a second set of legacy provider forms caused QR and
 * pairing protocols to diverge from the product after onboarding.
 */
export function SetupChannelsPage() {
  const navigate = useNavigate();
  const { user, initialized } = useAuthStore();

  useEffect(() => {
    if (user === null && initialized) navigate('/login', { replace: true });
  }, [initialized, navigate, user]);

  return (
    <main className="h-dvh overflow-y-auto bg-background">
      <PageContainer className="space-y-6">
        <header className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-surface-border">
            <MessageSquare className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-title-lg text-foreground">
              接入消息渠道（可选）
            </h1>
            <p className="mt-1 max-w-2xl text-body text-muted-foreground">
              添加飞书、Telegram、QQ、微信、钉钉、Discord 或 WhatsApp
              账号。凭证、扫码和聊天配对会按照各渠道自己的协议完成。
            </p>
          </div>
        </header>

        <ChannelAccountsManager />

        <footer className="flex flex-wrap justify-end gap-2 border-t border-surface-border pt-5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate('/chat', { replace: true })}
          >
            <SkipForward />
            稍后设置
          </Button>
          <Button
            type="button"
            onClick={() => navigate('/chat', { replace: true })}
          >
            完成并进入 HappyClaw
            <ArrowRight />
          </Button>
        </footer>
      </PageContainer>
    </main>
  );
}
