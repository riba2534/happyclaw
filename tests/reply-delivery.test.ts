import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  acknowledgeIpcReplyTurn,
  decideAssistantPrimaryProjection,
  isGenuineReplyResult,
  occupiesPrimaryReplyDeliverySlot,
  resolveHeldReplyDbText,
  setIpcReplyInputTurn,
  shouldFinalizeScheduledGroupPrimaryResult,
  shouldSkipRetryAfterLateError,
  wasGenuineReplyDeliveredForInput,
} from '../src/reply-delivery.js';
import { resolveContainerOutputInputTurnId } from '../src/channel-output-correlation.js';
import { TurnOutputCoordinator } from '../src/turn-output-coordinator.js';

describe('isGenuineReplyResult', () => {
  test('a normal completed SDK final result is genuine', () => {
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      }),
    ).toBe(true);
  });

  test('a healthy hold-sequence closure (holdReason now null) is genuine', () => {
    // wasInHeldSeq was true, this result is the merged full content finally
    // delivered as one message — must count as genuine.
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      }),
    ).toBe(true);
  });

  test('bg_tasks hold is NOT genuine — background tasks still settling', () => {
    expect(
      isGenuineReplyResult({
        holdReason: 'bg_tasks',
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      }),
    ).toBe(false);
  });

  test('truncated hold is NOT genuine — upstream cutoff, auto-continuing', () => {
    expect(
      isGenuineReplyResult({
        holdReason: 'truncated',
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      }),
    ).toBe(false);
  });

  test('overflow_partial sourceKind is NOT genuine even with holdReason null', () => {
    // Regression case: runEnded forces holdReason to null unconditionally,
    // so holdReason alone cannot be trusted to catch every partial result.
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'overflow_partial',
        finalizationReason: 'completed',
      }),
    ).toBe(false);
  });

  test('compact_partial sourceKind is NOT genuine even with holdReason null', () => {
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'compact_partial',
        finalizationReason: 'completed',
      }),
    ).toBe(false);
  });

  test('finalizationReason truncated is NOT genuine even with holdReason null', () => {
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'sdk_final',
        finalizationReason: 'truncated',
      }),
    ).toBe(false);
  });

  test('an input rejection warning is visible but never marks the primary reply complete', () => {
    expect(
      isGenuineReplyResult({
        holdReason: null,
        sourceKind: 'input_rejection_warning',
      }),
    ).toBe(false);
  });
});

describe('shouldFinalizeScheduledGroupPrimaryResult', () => {
  test('finalizes the first substantive primary before a lifecycle completion frame', () => {
    expect(
      shouldFinalizeScheduledGroupPrimaryResult({
        status: 'success',
        providerFailure: false,
        hasScheduledGroupRuns: true,
        holdReason: null,
        sourceKind: 'sdk_final',
        finalizationReason: 'completed',
      }),
    ).toBe(true);
  });

  test('finalizes a healthy continuation that completes a truncated scheduled answer', () => {
    expect(
      shouldFinalizeScheduledGroupPrimaryResult({
        status: 'success',
        providerFailure: false,
        hasScheduledGroupRuns: true,
        holdReason: null,
        sourceKind: 'truncation_continue',
        finalizationReason: 'completed',
      }),
    ).toBe(true);
  });

  test.each([
    {
      label: 'unrelated',
      status: 'success' as const,
      providerFailure: false,
      hasScheduledGroupRuns: false,
      holdReason: null,
      sourceKind: 'sdk_final',
    },
    {
      label: 'provider failure',
      status: 'success' as const,
      providerFailure: true,
      hasScheduledGroupRuns: true,
      holdReason: null,
      sourceKind: 'sdk_final',
    },
    {
      label: 'input rejection warning without a primary source',
      status: 'success' as const,
      providerFailure: false,
      hasScheduledGroupRuns: true,
      holdReason: null,
      sourceKind: 'input_rejection_warning',
    },
    {
      label: 'internal continuation output',
      status: 'success' as const,
      providerFailure: false,
      hasScheduledGroupRuns: true,
      holdReason: null,
      sourceKind: 'auto_continue',
    },
    {
      label: 'background checkpoint',
      status: 'success' as const,
      providerFailure: false,
      hasScheduledGroupRuns: true,
      holdReason: 'bg_tasks' as const,
      sourceKind: 'sdk_final',
    },
    {
      label: 'partial continuation',
      status: 'success' as const,
      providerFailure: false,
      hasScheduledGroupRuns: true,
      holdReason: null,
      sourceKind: 'overflow_partial',
    },
    {
      label: 'still-truncated continuation',
      status: 'success' as const,
      providerFailure: false,
      hasScheduledGroupRuns: true,
      holdReason: 'truncated' as const,
      sourceKind: 'truncation_continue',
      finalizationReason: 'truncated',
    },
    {
      label: 'stream event',
      status: 'stream' as const,
      providerFailure: false,
      hasScheduledGroupRuns: true,
      holdReason: null,
      sourceKind: 'sdk_final',
    },
  ])('rejects $label output', (input) => {
    expect(shouldFinalizeScheduledGroupPrimaryResult(input)).toBe(false);
  });
});

describe('scheduled result presentation boundaries', () => {
  test('an input rejection warning remains auxiliary and does not occupy the primary delivery slot', () => {
    expect(occupiesPrimaryReplyDeliverySlot('input_rejection_warning')).toBe(
      false,
    );
    expect(occupiesPrimaryReplyDeliverySlot('sdk_final')).toBe(true);
  });

  test('a healthy truncation continuation persists the complete business result', () => {
    expect(
      resolveHeldReplyDbText({
        heldBaseText: '调研首段：市场规模 100\n\n---\n\n',
        text: '续写尾段：结论为增长。',
        sourceKind: 'truncation_continue',
        holdReason: null,
        wasInHeldSequence: true,
      }),
    ).toBe('调研首段：市场规模 100\n\n---\n\n续写尾段：结论为增长。');
  });

  test('an ordinary healthy SDK final remains authoritative over held progress', () => {
    expect(
      resolveHeldReplyDbText({
        heldBaseText: '中间进度\n\n---\n\n',
        text: '完整的最终汇总',
        sourceKind: 'sdk_final',
        holdReason: null,
        wasInHeldSequence: true,
      }),
    ).toBe('完整的最终汇总');
  });
});

describe('shouldSkipRetryAfterLateError', () => {
  test('skips retry when a genuine reply was delivered this run', () => {
    expect(
      shouldSkipRetryAfterLateError({
        genuineReplyDelivered: true,
        ipcReplyDeliveredForInputTurn: false,
      }),
    ).toBe(true);
  });

  test('skips retry when send_message was host-acknowledged for this exact input turn', () => {
    // The exact "runner replies via send_message then errors on a late-turn
    // timeout" scenario — genuineReplyDelivered stays false since no SDK
    // final result ever completed, but a real message was already sent.
    expect(
      shouldSkipRetryAfterLateError({
        genuineReplyDelivered: false,
        ipcReplyDeliveredForInputTurn: true,
      }),
    ).toBe(true);
  });

  test('does NOT skip retry without a final reply or exact-turn host acknowledgement', () => {
    expect(
      shouldSkipRetryAfterLateError({
        genuineReplyDelivered: false,
        ipcReplyDeliveredForInputTurn: false,
      }),
    ).toBe(false);
  });
});

describe('IPC reply turn correlation', () => {
  test("regression: A's late SDK final cannot make active B skip retry", () => {
    const genuineReplyDeliveredByInput = new Map<string, boolean>([
      ['delivery-a', false],
    ]);
    genuineReplyDeliveredByInput.set('delivery-b', false);

    // B is already active when the delayed SDK callback for A is delivered.
    genuineReplyDeliveredByInput.set('delivery-a', true);

    expect(
      wasGenuineReplyDeliveredForInput(
        genuineReplyDeliveredByInput,
        'delivery-a',
      ),
    ).toBe(true);
    expect(
      shouldSkipRetryAfterLateError({
        genuineReplyDelivered: wasGenuineReplyDeliveredForInput(
          genuineReplyDeliveredByInput,
          'delivery-b',
        ),
        ipcReplyDeliveredForInputTurn: false,
      }),
    ).toBe(false);
  });

  test("regression: an older turn's delivery on the same warm runner cannot suppress the current turn's retry", () => {
    const tracker = { inputTurnId: 'delivery-old', delivered: false };
    expect(acknowledgeIpcReplyTurn(tracker, 'delivery-old')).toBe(true);
    expect(tracker.delivered).toBe(true);

    setIpcReplyInputTurn(tracker, 'delivery-current');
    expect(tracker.delivered).toBe(false);
    expect(acknowledgeIpcReplyTurn(tracker, 'delivery-old')).toBe(false);
    expect(tracker.delivered).toBe(false);

    const skipCurrent = shouldSkipRetryAfterLateError({
      genuineReplyDelivered: false,
      ipcReplyDeliveredForInputTurn: tracker.delivered,
    });
    expect(skipCurrent).toBe(false);

    expect(acknowledgeIpcReplyTurn(tracker, 'delivery-current')).toBe(true);
    const skipAcknowledgedCurrent = shouldSkipRetryAfterLateError({
      genuineReplyDelivered: false,
      ipcReplyDeliveredForInputTurn: tracker.delivered,
    });
    expect(skipAcknowledgedCurrent).toBe(true);
  });
});

describe('Assistant primary projection boundary', () => {
  const inputTurnId = 'a8c3513c-primary-input';
  const answer = '这是唯一应该展示的 Assistant 主回答';

  test('a body success followed by an uncorrelated session-only success projects exactly once', () => {
    const coordinator = new TurnOutputCoordinator();
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'assistant-primary',
    });
    coordinator.reduceStreamEvent({
      eventType: 'text_delta',
      text: answer,
      messageUuid: 'assistant-primary',
    });
    coordinator.reduceStreamEvent({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_stop',
      messageUuid: 'assistant-primary',
    });

    const projected: Array<{ turnId: string; text: string }> = [];
    const first = {
      status: 'success' as const,
      result: answer,
      sourceKind: 'sdk_final',
      inputTurnId,
      inputTurnCompleted: true,
      finalizationReason: 'completed',
      sdkMessageUuid: 'assistant-primary',
    };
    const firstCanonicalTurnId = resolveContainerOutputInputTurnId(
      first,
      inputTurnId,
    );
    const firstDecision = decideAssistantPrimaryProjection({
      canonicalInputTurnId: firstCanonicalTurnId,
      ...first,
      primaryAlreadyProjected: false,
      anyReplyProjected: false,
    });
    expect(firstDecision).toEqual({
      project: true,
      canonicalTurnId: inputTurnId,
      reason: 'first_primary',
    });
    projected.push({
      turnId: firstDecision.canonicalTurnId,
      text: coordinator.resolvePrimaryAnswer(first.result).text!,
    });
    coordinator.markFinalized();

    // Exact SIGTERM shape emitted by agent-runner: session metadata only,
    // without sourceKind/inputTurnId/inputTurnCompleted.
    const trailing = {
      status: 'success' as const,
      result: null,
      newSessionId: 'session-after-sigterm',
    };
    const trailingCanonicalTurnId = resolveContainerOutputInputTurnId(
      trailing,
      inputTurnId,
    );
    const trailingDecision = decideAssistantPrimaryProjection({
      canonicalInputTurnId: trailingCanonicalTurnId,
      status: trailing.status,
      result: trailing.result,
      primaryAlreadyProjected: true,
      anyReplyProjected: true,
    });
    expect(trailingDecision).toEqual({
      project: false,
      canonicalTurnId: inputTurnId,
      reason: 'already_projected',
    });

    // Calling resolvePrimaryAnswer here would reproduce the bug: finalized
    // coordinators still retain their candidate. The decision boundary stops
    // the lifecycle frame before that recovery.
    expect(coordinator.resolvePrimaryAnswer(trailing.result).text).toBe(answer);
    expect(projected).toEqual([{ turnId: inputTurnId, text: answer }]);
  });

  test('does not suppress the only substantive result even without runner correlation', () => {
    expect(
      decideAssistantPrimaryProjection({
        canonicalInputTurnId: inputTurnId,
        status: 'success',
        result: answer,
        primaryAlreadyProjected: false,
        anyReplyProjected: false,
      }),
    ).toMatchObject({
      project: true,
      canonicalTurnId: inputTurnId,
    });
  });

  test('allows the only empty SDK final to recover its streamed candidate', () => {
    expect(
      decideAssistantPrimaryProjection({
        canonicalInputTurnId: inputTurnId,
        status: 'success',
        result: null,
        primaryAlreadyProjected: false,
        anyReplyProjected: false,
      }),
    ).toMatchObject({
      project: true,
      canonicalTurnId: inputTurnId,
    });
  });

  test('held checkpoint suppresses session-only recovery but still permits the explicit final', () => {
    const anyReplyProjectedByInput = new Map([[inputTurnId, false]]);

    // Conversation marks persistence immediately, before a held Feishu card
    // has a physical final ACK.
    anyReplyProjectedByInput.set(inputTurnId, true);
    expect(
      decideAssistantPrimaryProjection({
        canonicalInputTurnId: inputTurnId,
        status: 'success',
        result: null,
        primaryAlreadyProjected: false,
        anyReplyProjected: anyReplyProjectedByInput.get(inputTurnId) === true,
      }),
    ).toEqual({
      project: false,
      canonicalTurnId: inputTurnId,
      reason: 'trailing_lifecycle_success',
    });

    expect(
      decideAssistantPrimaryProjection({
        canonicalInputTurnId: inputTurnId,
        status: 'success',
        result: '后台任务完成后的最终汇总',
        sourceKind: 'sdk_final',
        inputTurnId,
        inputTurnCompleted: true,
        finalizationReason: 'completed',
        primaryAlreadyProjected: false,
        anyReplyProjected: anyReplyProjectedByInput.get(inputTurnId) === true,
      }),
    ).toMatchObject({
      project: true,
      canonicalTurnId: inputTurnId,
    });
  });

  test('wires the strict boundary and canonical turn identity into main and conversation paths', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );

    expect(
      source.match(/decideAssistantPrimaryProjection\(\{/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(source).toContain(
      'const effectiveTurnId = outputChannelScope.inputId;',
    );
    expect(source).toContain('? heldAgentDbTurnId || outputAgentScope.inputId');
    expect(source).toContain(
      'const agentAnyReplyProjectedByInput = new Map<string, boolean>',
    );
    expect(source).toMatch(
      /anyReplyProjected:\s+agentAnyReplyProjectedByInput\.get\(resultInputTurnId\) === true/,
    );
    expect(source).toContain(
      'agentAnyReplyProjectedByInput.set(outputAgentScope.inputId, true);',
    );
    expect(source).toMatch(
      /activeRouteAdmissions\.set\(\s+mainAdmissionKey,\s+\(newSourceJid, inputTurnId, inputCursor, coveredInputs, receipt\) => \{/,
    );
    expect(source).toMatch(
      /beforePublish hook,[\s\S]{0,500}if \(receipt\?\.deliveryId === inputTurnId\) \{\s+rememberScheduledGroupRuns\(\{\s+inputTurnId,\s+ipcReceipts: \[receipt\],/,
    );
    expect(source).toContain('scheduledGroupRunsByInput.delete(inputTurnId);');
    expect(
      source.match(
        /finalizeChannelCardAfterDelivery\(\s+pending(?:StreamingCard|AgentCard)Completion,\s+dbText,/g,
      ),
    ).toHaveLength(2);
    expect(source).not.toContain(
      'outputAlreadySent && effectiveTurnId === lastSavedTurnId',
    );

    const runnerSource = fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/index.ts'),
      'utf8',
    );
    expect(runnerSource).toMatch(
      /result: `\\u26a0\\ufe0f \$\{reason\}`,[\s\S]{0,120}sourceKind: 'input_rejection_warning'/,
    );
    expect(runnerSource).toMatch(
      /const truncationLogicalInputTurnId = activeOutputInputTurnId;[\s\S]{0,3500}'truncation_continue',\s+truncationIpcMessages,\s+mcpToolsConfig,\s+truncationLogicalInputTurnId,\s+false,/,
    );
  });
});
