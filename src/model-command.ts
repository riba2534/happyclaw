import {
  getProviderPool,
  getProviderPools,
  listProviderPoolModelOptions,
} from './db.js';
import { getEnabledProvidersForPool } from './runtime-config.js';
import type {
  ConversationRuntimeState,
  ModelBinding,
  ModelSelectionKind,
  ProviderPoolModelOption,
} from './types.js';

export function formatModelLabel(model: string | null | undefined): string {
  return model && model.trim() ? model : 'default';
}

export function commandParts(content: string): string[] {
  return content.trim().split(/\s+/).filter(Boolean);
}

export function shouldIncludeAllModelOptions(args: string[]): boolean {
  return args.some((arg) => {
    const normalized = arg.toLowerCase();
    return normalized === '--all' || normalized === 'all';
  });
}

function resolvedModelFromOption(option?: ProviderPoolModelOption): string | null {
  if (!option?.metadata_json) return null;
  try {
    const metadata = JSON.parse(option.metadata_json) as Record<string, unknown>;
    const resolved = metadata.resolved_model ?? metadata.resolvedModel;
    return typeof resolved === 'string' && resolved.trim()
      ? resolved.trim()
      : null;
  } catch {
    return null;
  }
}

function shouldShowInDefaultModelList(option: ProviderPoolModelOption): boolean {
  return option.status !== 'hidden' && option.status !== 'unsupported';
}

function formatModelOptionLine(option: ProviderPoolModelOption): string {
  const displayName =
    option.display_name && option.display_name !== option.model_id
      ? ` - ${option.display_name}`
      : '';
  return `  - ${option.model_id}${displayName} (${option.model_kind}, ${option.status})`;
}

export function parseModelBindingFromArgs(
  args: string[],
): { binding?: ModelBinding; error?: string } {
  if (args.length === 0) {
    return {
      error:
        '用法：/model use <claude|gpt> [model]\n例如：/model use claude opus-4.7 或 /model use gpt',
    };
  }

  const pools = getProviderPools().filter((pool) => pool.enabled);
  const visibleOptions = listProviderPoolModelOptions(undefined, false).filter(
    (option) => option.status !== 'hidden',
  );
  const first = args[0].toLowerCase();
  const pool = pools.find(
    (item) =>
      item.provider_pool_id.toLowerCase() === first ||
      item.display_name.toLowerCase() === first,
  );

  let providerPoolId: string;
  let selectedModel: string | null = null;
  let modelKind: ModelSelectionKind = 'provider_default';
  let resolvedModel: string | null = null;

  if (pool) {
    providerPoolId = pool.provider_pool_id;
    const modelSpec = args.slice(1).join(' ').trim();
    if (modelSpec && modelSpec.toLowerCase() !== 'default') {
      const option = visibleOptions.find(
        (item) =>
          item.provider_pool_id === providerPoolId &&
          item.model_id.toLowerCase() === modelSpec.toLowerCase(),
      );
      if (!option) {
        return {
          error: `模型 ${modelSpec} 未配置在模型池 ${providerPoolId} 中。请先用 /model list 查看可用模型。`,
        };
      }
      if (option.status === 'unsupported') {
        return { error: `模型 ${modelSpec} 当前标记为不可用。` };
      }
      selectedModel = option.model_id;
      modelKind = option.model_kind;
      resolvedModel = resolvedModelFromOption(option);
    }
  } else {
    const modelSpec = args.join(' ').trim();
    if (modelSpec.toLowerCase() === 'default') {
      return {
        error: '请指定模型池：/model use claude default 或 /model use gpt default',
      };
    }
    const matches = visibleOptions.filter(
      (item) => item.model_id.toLowerCase() === modelSpec.toLowerCase(),
    );
    if (matches.length === 0) {
      return {
        error: `未找到模型 ${modelSpec}。请先用 /model list 查看可用模型。`,
      };
    }
    const enabledMatches = matches.filter((item) =>
      pools.some(
        (poolItem) => poolItem.provider_pool_id === item.provider_pool_id,
      ),
    );
    if (enabledMatches.length !== 1) {
      return {
        error:
          enabledMatches.length > 1
            ? `模型 ${modelSpec} 在多个模型池中存在，请写成 /model use <模型池> ${modelSpec}`
            : `模型 ${modelSpec} 所在模型池未启用。`,
      };
    }
    const option = enabledMatches[0];
    if (option.status === 'unsupported') {
      return { error: `模型 ${modelSpec} 当前标记为不可用。` };
    }
    providerPoolId = option.provider_pool_id;
    selectedModel = option.model_id;
    modelKind = option.model_kind;
    resolvedModel = resolvedModelFromOption(option);
  }

  const resolvedPool = getProviderPool(providerPoolId);
  if (!resolvedPool) return { error: `未知模型池：${providerPoolId}` };
  if (getEnabledProvidersForPool(providerPoolId).length === 0) {
    return {
      error: `模型池 ${providerPoolId} 没有启用的鉴权供应商，请先配置对应账号池。`,
    };
  }

  return {
    binding: {
      runtime: resolvedPool.runtime,
      provider_family: resolvedPool.provider_family,
      provider_pool_id: resolvedPool.provider_pool_id,
      selected_model: selectedModel,
      model_kind: modelKind,
      resolved_model: resolvedModel,
    },
  };
}

export function formatModelList(includeAll = false): string {
  const pools = getProviderPools();
  const options = listProviderPoolModelOptions(undefined, includeAll);
  const lines = [includeAll ? '模型目录（含隐藏/不可用）：' : '可用模型：'];
  for (const pool of pools) {
    const poolOptions = options.filter(
      (item) => item.provider_pool_id === pool.provider_pool_id,
    );
    lines.push(`\n${pool.display_name} (${pool.provider_pool_id})`);
    if (poolOptions.length === 0) {
      lines.push('  - 暂无模型选项');
      continue;
    }
    for (const option of poolOptions) {
      if (!includeAll && !shouldShowInDefaultModelList(option)) continue;
      lines.push(formatModelOptionLine(option));
    }
  }
  lines.push('\n切换用法：/model use <claude|gpt> [model]');
  lines.push('查看完整目录：/model list --all');
  return lines.join('\n');
}

export function formatRuntimeState(
  state: ConversationRuntimeState,
  scopeName: string,
): string {
  const pool = getProviderPool(state.provider_pool_id);
  return [
    `当前模型：${formatModelLabel(state.selected_model)}`,
    `模型池：${pool?.display_name || state.provider_pool_id} (${state.provider_pool_id})`,
    `运行时：${state.runtime}`,
    `选择类型：${state.model_kind}`,
    `作用域：${scopeName}`,
    `来源：${state.binding_source}`,
  ].join('\n');
}
