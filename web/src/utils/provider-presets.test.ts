import { describe, expect, test } from 'vitest';

import {
  PROVIDER_PRESETS,
  findProviderPreset,
  getPresetEndpoint,
  getPresetModel,
  providerPresetRegionLabel,
} from './provider-presets';

describe('provider presets', () => {
  test('exposes a first-class MiniMax preset', () => {
    const minimax = findProviderPreset('minimax');
    expect(minimax).toBeDefined();
    expect(minimax!.name).toBe('MiniMax');
  });

  test('covers both current models', () => {
    const minimax = findProviderPreset('minimax')!;
    expect(minimax.models.map((m) => m.modelId)).toEqual([
      'MiniMax-M3',
      'MiniMax-M2.7',
    ]);
    expect(
      minimax.models.find((m) => m.modelId === 'MiniMax-M3')!.oneMillionContext,
    ).toBe(true);
    expect(
      minimax.models.find((m) => m.modelId === 'MiniMax-M2.7')!
        .oneMillionContext,
    ).toBe(false);
  });

  test('covers the global and China endpoint families', () => {
    const minimax = findProviderPreset('minimax')!;
    const regions = minimax.endpoints.map((e) => e.region);
    expect(regions).toEqual(['global_en', 'cn_zh']);

    const globalEn = getPresetEndpoint(minimax, 'global_en');
    expect(globalEn.anthropicBaseUrl).toBe('https://api.minimax.io/anthropic');
    expect(globalEn.openaiBaseUrl).toBe('https://api.minimax.io/v1');

    const cnZh = getPresetEndpoint(minimax, 'cn_zh');
    expect(cnZh.anthropicBaseUrl).toBe('https://api.minimaxi.com/anthropic');
    expect(cnZh.openaiBaseUrl).toBe('https://api.minimaxi.com/v1');
  });

  test('resolves the default model and falls back when unknown', () => {
    const minimax = findProviderPreset('minimax')!;
    expect(getPresetModel(minimax, 'MiniMax-M2.7').modelId).toBe(
      'MiniMax-M2.7',
    );
    expect(getPresetModel(minimax, 'unknown').modelId).toBe(
      minimax.defaultModelId,
    );
  });

  test('labels regions readably', () => {
    expect(providerPresetRegionLabel('global_en')).toBe('Global');
    expect(providerPresetRegionLabel('cn_zh')).toBe('China');
  });

  test('every preset exposes the Anthropic-compatible base URL it injects at runtime', () => {
    for (const preset of PROVIDER_PRESETS) {
      for (const endpoint of preset.endpoints) {
        expect(endpoint.anthropicBaseUrl).toMatch(/^https?:\/\//);
      }
    }
  });
});
