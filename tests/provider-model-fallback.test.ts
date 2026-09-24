import { describe, expect, test } from 'vitest';

import {
  classifyProviderAssistantError,
  classifyProviderLimitNotice,
  classifyProviderRateLimitType,
  decideProviderLimitAction,
  isProviderLimitNotice,
  ProviderFallbackModelState,
  ProviderFallbackTurnLedger,
} from '../container/agent-runner/src/provider-fallback.js';
import {
  resolveClaudeProviderRuntime,
  resolveClaudeQueryModelRuntime,
  resolveProviderReportedModelTier,
} from '../container/agent-runner/src/provider-runtime.js';
import {
  IpcTurnDeliveryTracker,
  type IpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';
import {
  classifyProviderLimitNotice as classifyHostProviderLimitNotice,
  isProviderFailureResult,
} from '../src/agent-output-parser.js';
import {
  applyFallbackModelToEnvLines,
  resolvePoolTierEnv,
} from '../src/container-runner.js';
import { SDK_DEFAULT_MODEL_TIER } from '../src/provider-pool.js';

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
  test('recognizes only standalone Claude account/model-limit notices', () => {
    const samples = [
      ["You're out of extra usage · resets 2:10am (Asia/Shanghai)", true],
      ["You've hit your limit", true],
      // Qualified variants of the real banner ("session"/"weekly" limit) must
      // match too — the original pattern only accepted the bare "your limit".
      ["You've hit your session limit · resets 11:10pm (Asia/Singapore)", true],
      ["You've hit your weekly limit · resets 3am (America/New_York)", true],
      ['Claude usage limit reached. Your limit will reset at 3pm.', true],
      ["You've reached your Fable 5 limit. /model to switch models.", true],
      [
        'To avoid a rate limit, retry the request with exponential backoff.',
        false,
      ],
      ['The database quota was exhausted by leaked connections.', false],
      ["You've hit your rate limit.", false],
      ["You've reached your storage limit.", false],
      ["You've reached your character limit.", false],
      ["You've hit your project limit.", false],
      ["You've reached your speed limit.", false],
    ] as const;

    for (const [text, expected] of samples) {
      expect(isProviderLimitNotice(text)).toBe(expected);
      expect(classifyHostProviderLimitNotice(text)).toBe(
        classifyProviderLimitNotice(text),
      );
      expect(isProviderFailureResult(text)).toBe(
        classifyProviderLimitNotice(text) === 'account',
      );
    }
  });

  test('switches only for model limits and keeps later queries on fallback', () => {
    const state = new ProviderFallbackModelState(
      'primary-model',
      'fallback-model',
    );
    expect(state.activeModelOverride).toBeUndefined();

    expect(state.activateForResult("You've hit your session limit.")).toBe(
      false,
    );
    expect(state.activeModelOverride).toBeUndefined();
    expect(
      state.activateForResult(
        "You've reached your Fable 5 limit. /model to switch models.",
      ),
    ).toBe(true);
    expect(state.activeModelOverride).toBe('fallback-model');
    expect(state.activateForResult("You've hit your Opus limit.")).toBe(false);

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
        "You've hit your Opus limit.",
      ),
    ).toBe(false);
    expect(
      new ProviderFallbackModelState('same', 'same').activateForResult(
        "You've hit your Opus limit.",
      ),
    ).toBe(false);
  });

  test('reports the official SDK default as a stable model tier', () => {
    const provider = resolveClaudeProviderRuntime({
      HAPPYCLAW_CLAUDE_ENDPOINT_KIND: 'official',
    });
    expect(provider.model).toBe('');
    expect(resolveProviderReportedModelTier(provider)).toBe(
      SDK_DEFAULT_MODEL_TIER,
    );
  });

  test('maps structured SDK rate limits to the correct blast radius', () => {
    expect(classifyProviderRateLimitType(undefined)).toBe('account');
    expect(classifyProviderRateLimitType('five_hour')).toBe('account');
    expect(classifyProviderRateLimitType('seven_day')).toBe('account');
    expect(classifyProviderRateLimitType('overage')).toBe('account');
    expect(classifyProviderRateLimitType('seven_day_opus')).toBe('model');
    expect(classifyProviderRateLimitType('seven_day_sonnet')).toBe('model');
    // Current Claude Code emits this type for Fable 5's model-specific wall.
    expect(classifyProviderRateLimitType('seven_day_overage_included')).toBe(
      'model',
    );
  });

  test('fails fast on synthetic assistant provider errors without a Result', () => {
    // Every recognized error still terminates the attempt; only the class,
    // and therefore the disposition, differs.
    for (const error of [
      'rate_limit',
      'billing_error',
      'authentication_failed',
      'oauth_org_not_allowed',
      'account_on_hold',
      'verification_required',
      'cloud_credential_error',
      'overloaded',
      'server_error',
      'unknown',
      'max_output_tokens',
      'invalid_request',
      'model_not_found',
    ] as const) {
      expect(classifyProviderAssistantError(error)).toBeDefined();
    }
    expect(classifyProviderAssistantError(undefined)).toBeUndefined();
  });

  test('only a verdict on the profile is classified as an account failure', () => {
    expect(classifyProviderAssistantError('authentication_failed')).toBe(
      'account',
    );
    expect(classifyProviderAssistantError('oauth_org_not_allowed')).toBe(
      'account',
    );
    expect(classifyProviderAssistantError('account_on_hold')).toBe('account');
    // SDK 0.3.280 values. An unverified organization is a verdict on the
    // profile; unloadable cloud credentials belong to the profile's own
    // environment, so another profile may still serve the input.
    expect(classifyProviderAssistantError('verification_required')).toBe(
      'account',
    );
    expect(classifyProviderAssistantError('cloud_credential_error')).toBe(
      'account',
    );
    expect(classifyProviderAssistantError('billing_error')).toBe('account');
    // A bare rate_limit carries no rateLimitType, so it fails safe as
    // account-wide — matching classifyProviderRateLimitType's unknown default.
    expect(classifyProviderAssistantError('rate_limit')).toBe('account');
  });

  test('upstream noise never becomes an account verdict', () => {
    // A 529 from the edge and a 5xx from the server say nothing about this
    // account's quota. Classifying them as `account` is what quarantined the
    // only profile of a single-account install and retired the user's input.
    expect(classifyProviderAssistantError('overloaded')).toBe('transient');
    expect(classifyProviderAssistantError('server_error')).toBe('transient');
    expect(classifyProviderAssistantError('unknown')).toBe('transient');
    expect(classifyProviderAssistantError('max_output_tokens')).toBe(
      'transient',
    );
    expect(classifyProviderAssistantError('future_sdk_error' as never)).toBe(
      'transient',
    );
  });

  test('an unservable model name is a config failure, not a quota one', () => {
    // Every account would be asked for the same model, so quarantining on this
    // would drain the whole pool over one bad model name.
    expect(classifyProviderAssistantError('model_not_found')).toBe('config');
    expect(classifyProviderAssistantError('invalid_request')).toBe('config');
  });

  test('structured rejection wins over text and preserves model-only errors without fallback', () => {
    expect(
      decideProviderLimitAction({
        structuredRejection: {},
        result: 'wording introduced by a future Claude Code release',
        canFallback: true,
      }),
    ).toEqual({ scope: 'account', action: 'provider_failure' });

    expect(
      decideProviderLimitAction({
        structuredRejection: { rateLimitType: 'seven_day_opus' },
        result: "You've hit your session limit.",
        canFallback: true,
      }),
    ).toEqual({ scope: 'model', action: 'model_fallback' });

    expect(
      decideProviderLimitAction({
        structuredRejection: {
          rateLimitType: 'seven_day_overage_included',
        },
        result: "You've reached your Fable 5 limit.",
        canFallback: false,
      }),
    ).toEqual({ scope: 'model', action: 'surface_result' });
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

  test('an explicit Agent pin keeps fallback inside its account in a multi-provider install', () => {
    expect(resolvePoolTierEnv(undefined, 3, 'fallback-model', true)).toEqual({
      runnerFallbackModel: 'fallback-model',
    });
    expect(resolvePoolTierEnv(undefined, 3, 'fallback-model', false)).toEqual(
      {},
    );
  });
});
