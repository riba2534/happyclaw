import { useEffect } from 'react';
import { History } from 'lucide-react';
import { useBillingStore } from '../../stores/billing';
import { useCurrency } from './utils';

/** Transaction type label mapping. */
const TYPE_LABELS: Record<string, string> = {
  deposit: '充值',
  deduction: '扣减',
  consumption: '消耗',
  adjustment: '调整',
  refund: '退款',
  redeem: '兑换码',
};

const SOURCE_LABELS: Record<string, string> = {
  admin_manual_recharge: '后台充值',
  admin_manual_deduct: '后台扣减',
  usage_charge: '用量扣费',
  redeem_code: '兑换码',
  migration_opening: '初始化',
  refund: '退款',
};

export default function TransactionsList() {
  const { transactions, transactionsTotal, loadMyTransactions } = useBillingStore();
  const fmt = useCurrency();

  useEffect(() => {
    loadMyTransactions();
  }, [loadMyTransactions]);

  return (
    <div className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">余额变动记录</h3>
        </div>
        {transactionsTotal > 0 && (
          <span className="text-xs text-zinc-400">共 {transactionsTotal} 条</span>
        )}
      </div>

      {transactions.length === 0 ? (
        <p className="text-sm text-zinc-500">暂无记录</p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {transactions.map((tx) => (
            <div
              key={tx.id}
              className="flex justify-between items-center py-2 border-b border-zinc-100 dark:border-zinc-700 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">
                  {tx.description || TYPE_LABELS[tx.type] || tx.type}
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-400">
                  <span>{new Date(tx.created_at).toLocaleString()}</span>
                  {(tx.source || tx.type) && (
                    <span className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400">
                      {SOURCE_LABELS[tx.source || ''] || TYPE_LABELS[tx.type] || tx.type}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end ml-3 shrink-0">
                <span
                  className={`text-sm font-medium ${
                    tx.amount_usd > 0 ? 'text-green-600' : 'text-red-500'
                  }`}
                >
                  {tx.amount_usd > 0 ? '+' : ''}
                  {fmt(tx.amount_usd)}
                </span>
                <span className="text-[11px] text-zinc-400">
                  余额 {fmt(tx.balance_after)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
