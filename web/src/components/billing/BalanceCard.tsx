import { useEffect, useState } from 'react';
import { Wallet, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useBillingStore } from '../../stores/billing';
import { useCurrency } from './utils';

export default function BalanceCard() {
  const {
    balance,
    access,
    billingMinStartBalanceUsd,
    loadMyBalance,
    loadMyAccess,
  } = useBillingStore();
  const fmt = useCurrency();
  const [redeemInput, setRedeemInput] = useState('');
  const [redeemMsg, setRedeemMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const redeemCode = useBillingStore((s) => s.redeemCode);

  useEffect(() => {
    loadMyBalance();
    loadMyAccess();
  }, [loadMyAccess, loadMyBalance]);

  // Auto-clear success message after 3 seconds
  useEffect(() => {
    if (redeemMsg?.ok) {
      const timer = setTimeout(() => setRedeemMsg(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [redeemMsg]);

  const handleRedeem = async () => {
    const code = redeemInput.trim();
    if (!code || submitting) return;
    setSubmitting(true);
    try {
      const result = await redeemCode(code);
      setRedeemMsg({ ok: result.success, text: result.message });
      if (result.success) {
        setRedeemInput('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="flex flex-col rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border sm:p-5">
      <div className="mb-3 flex min-h-7 items-center gap-2">
        <Wallet className="size-4 text-muted-foreground" />
        <h3 className="text-title-sm text-foreground">余额</h3>
      </div>

      {/* Balance display */}
      <div className="text-display-sm text-foreground tabular-nums">
        {balance ? fmt(balance.balance_usd) : '--'}
      </div>
      {balance && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-caption text-muted-foreground tabular-nums">
          <span>累计充值 {fmt(balance.total_deposited_usd)}</span>
          <span>累计消耗 {fmt(balance.total_consumed_usd)}</span>
        </div>
      )}

      {access && (
        <div
          className={cn(
            'mt-4 rounded-lg px-3 py-2 text-body',
            access.allowed
              ? 'bg-success/10 text-success'
              : 'bg-error/10 text-error',
          )}
        >
          <div className="flex items-center gap-2 font-medium">
            {access.allowed ? (
              <CheckCircle2 className="size-4 shrink-0" />
            ) : (
              <AlertTriangle className="size-4 shrink-0" />
            )}
            <span>
              {access.allowed
                ? '当前可正常使用'
                : access.reason || '当前余额不足'}
            </span>
          </div>
          <p className="mt-1 text-caption opacity-80">
            钱包优先模式下，普通用户余额需至少达到{' '}
            {fmt(access.minBalanceUsd || billingMinStartBalanceUsd)}{' '}
            才能继续使用。
          </p>
        </div>
      )}

      {/* Redeem input — auto uppercase */}
      <div className="mt-4 flex gap-2">
        <Input
          type="text"
          placeholder="输入兑换码"
          aria-label="兑换码"
          value={redeemInput}
          onChange={(e) => setRedeemInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && handleRedeem()}
          maxLength={64}
          className="flex-1 font-mono tracking-wider pointer-coarse:min-h-11"
        />
        <Button
          onClick={handleRedeem}
          disabled={submitting || !redeemInput.trim()}
          className="pointer-coarse:min-h-11"
        >
          {submitting ? '...' : '兑换'}
        </Button>
      </div>

      {/* Feedback */}
      {redeemMsg && (
        <div
          role="status"
          className={cn(
            'mt-2 flex items-center gap-1.5 text-caption',
            redeemMsg.ok ? 'text-success' : 'text-error',
          )}
        >
          {redeemMsg.ok && <CheckCircle2 className="size-3.5" />}
          <span>{redeemMsg.text}</span>
        </div>
      )}
    </section>
  );
}
