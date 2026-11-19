import { useEffect, useState } from 'react';

import { api } from '../../api/client';
import { formatTokens } from '../billing/utils';
import {
  DataTable,
  SegmentedControl,
  type DataTableColumn,
} from '@/components/common';
import { Skeleton } from '@/components/ui/skeleton';
import { formatHitRate } from '@/lib/usage-metrics';

export interface CacheRateRow {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  hitRate: number | null;
}

export interface CacheRateResponse {
  summary: CacheRateRow;
  daily: Array<CacheRateRow & { date: string }>;
  models: Array<CacheRateRow & { model: string }>;
  connections: Array<
    CacheRateRow & { connectionId: string | null; name: string | null }
  >;
}

type Dimension = 'connection' | 'model' | 'day';

interface LabelledRow extends CacheRateRow {
  key: string;
  label: string;
}

const DIMENSIONS: Array<{ value: Dimension; label: string }> = [
  { value: 'connection', label: '连接' },
  { value: 'model', label: '模型' },
  { value: 'day', label: '日期' },
];

export function cacheRateRows(
  data: CacheRateResponse,
  dimension: Dimension,
): LabelledRow[] {
  if (dimension === 'day') {
    return [...data.daily]
      .reverse()
      .map((row) => ({ ...row, key: row.date, label: row.date }));
  }
  if (dimension === 'model') {
    return data.models.map((row) => ({
      ...row,
      key: row.model,
      label: row.model,
    }));
  }
  return data.connections.map((row) => ({
    ...row,
    key: row.connectionId ?? '',
    label: row.connectionId
      ? row.name || `已删除的连接（${row.connectionId.slice(0, 8)}）`
      : '未记录连接',
  }));
}

const numberColumn = {
  align: 'right' as const,
  className: 'tabular-nums text-muted-foreground',
};

/**
 * Prompt-cache hit rate for the page's current filters, per connection,
 * model or day, with the raw token counts the rate is computed from.
 */
export function CacheHitRatePanel({ queryParams }: { queryParams: string }) {
  const [data, setData] = useState<CacheRateResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [dimension, setDimension] = useState<Dimension>('connection');

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    api
      .get<CacheRateResponse>(`/api/usage/cache?${queryParams}`)
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [queryParams]);

  const columns: DataTableColumn<LabelledRow>[] = [
    {
      key: 'label',
      header: DIMENSIONS.find((option) => option.value === dimension)!.label,
      cell: (row) => (
        <span className="block max-w-48 truncate sm:max-w-80" title={row.label}>
          {row.label}
        </span>
      ),
      className: 'font-medium text-foreground',
    },
    {
      key: 'rate',
      header: '命中率',
      align: 'right',
      className: 'tabular-nums font-medium text-foreground',
      cell: (row) => formatHitRate(row.hitRate),
    },
    {
      key: 'read',
      header: '缓存读取',
      cell: (row) => formatTokens(row.cacheReadTokens),
      ...numberColumn,
    },
    {
      key: 'creation',
      header: '缓存写入',
      cell: (row) => formatTokens(row.cacheCreationTokens),
      ...numberColumn,
    },
    {
      key: 'input',
      header: '普通输入',
      cell: (row) => formatTokens(row.inputTokens),
      ...numberColumn,
    },
  ];

  return (
    <section
      className="space-y-3 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border"
      aria-labelledby="cache-hit-rate-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            id="cache-hit-rate-heading"
            className="text-label text-foreground"
          >
            缓存命中率
          </h3>
          <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
            按 Anthropic 用量语义计算（input 不含缓存）：缓存读取 ÷（普通输入 +
            缓存写入 + 缓存读取）；若网关把缓存计入 input，命中率会偏低。
          </p>
        </div>
        <SegmentedControl
          label="命中率维度"
          value={dimension}
          onChange={setDimension}
          options={DIMENSIONS}
        />
      </div>
      {failed ? (
        <p className="py-6 text-center text-body text-muted-foreground">
          缓存命中率加载失败，请稍后刷新页面
        </p>
      ) : !data ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <DataTable
          columns={columns}
          rows={cacheRateRows(data, dimension)}
          rowKey={(row) => row.key}
          empty={
            <p className="py-8 text-center text-body text-muted-foreground">
              当前范围没有缓存数据
            </p>
          }
        />
      )}
    </section>
  );
}
