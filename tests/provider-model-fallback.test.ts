import { describe, expect, test } from 'vitest';

import {
  isProviderLimitNotice,
  ProviderFallbackModelState,
  ProviderFallbackTurnLedger,
} from '../container/agent-runner/src/provider-fallback.js';
import {
  resolveClaudeProviderRuntime,
  resolveClaudeQueryModelRuntime,
} from '../container/agent-runner/src/provider-runtime.js';
import {
  IpcTurnDeliveryTracker,
  type IpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';
import { isProviderFailureResult } from '../src/agent-output-parser.js';
import { applyFallbackModelToEnvLines } from '../src/container-runner.js';

function message(id: string, text = `prompt-${id}`): IpcInputMessage {
  return {
    text,
    images: [{ data: `image-${id}`, mimeType: 'image/png' }],
    receipt: {
      deliveryId: `delivery-${id}`,
      chatJid: 'web:fallback',
      cursor: { timestamp: '2026-07-22T00:00:00.000Z', id },
    },
  };
}

describe('provider model fallback lifecycle', () => {
  test('recognizes only standalone Claude account-limit notices', () => {
    const samples = [
      ["You're out of extra usage · resets 2:10am (Asia/Shanghai)", true],
      ["You've hit your limit", true],
      // Qualified variants of the real banner ("session"/"weekly" limit) must
      // match too — the original pattern only accepted the bare "your limit".
      ["You've hit your session limit · resets 11:10pm (Asia/Singapore)", true],
      ["You've hit your weekly limit · resets 3am (America/New_York)", true],
      ['Claude usage limit reached. Your limit will reset at 3pm.', true],
      [
        'To avoid a rate limit, retry the request with exponential backoff.',
        false,
      ],
      ['The database quota was exhausted by leaked connections.', false],
    ] as const;

    for (const [text, expected] of samples) {
      expect(isProviderLimitNotice(text)).toBe(expected);
      expect(isProviderFailureResult(text)).toBe(expected);
    }
  });

  test('switches once and keeps later warm queries on the fallback model', () => {
    const state = new ProviderFallbackModelState(
      'primary-model',
      'fallback-model',
    );
    expect(state.activeModelOverride).toBeUndefined();

    expect(state.activateForResult("You've hit your limit")).toBe(true);
    expect(state.activeModelOverride).toBe('fallback-model');
    expect(state.activateForResult("You've hit your limit")).toBe(false);

    const provider = resolveClaudeProviderRuntime({
      HAPPYCLAW_CLAUDE_ENDPOINT_KIND: 'official',
      ANTHROPIC_MODEL: 'primary-model',
    });
    expect(
      resolveClaudeQueryModelRuntime(provider, state.activeModelOverride),
    ).toMatchObject({
      model: 'fallback-model',
      queryModelOptions: { model: 'fallback-model' },
      usageModelKey: 'fallback-model',
    });
  });

  test('does not retry when fallback is empty or identical to primary', () => {
    expect(
      new ProviderFallbackModelState('same', '').activateForResult(
        "You've hit your limit",
      ),
    ).toBe(false);
    expect(
      new ProviderFallbackModelState('same', 'same').activateForResult(
        "You've hit your limit",
      ),
    ).toBe(false);
  });

  test('warm failure keeps only the current receipt and leaves later turns ordered', () => {
    const failed = message('n', 'the actual Nth warm prompt');
    const later = message('n+1', 'later prompt');
    const tracker = new IpcTurnDeliveryTracker([]);
    const turns = new ProviderFallbackTurnLedger({
      prompt: 'cold startup prompt',
      images: [{ data: 'cold-image', mimeType: 'image/png' }],
      sessionId: undefined,
      resumeAt: undefined,
    });

    const coldPlan = turns.snapshotFailure({
      ipcMessages: tracker.currentTurnMessages,
      laterIpcMessages: tracker.laterTurnMessages,
      turnId: 'cold-turn',
    });
    expect(coldPlan).toMatchObject({
      prompt: 'cold startup prompt',
      images: [{ data: 'cold-image', mimeType: 'image/png' }],
      sessionIdBeforeTurn: undefined,
      resumeAt: undefined,
      ipcMessages: [],
      laterIpcMessages: [],
      turnId: 'cold-turn',
    });

    tracker.completeNextTurn(); // cold startup turn already completed
    turns.completeHealthyTurn({
      sessionId: 'session-after-cold',
      resumeAt: 'assistant-after-cold',
      nextTurnMessages: [],
    });
    tracker.acceptTurn([failed]);
    turns.acceptCurrentTurn([failed]);
    tracker.acceptTurn([later]);

    const warmPlan = turns.snapshotFailure({
      ipcMessages: tracker.currentTurnMessages,
      laterIpcMessages: tracker.laterTurnMessages,
      turnId: 'warm-turn-n',
    });
    expect(warmPlan).toMatchObject({
      prompt: 'the actual Nth warm prompt',
      images: failed.images,
      sessionIdBeforeTurn: 'session-after-cold',
      resumeAt: 'assistant-after-cold',
      ipcMessages: [failed],
      laterIpcMessages: [later],
      turnId: 'warm-turn-n',
    });

    // A healthy fallback result ACKs only N. N+1 stays pending for its own turn.
    expect(tracker.completeNextTurn()).toEqual([failed.receipt]);
    expect(tracker.currentTurnMessages).toEqual([later]);
    expect(tracker.unacknowledgedMessages).toEqual([later]);
  });

  test('global fallback env is authoritative and empty config removes inherited values', () => {
    const configured = [
      'HAPPYCLAW_FALLBACK_MODEL=workspace-value',
      'KEEP_ME=yes',
    ];
    applyFallbackModelToEnvLines(configured, 'fallback-model');
    expect(configured).toContain('HAPPYCLAW_FALLBACK_MODEL=fallback-model');
    expect(configured).not.toContain(
      'HAPPYCLAW_FALLBACK_MODEL=workspace-value',
    );

    const cleared = ['HAPPYCLAW_FALLBACK_MODEL=inherited-value', 'KEEP_ME=yes'];
    applyFallbackModelToEnvLines(cleared, '');
    expect(cleared).toEqual(['KEEP_ME=yes']);
  });
});
