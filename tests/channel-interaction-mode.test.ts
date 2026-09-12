import { describe, expect, test } from 'vitest';
import {
  resolveSourceInteractionMode,
  selectSourceInteractionModePrefix,
  sessionInteractionModeChanged,
} from '../src/channel-interaction-mode.js';
import type { ChannelMount, InteractionMode } from '../src/types.js';

const mount = (
  channel: string,
  override: InteractionMode | null,
  workspace = 'web:home',
): ChannelMount => ({
  channel_jid: channel,
  channel_type: 'feishu',
  workspace_jid: workspace,
  interaction_mode_override: override,
  routing_mode: 'thread_map',
  reply_policy: 'source_only',
  activation_mode: 'auto',
  audience_mode: 'everyone',
  created_at: '',
  updated_at: '',
});
const mounts = new Map([
  ['feishu:research', mount('feishu:research', 'assistant')],
  ['feishu:other', mount('feishu:other', null)],
  ['feishu:foreign', mount('feishu:foreign', 'assistant', 'web:other')],
]);
const deps = {
  getMount: (jid: string) => mounts.get(jid),
  getWorkspaceFolder: (jid: string) => (jid === 'web:home' ? 'home' : 'other'),
};
const resolve = (
  sourceJid?: string,
  kind: 'main' | 'conversation' | 'spawn' = 'main',
) =>
  resolveSourceInteractionMode(
    {
      workspaceFolder: 'home',
      workspaceMode: 'proactive',
      sourceJid,
      agentKind: kind,
    },
    deps,
  );

describe('trusted source mount reply-mode contract', () => {
  test('one research mount overrides Home without changing Web, other mounts, or foreign bindings', () => {
    expect(resolve('feishu:research')).toBe('assistant');
    expect(resolve('feishu:research', 'conversation')).toBe('assistant');
    expect(resolve('feishu:other')).toBe('proactive');
    expect(resolve('web:home')).toBe('proactive');
    expect(resolve()).toBe('proactive');
    expect(resolve('feishu:foreign')).toBe('proactive');
    expect(resolve('feishu:unknown')).toBe('proactive');
  });

  test('spawn and isolated scheduled work retain assistant semantics', () => {
    expect(resolve('feishu:other', 'spawn')).toBe('assistant');
    expect(
      resolveSourceInteractionMode(
        {
          workspaceFolder: 'home',
          workspaceMode: 'proactive',
          sourceJid: 'feishu:other',
          agentKind: 'main',
          scheduledTask: true,
        },
        deps,
      ),
    ).toBe('assistant');
  });

  test('mixed Home inputs are consumed as contiguous mode-compatible batches, preserving every suffix', () => {
    const messages = [
      { id: 'a1', source: 'feishu:research' },
      { id: 'a2', source: 'feishu:research' },
      { id: 'p1', source: 'feishu:other' },
      { id: 'w1', source: 'web:home' },
      { id: 'a3', source: 'feishu:research' },
    ];
    const pending = [...messages];
    const batches: Array<{ mode: InteractionMode; ids: string[] }> = [];
    while (pending.length) {
      const batch = selectSourceInteractionModePrefix(
        pending,
        (message) => resolve(message.source),
        'proactive',
      );
      expect(batch.messages.length).toBeGreaterThan(0);
      expect(batch.hasDeferredMessages).toBe(
        batch.messages.length < pending.length,
      );
      batches.push({
        mode: batch.interactionMode,
        ids: batch.messages.map((message) => message.id),
      });
      pending.splice(0, batch.messages.length);
    }
    expect(batches).toEqual([
      { mode: 'assistant', ids: ['a1', 'a2'] },
      { mode: 'proactive', ids: ['p1', 'w1'] },
      { mode: 'assistant', ids: ['a3'] },
    ]);
    expect(batches.flatMap((batch) => batch.ids)).toEqual(
      messages.map((message) => message.id),
    );
  });

  test('frozen scheduled input can precede a differently configured source without changing either contract', () => {
    const messages: Array<{
      id: string;
      source: string;
      frozen?: InteractionMode;
    }> = [
      { id: 'scheduled', source: 'feishu:research', frozen: 'proactive' },
      { id: 'user', source: 'feishu:research' },
    ];
    const batch = selectSourceInteractionModePrefix(
      messages,
      (message) => message.frozen ?? resolve(message.source),
      'proactive',
    );
    expect(batch.interactionMode).toBe('proactive');
    expect(batch.messages.map((message) => message.id)).toEqual(['scheduled']);
    expect(batch.hasDeferredMessages).toBe(true);
    expect(resolve(messages[1].source)).toBe('assistant');
  });

  test('SDK resume is reused only under the same mode, including legacy and restart cases', () => {
    const existing = {
      sessionId: 'sdk-1',
      storedMode: null,
      legacyMode: 'proactive' as const,
      requiredMode: 'assistant' as const,
    };
    expect(sessionInteractionModeChanged(existing)).toBe(true);
    expect(
      sessionInteractionModeChanged({ ...existing, sessionId: undefined }),
    ).toBe(false);
    expect(
      sessionInteractionModeChanged({ ...existing, storedMode: 'assistant' }),
    ).toBe(false);
    expect(
      sessionInteractionModeChanged({
        ...existing,
        storedMode: 'assistant',
        requiredMode: 'proactive',
      }),
    ).toBe(true);
    expect(
      sessionInteractionModeChanged({
        ...existing,
        storedMode: 'proactive',
        requiredMode: 'proactive',
      }),
    ).toBe(false);
    expect(
      sessionInteractionModeChanged({ ...existing, legacyMode: 'assistant' }),
    ).toBe(false);
  });
});
