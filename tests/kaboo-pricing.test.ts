import { describe, expect, test } from 'vitest';

import {
  KABOO_SONNET_FALLBACK,
  estimateKabooModelCostCents,
  estimateKabooModelCostUSD,
  matchKabooModelPricing,
  normalizeKabooTokenUsage,
  priceKabooUsageByModel,
} from '../src/kaboo-pricing.js';

describe('Kaboo-aligned model pricing', () => {
  test('uses case-insensitive longest-substring matching', () => {
    const pricing = matchKabooModelPricing(
      'provider/CLAUDE-OPUS-4-5-20251101:beta',
    );
    expect(pricing).toMatchObject({
      pattern: 'claude-opus-4-5%',
      inputPricePerMTok: 5,
      outputPricePerMTok: 25,
      cacheCreationPricePerMTok: 6.25,
    });
  });

  test('prices Claude 5 generation models and preserves longest-pattern matching', () => {
    expect(matchKabooModelPricing('claude-fable-5')).toMatchObject({
      pattern: 'claude-fable-5%',
      displayName: 'Claude Fable 5',
      inputPricePerMTok: 10,
      outputPricePerMTok: 50,
      cacheReadPricePerMTok: 1,
      cacheCreationPricePerMTok: 12.5,
      reasoningPricePerMTok: 50,
    });
    expect(matchKabooModelPricing('claude-opus-5')).toMatchObject({
      pattern: 'claude-opus-5%',
      displayName: 'Claude Opus 5',
      inputPricePerMTok: 5,
      outputPricePerMTok: 25,
      cacheReadPricePerMTok: 0.5,
      cacheCreationPricePerMTok: 6.25,
      reasoningPricePerMTok: 25,
    });
    expect(matchKabooModelPricing('claude-opus-5-5[1m]')).toMatchObject({
      pattern: 'claude-opus-5-5%',
      displayName: 'Claude Opus 5.5',
      inputPricePerMTok: 4,
      outputPricePerMTok: 20,
      cacheReadPricePerMTok: 0.2,
      cacheCreationPricePerMTok: 5,
      reasoningPricePerMTok: 20,
    });
    expect(matchKabooModelPricing('claude-sonnet-5')).toMatchObject({
      pattern: 'claude-sonnet-5%',
      displayName: 'Claude Sonnet 5',
      inputPricePerMTok: 2,
      outputPricePerMTok: 10,
      cacheReadPricePerMTok: 0.2,
      cacheCreationPricePerMTok: 2.5,
      reasoningPricePerMTok: 10,
    });
    expect(matchKabooModelPricing('claude-sonnet-5-5-20260101')).toMatchObject({
      pattern: 'claude-sonnet-5-5%',
      displayName: 'Claude Sonnet 5.5',
      inputPricePerMTok: 2,
      outputPricePerMTok: 10,
      cacheReadPricePerMTok: 0.1,
      cacheCreationPricePerMTok: 2.5,
      reasoningPricePerMTok: 10,
    });

    expect(
      matchKabooModelPricing('claude-sonnet-5-5')?.cacheReadPricePerMTok,
    ).toBe(0.1);
    expect(
      matchKabooModelPricing('claude-sonnet-5')?.cacheReadPricePerMTok,
    ).toBe(0.2);
    expect(
      matchKabooModelPricing('claude-fable-5-1')?.cacheReadPricePerMTok,
    ).toBe(0.25);
    expect(
      matchKabooModelPricing('claude-fable-5')?.cacheReadPricePerMTok,
    ).toBe(1);

    expect(
      estimateKabooModelCostUSD('claude-sonnet-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        reasoningTokens: 1_000_000,
      }),
    ).toBe(24.6);

    expect(matchKabooModelPricing('unrelated-unknown-model')).toBeUndefined();
    expect(
      estimateKabooModelCostUSD('unrelated-unknown-model', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        reasoningTokens: 1_000_000,
      }),
    ).toBe(37.05);
  });

  test('prices Claude Fable 5.1 with its reduced cache-read rate', () => {
    const pricing = matchKabooModelPricing('claude-fable-5-1-20260901');
    expect(pricing).toMatchObject({
      pattern: 'claude-fable-5-1%',
      inputPricePerMTok: 10,
      outputPricePerMTok: 50,
      cacheReadPricePerMTok: 0.25,
      cacheCreationPricePerMTok: 12.5,
      reasoningPricePerMTok: 50,
    });

    expect(
      estimateKabooModelCostCents('claude-fable-5-1', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        reasoningTokens: 1_000_000,
      }),
    ).toBe(12_275);
  });

  test('prices all five token categories and rounds to cents once', () => {
    expect(
      estimateKabooModelCostCents('claude-opus-4-5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        reasoningTokens: 1_000_000,
      }),
    ).toBe(6_175);

    expect(
      estimateKabooModelCostCents('unlisted-model', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        reasoningTokens: 1_000_000,
      }),
    ).toBe(3_705);
    expect(matchKabooModelPricing('unlisted-model')).toBeUndefined();
    expect(KABOO_SONNET_FALLBACK.displayName).toBe('Claude Sonnet fallback');
  });

  test('uses Kaboo nearest-cent rounding', () => {
    expect(
      estimateKabooModelCostUSD('claude-sonnet-4-5', {
        inputTokens: 1_667,
      }),
    ).toBeCloseTo(0.005001);
    expect(
      estimateKabooModelCostCents('claude-sonnet-4-5', {
        inputTokens: 1_666,
      }),
    ).toBe(0);
    expect(
      estimateKabooModelCostCents('claude-sonnet-4-5', {
        inputTokens: 1_667,
      }),
    ).toBe(1);
  });

  test('clamps every token category to non-negative safe integers', () => {
    expect(
      normalizeKabooTokenUsage({
        inputTokens: -1,
        outputTokens: Number.NaN,
        cacheReadInputTokens: Number.NEGATIVE_INFINITY,
        cacheCreationInputTokens: 4.9,
        reasoningTokens: 2.2,
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 4,
      reasoningTokens: 2,
    });
  });
});

describe('Kaboo model attribution reconciliation', () => {
  test('uses an unknown row only when model usage is absent', () => {
    const priced = priceKabooUsageByModel({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 50_000,
      reasoningTokens: 25_000,
    });
    expect(priced.models).toHaveLength(1);
    expect(priced.models[0]).toMatchObject({
      model: 'unknown',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 50_000,
      reasoningTokens: 25_000,
    });
    expect(priced.usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 50_000,
      reasoningTokens: 25_000,
    });
  });

  test('rebuilds event usage from model rows instead of an inconsistent root', () => {
    const priced = priceKabooUsageByModel(
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadInputTokens: 200_000,
        cacheCreationInputTokens: 100_000,
        reasoningTokens: 0,
      },
      {
        'claude-opus-4-5': {
          inputTokens: 600_000,
          outputTokens: 60_000,
          cacheReadInputTokens: 50_000,
          cacheCreationInputTokens: 50_000,
        },
        'claude-haiku-4-5': {
          inputTokens: 200_000,
          outputTokens: 40_000,
          cacheReadInputTokens: 150_000,
          cacheCreationInputTokens: 25_000,
        },
      },
    );

    expect(
      priced.models.find((model) => model.model === 'unknown'),
    ).toBeUndefined();
    expect(priced.usage).toEqual({
      inputTokens: 800_000,
      outputTokens: 100_000,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 75_000,
      reasoningTokens: 0,
    });
    expect(priced.costCents).toBe(529);
    expect(priced.costUSD).toBe(5.29);
    for (const field of [
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
      'reasoningTokens',
    ] as const) {
      expect(priced.models.reduce((sum, model) => sum + model[field], 0)).toBe(
        priced.usage[field],
      );
    }
  });

  test('keeps sanitized model rows when result root under-reports them', () => {
    const priced = priceKabooUsageByModel(
      {
        inputTokens: 10,
        outputTokens: 7,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 3,
        reasoningTokens: 2,
      },
      {
        'model-a': {
          inputTokens: 8,
          outputTokens: 7,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          reasoningTokens: 2,
        },
        'model-b': {
          inputTokens: 5,
          outputTokens: 3,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 4,
          reasoningTokens: 4,
        },
      },
    );

    expect(
      priced.models.map(({ model, ...tokens }) => ({ model, ...tokens })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: 'model-a',
          inputTokens: 8,
          outputTokens: 7,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          reasoningTokens: 2,
        }),
        expect.objectContaining({
          model: 'model-b',
          inputTokens: 5,
          outputTokens: 3,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 4,
          reasoningTokens: 4,
        }),
      ]),
    );
  });
});
