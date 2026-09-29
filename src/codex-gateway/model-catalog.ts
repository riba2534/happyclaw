/**
 * Codex 模型目录 — baked-in 离线兜底。
 *
 * 目录对齐 codex CLI 随版本捆绑的 models.json（上游移除模型后请求会直接
 * 400，例如 gpt-5.1 系列）。UI 下拉、请求侧 effort 钳制、legacy 归一都以
 * 这里为准；前端通过 GET /api/config/codex/model-catalog 获取。
 *
 * 实时目录由 model-catalog-sync.ts 从上游 openai/codex 仓库同步（本文件
 * 是拉取失败/首次启动时的兜底）；目录随上游更新通常无需改这个文件。
 */

export interface CodexModelCatalogEntry {
  /** 上游 Responses API 接受的模型 slug。 */
  value: string;
  /** UI 展示文案。 */
  label: string;
  /** 该模型支持的 reasoning.effort 档位（不支持的档位上游 400）。 */
  efforts: readonly string[];
  /** 上游 default_reasoning_level；缺失时钳制兜底用 CODEX_DEFAULT_EFFORT。 */
  defaultEffort?: string;
}

export const CODEX_FULL_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export const CODEX_CAPPED_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const CODEX_LEGACY_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

/** 全部已知 effort 档位（不含已被上游移除的 minimal）。同步层用它过滤上游值。 */
export const CODEX_KNOWN_EFFORTS: readonly string[] = [
  ...new Set<string>([
    ...CODEX_FULL_EFFORTS,
    ...CODEX_CAPPED_EFFORTS,
    ...CODEX_LEGACY_EFFORTS,
  ]),
];

export const CODEX_MODEL_CATALOG: readonly CodexModelCatalogEntry[] = [
  {
    value: 'gpt-6-sol',
    label: 'gpt-6-sol（主力编码）',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-6-astra',
    label: 'gpt-6-astra（旗舰·最强推理）',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'low',
  },
  {
    value: 'gpt-6-luna',
    label: 'gpt-6-luna（快速轻量）',
    efforts: CODEX_CAPPED_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol（上一代编码）',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'low',
  },
  {
    value: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra（上一代均衡）',
    efforts: CODEX_FULL_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.6-luna',
    label: 'gpt-5.6-luna（上一代快速）',
    efforts: CODEX_CAPPED_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-5.5',
    label: 'gpt-5.5（旧款）',
    efforts: CODEX_LEGACY_EFFORTS,
    defaultEffort: 'medium',
  },
];

export const CODEX_DEFAULT_MODEL = 'gpt-6-sol';
export const CODEX_DEFAULT_EFFORT = 'medium';

export function resolveCodexCatalogEntry(
  model: string,
): CodexModelCatalogEntry | undefined {
  return CODEX_MODEL_CATALOG.find((entry) => entry.value === model);
}

/**
 * 模型的钳制兜底档：优先上游 per-model default（且必须在该模型支持的档位里），
 * 其次该模型第一个档位，最后全局默认。避免"不支持 → 兜底档也不支持"仍然 400。
 */
function resolveEntryFallbackEffort(entry: CodexModelCatalogEntry): string {
  if (entry.defaultEffort && entry.efforts.includes(entry.defaultEffort)) {
    return entry.defaultEffort;
  }
  return entry.efforts[0] ?? CODEX_DEFAULT_EFFORT;
}

/**
 * 请求侧 effort 钳制（纵深防御，与前端"切模型归位默认档"语义一致）：
 * 模型在目录中且配置的 effort 不受支持时，回落到该模型的默认档。
 * 目录外模型（上游新模型尚未收录）不做钳制，保持透传。
 * catalog 参数供上游同步层传入解析后的实时目录；缺省用 baked-in 目录。
 */
export function clampCodexEffortWithCatalog(
  catalog: readonly CodexModelCatalogEntry[],
  model: string,
  effort: string | undefined,
): string | undefined {
  if (!effort) return effort;
  const entry = catalog.find((candidate) => candidate.value === model);
  if (!entry) return effort;
  return entry.efforts.includes(effort)
    ? effort
    : resolveEntryFallbackEffort(entry);
}

export function clampCodexEffort(
  model: string,
  effort: string | undefined,
): string | undefined {
  return clampCodexEffortWithCatalog(CODEX_MODEL_CATALOG, model, effort);
}
