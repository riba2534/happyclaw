import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabledProvidersByPool: new Map<string, Array<{ id: string }>>(),
}));

const modelOptions = [
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'opus',
    model_kind: 'alias',
    display_name: 'Opus',
    source: 'admin_configured',
    status: 'available',
    metadata_json: JSON.stringify({
      resolved_model: 'claude-opus-4-20260401',
    }),
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'fast',
    model_kind: 'alias',
    display_name: 'Claude Fast',
    source: 'admin_configured',
    status: 'available',
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'codex',
    provider_family: 'gpt',
    provider_pool_id: 'gpt',
    model_id: 'gpt-5.5',
    model_kind: 'explicit_version',
    display_name: 'GPT-5.5',
    source: 'admin_configured',
    status: 'available',
    metadata_json: JSON.stringify({
      resolved_model: 'gpt-5.5',
    }),
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'codex',
    provider_family: 'gpt',
    provider_pool_id: 'gpt',
    model_id: 'fast',
    model_kind: 'alias',
    display_name: 'GPT Fast',
    source: 'admin_configured',
    status: 'available',
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'codex',
    provider_family: 'gpt',
    provider_pool_id: 'gpt',
    model_id: 'gpt-legacy-hidden',
    model_kind: 'explicit_version',
    display_name: 'GPT Legacy Hidden',
    source: 'admin_configured',
    status: 'hidden',
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
  {
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    model_id: 'claude-retired',
    model_kind: 'explicit_version',
    display_name: 'Claude Retired',
    source: 'admin_configured',
    status: 'unsupported',
    metadata_json: null,
    updated_by: 'test',
    updated_at: '2026-04-25T00:00:00.000Z',
  },
];

vi.mock('../src/db.js', () => ({
  getProviderPools: () => [
    {
      provider_pool_id: 'claude',
      display_name: 'Claude',
      runtime: 'claude',
      provider_family: 'claude',
      enabled: true,
    },
    {
      provider_pool_id: 'gpt',
      display_name: 'GPT',
      runtime: 'codex',
      provider_family: 'gpt',
      enabled: true,
    },
  ],
  getProviderPool: (providerPoolId: string) =>
    providerPoolId === 'claude'
      ? {
          provider_pool_id: 'claude',
          display_name: 'Claude',
          runtime: 'claude',
          provider_family: 'claude',
          enabled: true,
        }
      : providerPoolId === 'gpt'
        ? {
            provider_pool_id: 'gpt',
            display_name: 'GPT',
            runtime: 'codex',
            provider_family: 'gpt',
            enabled: true,
          }
      : null,
  listProviderPoolModelOptions: (_providerPoolId?: string, includeAll = false) =>
    includeAll
      ? modelOptions
      : modelOptions.filter((option) => option.status !== 'hidden'),
}));

vi.mock('../src/runtime-config.js', () => ({
  getEnabledProvidersForPool: (providerPoolId: string) =>
    mocks.enabledProvidersByPool.get(providerPoolId) || [],
}));

import {
  formatModelList,
  parseModelBindingFromArgs,
} from '../src/model-command.js';

describe('model command parsing', () => {
  beforeEach(() => {
    mocks.enabledProvidersByPool.clear();
    mocks.enabledProvidersByPool.set('claude', [{ id: 'claude-provider' }]);
    mocks.enabledProvidersByPool.set('gpt', [{ id: 'gpt-provider' }]);
  });

  it('carries resolved model metadata into the binding key material', () => {
    const result = parseModelBindingFromArgs(['claude', 'opus']);

    expect(result.error).toBeUndefined();
    expect(result.binding).toMatchObject({
      provider_pool_id: 'claude',
      selected_model: 'opus',
      model_kind: 'alias',
      resolved_model: 'claude-opus-4-20260401',
    });
  });

  it('selects a GPT pool explicit model without naming a provider', () => {
    const result = parseModelBindingFromArgs(['gpt', 'gpt-5.5']);

    expect(result.error).toBeUndefined();
    expect(result.binding).toMatchObject({
      runtime: 'codex',
      provider_family: 'gpt',
      provider_pool_id: 'gpt',
      selected_model: 'gpt-5.5',
      model_kind: 'explicit_version',
      resolved_model: 'gpt-5.5',
    });
  });

  it('uses the provider default for an enabled GPT pool', () => {
    const result = parseModelBindingFromArgs(['gpt']);

    expect(result.error).toBeUndefined();
    expect(result.binding).toMatchObject({
      runtime: 'codex',
      provider_family: 'gpt',
      provider_pool_id: 'gpt',
      selected_model: null,
      model_kind: 'provider_default',
      resolved_model: null,
    });
  });

  it('rejects ambiguous model names that exist in multiple pools', () => {
    const result = parseModelBindingFromArgs(['fast']);

    expect(result.binding).toBeUndefined();
    expect(result.error).toContain('多个模型池');
  });

  it('rejects a pool without an enabled auth provider', () => {
    mocks.enabledProvidersByPool.set('gpt', []);

    const result = parseModelBindingFromArgs(['gpt', 'gpt-5.5']);

    expect(result.binding).toBeUndefined();
    expect(result.error).toContain('没有启用的鉴权供应商');
  });

  it('lists Claude and GPT pool options together', () => {
    const output = formatModelList();

    expect(output).toContain('Claude (claude)');
    expect(output).toContain('opus - Opus (alias, available)');
    expect(output).toContain('GPT (gpt)');
    expect(output).toContain('gpt-5.5 - GPT-5.5 (explicit_version, available)');
    expect(output).not.toContain('Claude Retired');
    expect(output).not.toContain('GPT Legacy Hidden');
  });

  it('supports /model list --all style output for hidden options', () => {
    const output = formatModelList(true);

    expect(output).toContain('模型目录（含隐藏/不可用）');
    expect(output).toContain(
      'gpt-legacy-hidden - GPT Legacy Hidden (explicit_version, hidden)',
    );
    expect(output).toContain(
      'claude-retired - Claude Retired (explicit_version, unsupported)',
    );
  });
});
