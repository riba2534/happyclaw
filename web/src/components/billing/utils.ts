import { useBillingStore } from '../../stores/billing';

/**
 * Format a USD amount with optional currency conversion.
 */
export function formatAmount(
  amount: number,
  currency?: string,
  rate?: number,
): string {
  const converted = amount * (rate ?? 1);
  const symbol = currency && currency !== 'USD' ? currency : '$';
  if (symbol === '$') return `$${converted.toFixed(2)}`;
  return `${symbol} ${converted.toFixed(2)}`;
}

/**
 * Format a token count in human-readable form (K / M).
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/**
 * Hook that returns a currency-aware formatter bound to the billing store.
 */
export function useCurrency() {
  const currency = useBillingStore((s) => s.billingCurrency);
  const rate = useBillingStore((s) => s.billingCurrencyRate);
  return (amount: number) => formatAmount(amount, currency, rate);
}

/** Transaction type labels. */
export const TX_TYPE_LABELS: Record<string, string> = {
  deposit: '充值',
  deduction: '扣减',
  consumption: '消耗',
  adjustment: '调整',
  refund: '退款',
  redeem: '兑换码',
};

/** Transaction source labels; take precedence over the type label. */
export const TX_SOURCE_LABELS: Record<string, string> = {
  admin_manual_recharge: '后台充值',
  admin_manual_deduct: '后台扣减',
  usage_charge: '用量扣费',
  redeem_code: '兑换码',
  migration_opening: '初始化',
  refund: '退款',
};

export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  active: '生效中',
  expired: '已过期',
  cancelled: '已取消',
};

/** Signed amounts read green/red; a zero amount stays neutral. */
export function amountToneClass(amount: number): string {
  if (amount > 0) return 'text-success';
  if (amount < 0) return 'text-error';
  return 'text-muted-foreground';
}
