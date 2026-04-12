/**
 * Shared task utilities used by CreateTaskForm, TaskCard, and TaskDetail.
 */

export const INTERVAL_UNITS = [
  { label: '秒', ms: 1_000 },
  { label: '分钟', ms: 60_000 },
  { label: '小时', ms: 3_600_000 },
  { label: '天', ms: 86_400_000 },
] as const;

export const CHANNEL_OPTIONS = [
  { key: 'feishu', label: '飞书' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'qq', label: 'QQ' },
  { key: 'wechat', label: '微信' },
  { key: 'dingtalk', label: '钉钉' },
  { key: 'discord', label: 'Discord' },
] as const;

/** Format interval milliseconds to human-readable string (e.g. "5 分钟"). */
export function formatInterval(ms: string | number): string {
  const n = typeof ms === 'string' ? parseInt(ms, 10) : ms;
  if (isNaN(n) || n <= 0) return String(ms);
  if (n % 86_400_000 === 0) return `${n / 86_400_000} 天`;
  if (n % 3_600_000 === 0) return `${n / 3_600_000} 小时`;
  if (n % 60_000 === 0) return `${n / 60_000} 分钟`;
  if (n % 1_000 === 0) return `${n / 1_000} 秒`;
  return `${n} 毫秒`;
}

/** Decompose milliseconds into {number, unitMs} picking the largest clean unit. */
export function decomposeInterval(ms: string): { num: string; unitMs: string } {
  const n = parseInt(ms, 10);
  if (isNaN(n) || n <= 0) return { num: '', unitMs: '60000' };
  for (let i = INTERVAL_UNITS.length - 1; i >= 0; i--) {
    if (n % INTERVAL_UNITS[i].ms === 0) {
      return { num: String(n / INTERVAL_UNITS[i].ms), unitMs: String(INTERVAL_UNITS[i].ms) };
    }
  }
  return { num: String(n / 60_000), unitMs: '60000' };
}

/**
 * Toggle a channel in a nullable channel list where null = "all connected".
 * Pure function — returns the new list.
 */
export function toggleNotifyChannel(
  current: string[] | null,
  key: string,
  connectedKeys: string[],
): string[] | null {
  if (current === null) {
    // Was "all connected" → uncheck this one
    return connectedKeys.filter((c) => c !== key);
  }
  if (current.includes(key)) {
    return current.filter((c) => c !== key);
  }
  const next = [...current, key];
  // If all connected channels selected, normalize back to null (= all)
  if (connectedKeys.length > 0 && connectedKeys.every((c) => next.includes(c))) {
    return null;
  }
  return next;
}
