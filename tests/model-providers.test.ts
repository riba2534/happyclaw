import { describe, expect, test } from 'vitest';

import {
  MAX_PROVIDER_MODELS,
  MODEL_PRESETS,
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_COPY,
  classifyProviderError,
  describeBaseUrlProblem,
  effectiveProviderModels,
  findPresetsByBaseUrl,
  getModelPreset,
  isValidModelId,
  mergeDiscoveredModels,
  modelCapabilities,
  modelsUrlFor,
  normalizeProviderBaseUrl,
  normalizeProviderModels,
  parseModelList,
  presetModelEntry,
  autoCompactWindowFor,
  keepsTwoHundredKWindow,
  buildConnectionModelEnv,
  launchModelName,
  normalizeConnectionModelRoles,
  resolveModelCapabilities,
  sortPresetsForRegion,
  splitOneMillionSuffix,
  withOneMillionSuffix,
} from '../shared/model-providers.js';

describe('model ids', () => {
  test('the [1m] suffix splits and joins like the runtime reads it', () => {
    expect(splitOneMillionSuffix(' glm-5.3[1M][1m] ')).toEqual({
      model: 'glm-5.3',
      oneMillion: true,
    });
    expect(withOneMillionSuffix('glm-5.3[1m]', false)).toBe('glm-5.3');
    expect(withOneMillionSuffix('glm-5.3', true)).toBe('glm-5.3[1m]');
    expect(withOneMillionSuffix('', true)).toBe('');
  });

  test('ids that would break an env file are refused', () => {
    expect(isValidModelId('deepseek-v4-pro')).toBe(true);
    expect(isValidModelId('z-ai/glm-5.2')).toBe(true);
    expect(isValidModelId('')).toBe(false);
    expect(isValidModelId('a b')).toBe(false);
    expect(isValidModelId('a\nANTHROPIC_BASE_URL=x')).toBe(false);
    expect(isValidModelId('x'.repeat(201))).toBe(false);
  });

  test('untrusted lists keep known fields, drop junk and duplicates', () => {
    expect(
      normalizeProviderModels([
        ' glm-5.3 ',
        { id: 'glm-5.3' },
        { id: 'glm-5.2', hidden: true, effort: 'max', extra: 1 },
        { id: 'glm-5.1', hidden: 'yes', effort: 'ultra' },
        { id: 'glm-5.0[1m]' },
        {
          id: 'glm-4.9',
          contextWindow: '262144',
          efforts: ['max', 'low', 'x'],
        },
        { id: 'glm-4.8', contextWindow: 12, defaultEffort: 'high' },
        { id: 'bad id' },
        42,
        null,
      ]),
    ).toEqual([
      { id: 'glm-5.3' },
      { id: 'glm-5.2', defaultEffort: 'max' },
      { id: 'glm-5.1' },
      { id: 'glm-5.0', contextWindow: 1_000_000 },
      { id: 'glm-4.9', contextWindow: 262_144, efforts: ['low', 'max'] },
      { id: 'glm-4.8', defaultEffort: 'high' },
    ]);
    expect(normalizeProviderModels('glm-5.3')).toBeNull();
    const many = Array.from({ length: MAX_PROVIDER_MODELS + 5 }, (_, i) => ({
      id: `m${i}`,
    }));
    expect(normalizeProviderModels(many)).toHaveLength(MAX_PROVIDER_MODELS);
  });

  test('a connection saved before model lists offers its one model', () => {
    expect(effectiveProviderModels({ anthropicModel: 'glm-5.3' })).toEqual([
      { id: 'glm-5.3' },
    ]);
    expect(effectiveProviderModels({ anthropicModel: '' })).toEqual([]);
  });

  test('the default model is always offered, without its [1m]', () => {
    expect(
      effectiveProviderModels({
        anthropicModel: 'glm-5.3[1m]',
        models: [{ id: 'glm-5.2' }],
      }),
    ).toEqual([{ id: 'glm-5.3', contextWindow: 1_000_000 }, { id: 'glm-5.2' }]);
    expect(
      effectiveProviderModels({
        anthropicModel: 'glm-5.3',
        models: [{ id: 'glm-5.2' }, { id: 'glm-5.3', hidden: true } as never],
      }),
    ).toEqual([{ id: 'glm-5.2' }, { id: 'glm-5.3' }]);
  });

  test('a refresh only adds, with what the vendor says about each', () => {
    const existing = [
      { id: 'glm-5.3', contextWindow: 1_000_000 },
      { id: 'glm-5.2' },
    ];
    const merged = mergeDiscoveredModels(existing, [
      'glm-5.3[1m]',
      'glm-5.2',
      {
        id: 'glm-5.4',
        contextWindow: 262_144,
        efforts: ['high', 'low'],
        defaultEffort: 'high',
      },
      ' glm-5.4 ',
      'bad id',
    ]);
    expect(merged.added).toEqual(['glm-5.4']);
    expect(merged.models).toEqual([
      ...existing,
      {
        id: 'glm-5.4',
        contextWindow: 262_144,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    ]);
  });

  test('a refresh never grows a list past the cap', () => {
    const existing = Array.from(
      { length: MAX_PROVIDER_MODELS - 1 },
      (_, i) => ({
        id: `m${i}`,
      }),
    );
    const merged = mergeDiscoveredModels(existing, ['n1', 'n2']);
    expect(merged.added).toEqual(['n1']);
    expect(merged.models).toHaveLength(MAX_PROVIDER_MODELS);
  });
});

describe('presets', () => {
  test('every preset is an Anthropic endpoint with usable models', () => {
    const ids = new Set<string>();
    for (const preset of MODEL_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(describeBaseUrlProblem(preset.baseUrl)).toBeNull();
      if (preset.editableBaseUrl) {
        // A gateway the user runs: its address is local, its models its own.
        expect(preset.gateway).toBeTruthy();
        expect(preset.models).toEqual([]);
        continue;
      }
      expect(normalizeProviderBaseUrl(preset.baseUrl)).toMatch(/^https:\/\//);
      expect(preset.models.length).toBeGreaterThan(0);
      for (const model of preset.models) {
        expect(isValidModelId(presetModelEntry(model).id)).toBe(true);
      }
      for (const url of [preset.keyUrl, preset.docsUrl, preset.modelsUrl]) {
        if (url) expect(url).toMatch(/^https:\/\//);
      }
    }
  });

  test('preset models carry their window, never a [1m] id', () => {
    expect(
      presetModelEntry({ id: 'glm-5.3', contextWindow: 1_048_576 }),
    ).toEqual({ id: 'glm-5.3', contextWindow: 1_048_576 });
    expect(presetModelEntry({ id: 'glm-5.3[1m]' })).toEqual({
      id: 'glm-5.3',
      contextWindow: 1_000_000,
    });
    expect(presetModelEntry({ id: 'ark-code-latest' })).toEqual({
      id: 'ark-code-latest',
    });
  });

  test('a base URL finds its preset regardless of case and trailing slash', () => {
    expect(
      findPresetsByBaseUrl('HTTPS://API.DEEPSEEK.COM/anthropic/').map(
        (preset) => preset.id,
      ),
    ).toEqual(['deepseek']);
    expect(findPresetsByBaseUrl('https://example.com/anthropic')).toEqual([]);
    expect(findPresetsByBaseUrl('not a url')).toEqual([]);
    expect(getModelPreset('deepseek')?.name).toBe('DeepSeek');
    expect(getModelPreset('nope')).toBeNull();
    expect(getModelPreset(null)).toBeNull();
  });

  test('a shared endpoint matches every preset on it', () => {
    expect(
      findPresetsByBaseUrl('https://open.bigmodel.cn/api/anthropic').length,
    ).toBeGreaterThan(1);
  });

  test('region only orders the list', () => {
    const cn = sortPresetsForRegion('cn');
    const global = sortPresetsForRegion('global');
    expect(cn).toHaveLength(MODEL_PRESETS.length);
    expect(global).toHaveLength(MODEL_PRESETS.length);
    expect(cn[0].region).toBe('cn');
    expect(global[0].region).toBe('global');
  });
});

describe('endpoints', () => {
  test('normalizes for comparison and refuses non-http URLs', () => {
    expect(
      normalizeProviderBaseUrl(' https://Api.Example.com/v1/?a=1#x '),
    ).toBe('https://api.example.com/v1');
    expect(normalizeProviderBaseUrl('ftp://example.com')).toBe('');
    expect(normalizeProviderBaseUrl('')).toBe('');
  });

  test('model lists live under /v1/models unless the path is versioned', () => {
    expect(modelsUrlFor('https://api.example.com/anthropic')).toBe(
      'https://api.example.com/anthropic/v1/models',
    );
    expect(modelsUrlFor('https://api.example.com/')).toBe(
      'https://api.example.com/v1/models',
    );
    expect(modelsUrlFor('https://api.example.com/api/v3')).toBe(
      'https://api.example.com/api/v3/models',
    );
    expect(
      modelsUrlFor(
        'https://api.deepseek.com/anthropic',
        getModelPreset('deepseek'),
      ),
    ).toBe('https://api.deepseek.com/models');
    expect(modelsUrlFor('nope')).toBe('');
  });

  test("a preset's model list URL is used only on the preset's own address", () => {
    const deepseek = getModelPreset('deepseek');
    expect(modelsUrlFor('https://API.deepseek.com/anthropic/', deepseek)).toBe(
      'https://api.deepseek.com/models',
    );
    // A relay that kept the preset id must not send its key to the vendor.
    expect(modelsUrlFor('https://relay.example.com/anthropic', deepseek)).toBe(
      'https://relay.example.com/anthropic/v1/models',
    );
  });

  test('warns about paths Claude Code would double', () => {
    expect(describeBaseUrlProblem('https://x.com/v1')).toMatch(/\/v1/);
    expect(describeBaseUrlProblem('https://x.com/v1/messages')).toMatch(/\/v1/);
    expect(describeBaseUrlProblem('https://x.com/anthropic')).toBeNull();
    expect(describeBaseUrlProblem('x.com')).toMatch(/http/);
    expect(describeBaseUrlProblem('')).toBeNull();
  });
});

describe('model list responses', () => {
  test('reads the OpenAI and Anthropic shapes', () => {
    expect(
      parseModelList({
        data: [
          {
            id: 'claude-sonnet-4-6',
            display_name: 'Claude Sonnet 4.6',
            max_input_tokens: 200_000,
          },
          { id: 'glm-5.3', context_length: 1_048_576 },
          { id: 'glm-5.3' },
        ],
      }),
    ).toEqual([
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        contextWindow: 200_000,
      },
      { id: 'glm-5.3', contextWindow: 1_048_576 },
    ]);
  });

  test('reads models arrays, bare strings and alternate id fields', () => {
    expect(
      parseModelList({ models: [{ slug: 'a' }, { model_id: 'b', name: 'B' }] }),
    ).toEqual([{ id: 'a' }, { id: 'b', name: 'B' }]);
    expect(parseModelList(['x', 'y', 'x', 'bad id', 3])).toEqual([
      { id: 'x' },
      { id: 'y' },
    ]);
  });

  test('ignores nonsense context windows', () => {
    expect(
      parseModelList({
        data: [
          { id: 'a', context_length: 0.5 },
          { id: 'b', context_length: 1e20 },
          { id: 'c', context_window: '128000' },
        ],
      }),
    ).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  test('tells "not a list" from "an empty list"', () => {
    expect(parseModelList({ data: [] })).toEqual([]);
    expect(parseModelList({ error: 'nope' })).toBeNull();
    expect(parseModelList('html')).toBeNull();
    expect(parseModelList(null)).toBeNull();
  });
});

describe('upstream errors', () => {
  const code = (input: Parameters<typeof classifyProviderError>[0]) =>
    classifyProviderError(input).code;

  test('network errors decide first', () => {
    expect(code({ networkErrorCode: 'ENOTFOUND', status: 401 })).toBe(
      'UPSTREAM_UNREACHABLE',
    );
    expect(code({ networkErrorCode: 'TimeoutError' })).toBe('TIMEOUT');
    expect(code({ networkErrorCode: 'EWHATEVER' })).toBe('UNKNOWN');
    expect(code({})).toBe('UNKNOWN');
  });

  test('statuses map to what the user should do next', () => {
    expect(code({ status: 401 })).toBe('AUTH_INVALID');
    expect(code({ status: 402 })).toBe('QUOTA_EXCEEDED');
    expect(code({ status: 403, bodyText: 'Invalid API key' })).toBe(
      'AUTH_INVALID',
    );
    expect(code({ status: 403, bodyText: 'region not allowed' })).toBe(
      'AUTH_FORBIDDEN',
    );
    expect(code({ status: 429 })).toBe('RATE_LIMITED');
    expect(code({ status: 529 })).toBe('RATE_LIMITED');
    expect(
      code({
        status: 429,
        bodyText: 'insufficient_quota: exceeded your quota',
      }),
    ).toBe('QUOTA_EXCEEDED');
    expect(code({ status: 404, bodyText: 'model: x not found' })).toBe(
      'MODEL_NOT_FOUND',
    );
    expect(code({ status: 404, bodyText: '<html>Not Found</html>' })).toBe(
      'ENDPOINT_NOT_FOUND',
    );
    expect(code({ status: 503 })).toBe('UPSTREAM_ERROR');
    expect(code({ status: 418 })).toBe('UNKNOWN');
  });

  test('400 bodies are read for the actual cause', () => {
    expect(
      code({ status: 400, bodyText: 'The model `x` does not exist' }),
    ).toBe('MODEL_NOT_FOUND');
    expect(
      code({ status: 400, bodyText: 'prompt is too long: 300000 tokens' }),
    ).toBe('CONTEXT_TOO_LONG');
    expect(code({ status: 400, bodyText: '账户余额不足' })).toBe(
      'QUOTA_EXCEEDED',
    );
    expect(code({ status: 400, bodyText: 'authentication_error' })).toBe(
      'AUTH_INVALID',
    );
    expect(
      code({ status: 422, bodyText: 'Extra inputs are not permitted' }),
    ).toBe('WIRE_INCOMPATIBLE');
    expect(code({ status: 400, bodyText: 'bad' })).toBe('UNKNOWN');
  });

  test('a valid key a gateway restricts is not called invalid', () => {
    expect(code({ status: 403, bodyText: '该令牌无权访问模型 kimi-k3' })).toBe(
      'AUTH_FORBIDDEN',
    );
    expect(code({ status: 403, bodyText: '该令牌无权使用模型：glm-5.3' })).toBe(
      'AUTH_FORBIDDEN',
    );
    expect(
      code({
        status: 400,
        bodyText: "Invalid 'max_tokens': integer below minimum value",
      }),
    ).toBe('UNKNOWN');
    expect(code({ status: 400, bodyText: '请求的令牌数超出模型上限' })).toBe(
      'CONTEXT_TOO_LONG',
    );
    expect(code({ status: 401, bodyText: '该令牌额度已用尽' })).toBe(
      'QUOTA_EXCEEDED',
    );
  });

  test('a bad credential is still recognized in its usual wordings', () => {
    for (const bodyText of [
      'invalid x-api-key',
      'Invalid API key provided',
      'invalid_api_key',
      'Invalid authentication token',
      'API key not valid. Please pass a valid API key.',
      '令牌无效',
      '无效的令牌',
      '鉴权失败',
    ]) {
      expect(code({ status: 403, bodyText }), bodyText).toBe('AUTH_INVALID');
    }
  });

  test('only transient failures are retryable', () => {
    expect(classifyProviderError({ status: 429 }).retryable).toBe(true);
    expect(classifyProviderError({ status: 502 }).retryable).toBe(true);
    expect(classifyProviderError({ status: 401 }).retryable).toBe(false);
  });

  test('every code has copy', () => {
    for (const each of PROVIDER_ERROR_CODES) {
      expect(PROVIDER_ERROR_COPY[each].title).toBeTruthy();
      expect(PROVIDER_ERROR_COPY[each].hint).toBeTruthy();
    }
  });
});

describe('model capabilities', () => {
  test('known models carry their window and efforts', () => {
    expect(modelCapabilities('claude-opus-5-5')).toMatchObject({
      name: 'Opus 5.5',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
    });
    expect(modelCapabilities('glm-5.3')?.efforts).toEqual([
      'low',
      'high',
      'max',
    ]);
    expect(modelCapabilities('DeepSeek-Flash[1m]')?.efforts).toEqual([
      'low',
      'high',
      'max',
    ]);
  });

  test('Claude Code aliases and vendor prefixes resolve', () => {
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable', 'default']) {
      expect(modelCapabilities(alias)?.efforts?.length, alias).toBeGreaterThan(
        0,
      );
    }
    expect(modelCapabilities('z-ai/glm-5.3')?.id).toBe('z-ai/glm-5.3');
    expect(modelCapabilities('deepseek/deepseek-v4-pro')).not.toBeNull();
  });

  test('a model without efforts offers none, and [1m] means a 1M window', () => {
    expect(modelCapabilities('claude-sonnet-4-5')?.efforts).toBeUndefined();
    expect(modelCapabilities('some-relay-model')).toBeNull();
    expect(modelCapabilities('some-relay-model[1m]')).toEqual({
      id: 'some-relay-model',
      contextWindow: 1_000_000,
    });
    expect(modelCapabilities('claude-haiku-4-5[1m]')?.contextWindow).toBe(
      1_000_000,
    );
    expect(modelCapabilities('')).toBeNull();
  });

  test('every listed effort is one Claude Code accepts', () => {
    for (const id of ['claude-opus-5-5', 'glm-5.3', 'kimi-k3', 'gpt-6-astra']) {
      const caps = modelCapabilities(id);
      for (const effort of caps?.efforts ?? []) {
        expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(effort);
      }
      if (caps?.defaultEffort)
        expect(caps.efforts).toContain(caps.defaultEffort);
    }
  });
});

describe('context window and [1m]', () => {
  test('only windows above 200K get [1m]', () => {
    expect(launchModelName('m', null)).toBe('m');
    expect(launchModelName('m', 128_000)).toBe('m');
    expect(launchModelName('m', 200_000)).toBe('m');
    expect(launchModelName('m', 262_144)).toBe('m[1m]');
    expect(launchModelName('m[1m]', 1_050_000)).toBe('m[1m]');
    expect(launchModelName('m[1m]', 128_000)).toBe('m');
  });

  test('the compact window is injected only where Claude Code would be wrong', () => {
    expect(autoCompactWindowFor(null)).toBeNull();
    expect(autoCompactWindowFor(200_000)).toBeNull();
    expect(autoCompactWindowFor(1_000_000)).toBeNull();
    expect(autoCompactWindowFor(1_050_000)).toBeNull();
    expect(autoCompactWindowFor(128_000)).toBe(128_000);
    expect(autoCompactWindowFor(262_144)).toBe(262_144);
  });
});

describe('connection model env', () => {
  const models = [
    { id: 'big', contextWindow: 262_144 },
    { id: 'small', contextWindow: 128_000 },
    { id: 'plain' },
  ];

  test('every tier follows the turn model unless a role names one', () => {
    expect(buildConnectionModelEnv({ model: 'big', models })).toEqual({
      ANTHROPIC_MODEL: 'big[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'big[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'big[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'big[1m]',
      CLAUDE_CODE_SUBAGENT_MODEL: 'big[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
    });
    expect(
      buildConnectionModelEnv({
        model: 'plain',
        models,
        roles: { smallFast: 'small', subagent: 'big' },
      }),
    ).toEqual({
      ANTHROPIC_MODEL: 'plain',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'plain',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'plain',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small',
      CLAUDE_CODE_SUBAGENT_MODEL: 'big[1m]',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    });
  });

  // Claude Code 2.1.323+ assumes 1M for a model it does not recognize.
  test('a launch without [1m] keeps the 200K ceiling next to its compact window', () => {
    expect(buildConnectionModelEnv({ model: 'small', models })).toMatchObject({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '128000',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    });
    expect(
      buildConnectionModelEnv({ model: 'big', models }),
    ).not.toHaveProperty('CLAUDE_CODE_DISABLE_1M_CONTEXT');
  });

  test('keepsTwoHundredKWindow', () => {
    expect(keepsTwoHundredKWindow('glm-5', null)).toBe(true);
    expect(keepsTwoHundredKWindow('glm-5', 128_000)).toBe(true);
    expect(keepsTwoHundredKWindow('glm-5[1m]', 262_144)).toBe(false);
    expect(keepsTwoHundredKWindow('anthropic/claude-opus-5-5', null)).toBe(
      false,
    );
    expect(keepsTwoHundredKWindow('opus', null)).toBe(false);
    expect(keepsTwoHundredKWindow('cursor/claude-opus-5-5@300k', null)).toBe(
      false,
    );
    // Only Claude's own families: a name merely containing "claude" is not
    // one Claude Code knows.
    expect(keepsTwoHundredKWindow('claude-distill-qwen-72b', null)).toBe(true);
    expect(keepsTwoHundredKWindow('myproxy/claude-coder', null)).toBe(true);
    for (const id of [
      'claude-mythos-5',
      'anthropic.claude-sonnet-5-5',
      'claude-haiku-4-5-20251001',
      'claude-3-7-sonnet-latest',
    ]) {
      expect(keepsTwoHundredKWindow(id, null)).toBe(false);
    }
    expect(keepsTwoHundredKWindow('claude-opus-5-5', 200_000)).toBe(true);
    expect(keepsTwoHundredKWindow('', null)).toBe(false);
  });

  test('a pass-through connection only gets the roles it names', () => {
    expect(buildConnectionModelEnv({ model: '', models })).toEqual({});
    expect(
      buildConnectionModelEnv({
        model: '',
        models,
        roles: { smallFast: 'small' },
      }),
    ).toEqual({ ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small' });
  });

  test('a choice saved with [1m] keeps its 1M window', () => {
    expect(
      buildConnectionModelEnv({ model: 'unknown-x[1m]', models: [] })
        .ANTHROPIC_MODEL,
    ).toBe('unknown-x[1m]');
  });

  test('roles naming a model the connection lacks are dropped', () => {
    expect(
      normalizeConnectionModelRoles(
        { subagent: 'big[1m]', smallFast: 'gone', opus: 3 },
        models,
      ),
    ).toEqual({ subagent: 'big' });
  });
});

describe('resolved capabilities', () => {
  test('declared efforts win, else the registry, else the family', () => {
    expect(
      resolveModelCapabilities({ id: 'mystery', efforts: ['low', 'high'] }),
    ).toMatchObject({
      efforts: ['low', 'high'],
      effortsSource: 'declared',
      defaultEffort: 'high',
    });
    expect(resolveModelCapabilities({ id: 'gpt-6.1-sol' })).toMatchObject({
      effortsSource: 'registry',
      defaultEffort: 'medium',
    });
    const terra = resolveModelCapabilities({ id: 'codex/gpt-6.1-terra' });
    expect(terra.effortsSource).toBe('family');
    expect(terra.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(terra.defaultEffort).toBe('medium');
    expect(resolveModelCapabilities({ id: 'mystery' })).toEqual({
      contextWindow: null,
      suggestedContextWindow: null,
      efforts: [],
      defaultEffort: null,
      effortsSource: 'none',
      contextSource: 'none',
      thinkingDisabled: false,
    });
  });

  test('the default effort is never max unless that is all there is', () => {
    expect(
      resolveModelCapabilities({ id: 'x', efforts: ['high', 'max'] })
        .defaultEffort,
    ).toBe('high');
    expect(
      resolveModelCapabilities({ id: 'x', efforts: ['max'] }).defaultEffort,
    ).toBe('max');
    expect(
      resolveModelCapabilities({
        id: 'x',
        efforts: ['low', 'max'],
        defaultEffort: 'max',
      }).defaultEffort,
    ).toBe('max');
  });

  test('only a declared window is used; the registry only suggests', () => {
    expect(
      resolveModelCapabilities({ id: 'gpt-6.1-sol', contextWindow: 272_000 }),
    ).toMatchObject({ contextWindow: 272_000, contextSource: 'declared' });
    expect(resolveModelCapabilities({ id: 'gpt-6.1-sol' })).toMatchObject({
      contextWindow: null,
      suggestedContextWindow: 1_050_000,
      contextSource: 'none',
    });
    // A registry window never adds [1m] at launch.
    expect(
      buildConnectionModelEnv({ model: 'claude-opus-5-5', models: [] })
        .ANTHROPIC_MODEL,
    ).toBe('claude-opus-5-5');
  });

  test('family inference lends efforts only, and Claude only within a variant', () => {
    const terra = resolveModelCapabilities({ id: 'codex/gpt-6.1-terra' });
    expect(terra.contextWindow).toBeNull();
    expect(terra.suggestedContextWindow).toBeNull();
    expect(
      resolveModelCapabilities({ id: 'claude-haiku-9-9' }).effortsSource,
    ).toBe('family');
    // No haiku-4-5 efforts are borrowed from opus-4-5.
    expect(
      resolveModelCapabilities({ id: 'claude-haiku-4-5' }).effortsSource,
    ).toBe('none');
  });
});

describe('vendor efforts in a model list', () => {
  test('the spellings vendors use are read; minimal and ultra are dropped', () => {
    expect(
      parseModelList({
        data: [
          {
            id: 'a',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'high' },
              { effort: 'ultra' },
            ],
            default_reasoning_level: 'high',
          },
          {
            id: 'b',
            reasoning: {
              supported_efforts: ['minimal', 'medium'],
              default_effort: 'minimal',
            },
          },
          { id: 'c' },
        ],
      }),
    ).toEqual([
      { id: 'a', efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: 'b', efforts: ['medium'] },
      { id: 'c' },
    ]);
  });
});
