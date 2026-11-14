import { useEffect, useState } from 'react';

import { InfoTip } from '@/components/common/InfoTip';
import { cn } from '@/lib/utils';
import { deepSeekPricePeriod, isDeepSeekModel } from '@/lib/usage-metrics';

function clockLabel(at: Date, now: Date): string {
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (sameDay) return time;
  const day = at.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
  return `${day} ${time}`;
}

/**
 * DeepSeek bills weekday 9–12 and 14–18 Beijing time at twice the off-peak
 * price. Next to the model picker while the session's model is DeepSeek:
 * the current period and when it changes. The dot alone on a phone.
 */
export function DeepSeekPriceBadge({ model }: { model: string | null }) {
  const [now, setNow] = useState(() => new Date());
  const active = isDeepSeekModel(model);
  const period = active ? deepSeekPricePeriod(now) : null;
  const until = period?.until.getTime();

  useEffect(() => {
    if (until === undefined) return;
    // Re-render at the switch; capped so a sleeping laptop catches up.
    const delay = Math.min(Math.max(until - Date.now(), 0) + 1000, 3_600_000);
    const timer = setTimeout(() => setNow(new Date()), delay);
    return () => clearTimeout(timer);
  }, [until]);

  if (!period) return null;
  const label = period.peak ? '高峰' : '空闲';
  const switchAt = clockLabel(period.until, now);
  const detail = period.peak
    ? `DeepSeek 高峰时段，价格是空闲时段的 2 倍；${switchAt} 起空闲`
    : `DeepSeek 空闲时段，价格为高峰的一半；${switchAt} 起高峰`;

  return (
    <InfoTip content={<span className="text-caption">{detail}</span>}>
      <button
        type="button"
        aria-label={`${detail}`}
        data-deepseek-period={period.peak ? 'peak' : 'off-peak'}
        className="inline-flex h-[30px] shrink-0 cursor-default items-center gap-1.5 rounded-full px-2 text-caption text-muted-foreground tabular-nums pointer-coarse:h-10 phone:px-1.5"
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full',
            period.peak ? 'bg-warning' : 'bg-success',
          )}
        />
        <span className="phone:hidden">
          {label} · 至 {switchAt}
        </span>
      </button>
    </InfoTip>
  );
}
