import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setWorkspaceModelDefault: vi.fn(),
  setConversationRuntimeBinding: vi.fn(),
  upsertProviderPoolModelOption: vi.fn(),
  getConversationRuntimeState: vi.fn(),
  getJidsByFolder: vi.fn(),
}));

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'owner-user',
      username: 'owner',
      role: 'user',
      status: 'active',
      display_name: 'Owner',
      permissions: [],
      must_change_password: false,
    });
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
}));

vi.mock('../src/web-context.js', () => ({
  canAccessGroup: vi.fn(() => true),
  canModifyGroup: vi.fn(() => true),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/model-switch-handoff.js', () => ({
  createModelSwitchHandoffSummary: vi.fn(async (input) => ({
    id: 'handoff-summary-1',
    group_folder: input.groupFolder,
    agent_id: input.agentId || '',
    chat_jid: input.chatJid,
    reason: input.reason || 'model_binding_changed',
    summary_text: '切换摘要',
    source_message_count: 3,
    source_first_message_id: 'm1',
    source_last_message_id: 'm3',
    source_last_message_timestamp: '2026-04-25T00:00:00.000Z',
    fallback_used: false,
    created_by: input.createdBy || null,
    created_at: '2026-04-25T00:00:00.000Z',
  })),
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
    providerPoolId === 'gpt'
      ? {
          provider_pool_id: 'gpt',
          display_name: 'GPT',
          runtime: 'codex',
          provider_family: 'gpt',
          enabled: true,
        }
      : providerPoolId === 'claude'
        ? {
            provider_pool_id: 'claude',
            display_name: 'Claude',
            runtime: 'claude',
            provider_family: 'claude',
            enabled: true,
          }
        : undefined,
  listProviderPoolModelOptions: () => [
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
  getRegisteredGroup: (jid: string) =>
    jid === 'web:flow'
      ? {
          name: 'Flow',
          folder: 'flow',
          added_at: '2026-04-25T00:00:00.000Z',
          created_by: 'owner-user',
        }
      : undefined,
  getJidsByFolder: mocks.getJidsByFolder,
  getSystemModelDefault: () => ({
    id: 'global',
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    selected_model: null,
    model_kind: 'provider_default',
    resolved_model: null,
    updated_by: 'system',
    updated_at: '2026-04-25T00:00:00.000Z',
  }),
  setSystemModelDefault: vi.fn((binding, updatedBy) => ({
    id: 'global',
    ...binding,
    updated_by: updatedBy,
    updated_at: '2026-04-25T00:00:00.000Z',
  })),
  ensureWorkspaceModelDefault: vi.fn((groupFolder, updatedBy) => ({
    group_folder: groupFolder,
    runtime: 'claude',
    provider_family: 'claude',
    provider_pool_id: 'claude',
    selected_model: null,
    model_kind: 'provider_default',
    resolved_model: null,
    updated_by: updatedBy,
    updated_at: '2026-04-25T00:00:00.000Z',
  })),
  getConversationRuntimeState: mocks.getConversationRuntimeState,
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
    updated_by: updatedBy,
    updated_at: '2026-04-25T00:00:00.000Z',
  })),
  setWorkspaceModelDefault: mocks.setWorkspaceModelDefault,
  setConversationRuntimeBinding: mocks.setConversationRuntimeBinding,
  upsertProviderPoolModelOption: mocks.upsertProviderPoolModelOption,
}));

import modelRoutes from '../src/routes/model.js';

function jsonRequest(pathname: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('model routes', () => {
  beforeEach(() => {
    mocks.setWorkspaceModelDefault.mockReset();
    mocks.setConversationRuntimeBinding.mockReset();
    mocks.upsertProviderPoolModelOption.mockReset();
    mocks.getConversationRuntimeState.mockReset();
    mocks.getJidsByFolder.mockReset();

    mocks.getJidsByFolder.mockReturnValue(['web:flow', 'feishu:chat']);
    mocks.getConversationRuntimeState.mockReturnValue({
      group_folder: 'flow',
      agent_id: '',
      runtime: 'claude',
      provider_family: 'claude',
      provider_pool_id: 'claude',
      selected_model: null,
      model_kind: 'provider_default',
      resolved_model: null,
      binding_source: 'workspace_default',
    });
    mocks.setWorkspaceModelDefault.mockImplementation(
      (groupFolder, binding, updatedBy) => ({
        group_folder: groupFolder,
        ...binding,
        updated_by: updatedBy,
      }),
    );
    mocks.setConversationRuntimeBinding.mockImplementation(
      (groupFolder, agentId, binding, bindingSource, updatedBy) => ({
        group_folder: groupFolder,
        agent_id: agentId || '',
        ...binding,
        binding_source: bindingSource,
        updated_by: updatedBy,
      }),
    );
    mocks.upsertProviderPoolModelOption.mockImplementation((option) => option);
  });

  it('stores pool-level model options', async () => {
    const res = await modelRoutes.request(
      jsonRequest('/pools/gpt/options', 'PUT', {
        modelId: 'gpt-5.6',
        modelKind: 'explicit_version',
        displayName: 'GPT-5.6',
        status: 'unverified',
        metadataJson: JSON.stringify({ resolved_model: 'gpt-5.6' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.upsertProviderPoolModelOption).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: 'codex',
        provider_family: 'gpt',
        provider_pool_id: 'gpt',
        model_id: 'gpt-5.6',
        model_kind: 'explicit_version',
      }),
    );
  });

  it('changes workspace default and updates main only while it follows workspace default', async () => {
    const res = await modelRoutes.request(
      jsonRequest('/workspaces/web:flow/default', 'PUT', {
        providerPoolId: 'gpt',
        model: 'gpt-5.5',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.setWorkspaceModelDefault).toHaveBeenCalledWith(
      'flow',
      expect.objectContaining({
        runtime: 'codex',
        provider_family: 'gpt',
        provider_pool_id: 'gpt',
        selected_model: 'gpt-5.5',
        model_kind: 'explicit_version',
      }),
      'owner-user',
    );
    expect(mocks.setConversationRuntimeBinding).toHaveBeenCalledWith(
      'flow',
      '',
      expect.objectContaining({
        provider_pool_id: 'gpt',
        selected_model: 'gpt-5.5',
      }),
      'workspace_default',
      'owner-user',
      { markPending: true, handoffSummaryId: 'handoff-summary-1' },
    );
  });

  it('changes only the main scope when using the scope mutation route', async () => {
    const res = await modelRoutes.request(
      jsonRequest('/workspaces/web:flow/scopes/main', 'PUT', {
        providerPoolId: 'gpt',
        model: 'gpt-5.5',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.setWorkspaceModelDefault).not.toHaveBeenCalled();
    expect(mocks.setConversationRuntimeBinding).toHaveBeenCalledWith(
      'flow',
      '',
      expect.objectContaining({
        provider_pool_id: 'gpt',
        selected_model: 'gpt-5.5',
      }),
      'user_pinned',
      'owner-user',
      { markPending: true, handoffSummaryId: 'handoff-summary-1' },
    );
  });

  it('rejects the legacy folder scope route when multiple web JIDs exist', async () => {
    mocks.getJidsByFolder.mockReturnValue(['web:flow', 'web:flow-copy']);

    const res = await modelRoutes.request(
      jsonRequest('/scopes/flow', 'PUT', {
        providerPoolId: 'gpt',
        model: 'gpt-5.5',
      }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('ambiguous');
  });
});
