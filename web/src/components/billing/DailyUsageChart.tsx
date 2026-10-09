import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBillingStore } from '../../stores/billing';
import { useCurrency, formatTokens } from './utils';

const CHART_DAYS = 14;

export default function DailyUsageChart() {
  const { dailyUsage, loadDailyUsage } = useBillingStore();
  const fmt = useCurrency();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  useEffect(() => {
    loadDailyUsage(CHART_DAYS);
  }, [loadDailyUsage]);

  // Pad to 14 days (fill missing days with zero)
  const today = new Date();
  const chartData = Array.from({ length: CHART_DAYS }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (CHART_DAYS - 1 - i));
    const dateStr = d.toISOString().slice(0, 10);
    const found = dailyUsage.find((u) => u.date === dateStr);
    return {
      date: dateStr,
      label: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      cost: found?.total_cost_usd ?? 0,
      inputTokens: found?.total_input_tokens ?? 0,
      outputTokens: found?.total_output_tokens ?? 0,
      messages: found?.message_count ?? 0,
    };
  });

  const maxCost = Math.max(...chartData.map((d) => d.cost), 0.01); // avoid divide-by-zero
  const hovered = hoveredIdx !== null ? chartData[hoveredIdx] : null;

  return (
    <section className="rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <BarChart3 className="size-4 text-muted-foreground" />
        <h3 className="text-title-sm text-foreground">
          近 {CHART_DAYS} 天用量
        </h3>
      </div>

      {dailyUsage.length === 0 ? (
        <p className="py-8 text-center text-body text-muted-foreground">
          暂无用量数据
        </p>
      ) : (
        <div className="relative">
          {/* Hover tooltip, anchored above the hovered bar */}
          {hovered && hoveredIdx !== null && (
            <div
              className="pointer-events-none absolute top-0 z-10 rounded-lg bg-popover px-3 py-2 text-caption whitespace-nowrap text-popover-foreground shadow-menu ring-1 ring-foreground/10"
              style={{
                left: `${((hoveredIdx + 0.5) / CHART_DAYS) * 100}%`,
                transform: `translateX(-${(hoveredIdx / (CHART_DAYS - 1)) * 100}%)`,
              }}
            >
              <div className="mb-1 font-medium">{hovered.date}</div>
              <div className="space-y-0.5 text-muted-foreground tabular-nums">
                <div>费用: {fmt(hovered.cost)}</div>
                <div>
                  Token:{' '}
                  {formatTokens(hovered.inputTokens + hovered.outputTokens)}
                </div>
                <div>消息: {hovered.messages}</div>
              </div>
            </div>
          )}

          {/* Bar chart */}
          <div className="flex h-40 items-end gap-1 border-b border-surface-border">
            {chartData.map((d, i) => {
              const heightPercent = maxCost > 0 ? (d.cost / maxCost) * 100 : 0;
              const isHovered = hoveredIdx === i;
              return (
                <div
                  key={d.date}
                  className="flex h-full flex-1 flex-col items-center justify-end"
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  <div
                    className={cn(
                      'w-full max-w-10 cursor-pointer rounded-t-sm transition-colors',
                      isHovered ? 'bg-primary' : 'bg-primary/75',
                    )}
                    style={{
                      height: `${Math.max(heightPercent, d.cost > 0 ? 4 : 0)}%`,
                      minHeight: d.cost > 0 ? '4px' : '0px',
                    }}
                  />
                </div>
              );
            })}
          </div>

          {/* X-axis labels */}
          <div className="mt-1.5 flex gap-1">
            {chartData.map((d, i) => (
              <div
                key={d.date}
                className={cn(
                  'flex-1 text-center text-micro whitespace-nowrap tabular-nums',
                  hoveredIdx === i
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {/* Show every other label on small screens to avoid crowding */}
                <span className="hidden sm:inline">{d.label}</span>
                <span className="sm:hidden">{i % 2 === 0 ? d.label : ''}</span>
              </div>
            ))}
          </div>

          {/* Summary line */}
          <div className="mt-3 flex justify-between border-t border-surface-border pt-3 text-caption text-muted-foreground tabular-nums">
            <span>
              合计费用: {fmt(chartData.reduce((sum, d) => sum + d.cost, 0))}
            </span>
            <span>
              合计消息: {chartData.reduce((sum, d) => sum + d.messages, 0)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
