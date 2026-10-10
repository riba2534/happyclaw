import { useEffect, useRef, useState } from 'react';
import { formatTokens } from '../billing/utils';

export type UsageTrendMetric = 'tokens' | 'cost' | 'runs';

export interface DailyUsagePoint {
  date: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerEstimatedCostUSD: number;
  billedCostUSD: number | null;
  runCount: number;
  modelCallCount: number;
}

/**
 * Mutually exclusive token classes, in stacking order, with chart colors.
 * The orange scheme's chart tokens are one light-to-dark ramp, so the slots
 * alternate light and dark steps and end on a neutral; neighbours stay
 * distinguishable (also for color-blind readers) in every scheme.
 */
export const TOKEN_SERIES = [
  ['inputTokens', '普通输入', 'var(--chart-4)'],
  ['cacheReadTokens', '缓存读取', 'var(--chart-1)'],
  ['cacheCreationTokens', '缓存写入', 'var(--chart-3)'],
  ['outputTokens', '输出', 'var(--chart-5)'],
  ['reasoningTokens', '推理', 'var(--muted-foreground)'],
] as const;

const SINGLE_SERIES_COLOR = 'var(--chart-1)';
// Before the first measurement (and in server rendering) assume a wide chart.
const DEFAULT_WIDTH = 1000;
const HEIGHT = 260;
const RIGHT = 4;
const TOP = 8;
const BOTTOM = 26;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;
const GRID_STEPS = 4;

function formatCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return '$0.00';
}

function metricValue(point: DailyUsagePoint, metric: UsageTrendMetric): number {
  if (metric === 'tokens') return point.totalTokens;
  if (metric === 'cost') return point.providerEstimatedCostUSD;
  return point.runCount;
}

function niceMaximum(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** Tracks the rendered width so SVG text stays at its real pixel size. */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const next = Math.round(element.clientWidth);
      if (next > 0) setWidth(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function UsageTrendChart({
  data,
  metric,
}: {
  data: DailyUsagePoint[];
  metric: UsageTrendMetric;
}) {
  const [containerRef, width] = useMeasuredWidth();
  const formatValue = (value: number) => {
    if (metric === 'tokens') return formatTokens(value);
    if (metric === 'cost') return formatCost(value);
    return new Intl.NumberFormat('zh-CN').format(value);
  };
  const ariaLabel =
    metric === 'tokens'
      ? '每日 Token 趋势图，按普通输入、缓存读取、缓存写入、输出和推理堆叠展示'
      : metric === 'cost'
        ? '每日模型估算费用趋势图'
        : '每日智能体运行次数趋势图';
  const maximum = niceMaximum(
    Math.max(0, ...data.map((point) => metricValue(point, metric))),
  );
  const left = width < 480 ? 44 : 60;
  const plotWidth = Math.max(1, width - left - RIGHT);
  const slotWidth = data.length > 0 ? plotWidth / data.length : plotWidth;
  const barWidth = Math.max(2, Math.min(28, slotWidth * 0.64));
  // Keep date labels roughly 56px apart whatever the width.
  const labelEvery = Math.max(
    1,
    Math.ceil(data.length / Math.max(2, Math.floor(plotWidth / 56))),
  );

  return (
    <div className="min-w-0 space-y-3">
      {metric === 'tokens' && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
          {TOKEN_SERIES.map(([key, label, color]) => (
            <li key={key} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2 rounded-sm"
                style={{ backgroundColor: color }}
              />
              {label}
            </li>
          ))}
        </ul>
      )}
      <div ref={containerRef} className="min-w-0">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          className="block overflow-visible"
          aria-hidden="true"
        >
          {Array.from({ length: GRID_STEPS + 1 }, (_, index) => {
            const ratio = index / GRID_STEPS;
            const y = TOP + PLOT_HEIGHT * ratio;
            const value = maximum * (1 - ratio);
            return (
              <g key={index}>
                <line
                  x1={left}
                  x2={width - RIGHT}
                  y1={y}
                  y2={y}
                  stroke="var(--surface-border)"
                  strokeDasharray={index === GRID_STEPS ? undefined : '3 4'}
                  shapeRendering="crispEdges"
                />
                <text
                  x={left - 8}
                  y={y + 4}
                  textAnchor="end"
                  fill="var(--muted-foreground)"
                  fontSize="11"
                  className="tabular-nums"
                >
                  {formatValue(value)}
                </text>
              </g>
            );
          })}

          {data.map((point, index) => {
            const slotX = left + slotWidth * index;
            const x = slotX + (slotWidth - barWidth) / 2;
            const label =
              metric === 'tokens'
                ? TOKEN_SERIES.map(
                    ([key, name]) => `${name} ${formatValue(point[key])}`,
                  ).join('，')
                : metric === 'cost'
                  ? `模型估算费用 ${formatValue(point.providerEstimatedCostUSD)}`
                  : `智能体运行次数 ${formatValue(point.runCount)}`;
            let stackedBottom = TOP + PLOT_HEIGHT;

            return (
              <g key={point.date} className="group">
                <title>{`${point.date}：${label}`}</title>
                <rect
                  x={slotX}
                  y={TOP}
                  width={slotWidth}
                  height={PLOT_HEIGHT}
                  className="fill-transparent group-hover:fill-surface-hover"
                />
                {metric === 'tokens' ? (
                  TOKEN_SERIES.map(([key, , color]) => {
                    const height = (point[key] / maximum) * PLOT_HEIGHT;
                    stackedBottom -= height;
                    return (
                      <rect
                        key={key}
                        x={x}
                        y={stackedBottom}
                        width={barWidth}
                        height={Math.max(0, height)}
                        fill={color}
                      />
                    );
                  })
                ) : (
                  <rect
                    x={x}
                    y={
                      TOP +
                      PLOT_HEIGHT * (1 - metricValue(point, metric) / maximum)
                    }
                    width={barWidth}
                    height={
                      (metricValue(point, metric) / maximum) * PLOT_HEIGHT
                    }
                    rx={Math.min(3, barWidth / 4)}
                    fill={SINGLE_SERIES_COLOR}
                  />
                )}
                {index % labelEvery === 0 && (
                  <text
                    x={slotX + slotWidth / 2}
                    y={HEIGHT - 8}
                    textAnchor="middle"
                    fill="var(--muted-foreground)"
                    fontSize="11"
                    className="tabular-nums"
                  >
                    {point.date.slice(5)}
                  </text>
                )}
              </g>
            );
          })}

          {data.length === 0 && (
            <text
              x={width / 2}
              y={HEIGHT / 2}
              textAnchor="middle"
              fill="var(--muted-foreground)"
              fontSize="13"
            >
              暂无趋势数据
            </text>
          )}
        </svg>
      </div>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th>日期</th>
            <th>数值</th>
          </tr>
        </thead>
        <tbody>
          {data.map((point) => (
            <tr key={point.date}>
              <td>{point.date}</td>
              <td>{formatValue(metricValue(point, metric))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
