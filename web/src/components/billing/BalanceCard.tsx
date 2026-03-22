import { useEffect, useState } from 'react';
import { Wallet, CheckCircle2, AlertTriangle } from 'lucide-react';
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
  const [redeemMsg, setRedeemMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
    <div className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Wallet className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">余额</h3>
      </div>

      {/* Balance display */}
      <div className="text-3xl font-bold text-primary mb-1">
        {balance ? fmt(balance.balance_usd) : '--'}
      </div>
      {balance && (
        <div className="flex gap-4 text-xs text-zinc-400 mb-4">
          <span>累计充值 {fmt(balance.total_deposited_usd)}</span>
          <span>累计消耗 {fmt(balance.total_consumed_usd)}</span>
        </div>
      )}

      {access && (
        <div
          className={`mb-4 rounded-md border px-3 py-2 text-sm ${
            access.allowed
              ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300'
          }`}
        >
          <div className="flex items-center gap-2 font-medium">
            {!access.allowed && <AlertTriangle className="h-4 w-4 shrink-0" />}
            <span>{access.allowed ? '当前可正常使用' : access.reason || '当前余额不足'}</span>
          </div>
          <p className="mt-1 text-xs opacity-80">
            钱包优先模式下，普通用户余额需至少达到 {fmt(access.minBalanceUsd || billingMinStartBalanceUsd)} 才能继续使用。
          </p>
        </div>
      )}

      {/* Redeem input — auto uppercase */}
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="输入兑换码"
          value={redeemInput}
          onChange={(e) => setRedeemInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && handleRedeem()}
          maxLength={64}
          className="flex-1 px-3 py-1.5 text-sm border border-zinc-300 dark:border-zinc-600 rounded-md bg-transparent font-mono tracking-wider"
        />
        <button
          onClick={handleRedeem}
          disabled={submitting || !redeemInput.trim()}
          className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? '...' : '兑换'}
        </button>
      </div>

      {/* Feedback */}
      {redeemMsg && (
        <div
          className={`flex items-center gap-1.5 text-xs mt-2 ${
            redeemMsg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'
          }`}
        >
          {redeemMsg.ok && <CheckCircle2 className="w-3.5 h-3.5" />}
          <span>{redeemMsg.text}</span>
        </div>
      )}
    </div>
  );
}
