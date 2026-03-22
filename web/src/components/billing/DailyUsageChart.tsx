import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
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

  return (
    <div className="bg-white dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 p-5">
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 className="w-5 h-5 text-primary" />
        <h3 className="font-semibold">近 {CHART_DAYS} 天用量</h3>
      </div>

      {dailyUsage.length === 0 ? (
        <p className="text-sm text-zinc-500 py-8 text-center">暂无用量数据</p>
      ) : (
        <div className="relative">
          {/* Hover tooltip */}
          {hoveredIdx !== null && (
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 z-10 bg-zinc-900 dark:bg-zinc-700 text-white text-xs rounded-md px-3 py-2 shadow-lg pointer-events-none whitespace-nowrap">
              <div className="font-medium mb-1">{chartData[hoveredIdx].date}</div>
              <div>费用: {fmt(chartData[hoveredIdx].cost)}</div>
              <div>
                Token: {formatTokens(chartData[hoveredIdx].inputTokens + chartData[hoveredIdx].outputTokens)}
              </div>
              <div>消息: {chartData[hoveredIdx].messages}</div>
            </div>
          )}

          {/* Bar chart */}
          <div className="flex items-end gap-1 h-40">
            {chartData.map((d, i) => {
              const heightPercent = maxCost > 0 ? (d.cost / maxCost) * 100 : 0;
              const isHovered = hoveredIdx === i;
              return (
                <div
                  key={d.date}
                  className="flex-1 flex flex-col items-center justify-end h-full"
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                >
                  <div
                    className={`w-full rounded-t transition-all cursor-pointer ${
                      isHovered
                        ? 'bg-brand-500 dark:bg-brand-400'
                        : 'bg-brand-400/70 dark:bg-brand-600/70'
                    }`}
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
          <div className="flex gap-1 mt-1.5">
            {chartData.map((d, i) => (
              <div
                key={d.date}
                className={`flex-1 text-center text-[10px] leading-tight ${
                  hoveredIdx === i
                    ? 'text-primary dark:text-brand-400 font-medium'
                    : 'text-zinc-400'
                }`}
              >
                {/* Show every other label on small screens to avoid crowding */}
                <span className="hidden sm:inline">{d.label}</span>
                <span className="sm:hidden">{i % 2 === 0 ? d.label : ''}</span>
              </div>
            ))}
          </div>

          {/* Summary line */}
          <div className="flex justify-between text-xs text-zinc-400 mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-700">
            <span>
              合计费用: {fmt(chartData.reduce((sum, d) => sum + d.cost, 0))}
            </span>
            <span>
              合计消息: {chartData.reduce((sum, d) => sum + d.messages, 0)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
