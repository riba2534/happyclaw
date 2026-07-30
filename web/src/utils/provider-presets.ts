/**
 * Provider presets — first-class configuration templates for known
 * Anthropic-compatible providers.
 *
 * A preset captures a provider's current models and regional endpoint
 * families so the provider editor can prefill a provider instead of
 * requiring a manually typed endpoint and model name. Selecting a preset
 * only fills in the editable fields; every value stays user-editable.
 *
 * The agent runtime speaks the Anthropic-compatible protocol
 * (ANTHROPIC_BASE_URL), so the Anthropic-compatible base URL is the value
 * injected at runtime. The OpenAI-compatible base URL is recorded per
 * region for reference so the full endpoint family is documented in one
 * place.
 */

export type ProviderPresetRegion = 'global_en' | 'cn_zh';

export interface ProviderPresetEndpoint {
  region: ProviderPresetRegion;
  /** Anthropic-compatible base URL (ANTHROPIC_BASE_URL), used at runtime. */
  anthropicBaseUrl: string;
  /** OpenAI-compatible base URL, recorded for reference. */
  openaiBaseUrl: string;
  /** Documentation root for this region. */
  docsRoot: string;
}

export interface ProviderPresetModel {
  modelId: string;
  /** Whether the model ships a one-million-token context window. */
  oneMillionContext: boolean;
}

export interface ProviderPreset {
  id: string;
  name: string;
  /** Models currently offered by the provider. */
  models: ProviderPresetModel[];
  /** Regional endpoint families. */
  endpoints: ProviderPresetEndpoint[];
  /** Region selected by default. */
  defaultRegion: ProviderPresetRegion;
  /** Model selected by default. */
  defaultModelId: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'minimax',
    name: 'MiniMax',
    models: [
      { modelId: 'MiniMax-M3', oneMillionContext: true },
      { modelId: 'MiniMax-M2.7', oneMillionContext: false },
    ],
    endpoints: [
      {
        region: 'global_en',
        anthropicBaseUrl: 'https://api.minimax.io/anthropic',
        openaiBaseUrl: 'https://api.minimax.io/v1',
        docsRoot: 'https://platform.minimax.io/docs',
      },
      {
        region: 'cn_zh',
        anthropicBaseUrl: 'https://api.minimaxi.com/anthropic',
        openaiBaseUrl: 'https://api.minimaxi.com/v1',
        docsRoot: 'https://platform.minimaxi.com/docs',
      },
    ],
    defaultRegion: 'global_en',
    defaultModelId: 'MiniMax-M3',
  },
];

/** Human-readable label for a preset region. */
export function providerPresetRegionLabel(
  region: ProviderPresetRegion,
): string {
  return region === 'global_en' ? 'Global' : 'China';
}

/** Look up a preset by id. */
export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Resolve the endpoint for a region, falling back to the first endpoint. */
export function getPresetEndpoint(
  preset: ProviderPreset,
  region: ProviderPresetRegion,
): ProviderPresetEndpoint {
  return (
    preset.endpoints.find((endpoint) => endpoint.region === region) ??
    preset.endpoints[0]
  );
}

/** Resolve a model by id, falling back to the default model. */
export function getPresetModel(
  preset: ProviderPreset,
  modelId: string,
): ProviderPresetModel {
  return (
    preset.models.find((model) => model.modelId === modelId) ??
    preset.models.find((model) => model.modelId === preset.defaultModelId) ??
    preset.models[0]
  );
}
