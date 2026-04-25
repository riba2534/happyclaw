import { describe, expect, it } from 'vitest';

import { buildRuntimePrompt } from '../src/runtime-input-builder.js';

describe('RuntimeInputBuilder', () => {
  it('lets Codex read CLAUDE.md natively and injects recent history on soft handoff', () => {
    const result = buildRuntimePrompt({
      runtime: 'codex',
      groupFolder: 'demo',
      chatJid: 'web:demo',
      basePrompt: '<messages><message>继续</message></messages>',
      sessionId: undefined,
      workspaceInstructions: 'Always use the project plan.',
      recentMessages: [
        {
          id: 'm1',
          sender_name: 'user',
          content: '之前的关键结论',
          timestamp: '2026-04-25T00:00:00.000Z',
          is_from_me: false,
        },
      ],
    });

    expect(result.resumeMode).toBe('soft_inject');
    expect(result.softInjectionReason).toBe('no_native_session');
    expect(result.injectedBlockKinds).toEqual(['recent_messages']);
    expect(result.prompt).not.toContain('workspace-instructions');
    expect(result.prompt).not.toContain('Always use the project plan.');
    expect(result.prompt).toContain('之前的关键结论');
  });

  it('uses a model-switch handoff summary instead of raw recent messages', () => {
    const result = buildRuntimePrompt({
      runtime: 'codex',
      groupFolder: 'demo',
      chatJid: 'web:demo',
      basePrompt: '<messages><message>继续</message></messages>',
      sessionId: 'old-session',
      nativeSession: undefined,
      handoffSummary: {
        id: 'summary-1',
        text: '用户正在测试模型切换；下一轮需要继续验证。',
      },
      recentMessages: [
        {
          id: 'm1',
          sender_name: 'user',
          content: '这条原文不应该注入',
          timestamp: '2026-04-25T00:00:00.000Z',
          is_from_me: false,
        },
      ],
      forceSoftInjectionReason: 'model_binding_changed',
    });

    expect(result.resumeMode).toBe('soft_inject');
    expect(result.summaryId).toBe('summary-1');
    expect(result.injectedBlockKinds).toEqual(['handoff_summary']);
    expect(result.prompt).toContain('<handoff-summary id="summary-1">');
    expect(result.prompt).toContain('用户正在测试模型切换');
    expect(result.prompt).not.toContain('这条原文不应该注入');
  });

  it('does not fall back to raw recent messages for model switches without a summary', () => {
    const result = buildRuntimePrompt({
      runtime: 'codex',
      groupFolder: 'demo',
      chatJid: 'web:demo',
      basePrompt: '<messages><message>继续</message></messages>',
      sessionId: 'old-session',
      nativeSession: undefined,
      recentMessages: [
        {
          id: 'm1',
          sender_name: 'user',
          content: '这条原文不能作为模型切换 handoff',
          timestamp: '2026-04-25T00:00:00.000Z',
          is_from_me: false,
        },
      ],
      forceSoftInjectionReason: 'model_binding_changed',
    });

    expect(result.injectedBlockKinds).toEqual([]);
    expect(result.prompt).not.toContain('这条原文不能作为模型切换 handoff');
  });

  it('does not inject persisted handoff summaries in privacy mode', () => {
    const result = buildRuntimePrompt({
      runtime: 'codex',
      groupFolder: 'demo',
      chatJid: 'web:demo',
      basePrompt: '<messages><message>继续</message></messages>',
      sessionId: 'old-session',
      nativeSession: undefined,
      privacyMode: true,
      handoffSummary: {
        id: 'summary-private',
        text: '隐私会话摘要不应该注入',
      },
      recentMessages: [
        {
          id: 'm1',
          sender_name: 'user',
          content: '隐私原文也不应该注入',
          timestamp: '2026-04-25T00:00:00.000Z',
          is_from_me: false,
        },
      ],
      forceSoftInjectionReason: 'model_binding_changed',
    });

    expect(result.injectedBlockKinds).toEqual([]);
    expect(result.summaryId).toBeNull();
    expect(result.prompt).not.toContain('隐私会话摘要不应该注入');
    expect(result.prompt).not.toContain('隐私原文也不应该注入');
  });

  it('keeps Claude workspace instructions out of the prompt by default', () => {
    const result = buildRuntimePrompt({
      runtime: 'claude',
      groupFolder: 'demo',
      chatJid: 'web:demo',
      basePrompt: '<messages><message>hello</message></messages>',
      sessionId: 'claude-session',
      nativeSession: {
        group_folder: 'demo',
        agent_id: '',
        runtime: 'claude',
        provider_family: 'claude',
        provider_pool_id: 'claude',
        provider_id: '__legacy_claude__',
        auth_profile_generation: 0,
        auth_profile_fingerprint: null,
        model_key: 'provider_default',
        selected_model: null,
        model_kind: 'provider_default',
        resolved_model: null,
        native_session_id: 'claude-session',
        native_resume_at: null,
        based_on_message_id: 'm0',
        based_on_message_timestamp: null,
        based_on_turn_id: null,
        input_context_hash: null,
        workspace_instruction_hash: null,
        summary_id: null,
        metadata_json: null,
        created_at: '2026-04-25T00:00:00.000Z',
        updated_at: '2026-04-25T00:00:00.000Z',
      },
      workspaceInstructions: 'Claude should read native CLAUDE.md.',
      recentMessages: [],
    });

    expect(result.resumeMode).toBe('resume');
    expect(result.prompt).not.toContain('workspace-instructions');
    expect(result.prompt).toBe('<messages><message>hello</message></messages>');
  });
});
