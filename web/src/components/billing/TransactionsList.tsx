import { useEffect } from 'react';
import { History } from 'lucide-react';
import {
  DataTable,
  EmptyState,
  type DataTableColumn,
} from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useBillingStore, type BalanceTransaction } from '../../stores/billing';
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
  const { transactions, transactionsTotal, loadMyTransactions } =
    useBillingStore();
  const fmt = useCurrency();

  useEffect(() => {
    loadMyTransactions();
  }, [loadMyTransactions]);

  const amountClass = (tx: BalanceTransaction) =>
    tx.amount_usd > 0 ? 'text-success' : 'text-error';
  const formatAmount = (tx: BalanceTransaction) =>
    `${tx.amount_usd > 0 ? '+' : tx.amount_usd < 0 ? '-' : ''}${fmt(Math.abs(tx.amount_usd))}`;

  const columns: DataTableColumn<BalanceTransaction>[] = [
    {
      key: 'description',
      header: '说明',
      className: 'max-w-0 w-full whitespace-normal',
      cell: (tx) => (
        <div className="min-w-0">
          <div className="truncate text-body text-foreground">
            {tx.description || TYPE_LABELS[tx.type] || tx.type}
          </div>
          <div className="mt-0.5 text-caption text-muted-foreground tabular-nums">
            {new Date(tx.created_at).toLocaleString()}
          </div>
        </div>
      ),
    },
    {
      key: 'source',
      header: '类型',
      headerClassName: 'hidden sm:table-cell',
      className: 'hidden sm:table-cell',
      cell: (tx) =>
        tx.source || tx.type ? (
          <Badge variant="neutral">
            {SOURCE_LABELS[tx.source || ''] || TYPE_LABELS[tx.type] || tx.type}
          </Badge>
        ) : null,
    },
    {
      key: 'amount',
      header: '金额',
      align: 'right',
      cell: (tx) => (
        <div>
          <div
            className={cn(
              'text-body font-medium tabular-nums',
              amountClass(tx),
            )}
          >
            {formatAmount(tx)}
          </div>
          <div className="text-micro text-muted-foreground tabular-nums sm:hidden">
            余额 {fmt(tx.balance_after)}
          </div>
        </div>
      ),
    },
    {
      key: 'balance',
      header: '余额',
      align: 'right',
      headerClassName: 'hidden sm:table-cell',
      className: 'hidden text-muted-foreground tabular-nums sm:table-cell',
      cell: (tx) => fmt(tx.balance_after),
    },
  ];

  return (
    <section className="overflow-hidden rounded-xl bg-surface-raised ring-1 ring-surface-border">
      <div className="flex items-center justify-between gap-2 border-b border-surface-border px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          <h3 className="text-title-sm text-foreground">余额变动记录</h3>
        </div>
        {transactionsTotal > 0 && (
          <span className="text-caption text-muted-foreground tabular-nums">
            共 {transactionsTotal} 条
          </span>
        )}
      </div>

      {transactions.length === 0 ? (
        <EmptyState icon={History} title="暂无记录" className="py-8" />
      ) : (
        <DataTable
          framed={false}
          className="max-h-80 overflow-y-auto"
          columns={columns}
          rows={transactions}
          rowKey={(tx) => tx.id}
        />
      )}
    </section>
  );
}
