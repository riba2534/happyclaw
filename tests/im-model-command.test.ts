import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabledProvidersByPool: new Map<string, Array<{ id: string }>>(),
}));

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
        : undefined,
  listProviderPoolModelOptions: () => [
    {
      runtime: 'claude',
      provider_family: 'claude',
      provider_pool_id: 'claude',
      model_id: 'opus',
      model_kind: 'alias',
      display_name: 'Opus',
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
      metadata_json: JSON.stringify({ resolved_model: 'gpt-5.5' }),
      updated_by: 'test',
      updated_at: '2026-04-25T00:00:00.000Z',
    },
  ],
}));

vi.mock('../src/runtime-config.js', () => ({
  getEnabledProvidersForPool: (providerPoolId: string) =>
    mocks.enabledProvidersByPool.get(providerPoolId) || [],
}));

import { handleModelCommandForTarget } from '../src/im-model-command.js';

function deps() {
  return {
    ensureConversationRuntimeState: vi.fn((groupFolder, agentId, updatedBy) => ({
      group_folder: groupFolder,
      agent_id: agentId || '',
      runtime: 'claude',
      provider_family: 'claude',
      provider_pool_id: 'claude',
      selected_model: null,
      model_kind: 'provider_default',
      resolved_model: null,
      binding_source: 'workspace_default',
      binding_revision: 7,
      active_runtime: null,
      active_provider_family: null,
      active_provider_pool_id: null,
      active_selected_model: null,
      active_model_kind: null,
      active_resolved_model: null,
      pending_runtime: null,
      pending_provider_family: null,
      pending_provider_pool_id: null,
      pending_selected_model: null,
      pending_model_kind: null,
      pending_resolved_model: null,
      updated_by: updatedBy,
      updated_at: '2026-04-25T00:00:00.000Z',
    })),
    setConversationRuntimeBinding: vi.fn(
      (groupFolder, agentId, binding, bindingSource, updatedBy) => ({
        group_folder: groupFolder,
        agent_id: agentId || '',
        ...binding,
        binding_source: bindingSource,
        binding_revision: 8,
        active_runtime: null,
        active_provider_family: null,
        active_provider_pool_id: null,
        active_selected_model: null,
        active_model_kind: null,
        active_resolved_model: null,
        pending_runtime: binding.runtime,
        pending_provider_family: binding.provider_family,
        pending_provider_pool_id: binding.provider_pool_id,
        pending_selected_model: binding.selected_model,
        pending_model_kind: binding.model_kind,
        pending_resolved_model: binding.resolved_model,
        updated_by: updatedBy,
        updated_at: '2026-04-25T00:00:00.000Z',
      }),
    ),
    broadcastModelChanged: vi.fn(),
    startModelSwitch: vi.fn(),
  };
}

describe('IM model command target execution', () => {
  beforeEach(() => {
    mocks.enabledProvidersByPool.clear();
    mocks.enabledProvidersByPool.set('claude', [{ id: 'claude-provider' }]);
    mocks.enabledProvidersByPool.set('gpt', [{ id: 'gpt-provider' }]);
  });

  it('switches a bound workspace target without an owner-only check', () => {
    const d = deps();
    const reply = handleModelCommandForTarget({
      rawArgs: 'use gpt gpt-5.5',
      target: {
        baseChatJid: 'web:flow',
        targetChatJid: 'web:flow',
        folder: 'flow',
        agentId: '',
        locationLine: 'Flow',
      },
      actor: 'im:ou-test',
      defaultUpdatedBy: 'owner-user',
      deps: d,
    });

    expect(reply).toContain('正在切换 Flow 的模型为 gpt gpt-5.5');
    expect(d.startModelSwitch).toHaveBeenCalledWith({
      target: expect.objectContaining({
        baseChatJid: 'web:flow',
        targetChatJid: 'web:flow',
        folder: 'flow',
        agentId: '',
      }),
      actor: 'im:ou-test',
      binding: expect.objectContaining({
        runtime: 'codex',
        provider_pool_id: 'gpt',
        selected_model: 'gpt-5.5',
      }),
    });
    expect(d.setConversationRuntimeBinding).not.toHaveBeenCalled();
  });

  it('switches a thread-map conversation agent target', () => {
    const d = deps();
    const reply = handleModelCommandForTarget({
      rawArgs: 'use claude opus',
      target: {
        baseChatJid: 'web:flow',
        targetChatJid: 'web:flow#agent:agent-thread-1',
        folder: 'flow',
        agentId: 'agent-thread-1',
        locationLine: 'Flow / Thread Agent',
      },
      actor: 'im:ou-test',
      defaultUpdatedBy: 'owner-user',
      deps: d,
    });

    expect(reply).toContain('Flow / Thread Agent');
    expect(d.startModelSwitch).toHaveBeenCalledWith({
      target: expect.objectContaining({
        baseChatJid: 'web:flow',
        targetChatJid: 'web:flow#agent:agent-thread-1',
        folder: 'flow',
        agentId: 'agent-thread-1',
      }),
      actor: 'im:ou-test',
      binding: expect.objectContaining({
        runtime: 'claude',
        provider_pool_id: 'claude',
        selected_model: 'opus',
      }),
    });
  });

  it('reports the target state for /model without mutating bindings', () => {
    const d = deps();
    const reply = handleModelCommandForTarget({
      rawArgs: '',
      target: {
        baseChatJid: 'web:flow',
        targetChatJid: 'web:flow',
        folder: 'flow',
        agentId: '',
        locationLine: 'Flow',
      },
      actor: 'im:ou-test',
      defaultUpdatedBy: 'owner-user',
      deps: d,
    });

    expect(reply).toContain('当前模型：default');
    expect(reply).toContain('作用域：Flow');
    expect(reply).toContain('版本：7');
    expect(d.setConversationRuntimeBinding).not.toHaveBeenCalled();
  });
});
