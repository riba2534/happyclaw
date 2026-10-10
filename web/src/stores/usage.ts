import { create } from 'zustand';
import { registerUserScopedReset } from './user-scope';
import { api } from '../api/client';

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  providerEstimatedCostUSD: number;
  billedCostUSD: number | null;
  runCount: number;
  modelCallCount: number;
  activeDays: number;
  averageCostPerRunUSD: number;
  // Legacy aliases are kept so older callers do not silently change meaning.
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalReasoningTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
}

export interface UsageBreakdown {
  date: string;
  model: string;
  user_id: string;
  agent_id: string | null;
  agent_name?: string | null;
  group_folder: string | null;
  workspace_name?: string | null;
  source: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  provider_estimated_cost_usd: number;
  billed_cost_usd: number | null;
  run_count: number;
  model_call_count: number;
  // Legacy aliases from usage_daily_summary.
  cost_usd: number;
  request_count: number;
}

export interface UsageDailyBucket {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  providerEstimatedCostUSD: number;
  billedCostUSD: number | null;
  runCount: number;
  modelCallCount: number;
}

export interface UsageWindow {
  from: string;
  to: string;
  days: number;
  timezone: string;
}

export interface UsageScope {
  userId: string | null;
  model: string | null;
  agentId: string | null;
  groupFolder: string | null;
  source: string | null;
}

export interface DataRange {
  from: string;
  to: string;
  activeDays: number;
}

export interface UsageUser {
  id: string;
  username: string;
}

export interface UsageQuery {
  days: number;
  userId: string | null;
  model: string | null;
  agentId: string | null;
  groupFolder: string | null;
  source: string | null;
}

export interface UsageAttributionItem {
  key: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  providerEstimatedCostUSD: number;
  billedCostUSD: number | null;
  runCount: number;
  modelCallCount: number;
}

export interface UsageAttributions {
  models: UsageAttributionItem[];
  agents: UsageAttributionItem[];
  workspaces: UsageAttributionItem[];
  sources: UsageAttributionItem[];
}

export interface UsageBillingSemantics {
  enabled: boolean;
  applicable: boolean;
  providerCostSemantics: string;
  billedCostSemantics: string;
}

interface RawUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  providerEstimatedCostUSD?: number;
  billedCostUSD?: number | null;
  runCount?: number;
  modelCallCount?: number;
  activeDays?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  totalReasoningTokens?: number;
  totalCostUSD?: number;
  totalMessages?: number;
  totalActiveDays?: number;
}

interface RawUsageBreakdown {
  date: string;
  model?: string;
  user_id?: string;
  agent_id?: string | null;
  agent_name?: string | null;
  group_folder?: string | null;
  workspace_name?: string | null;
  source?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  provider_estimated_cost_usd?: number;
  billed_cost_usd?: number | null;
  run_count?: number;
  model_call_count?: number;
  cost_usd?: number;
  request_count?: number;
}

interface RawUsageResponse {
  window?: UsageWindow;
  generatedAt?: string;
  scope?: Partial<UsageScope>;
  summary?: RawUsageSummary;
  breakdown?: RawUsageBreakdown[];
  daily?: RawUsageBreakdown[];
  days?: number;
  dataRange?: DataRange | null;
  attributions?: Partial<Record<keyof UsageAttributions, unknown[]>>;
  billing?: Partial<UsageBillingSemantics>;
}

export interface NormalizedUsageResponse {
  summary: UsageSummary;
  breakdown: UsageBreakdown[];
  daily: UsageDailyBucket[];
  window: UsageWindow;
  generatedAt: string;
  scope: UsageScope;
  dataRange: DataRange;
  attributions: UsageAttributions;
  billing: UsageBillingSemantics | null;
}

const DEFAULT_QUERY: UsageQuery = {
  days: 7,
  userId: null,
  model: null,
  agentId: null,
  groupFolder: null,
  source: null,
};

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function fallbackWindow(days: number, now: Date): UsageWindow {
  const safeDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 365);
  const to = new Date(now);
  const from = new Date(now);
  from.setDate(from.getDate() - (safeDays - 1));
  return {
    from: localDateString(from),
    to: localDateString(to),
    days: safeDays,
    timezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Browser local time',
  };
}

function normalizeBreakdown(row: RawUsageBreakdown): UsageBreakdown {
  const estimatedCost = finiteNumber(
    row.provider_estimated_cost_usd ?? row.cost_usd,
  );
  const runCount = finiteNumber(row.run_count ?? row.request_count);
  return {
    date: row.date,
    model: row.model || 'unknown',
    user_id: row.user_id || '',
    agent_id: row.agent_id || null,
    agent_name: row.agent_name || null,
    group_folder: row.group_folder || null,
    workspace_name: row.workspace_name || null,
    source: row.source || 'agent',
    input_tokens: finiteNumber(row.input_tokens),
    output_tokens: finiteNumber(row.output_tokens),
    cache_read_tokens: finiteNumber(row.cache_read_tokens),
    cache_creation_tokens: finiteNumber(row.cache_creation_tokens),
    reasoning_tokens: finiteNumber(row.reasoning_tokens),
    provider_estimated_cost_usd: estimatedCost,
    billed_cost_usd:
      typeof row.billed_cost_usd === 'number' ? row.billed_cost_usd : null,
    run_count: runCount,
    model_call_count: finiteNumber(row.model_call_count ?? row.request_count),
    cost_usd: estimatedCost,
    request_count: runCount,
  };
}

function normalizeDailyBucket(row: RawUsageBreakdown): UsageDailyBucket {
  const inputTokens = finiteNumber(row.input_tokens);
  const outputTokens = finiteNumber(row.output_tokens);
  const cacheReadTokens = finiteNumber(row.cache_read_tokens);
  const cacheCreationTokens = finiteNumber(row.cache_creation_tokens);
  const reasoningTokens = finiteNumber(row.reasoning_tokens);
  return {
    date: row.date,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      cacheReadTokens +
      cacheCreationTokens +
      reasoningTokens,
    providerEstimatedCostUSD: finiteNumber(
      row.provider_estimated_cost_usd ?? row.cost_usd,
    ),
    billedCostUSD:
      typeof row.billed_cost_usd === 'number' ? row.billed_cost_usd : null,
    runCount: finiteNumber(row.run_count ?? row.request_count),
    modelCallCount: finiteNumber(row.model_call_count ?? row.request_count),
  };
}

function normalizeAttributionItem(item: unknown): UsageAttributionItem | null {
  if (typeof item === 'string') {
    return {
      key: item,
      name: item,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      providerEstimatedCostUSD: 0,
      billedCostUSD: null,
      runCount: 0,
      modelCallCount: 0,
    };
  }
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const key = typeof record.key === 'string' ? record.key : '';
  if (!key) return null;
  return {
    key,
    name: typeof record.name === 'string' && record.name ? record.name : key,
    inputTokens: finiteNumber(record.inputTokens),
    outputTokens: finiteNumber(record.outputTokens),
    cacheReadTokens: finiteNumber(record.cacheReadTokens),
    cacheCreationTokens: finiteNumber(record.cacheCreationTokens),
    reasoningTokens: finiteNumber(record.reasoningTokens),
    totalTokens: finiteNumber(record.totalTokens),
    providerEstimatedCostUSD: finiteNumber(record.providerEstimatedCostUSD),
    billedCostUSD:
      typeof record.billedCostUSD === 'number' ? record.billedCostUSD : null,
    runCount: finiteNumber(record.runCount),
    modelCallCount: finiteNumber(record.modelCallCount),
  };
}

function normalizeAttributions(
  raw?: Partial<Record<keyof UsageAttributions, unknown[]>>,
): UsageAttributions {
  const normalize = (key: keyof UsageAttributions) =>
    (raw?.[key] || [])
      .map(normalizeAttributionItem)
      .filter((item): item is UsageAttributionItem => item !== null);
  return {
    models: normalize('models'),
    agents: normalize('agents'),
    workspaces: normalize('workspaces'),
    sources: normalize('sources'),
  };
}

function aggregateSummary(
  rows: UsageBreakdown[],
  rawSummary: RawUsageSummary,
  hasExplicitWindow: boolean,
): UsageSummary {
  const totals = rows.reduce(
    (acc, row) => {
      acc.input += row.input_tokens;
      acc.output += row.output_tokens;
      acc.cacheRead += row.cache_read_tokens;
      acc.cacheCreation += row.cache_creation_tokens;
      acc.reasoning += row.reasoning_tokens;
      acc.estimatedCost += row.provider_estimated_cost_usd;
      if (row.billed_cost_usd !== null) {
        acc.hasBilledCost = true;
        acc.billedCost += row.billed_cost_usd;
      }
      acc.runCount += row.run_count;
      acc.modelCallCount += row.model_call_count;
      acc.dates.add(row.date);
      return acc;
    },
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
      estimatedCost: 0,
      billedCost: 0,
      hasBilledCost: false,
      runCount: 0,
      modelCallCount: 0,
      dates: new Set<string>(),
    },
  );

  // The enhanced API can de-duplicate one run that touched multiple models.
  // Legacy responses cannot, so their visible totals are recomputed from the
  // exact date buckets after trimming the historical off-by-one window.
  const runCount =
    hasExplicitWindow && typeof rawSummary.runCount === 'number'
      ? rawSummary.runCount
      : totals.runCount;
  const modelCallCount =
    hasExplicitWindow && typeof rawSummary.modelCallCount === 'number'
      ? rawSummary.modelCallCount
      : totals.modelCallCount;
  const billedCost =
    hasExplicitWindow && typeof rawSummary.billedCostUSD === 'number'
      ? rawSummary.billedCostUSD
      : totals.hasBilledCost
        ? totals.billedCost
        : null;
  // Windowed responses carry server-side totals over the same filters, so
  // the page can request stats without the bulky per-row breakdown.
  const serverNumber = (value: number | undefined, fallback: number) =>
    hasExplicitWindow && typeof value === 'number' ? value : fallback;
  const input = serverNumber(rawSummary.inputTokens, totals.input);
  const output = serverNumber(rawSummary.outputTokens, totals.output);
  const cacheRead = serverNumber(rawSummary.cacheReadTokens, totals.cacheRead);
  const cacheCreation = serverNumber(
    rawSummary.cacheCreationTokens,
    totals.cacheCreation,
  );
  const reasoning = serverNumber(rawSummary.reasoningTokens, totals.reasoning);
  const estimatedCost = serverNumber(
    rawSummary.providerEstimatedCostUSD,
    totals.estimatedCost,
  );
  const activeDays = serverNumber(rawSummary.activeDays, totals.dates.size);
  const totalTokens = serverNumber(
    rawSummary.totalTokens,
    input + output + cacheRead + cacheCreation + reasoning,
  );

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: reasoning,
    totalTokens,
    providerEstimatedCostUSD: estimatedCost,
    billedCostUSD: billedCost,
    runCount,
    modelCallCount,
    activeDays,
    averageCostPerRunUSD: runCount > 0 ? estimatedCost / runCount : 0,
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCacheReadTokens: cacheRead,
    totalCacheCreationTokens: cacheCreation,
    totalReasoningTokens: reasoning,
    totalCostUSD: estimatedCost,
    totalMessages: runCount,
    totalActiveDays: activeDays,
  };
}

export function normalizeUsageResponse(
  raw: RawUsageResponse,
  query: UsageQuery,
  now = new Date(),
): NormalizedUsageResponse {
  const hasExplicitWindow = Boolean(raw.window);
  const window = raw.window || fallbackWindow(raw.days ?? query.days, now);
  const normalizedRows = (raw.breakdown || []).map(normalizeBreakdown);
  const breakdown = normalizedRows.filter(
    (row) => row.date >= window.from && row.date <= window.to,
  );
  const daily = (raw.daily || [])
    .map(normalizeDailyBucket)
    .filter((row) => row.date >= window.from && row.date <= window.to);
  const summary = aggregateSummary(
    breakdown,
    raw.summary || {},
    hasExplicitWindow,
  );
  const scope: UsageScope = {
    userId: raw.scope?.userId ?? query.userId,
    model: raw.scope?.model ?? query.model,
    agentId: raw.scope?.agentId ?? query.agentId,
    groupFolder: raw.scope?.groupFolder ?? query.groupFolder,
    source: raw.scope?.source ?? query.source,
  };
  const billing = raw.billing
    ? {
        enabled: raw.billing.enabled === true,
        applicable:
          typeof raw.billing.applicable === 'boolean'
            ? raw.billing.applicable
            : raw.billing.enabled === true,
        providerCostSemantics:
          raw.billing.providerCostSemantics || 'kaboo-utc-30m-rounded-estimate',
        billedCostSemantics: raw.billing.billedCostSemantics || 'actual-charge',
      }
    : null;

  return {
    summary,
    breakdown,
    daily,
    window,
    generatedAt: raw.generatedAt || now.toISOString(),
    scope,
    dataRange: {
      from: window.from,
      to: window.to,
      activeDays: summary.activeDays,
    },
    attributions: normalizeAttributions(raw.attributions),
    billing,
  };
}

export function buildUsageQueryParams(
  query: UsageQuery,
  options: { omitModel?: boolean } = {},
): URLSearchParams {
  const params = new URLSearchParams({ days: String(query.days) });
  if (query.userId) params.set('userId', query.userId);
  if (query.model && !options.omitModel) params.set('model', query.model);
  if (query.agentId) params.set('agentId', query.agentId);
  if (query.groupFolder) params.set('groupFolder', query.groupFolder);
  if (query.source) params.set('source', query.source);
  return params;
}

export function usageQueryKey(query: UsageQuery): string {
  return buildUsageQueryParams(query).toString();
}

function mergeStrings(
  current: string[],
  incoming: Array<string | null>,
): string[] {
  return Array.from(
    new Set([
      ...current,
      ...incoming.filter((value): value is string => !!value),
    ]),
  ).sort((a, b) => a.localeCompare(b));
}

interface UsageState {
  ownerUserId: string | null;
  summary: UsageSummary | null;
  breakdown: UsageBreakdown[];
  daily: UsageDailyBucket[];
  window: UsageWindow | null;
  scope: UsageScope | null;
  dataRange: DataRange | null;
  generatedAt: string | null;
  attributions: UsageAttributions;
  billing: UsageBillingSemantics | null;
  days: number;
  loading: boolean;
  error: string | null;
  lastQueryKey: string | null;

  selectedUserId: string | null;
  selectedModel: string | null;
  selectedAgentId: string | null;
  selectedGroupFolder: string | null;
  selectedSource: string | null;
  availableModels: string[];
  availableUsers: UsageUser[];
  availableAgents: string[];
  availableWorkspaces: string[];
  availableSources: string[];
  agentNames: Record<string, string>;
  workspaceNames: Record<string, string>;

  ensureOwner: (userId: string | null) => void;
  reset: (ownerUserId?: string | null) => void;
  setQuery: (query: UsageQuery) => void;
  loadStats: (query?: UsageQuery | number) => Promise<void>;
  refresh: () => Promise<void>;
  setDays: (days: number) => void;
  setSelectedUserId: (id: string | null) => void;
  setSelectedModel: (model: string | null) => void;
  setSelectedAgentId: (id: string | null) => void;
  setSelectedGroupFolder: (folder: string | null) => void;
  setSelectedSource: (source: string | null) => void;
  loadFilters: (query?: UsageQuery) => Promise<void>;
}

function stateValues(ownerUserId: string | null) {
  return {
    ownerUserId,
    summary: null,
    breakdown: [] as UsageBreakdown[],
    daily: [] as UsageDailyBucket[],
    window: null as UsageWindow | null,
    scope: null as UsageScope | null,
    dataRange: null as DataRange | null,
    generatedAt: null as string | null,
    attributions: normalizeAttributions(),
    billing: null as UsageBillingSemantics | null,
    days: DEFAULT_QUERY.days,
    loading: false,
    error: null as string | null,
    lastQueryKey: null as string | null,
    selectedUserId: null as string | null,
    selectedModel: null as string | null,
    selectedAgentId: null as string | null,
    selectedGroupFolder: null as string | null,
    selectedSource: null as string | null,
    availableModels: [] as string[],
    availableUsers: [] as UsageUser[],
    availableAgents: [] as string[],
    availableWorkspaces: [] as string[],
    availableSources: [] as string[],
    agentNames: {} as Record<string, string>,
    workspaceNames: {} as Record<string, string>,
  };
}

function queryFromState(state: UsageState): UsageQuery {
  return {
    days: state.days,
    userId: state.selectedUserId,
    model: state.selectedModel,
    agentId: state.selectedAgentId,
    groupFolder: state.selectedGroupFolder,
    source: state.selectedSource,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return '用量数据加载失败，请检查网络后重试。';
}

let statsRequestId = 0;
let filtersRequestId = 0;

export const useUsageStore = create<UsageState>((set, get) => ({
  ...stateValues(null),

  ensureOwner: (userId) => {
    if (get().ownerUserId === userId) return;
    statsRequestId += 1;
    filtersRequestId += 1;
    set(stateValues(userId));
  },

  reset: (ownerUserId = null) => {
    statsRequestId += 1;
    filtersRequestId += 1;
    set(stateValues(ownerUserId));
  },

  setQuery: (query) => {
    set({
      days: query.days,
      selectedUserId: query.userId,
      selectedModel: query.model,
      selectedAgentId: query.agentId,
      selectedGroupFolder: query.groupFolder,
      selectedSource: query.source,
    });
  },

  loadStats: async (queryOrDays) => {
    const query =
      typeof queryOrDays === 'number'
        ? { ...queryFromState(get()), days: queryOrDays }
        : queryOrDays || queryFromState(get());
    const requestId = ++statsRequestId;
    const queryKey = usageQueryKey(query);
    set({
      loading: true,
      error: null,
      summary: null,
      breakdown: [],
      daily: [],
      window: null,
      scope: null,
      dataRange: null,
      generatedAt: null,
      attributions: normalizeAttributions(),
      billing: null,
      days: query.days,
      lastQueryKey: queryKey,
    });

    try {
      // The page renders daily buckets and server attributions; the
      // per-row breakdown is only needed by pre-window servers.
      const params = buildUsageQueryParams(query);
      params.set('breakdown', 'none');
      const raw = await api.get<RawUsageResponse>(
        `/api/usage/stats?${params.toString()}`,
      );
      if (requestId !== statsRequestId || get().lastQueryKey !== queryKey)
        return;
      const normalized = normalizeUsageResponse(raw, query);
      set((state) => ({
        summary: normalized.summary,
        breakdown: normalized.breakdown,
        daily: normalized.daily,
        window: normalized.window,
        scope: normalized.scope,
        dataRange: normalized.dataRange,
        generatedAt: normalized.generatedAt,
        attributions: normalized.attributions,
        billing: normalized.billing,
        loading: false,
        error: null,
        availableModels: mergeStrings(state.availableModels, [
          ...normalized.breakdown.map((row) => row.model),
          ...normalized.attributions.models.map((item) => item.key),
        ]),
        availableAgents: mergeStrings(state.availableAgents, [
          ...normalized.breakdown.map((row) => row.agent_id),
          ...normalized.attributions.agents.map((item) => item.key),
        ]),
        availableWorkspaces: mergeStrings(state.availableWorkspaces, [
          ...normalized.breakdown.map((row) => row.group_folder),
          ...normalized.attributions.workspaces.map((item) => item.key),
        ]),
        availableSources: mergeStrings(state.availableSources, [
          ...normalized.breakdown.map((row) => row.source),
          ...normalized.attributions.sources.map((item) => item.key),
        ]),
        agentNames: {
          ...state.agentNames,
          ...Object.fromEntries(
            normalized.attributions.agents.map((item) => [item.key, item.name]),
          ),
        },
        workspaceNames: {
          ...state.workspaceNames,
          ...Object.fromEntries(
            normalized.attributions.workspaces.map((item) => [
              item.key,
              item.name,
            ]),
          ),
        },
      }));
    } catch (error) {
      if (requestId !== statsRequestId || get().lastQueryKey !== queryKey)
        return;
      set({
        loading: false,
        error: errorMessage(error),
        summary: null,
        breakdown: [],
        daily: [],
        window: null,
        scope: null,
        dataRange: null,
        generatedAt: null,
        attributions: normalizeAttributions(),
        billing: null,
      });
    }
  },

  refresh: async () => {
    await get().loadStats(queryFromState(get()));
  },

  setDays: (days) => set({ days }),
  setSelectedUserId: (id) => set({ selectedUserId: id }),
  setSelectedModel: (model) => set({ selectedModel: model }),
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),
  setSelectedGroupFolder: (folder) => set({ selectedGroupFolder: folder }),
  setSelectedSource: (source) => set({ selectedSource: source }),

  loadFilters: async (providedQuery) => {
    const query = providedQuery || queryFromState(get());
    const requestId = ++filtersRequestId;
    const modelParams = buildUsageQueryParams(query, { omitModel: true });
    const [modelsResult, usersResult, filtersResult] = await Promise.allSettled(
      [
        api.get<{ models: string[] }>(`/api/usage/models?${modelParams}`),
        api.get<{ users: UsageUser[] }>('/api/usage/users'),
        api.get<{
          models?: unknown[];
          agents?: unknown[];
          workspaces?: unknown[];
          sources?: unknown[];
        }>(`/api/usage/filters?${modelParams}`),
      ],
    );
    if (requestId !== filtersRequestId) return;
    set((state) => {
      const filterAttributions =
        filtersResult.status === 'fulfilled'
          ? normalizeAttributions(filtersResult.value)
          : normalizeAttributions();
      return {
        availableModels: mergeStrings(state.availableModels, [
          ...(modelsResult.status === 'fulfilled'
            ? modelsResult.value.models || []
            : []),
          ...filterAttributions.models.map((item) => item.key),
        ]),
        availableUsers:
          usersResult.status === 'fulfilled'
            ? usersResult.value.users || []
            : state.availableUsers,
        availableAgents: mergeStrings(
          state.availableAgents,
          filterAttributions.agents.map((item) => item.key),
        ),
        availableWorkspaces: mergeStrings(
          state.availableWorkspaces,
          filterAttributions.workspaces.map((item) => item.key),
        ),
        availableSources: mergeStrings(
          state.availableSources,
          filterAttributions.sources.map((item) => item.key),
        ),
        agentNames: {
          ...state.agentNames,
          ...Object.fromEntries(
            filterAttributions.agents.map((item) => [item.key, item.name]),
          ),
        },
        workspaceNames: {
          ...state.workspaceNames,
          ...Object.fromEntries(
            filterAttributions.workspaces.map((item) => [item.key, item.name]),
          ),
        },
      };
    });
  },
}));

export { DEFAULT_QUERY };

registerUserScopedReset(() => useUsageStore.getState().reset());
