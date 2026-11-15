import { describe, expect, test } from 'vitest';

import {
  buildConnectionModelEnv,
  carrySyncedModelFields,
  discoveredModelEntry,
  getModelPreset,
  isMagpieAliasModelId,
  isMagpieModelList,
  isMagpieUsageLimitMessage,
  magpieUsageLimitResetAt,
  maxOutputTokensFor,
  mergeDiscoveredModels,
  normalizeEfforts,
  normalizeProviderModels,
  parseMagpieQuotas,
  parseModelList,
  resolveModelCapabilities,
  toolSearchEnabled,
} from '../shared/model-providers.js';
import {
  magpieModelList,
  magpieQuotas,
  magpieUsageLimitBody,
} from './fixtures/magpie.js';

describe('efforts: declared none versus unknown', () => {
  test('an empty list is a declaration, a list of unknown spellings is not', () => {
    expect(normalizeEfforts([])).toEqual([]);
    expect(normalizeEfforts(['minimal', 'none'])).toBeUndefined();
    expect(normalizeEfforts(['high', 'low', 'high'])).toEqual(['low', 'high']);
    expect(normalizeEfforts(undefined)).toBeUndefined();
  });

  test('a stored empty list survives, and drops a default effort', () => {
    expect(
      normalizeProviderModels([
        { id: 'a', efforts: [], defaultEffort: 'high' },
        { id: 'b' },
      ]),
    ).toEqual([{ id: 'a', efforts: [] }, { id: 'b' }]);
  });

  test('declared none turns thinking off unless the model thinks', () => {
    const none = resolveModelCapabilities({ id: 'mystery', efforts: [] });
    expect(none).toMatchObject({
      efforts: [],
      effortsSource: 'declared',
      defaultEffort: null,
      thinkingDisabled: true,
    });
    expect(
      resolveModelCapabilities({ id: 'mystery', efforts: [], thinks: true }),
    ).toMatchObject({ effortsSource: 'declared', thinkingDisabled: false });
    expect(resolveModelCapabilities({ id: 'mystery' })).toMatchObject({
      efforts: [],
      effortsSource: 'none',
      thinkingDisabled: false,
    });
    // A declaration outranks the registry, an empty one too.
    expect(
      resolveModelCapabilities({ id: 'claude-opus-5-5', efforts: [] }),
    ).toMatchObject({ efforts: [], thinkingDisabled: true });
  });
});

describe('magpie model lists', () => {
  test('rows carry the name, the reply limit, the vendor and the label', () => {
    const models = parseModelList(magpieModelList())!;
    expect(isMagpieModelList(models)).toBe(true);
    expect(models.find((model) => model.id === 'codex/gpt-5.6-sol')).toEqual({
      id: 'codex/gpt-5.6-sol',
      name: 'GPT-5.6-Sol',
      contextWindow: 400_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      thinks: true,
      maxOutputTokens: 128_000,
      vendor: 'Codex',
      magpieLabel: 'GPT-5.6-Sol · Codex',
    });
    // `reasoning: true` with no levels: no effort, but it reasons.
    expect(models.find((model) => model.id === 'relaya/glm-5')).toMatchObject({
      efforts: [],
      thinks: true,
      vendor: 'Relay A',
    });
    expect(
      models.find((model) => model.id === 'relaya/deepseek-chat'),
    ).toMatchObject({ efforts: [] });
    expect(
      models.find((model) => model.id === 'relaya/deepseek-chat')?.thinks,
    ).toBeUndefined();
  });

  test('a list without magpie labels is not magpie', () => {
    const models = parseModelList({
      data: [{ id: 'gpt-5.5', owned_by: 'openai', max_completion_tokens: 9 }],
    })!;
    expect(isMagpieModelList(models)).toBe(false);
    expect(models[0]).toEqual({
      id: 'gpt-5.5',
      vendor: 'openai',
      maxOutputTokens: 9,
    });
    // OpenRouter names the reply limit under top_provider.
    expect(
      parseModelList({
        data: [{ id: 'x/y', top_provider: { max_completion_tokens: 65_536 } }],
      })![0].maxOutputTokens,
    ).toBe(65_536);
  });

  test("Claude Code's discovery aliases never become entries", () => {
    const listed = parseModelList(magpieModelList({ forClaudeCode: true }))!;
    expect(listed.some((model) => isMagpieAliasModelId(model.id))).toBe(true);
    expect(isMagpieAliasModelId('anthropic/magpie-12')).toBe(true);
    expect(isMagpieAliasModelId('anthropic/magpie-12[1m]')).toBe(true);
    expect(isMagpieAliasModelId('anthropic/claude-opus-5-5')).toBe(false);
    expect(discoveredModelEntry('anthropic/magpie-3')).toBeNull();
    const { models, added } = mergeDiscoveredModels([], listed);
    expect(added.some(isMagpieAliasModelId)).toBe(false);
    expect(models.map((entry) => entry.id)).toEqual(['claude/claude-opus-5-5']);
  });

  test('a discovered model joins with what the vendor said about it', () => {
    const { models } = mergeDiscoveredModels(
      [{ id: 'codex/gpt-5.6-sol', contextWindow: 200_000 }],
      parseModelList(magpieModelList())!,
    );
    expect(models[0]).toEqual({
      id: 'codex/gpt-5.6-sol',
      contextWindow: 200_000,
    });
    expect(models.find((entry) => entry.id === 'relaya/glm-5')).toEqual({
      id: 'relaya/glm-5',
      displayName: 'GLM-5',
      contextWindow: 202_752,
      efforts: [],
      thinks: true,
      maxOutputTokens: 131_072,
      vendor: 'Relay A',
    });
  });

  test('an admin edit keeps the fields the sync owns', () => {
    const current = [
      {
        id: 'a',
        displayName: 'A',
        maxOutputTokens: 64_000,
        vendor: 'V',
        upstreamMissingSince: '2026-01-01T00:00:00.000Z',
        synced: { contextWindow: 200_000 },
      },
    ];
    expect(
      carrySyncedModelFields(
        [{ id: 'a', contextWindow: 300_000 }, { id: 'b' }],
        current,
      ),
    ).toEqual([{ ...current[0], contextWindow: 300_000 }, { id: 'b' }]);
  });
});

describe('the launch reply limit', () => {
  const models = [
    { id: 'big', maxOutputTokens: 200_000 },
    { id: 'mid', maxOutputTokens: 64_000 },
    { id: 'small', maxOutputTokens: 16_000 },
    { id: 'silent' },
  ];

  test('the smallest declared limit of every model the launch may use, capped', () => {
    expect(maxOutputTokensFor(models, 'big', {})).toBe(128_000);
    expect(maxOutputTokensFor(models, 'big[1m]', { subagent: 'mid' })).toBe(
      64_000,
    );
    // Not above Claude Code's own 32K: nothing to raise.
    expect(maxOutputTokensFor(models, 'big', { smallFast: 'small' })).toBe(
      null,
    );
    // One model declares nothing: it might refuse a longer request.
    expect(maxOutputTokensFor(models, 'big', { opus: 'silent' })).toBe(null);
    expect(maxOutputTokensFor(models, '', {})).toBe(null);
  });

  test('buildConnectionModelEnv writes it', () => {
    expect(
      buildConnectionModelEnv({ model: 'mid', models, roles: {} })
        .CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    ).toBe('64000');
    expect(
      buildConnectionModelEnv({ model: 'silent', models, roles: {} })
        .CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    ).toBeUndefined();
  });
});

describe('magpie preset and settings', () => {
  test('the preset is a gateway on a local, editable address', () => {
    expect(getModelPreset('magpie')).toMatchObject({
      name: 'Magpie',
      baseUrl: 'http://127.0.0.1:3425',
      docsUrl: 'https://usemagpie.ai/docs/integrate',
      models: [],
      editableBaseUrl: true,
      gateway: 'magpie',
    });
  });

  test('tool search is on by default for magpie only', () => {
    expect(toolSearchEnabled('default', 'magpie')).toBe(true);
    expect(toolSearchEnabled(undefined, null)).toBe(false);
    expect(toolSearchEnabled('off', 'magpie')).toBe(false);
    expect(toolSearchEnabled('on', null)).toBe(true);
  });
});

describe('magpie quotas', () => {
  const now = Date.parse('2026-11-15T12:00:00.000Z');

  test('the answer is read into accounts and windows', () => {
    const accounts = parseMagpieQuotas(magpieQuotas(now))!;
    expect(accounts).toHaveLength(4);
    expect(accounts[0]).toMatchObject({
      provider: 'codex',
      name: 'Codex · work',
      kind: 'subscription',
      windows: [
        { name: '5h', remaining: 0, unlimited: false },
        { name: 'weekly', remaining: 60 },
      ],
    });
    expect(accounts[3].error).toBe('token expired');
    expect(parseMagpieQuotas({ error: 'nope' })).toBeNull();
  });

  test("a model's wait is the earliest renewal of its provider's spent windows", () => {
    const accounts = parseMagpieQuotas(magpieQuotas(now))!;
    expect(magpieUsageLimitResetAt(accounts, 'codex/gpt-5.6-sol')).toBe(
      now + 3_600_000,
    );
    // Nothing guessed: routing groups, auto, unlimited or unreadable accounts.
    expect(magpieUsageLimitResetAt(accounts, 'group/fast')).toBeNull();
    expect(magpieUsageLimitResetAt(accounts, 'auto/gpt-5.6-sol')).toBeNull();
    expect(magpieUsageLimitResetAt(accounts, 'relaya/glm-5')).toBeNull();
    expect(
      magpieUsageLimitResetAt(accounts, 'claude/claude-opus-5-5'),
    ).toBeNull();
    expect(magpieUsageLimitResetAt(accounts, 'gpt-5.6-sol')).toBeNull();
  });

  test("magpie's usage-limit wording is recognized", () => {
    const body = magpieUsageLimitBody('codex/gpt-5.6-sol');
    expect(
      isMagpieUsageLimitMessage(
        `API Error: Request rejected (429) · ${body.error.message}`,
      ),
    ).toBe(true);
    expect(
      isMagpieUsageLimitMessage(
        'API Error: Request rejected (429) · slow down',
      ),
    ).toBe(false);
    expect(isMagpieUsageLimitMessage(undefined)).toBe(false);
  });
});
