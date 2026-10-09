import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Download,
  Info,
  RefreshCw,
  SlidersHorizontal,
  Table2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { useUsageStore } from '../stores/usage';
import type {
  UsageBreakdown,
  UsageAttributionItem,
  UsageDailyBucket,
  UsageQuery,
  UsageSummary,
  UsageWindow,
} from '../stores/usage';
import { buildUsageQueryParams, usageQueryKey } from '../stores/usage';
import { useAuthStore } from '../stores/auth';
import { useBillingStore } from '../stores/billing';
import { formatTokens } from '../components/billing/utils';
import {
  TOKEN_SERIES,
  UsageTrendChart,
  type DailyUsagePoint,
  type UsageTrendMetric,
} from '../components/usage/UsageTrendChart';
import {
  DataTable,
  EmptyState,
  PageContainer,
  PageHeader,
  SegmentedControl,
  type DataTableColumn,
} from '@/components/common';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  DownloadError,
  downloadFromUrl,
  downloadTextFile,
} from '@/utils/download';

const PERIOD_OPTIONS = [7, 14, 30, 90] as const;
const ALL_VALUE = '__all__';

type TrendView = 'chart' | 'table';
type AttributionDimension = 'model' | 'agent' | 'workspace' | 'source';
type AttributionSort = 'cost' | 'tokens' | 'runs';
type SortDirection = 'desc' | 'asc';

const DIMENSION_LABELS: Record<AttributionDimension, string> = {
  model: '模型',
  agent: '智能体',
  workspace: '工作区',
  source: '来源',
};

const SOURCE_LABELS: Record<string, string> = {
  agent: '智能体对话',
  main: '主智能体',
  'main-agent': '主智能体',
  'custom-agent': '自定义智能体',
  scheduled_task: '定时任务',
  task: '定时任务',
  automation: '自动化任务',
  chat: '网页对话',
  im: '消息渠道',
  unknown: '未标记来源',
  unassigned: '未标记来源',
};

interface AttributionRow {
  key: string;
  label: string;
  tokens: number;
  estimatedCost: number;
  billedCost: number | null;
  runCount: number;
  modelCallCount: number;
}

function parseDays(value: string | null): number {
  const parsed = Number.parseInt(value || '7', 10);
  return PERIOD_OPTIONS.includes(parsed as (typeof PERIOD_OPTIONS)[number])
    ? parsed
    : 7;
}

function parseQuery(params: URLSearchParams, isAdmin: boolean): UsageQuery {
  const read = (name: string) => params.get(name)?.trim() || null;
  return {
    days: parseDays(params.get('days')),
    userId: isAdmin ? read('userId') : null,
    model: read('model'),
    agentId: read('agentId'),
    groupFolder: read('groupFolder'),
    source: read('source'),
  };
}

function formatCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return '$0.00';
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatDateRange(window: UsageWindow | null, days: number): string {
  if (!window) return `过去 ${days} 天`;
  return `${window.from} 至 ${window.to}`;
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return '等待首次更新';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function enumerateDates(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start > end
  ) {
    return [];
  }
  const dates: string[] = [];
  for (
    const date = start;
    date <= end;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

function buildDailyData(
  breakdown: UsageBreakdown[],
  daily: UsageDailyBucket[],
  window: UsageWindow | null,
): DailyUsagePoint[] {
  if (!window) return [];
  const byDate = new Map<string, DailyUsagePoint>();
  for (const date of enumerateDates(window.from, window.to)) {
    byDate.set(date, {
      date,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerEstimatedCostUSD: 0,
      billedCostUSD: null,
      runCount: 0,
      modelCallCount: 0,
    });
  }
  if (daily.length > 0) {
    for (const row of daily) {
      const point = byDate.get(row.date);
      if (!point) continue;
      point.inputTokens = row.inputTokens;
      point.cacheReadTokens = row.cacheReadTokens;
      point.cacheCreationTokens = row.cacheCreationTokens;
      point.reasoningTokens = row.reasoningTokens;
      point.outputTokens = row.outputTokens;
      point.totalTokens = row.totalTokens;
      point.providerEstimatedCostUSD = row.providerEstimatedCostUSD;
      point.billedCostUSD = row.billedCostUSD;
      point.runCount = row.runCount;
      point.modelCallCount = row.modelCallCount;
    }
    return Array.from(byDate.values());
  }
  for (const row of breakdown) {
    const point = byDate.get(row.date);
    if (!point) continue;
    point.inputTokens += row.input_tokens;
    point.cacheReadTokens += row.cache_read_tokens;
    point.cacheCreationTokens += row.cache_creation_tokens;
    point.reasoningTokens += row.reasoning_tokens;
    point.outputTokens += row.output_tokens;
    point.totalTokens +=
      row.input_tokens +
      row.cache_read_tokens +
      row.cache_creation_tokens +
      row.output_tokens +
      row.reasoning_tokens;
    point.providerEstimatedCostUSD += row.provider_estimated_cost_usd;
    if (row.billed_cost_usd !== null) {
      point.billedCostUSD = (point.billedCostUSD || 0) + row.billed_cost_usd;
    }
    point.runCount += row.run_count;
    point.modelCallCount += row.model_call_count;
  }
  return Array.from(byDate.values());
}

function attributionKey(
  row: UsageBreakdown,
  dimension: AttributionDimension,
): { key: string; label: string } {
  if (dimension === 'model') {
    return { key: row.model || 'unknown', label: row.model || '未知模型' };
  }
  if (dimension === 'agent') {
    return {
      key: row.agent_id || 'unknown',
      label: row.agent_name || row.agent_id || '未标记智能体',
    };
  }
  if (dimension === 'workspace') {
    return {
      key: row.group_folder || 'unknown',
      label: row.workspace_name || row.group_folder || '未标记工作区',
    };
  }
  const source = row.source || 'unknown';
  return { key: source, label: SOURCE_LABELS[source] || source };
}

function buildAttributionRows(
  breakdown: UsageBreakdown[],
  dimension: AttributionDimension,
): AttributionRow[] {
  const rows = new Map<string, AttributionRow>();
  for (const item of breakdown) {
    const identity = attributionKey(item, dimension);
    const existing = rows.get(identity.key) || {
      key: identity.key,
      label: identity.label,
      tokens: 0,
      estimatedCost: 0,
      billedCost: null,
      runCount: 0,
      modelCallCount: 0,
    };
    existing.tokens +=
      item.input_tokens +
      item.cache_read_tokens +
      item.cache_creation_tokens +
      item.output_tokens +
      item.reasoning_tokens;
    existing.estimatedCost += item.provider_estimated_cost_usd;
    if (item.billed_cost_usd !== null) {
      existing.billedCost = (existing.billedCost || 0) + item.billed_cost_usd;
    }
    existing.runCount += item.run_count;
    existing.modelCallCount += item.model_call_count;
    rows.set(identity.key, existing);
  }
  return Array.from(rows.values());
}

function attributionRowsFromServer(
  items: UsageAttributionItem[],
  dimension: AttributionDimension,
): AttributionRow[] {
  return items.map((item) => ({
    key: item.key,
    label:
      dimension === 'source'
        ? SOURCE_LABELS[item.key] || item.name || item.key
        : item.name || item.key,
    tokens: item.totalTokens,
    estimatedCost: item.providerEstimatedCostUSD,
    billedCost: item.billedCostUSD,
    runCount: item.runCount,
    modelCallCount: item.modelCallCount,
  }));
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function buildFallbackCsv(rows: UsageBreakdown[]): string {
  const headers = [
    '日期',
    '模型',
    '用户 ID',
    '智能体 ID',
    '工作区',
    '来源',
    '普通输入 Token',
    '缓存读取 Token',
    '缓存写入 Token',
    '输出 Token',
    '推理 Token',
    '模型估算费用 USD',
    '账单扣费 USD',
    '智能体运行次数',
    '模型调用次数',
  ];
  const body = rows.map((row) =>
    [
      row.date,
      row.model,
      row.user_id,
      row.agent_id,
      row.group_folder,
      row.source,
      row.input_tokens,
      row.cache_read_tokens,
      row.cache_creation_tokens,
      row.output_tokens,
      row.reasoning_tokens,
      row.provider_estimated_cost_usd,
      row.billed_cost_usd,
      row.run_count,
      row.model_call_count,
    ]
      .map(csvCell)
      .join(','),
  );
  return `\uFEFF${[headers.map(csvCell).join(','), ...body].join('\n')}`;
}

function metricValue(
  summary: UsageSummary,
  key: 'tokens' | 'runs' | 'cost' | 'average',
): string {
  if (key === 'tokens') return formatTokens(summary.totalTokens);
  if (key === 'runs') return formatInteger(summary.runCount);
  if (key === 'cost') return formatCost(summary.providerEstimatedCostUSD);
  return formatCost(summary.averageCostPerRunUSD);
}

export function UsagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const user = useAuthStore((state) => state.user);
  const billingEnabled = useBillingStore((state) => state.billingEnabled);
  const isAdmin = user?.role === 'admin';
  const query = useMemo(
    () => parseQuery(searchParams, isAdmin),
    [isAdmin, searchParams],
  );
  const queryKey = usageQueryKey(query);
  const {
    ownerUserId,
    summary,
    breakdown,
    daily,
    window,
    generatedAt,
    attributions,
    billing,
    loading,
    error,
    availableModels,
    availableUsers,
    availableAgents,
    availableWorkspaces,
    availableSources,
    agentNames,
    workspaceNames,
    ensureOwner,
    setQuery,
    loadStats,
    loadFilters,
  } = useUsageStore();

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [trendMetric, setTrendMetric] = useState<UsageTrendMetric>('tokens');
  const [trendView, setTrendView] = useState<TrendView>('chart');
  const [dimension, setDimension] = useState<AttributionDimension>('model');
  const [sortBy, setSortBy] = useState<AttributionSort>('cost');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [exporting, setExporting] = useState(false);

  const authUserId = user?.id || null;
  const ownsState = ownerUserId === authUserId;
  const visibleSummary = ownsState ? summary : null;
  const visibleBreakdown = ownsState ? breakdown : [];
  const visibleDaily = ownsState ? daily : [];
  const visibleWindow = ownsState ? window : null;
  const visibleGeneratedAt = ownsState ? generatedAt : null;
  const visibleBilling = ownsState ? billing : null;
  const visibleLoading = !ownsState || loading;
  const visibleError = ownsState ? error : null;

  useEffect(() => {
    if (isAdmin || !searchParams.has('userId')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('userId');
    setSearchParams(next, { replace: true });
  }, [isAdmin, searchParams, setSearchParams]);

  useEffect(() => {
    ensureOwner(authUserId);
    setQuery(query);
    void loadStats(query);
    void loadFilters(query);
  }, [authUserId, ensureOwner, loadFilters, loadStats, queryKey, setQuery]);

  const updateFilter = (name: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    next.set('days', String(query.days));
    if (!value || value === ALL_VALUE) next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  };

  const clearFilters = () => {
    setSearchParams({ days: String(query.days) }, { replace: true });
  };

  const dailyData = useMemo(
    () => buildDailyData(visibleBreakdown, visibleDaily, visibleWindow),
    [visibleBreakdown, visibleDaily, visibleWindow],
  );

  const attributionRows = useMemo(() => {
    const serverItems =
      dimension === 'model'
        ? attributions.models
        : dimension === 'agent'
          ? attributions.agents
          : dimension === 'workspace'
            ? attributions.workspaces
            : attributions.sources;
    const rows =
      ownsState && serverItems.length > 0
        ? attributionRowsFromServer(serverItems, dimension)
        : buildAttributionRows(visibleBreakdown, dimension);
    const multiplier = sortDirection === 'desc' ? -1 : 1;
    return rows.sort((a, b) => {
      const left =
        sortBy === 'cost'
          ? a.estimatedCost
          : sortBy === 'tokens'
            ? a.tokens
            : a.runCount;
      const right =
        sortBy === 'cost'
          ? b.estimatedCost
          : sortBy === 'tokens'
            ? b.tokens
            : b.runCount;
      return (left - right) * multiplier || a.label.localeCompare(b.label);
    });
  }, [
    attributions,
    dimension,
    ownsState,
    sortBy,
    sortDirection,
    visibleBreakdown,
  ]);

  const selectedUser = availableUsers.find(
    (option) => option.id === query.userId,
  );
  const scopeLabel = isAdmin
    ? selectedUser?.username || (query.userId ? '指定用户' : '全组织')
    : '我的用量';
  const activeFilterCount = [
    query.userId,
    query.model,
    query.agentId,
    query.groupFolder,
    query.source,
  ].filter(Boolean).length;
  const cacheDenominator = visibleSummary
    ? visibleSummary.inputTokens +
      visibleSummary.cacheReadTokens +
      visibleSummary.cacheCreationTokens
    : 0;
  const cacheReadShare =
    visibleSummary && cacheDenominator > 0
      ? (visibleSummary.cacheReadTokens / cacheDenominator) * 100
      : 0;
  const billingApplicable = visibleBilling?.applicable ?? billingEnabled;
  const billingFeatureEnabled = visibleBilling?.enabled ?? billingEnabled;

  const handleExport = async () => {
    if (!visibleWindow || visibleBreakdown.length === 0) return;
    setExporting(true);
    const filename = `happyclaw-usage-${visibleWindow.from}-${visibleWindow.to}.csv`;
    try {
      await downloadFromUrl(
        `/api/usage/export.csv?${buildUsageQueryParams(query)}`,
        filename,
      );
      toast.success('用量明细已导出');
    } catch (exportError) {
      if (exportError instanceof DownloadError && exportError.status === 404) {
        downloadTextFile(
          buildFallbackCsv(visibleBreakdown),
          filename,
          'text/csv;charset=utf-8',
        );
        toast.success('已导出当前聚合数据');
      } else if (
        exportError instanceof DownloadError &&
        exportError.status === 413
      ) {
        toast.error('导出记录过多，请缩小时间范围或增加筛选条件后重试');
      } else if (
        exportError instanceof DownloadError &&
        (exportError.status === 401 || exportError.status === 403)
      ) {
        toast.error('登录状态已失效，请重新登录');
      } else {
        toast.error('导出失败，请稍后重试');
      }
    } finally {
      setExporting(false);
    }
  };

  const hasUsage = Boolean(visibleSummary && visibleSummary.runCount > 0);

  const filterControls = (
    <>
      {isAdmin && (
        <FilterSelect
          id="usage-user"
          label="统计用户"
          value={query.userId || ALL_VALUE}
          onChange={(value) => updateFilter('userId', value)}
          options={[
            { value: ALL_VALUE, label: '全部用户' },
            ...availableUsers.map((option) => ({
              value: option.id,
              label: option.username,
            })),
          ]}
        />
      )}
      <FilterSelect
        id="usage-model"
        label="模型"
        value={query.model || ALL_VALUE}
        onChange={(value) => updateFilter('model', value)}
        options={[
          { value: ALL_VALUE, label: '全部模型' },
          ...availableModels.map((model) => ({
            value: model,
            label: model,
          })),
        ]}
      />
      <FilterSelect
        id="usage-agent"
        label="智能体"
        value={query.agentId || ALL_VALUE}
        onChange={(value) => updateFilter('agentId', value)}
        options={[
          { value: ALL_VALUE, label: '全部智能体' },
          ...availableAgents.map((agentId) => ({
            value: agentId,
            label: agentNames[agentId] || agentId,
          })),
        ]}
      />
      <FilterSelect
        id="usage-workspace"
        label="工作区"
        value={query.groupFolder || ALL_VALUE}
        onChange={(value) => updateFilter('groupFolder', value)}
        options={[
          { value: ALL_VALUE, label: '全部工作区' },
          ...availableWorkspaces.map((folder) => ({
            value: folder,
            label: workspaceNames[folder] || folder,
          })),
        ]}
      />
      <FilterSelect
        id="usage-source"
        label="来源"
        value={query.source || ALL_VALUE}
        onChange={(value) => updateFilter('source', value)}
        options={[
          { value: ALL_VALUE, label: '全部来源' },
          ...availableSources.map((source) => ({
            value: source,
            label: SOURCE_LABELS[source] || source,
          })),
        ]}
      />
    </>
  );

  return (
    <PageContainer size="wide" className="min-w-0 space-y-6">
      <div className="space-y-3">
        <PageHeader
          title="用量分析"
          subtitle="查看智能体运行、Token 与模型成本估算。模型估算费用用于分析资源消耗，不等同于账单扣费。"
          className="max-sm:flex-col max-sm:items-stretch"
          actions={
            <>
              <Button
                variant="outline"
                className="flex-1 pointer-coarse:min-h-11 sm:flex-none"
                onClick={() =>
                  void Promise.all([loadStats(query), loadFilters(query)])
                }
                disabled={visibleLoading}
                aria-label={
                  visibleLoading ? '正在刷新用量数据' : '刷新用量数据'
                }
              >
                <RefreshCw
                  className={visibleLoading ? 'motion-safe:animate-spin' : ''}
                />
                刷新数据
              </Button>
              <Button
                variant="outline"
                className="flex-1 pointer-coarse:min-h-11 sm:flex-none"
                onClick={() => void handleExport()}
                disabled={exporting || visibleBreakdown.length === 0}
              >
                <Download />
                {exporting ? '正在导出' : '导出 CSV'}
              </Button>
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
          <Badge variant="outline">{scopeLabel}</Badge>
          <span>统计范围：{formatDateRange(visibleWindow, query.days)}</span>
          <span>时区：{visibleWindow?.timezone || '加载中'}</span>
          <span>更新时间：{formatUpdatedAt(visibleGeneratedAt)}</span>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {visibleLoading
          ? '正在更新用量数据'
          : visibleSummary
            ? `用量数据已更新，共 ${visibleSummary.runCount} 次智能体运行`
            : ''}
      </p>

      <section
        className="flex min-w-0 flex-col gap-2 border-y border-surface-border py-3 sm:flex-row sm:flex-wrap sm:items-center"
        aria-label="用量筛选"
        aria-busy={visibleLoading}
      >
        <div className="flex min-w-0 items-center gap-2">
          <SegmentedControl
            label="时间范围"
            value={String(query.days)}
            onChange={(value) => updateFilter('days', value)}
            options={PERIOD_OPTIONS.map((days) => ({
              value: String(days),
              label: `${days} 天`,
            }))}
          />
          <Button
            variant="ghost"
            className="ml-auto pointer-coarse:min-h-11 sm:hidden"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            aria-controls="usage-filter-fields"
          >
            <SlidersHorizontal />
            筛选条件
            {activeFilterCount > 0 && (
              <Badge variant="info" className="tabular-nums">
                {activeFilterCount}
              </Badge>
            )}
          </Button>
        </div>
        <span
          aria-hidden="true"
          className="mx-1 hidden h-5 w-px bg-surface-border sm:block"
        />
        <div
          id="usage-filter-fields"
          className={cn(
            filtersOpen ? 'grid' : 'hidden',
            'min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center',
          )}
        >
          {filterControls}
        </div>
        {activeFilterCount > 0 && (
          <Button
            variant="ghost"
            className="text-muted-foreground pointer-coarse:min-h-11 sm:ml-auto"
            onClick={clearFilters}
          >
            清除筛选
          </Button>
        )}
      </section>

      {visibleError && (
        <section className="rounded-xl bg-error/10 p-4" role="alert">
          <h2 className="text-title-sm text-error">用量数据加载失败</h2>
          <p className="mt-1 text-body text-muted-foreground">
            {visibleError}
            。请检查网络连接后重试，当前不会展示旧账号或旧筛选的数据。
          </p>
          <Button
            variant="outline"
            className="mt-3 pointer-coarse:min-h-11"
            onClick={() => void loadStats(query)}
          >
            <RefreshCw />
            重试加载
          </Button>
        </section>
      )}

      {visibleLoading && !visibleError && <UsageLoadingState />}

      {!visibleLoading && !visibleError && visibleSummary && !hasUsage && (
        <UsageEmptyState
          filtered={activeFilterCount > 0}
          onClear={clearFilters}
        />
      )}

      {!visibleLoading && !visibleError && visibleSummary && hasUsage && (
        <div className="min-w-0 space-y-8">
          <section
            aria-labelledby="usage-summary-heading"
            className="space-y-3"
          >
            <SectionHeading
              id="usage-summary-heading"
              title="核心指标"
              description="下列指标与趋势图使用同一组服务端日期桶。"
              actions={
                <Badge variant="neutral" className="tabular-nums">
                  {visibleSummary.activeDays} 个活跃日
                </Badge>
              }
            />
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricItem
                label="总 Token"
                value={metricValue(visibleSummary, 'tokens')}
                exactValue={formatInteger(visibleSummary.totalTokens)}
              />
              <MetricItem
                label="智能体运行次数"
                value={metricValue(visibleSummary, 'runs')}
                note={`${formatInteger(visibleSummary.modelCallCount)} 次模型调用`}
              />
              <MetricItem
                label="模型估算费用 (USD)"
                value={metricValue(visibleSummary, 'cost')}
                note={
                  !billingApplicable
                    ? '账单扣费：不适用（未启用计费）'
                    : visibleSummary.billedCostUSD === null
                      ? '不是账单扣费'
                      : `账单扣费 ${formatCost(visibleSummary.billedCostUSD)}`
                }
              />
              <MetricItem
                label="平均每次成本"
                value={metricValue(visibleSummary, 'average')}
                note="模型估算费用 ÷ 智能体运行次数"
              />
            </dl>

            <TokenComposition
              summary={visibleSummary}
              cacheReadShare={cacheReadShare}
            />
          </section>

          <section
            className="min-w-0 space-y-3"
            aria-labelledby="usage-trend-heading"
          >
            <SectionHeading
              id="usage-trend-heading"
              title="每日趋势"
              description="费用按咖宝模型价格在 UTC 30 分钟桶内统一取整；运行次数按完成的智能体用量事件计数。"
              actions={
                <>
                  <SegmentedControl
                    label="趋势指标"
                    value={trendMetric}
                    onChange={setTrendMetric}
                    options={[
                      { value: 'tokens', label: 'Token' },
                      { value: 'cost', label: '费用' },
                      { value: 'runs', label: '运行次数' },
                    ]}
                  />
                  <SegmentedControl
                    label="趋势视图"
                    value={trendView}
                    onChange={setTrendView}
                    options={[
                      { value: 'chart', label: '图表', icon: BarChart3 },
                      { value: 'table', label: '表格', icon: Table2 },
                    ]}
                  />
                </>
              }
            />
            {trendView === 'chart' ? (
              <div className="min-w-0 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border">
                <UsageTrendChart data={dailyData} metric={trendMetric} />
              </div>
            ) : (
              <UsageTrendTable
                data={dailyData}
                metric={trendMetric}
                billingApplicable={billingApplicable}
              />
            )}
          </section>

          <section
            className="min-w-0 space-y-3"
            aria-labelledby="usage-attribution-heading"
          >
            <SectionHeading
              id="usage-attribution-heading"
              title="用量归因"
              description="找出当前范围内的主要成本与 Token 来源。"
              actions={
                <>
                  <SegmentedControl
                    label="归因维度"
                    value={dimension}
                    onChange={setDimension}
                    options={(
                      Object.keys(DIMENSION_LABELS) as AttributionDimension[]
                    ).map((value) => ({
                      value,
                      label: DIMENSION_LABELS[value],
                    }))}
                  />
                  <div className="flex items-center gap-1.5">
                    <Select
                      value={sortBy}
                      onValueChange={(value) =>
                        setSortBy(value as AttributionSort)
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label="归因表排序指标"
                        className="pointer-coarse:min-h-11"
                      >
                        <span className="text-muted-foreground">排序</span>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        <SelectItem value="cost">估算费用</SelectItem>
                        <SelectItem value="tokens">Token</SelectItem>
                        <SelectItem value="runs">运行次数</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      className="pointer-coarse:min-h-11"
                      onClick={() =>
                        setSortDirection((direction) =>
                          direction === 'desc' ? 'asc' : 'desc',
                        )
                      }
                      aria-label={
                        sortDirection === 'desc'
                          ? '当前降序，切换为升序'
                          : '当前升序，切换为降序'
                      }
                    >
                      {sortDirection === 'desc' ? <ArrowDown /> : <ArrowUp />}
                      {sortDirection === 'desc' ? '降序' : '升序'}
                    </Button>
                  </div>
                </>
              }
            />
            <AttributionTable
              rows={attributionRows}
              dimension={dimension}
              totalCost={visibleSummary.providerEstimatedCostUSD}
            />
          </section>

          <aside className="flex items-start gap-2 rounded-xl bg-muted/50 p-4 text-caption leading-5 text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <p>
              模型估算费用按咖宝价格表和 UTC 30
              分钟模型桶计算，可能与套餐倍率、赠送额度或实际账单扣费不同。
              {billingFeatureEnabled && (
                <>
                  需要核对余额和交易时，请前往{' '}
                  <Link
                    to="/billing"
                    className="font-medium text-primary hover:underline"
                  >
                    账单
                  </Link>
                  。
                </>
              )}
            </p>
          </aside>
        </div>
      )}
    </PageContainer>
  );
}

function SectionHeading({
  id,
  title,
  description,
  actions,
}: {
  id: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h2 id={id} className="text-title-sm text-foreground">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-caption text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const active = value !== ALL_VALUE;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        id={id}
        aria-label={label}
        className={cn(
          'w-full min-w-0 pointer-coarse:min-h-11 sm:w-auto sm:max-w-56',
          active && 'border-foreground/25 bg-surface-hover',
        )}
      >
        <span className="shrink-0 text-muted-foreground">{label}</span>
        {/* "All" is implied while a filter is unset; keep it for screen readers. */}
        <span className={cn('min-w-0 truncate', !active && 'sr-only')}>
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MetricItem({
  label,
  value,
  note,
  exactValue,
}: {
  label: string;
  value: string;
  note?: string;
  exactValue?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border">
      <dt className="truncate text-caption text-muted-foreground">{label}</dt>
      <dd
        className="mt-1 truncate text-display-sm text-foreground tabular-nums"
        title={exactValue || value}
      >
        {value}
      </dd>
      {(note || exactValue) && (
        <p className="mt-1 truncate text-caption text-muted-foreground">
          {note || exactValue}
        </p>
      )}
    </div>
  );
}

function TokenComposition({
  summary,
  cacheReadShare,
}: {
  summary: UsageSummary;
  cacheReadShare: number;
}) {
  const total = TOKEN_SERIES.reduce((sum, [key]) => sum + summary[key], 0);
  return (
    <section
      className="space-y-3 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border"
      aria-labelledby="token-composition-heading"
    >
      <div className="min-w-0">
        <h3
          id="token-composition-heading"
          className="text-label text-foreground"
        >
          Token 构成
        </h3>
        <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
          五类互斥，不重复相加。缓存读取占全部输入的 {cacheReadShare.toFixed(1)}
          %；公式：缓存读取 ÷（普通输入 + 缓存读取 + 缓存写入）。
        </p>
      </div>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        {total > 0 &&
          TOKEN_SERIES.map(([key, , color]) =>
            summary[key] > 0 ? (
              <span
                key={key}
                className="h-full"
                style={{
                  width: `${(summary[key] / total) * 100}%`,
                  backgroundColor: color,
                }}
              />
            ) : null,
          )}
      </div>
      <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
        {TOKEN_SERIES.map(([key, label, color]) => (
          <TokenValue
            key={key}
            label={label}
            value={summary[key]}
            color={color}
          />
        ))}
      </dl>
    </section>
  );
}

function TokenValue({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-sm"
          style={{ backgroundColor: color }}
        />
        {label}
      </dt>
      <dd
        className="mt-1 truncate text-title-sm text-foreground tabular-nums"
        title={formatInteger(value)}
      >
        {formatTokens(value)}
      </dd>
    </div>
  );
}

const numberColumn = {
  align: 'right' as const,
  className: 'tabular-nums text-muted-foreground',
};
const strongNumberColumn = {
  align: 'right' as const,
  className: 'tabular-nums font-medium text-foreground',
};

function UsageTrendTable({
  data,
  metric,
  billingApplicable,
}: {
  data: DailyUsagePoint[];
  metric: UsageTrendMetric;
  billingApplicable: boolean;
}) {
  const dateColumn: DataTableColumn<DailyUsagePoint> = {
    key: 'date',
    header: '日期',
    cell: (row) => row.date,
    className: 'tabular-nums text-foreground',
  };
  const columns: DataTableColumn<DailyUsagePoint>[] =
    metric === 'tokens'
      ? [
          dateColumn,
          ...TOKEN_SERIES.map(([key, label]) => ({
            key,
            header: label,
            cell: (row: DailyUsagePoint) => formatTokens(row[key]),
            ...numberColumn,
          })),
          {
            key: 'total',
            header: '合计',
            cell: (row) => formatTokens(row.totalTokens),
            ...strongNumberColumn,
          },
        ]
      : metric === 'cost'
        ? [
            dateColumn,
            {
              key: 'estimated',
              header: '模型估算费用',
              cell: (row) => formatCost(row.providerEstimatedCostUSD),
              ...strongNumberColumn,
            },
            {
              key: 'billed',
              header: '账单扣费',
              cell: (row) =>
                !billingApplicable
                  ? '不适用'
                  : row.billedCostUSD === null
                    ? '—'
                    : formatCost(row.billedCostUSD),
              ...numberColumn,
            },
          ]
        : [
            dateColumn,
            {
              key: 'runs',
              header: '智能体运行次数',
              cell: (row) => formatInteger(row.runCount),
              ...strongNumberColumn,
            },
            {
              key: 'calls',
              header: '模型调用次数',
              cell: (row) => formatInteger(row.modelCallCount),
              ...numberColumn,
            },
          ];
  return (
    <div className="max-h-[28rem] max-w-full overflow-x-auto overflow-y-auto rounded-xl bg-surface-raised ring-1 ring-surface-border">
      <DataTable
        framed={false}
        columns={columns}
        rows={data}
        rowKey={(row) => row.date}
        className="[&_thead]:bg-muted/40"
      />
      <p className="sr-only">
        {metric === 'tokens'
          ? '每日 Token 分类数据'
          : metric === 'cost'
            ? '每日模型估算费用数据'
            : '每日智能体运行次数数据'}
      </p>
    </div>
  );
}

function AttributionTable({
  rows,
  dimension,
  totalCost,
}: {
  rows: AttributionRow[];
  dimension: AttributionDimension;
  totalCost: number;
}) {
  const columns: DataTableColumn<AttributionRow>[] = [
    {
      key: 'label',
      header: DIMENSION_LABELS[dimension],
      cell: (row) => row.label,
      className:
        'min-w-36 max-w-[20rem] whitespace-normal break-all font-medium text-foreground',
    },
    {
      key: 'tokens',
      header: '总 Token',
      cell: (row) => formatTokens(row.tokens),
      ...numberColumn,
    },
    {
      key: 'runs',
      header: '智能体运行次数',
      cell: (row) => formatInteger(row.runCount),
      ...numberColumn,
    },
    {
      key: 'calls',
      header: '模型调用次数',
      cell: (row) => formatInteger(row.modelCallCount),
      ...numberColumn,
    },
    {
      key: 'cost',
      header: '模型估算费用',
      cell: (row) => formatCost(row.estimatedCost),
      ...strongNumberColumn,
    },
    {
      key: 'share',
      header: '费用占比',
      align: 'right',
      className: 'tabular-nums text-muted-foreground',
      cell: (row) => {
        const share = totalCost > 0 ? (row.estimatedCost / totalCost) * 100 : 0;
        return (
          <span className="inline-flex items-center justify-end gap-2">
            <span
              aria-hidden="true"
              className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block"
            >
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, share)}%` }}
              />
            </span>
            {totalCost > 0 ? `${share.toFixed(1)}%` : '0.0%'}
          </span>
        );
      },
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      empty={
        <p className="py-8 text-center text-body text-muted-foreground">
          当前范围没有可归因的数据
        </p>
      }
    />
  );
}

function UsageLoadingState() {
  return (
    <div className="space-y-6" aria-label="正在加载用量数据" aria-live="polite">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="space-y-3 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="space-y-4 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

function UsageEmptyState({
  filtered,
  onClear,
}: {
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <EmptyState
      icon={Zap}
      title={filtered ? '当前筛选没有用量数据' : '还没有智能体用量数据'}
      description={
        filtered
          ? '尝试扩大时间范围或清除筛选，即可继续查看成本和 Token 趋势。'
          : '完成一次 AI 对话或智能体任务后，这里会展示运行次数、Token 构成和模型成本估算。'
      }
      className="rounded-xl ring-1 ring-surface-border"
      action={
        filtered ? (
          <Button className="pointer-coarse:min-h-11" onClick={onClear}>
            清除筛选
          </Button>
        ) : (
          <Button asChild className="pointer-coarse:min-h-11">
            <Link to="/chat">开始一次对话</Link>
          </Button>
        )
      }
    />
  );
}
