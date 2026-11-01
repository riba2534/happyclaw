import { describe, expect, test } from 'vitest';

import {
  resolveBindingActivationMode,
  resolveBindingAudienceMode,
  resolveBindingTargetType,
  hasBindingPolicyMismatch,
  isBoundToImDestination,
  buildImBindingRequest,
} from '../web/src/utils/im-binding-policy.js';
import type { AvailableImGroup } from '../web/src/types.js';

function makeGroup(
  overrides: Partial<AvailableImGroup> = {},
): AvailableImGroup {
  return {
    jid: 'feishu:chat-a',
    name: 'Feishu chat',
    added_at: '2026-07-22T00:00:00.000Z',
    bound_agent_id: null,
    bound_main_jid: null,
    bound_target_name: null,
    bound_workspace_name: null,
    channel_type: 'feishu',
    ...overrides,
  };
}

describe('IM binding policy selection', () => {
  test('preserves a newly-synced chat durable policy when local form state is absent', () => {
    const group = makeGroup({
      activation_mode: 'always',
      audience_mode: 'owner_only',
    });

    expect(resolveBindingActivationMode(group)).toBe('always');
    expect(resolveBindingAudienceMode(group)).toBe('owner_only');
  });

  test('normalizes the legacy composite owner policy without widening its audience', () => {
    const group = makeGroup({ activation_mode: 'owner_mentioned' });

    expect(resolveBindingActivationMode(group)).toBe('when_mentioned');
    expect(resolveBindingAudienceMode(group)).toBe('owner_only');
  });

  test('uses an explicit user selection instead of the durable fallback', () => {
    const group = makeGroup({
      activation_mode: 'when_mentioned',
      audience_mode: 'owner_only',
    });

    expect(resolveBindingActivationMode(group, 'disabled')).toBe('disabled');
    expect(resolveBindingAudienceMode(group, 'everyone')).toBe('everyone');
  });

  test('rejects invalid stale form values instead of sending them to the API', () => {
    const group = makeGroup();

    expect(resolveBindingActivationMode(group, 'invalid')).toBe('auto');
    expect(resolveBindingAudienceMode(group, 'invalid')).toBe('everyone');
  });

  test('private Feishu binding drops obsolete mention activation while preserving audience and disabled state', () => {
    const group = makeGroup({
      conversation_kind: 'direct',
      activation_mode: 'owner_mentioned',
    });
    expect(resolveBindingActivationMode(group)).toBe('auto');
    expect(resolveBindingAudienceMode(group)).toBe('owner_only');
    expect(resolveBindingActivationMode(group, 'disabled')).toBe('disabled');
  });
});

describe('IM binding destinations', () => {
  test.each(['direct', 'group'] as const)(
    '%s binds to named sessions and main, never to a workspace',
    (kind) => {
      const group = makeGroup({
        conversation_kind: kind,
        activation_mode: 'when_mentioned',
      });
      expect(resolveBindingTargetType(group)).toBe('session');
      for (const sessionId of ['main', 'session-a']) {
        const request = buildImBindingRequest(group, {
          type: 'session',
          groupJid: 'web:main',
          sessionId,
        });
        expect(request.url).toBe(
          `/api/groups/web%3Amain/sessions/${sessionId}/im-binding`,
        );
        expect(request.body).toMatchObject({
          im_jid: group.jid,
          reply_policy: 'source_only',
          activation_mode: kind === 'direct' ? 'auto' : 'when_mentioned',
        });
      }
      expect(() =>
        buildImBindingRequest(group, {
          type: 'workspace',
          groupJid: 'web:main',
        }),
      ).toThrow();
    },
  );

  test('topic groups select workspaces and cannot bind to main or another fixed session', () => {
    const group = makeGroup({ conversation_kind: 'topic' });
    expect(resolveBindingTargetType(group)).toBe('workspace');
    expect(
      buildImBindingRequest(group, { type: 'workspace', groupJid: 'web:main' })
        .url,
    ).toBe('/api/groups/web%3Amain/im-binding');
    for (const sessionId of ['main', 'other']) {
      expect(() =>
        buildImBindingRequest(group, {
          type: 'session',
          groupJid: 'web:main',
          sessionId,
        }),
      ).toThrow();
    }
  });

  test('unknown kinds cannot make binding requests even when stale capabilities suggest threads', () => {
    const group = makeGroup({
      conversation_kind: 'unknown',
      is_thread_capable: true,
    });
    expect(resolveBindingTargetType(group)).toBeNull();
    expect(() =>
      buildImBindingRequest(group, { type: 'workspace', groupJid: 'web:main' }),
    ).toThrow();
    expect(() =>
      buildImBindingRequest(group, {
        type: 'session',
        groupJid: 'web:main',
        sessionId: 'main',
      }),
    ).toThrow();
  });

  test('changing activation never changes binding dimension or widens the audience', () => {
    const group = makeGroup({
      conversation_kind: 'group',
      audience_mode: 'owner_only',
    });
    for (const activationMode of ['always', 'when_mentioned', 'disabled']) {
      const request = buildImBindingRequest(
        group,
        { type: 'session', groupJid: 'web:a', sessionId: 's-a' },
        { activationMode, force: true },
      );
      expect(request.url).toBe('/api/groups/web%3Aa/sessions/s-a/im-binding');
      expect(request.body).toMatchObject({
        force: true,
        audience_mode: 'owner_only',
        activation_mode: activationMode,
      });
    }
  });

  test('an ordinary group binds to a session: one left on a workspace alone, or thread-mapped, needs correction', () => {
    const group = makeGroup({
      conversation_kind: 'group',
      bound_agent_id: 's-a',
      bound_session_id: 's-a',
      binding_mode: 'single_context',
    });
    expect(hasBindingPolicyMismatch(group)).toBe(false);
    expect(
      isBoundToImDestination(group, {
        type: 'session',
        groupJid: 'web:a',
        sessionId: 's-a',
      }),
    ).toBe(true);
    expect(
      isBoundToImDestination(group, { type: 'workspace', groupJid: 'web:a' }),
    ).toBe(false);
    expect(
      hasBindingPolicyMismatch({ ...group, routing_mode: 'thread_map' }),
    ).toBe(true);
    // A mount from before sessions were all alike: the workspace, no session.
    const leftOver = makeGroup({
      conversation_kind: 'group',
      bound_main_jid: 'web:a',
      binding_mode: 'single_context',
    });
    expect(hasBindingPolicyMismatch(leftOver)).toBe(true);
    expect(
      isBoundToImDestination(leftOver, {
        type: 'session',
        groupJid: 'web:a',
        sessionId: 's-a',
      }),
    ).toBe(false);
  });

  test('a workspace binding does not claim its child sessions, and topic mounts are distinct from sessions', () => {
    const group = makeGroup({
      conversation_kind: 'group',
      bound_workspace_jid: 'web:a',
      bound_session_id: 's-a',
    });
    expect(
      isBoundToImDestination(group, { type: 'workspace', groupJid: 'web:a' }),
    ).toBe(false);
    expect(
      isBoundToImDestination(group, {
        type: 'session',
        groupJid: 'web:a',
        sessionId: 's-b',
      }),
    ).toBe(false);
    expect(
      isBoundToImDestination(group, {
        type: 'session',
        groupJid: 'web:a',
        sessionId: 's-a',
      }),
    ).toBe(true);
    const topic = makeGroup({
      conversation_kind: 'topic',
      bound_workspace_jid: 'web:a',
      routing_mode: 'thread_map',
    });
    expect(
      isBoundToImDestination(topic, { type: 'workspace', groupJid: 'web:a' }),
    ).toBe(true);
    expect(
      isBoundToImDestination(topic, {
        type: 'session',
        groupJid: 'web:a',
        sessionId: 's-a',
      }),
    ).toBe(false);
    expect(
      hasBindingPolicyMismatch({ ...topic, bound_session_id: 's-a' }),
    ).toBe(true);
  });
});
