import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  hasUnfinishedProactiveOutput,
  resolveTurnOutcome,
} from '../src/turn-outcome.js';
import { resolveStreamingCardReplyAcknowledgement } from '../src/reply-delivery.js';

describe('resolveStreamingCardReplyAcknowledgement', () => {
  const base = {
    streamingDeliveryUncertain: false,
    streamingCardHandled: false,
    attachmentsDelivered: true,
    postFinalizationStaticRequired: false,
    postFinalizationStaticDelivered: false,
    projectedTargetDelivered: true,
  };

  test('never treats a Web projection as the required failed static fallback', () => {
    expect(
      resolveStreamingCardReplyAcknowledgement({
        ...base,
        postFinalizationStaticRequired: true,
        postFinalizationStaticDelivered: false,
      }),
    ).toBe(false);
  });

  test('requires both the post-finalizer text and every attachment ACK', () => {
    expect(
      resolveStreamingCardReplyAcknowledgement({
        ...base,
        postFinalizationStaticRequired: true,
        postFinalizationStaticDelivered: true,
      }),
    ).toBe(true);
    expect(
      resolveStreamingCardReplyAcknowledgement({
        ...base,
        attachmentsDelivered: false,
        postFinalizationStaticRequired: true,
        postFinalizationStaticDelivered: true,
      }),
    ).toBe(false);
  });

  test('uncertain card evidence dominates every apparent delivery ACK', () => {
    expect(
      resolveStreamingCardReplyAcknowledgement({
        ...base,
        streamingDeliveryUncertain: true,
        streamingCardHandled: true,
        postFinalizationStaticRequired: true,
        postFinalizationStaticDelivered: true,
      }),
    ).toBe(false);
  });
});

describe('resolveTurnOutcome', () => {
  test('requires a final after progress or separate Proactive output', () => {
    expect(
      hasUnfinishedProactiveOutput({
        interactionMode: 'proactive',
        nonTerminalDelivered: true,
        finalDelivered: false,
      }),
    ).toBe(true);
    expect(
      hasUnfinishedProactiveOutput({
        interactionMode: 'proactive',
        nonTerminalDelivered: false,
        finalDelivered: false,
      }),
    ).toBe(false);
    expect(
      hasUnfinishedProactiveOutput({
        interactionMode: 'proactive',
        nonTerminalDelivered: true,
        finalDelivered: true,
      }),
    ).toBe(false);
  });
  test('retries an in-flight close with no reply or healthy completion', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: false,
        cursorCommitted: false,
        replyDelivered: false,
      }),
    ).toEqual({
      kind: 'retryable',
      cursor: 'keep',
      reason: 'runner_closed_in_flight',
    });
  });

  test('retries after an acknowledged progress update followed by runner error', () => {
    expect(
      resolveTurnOutcome({
        status: 'error',
        healthyInputTurnCompleted: false,
        cursorCommitted: false,
        replyDelivered: false,
        progressDelivered: true,
      }),
    ).toEqual({
      kind: 'retryable',
      cursor: 'keep',
      reason: 'runner_failed_in_flight',
    });
  });

  test('commits a silent close after a healthy input completion', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: true,
        cursorCommitted: false,
        replyDelivered: false,
      }),
    ).toEqual({
      kind: 'completed',
      cursor: 'commit',
      reason: 'healthy_input_completed',
    });
  });

  test('preserves the existing delivered-reply no-replay path', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: false,
        cursorCommitted: true,
        replyDelivered: true,
      }),
    ).toEqual({
      kind: 'completed',
      cursor: 'already_committed',
      reason: 'reply_delivered',
    });
  });

  test('commits a delivered reply when completion bookkeeping arrived late', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: false,
        cursorCommitted: false,
        replyDelivered: true,
      }),
    ).toEqual({
      kind: 'completed',
      cursor: 'commit',
      reason: 'reply_delivered',
    });
  });

  test('classifies a user stop separately and commits the discarded input', () => {
    expect(
      resolveTurnOutcome({
        status: 'closed',
        healthyInputTurnCompleted: false,
        cursorCommitted: false,
        replyDelivered: false,
        stopRequested: true,
      }),
    ).toEqual({
      kind: 'stopped',
      cursor: 'commit',
      reason: 'user_stop',
    });
  });

  test('classifies deterministic failures as commit-without-retry', () => {
    expect(
      resolveTurnOutcome({
        status: 'error',
        healthyInputTurnCompleted: false,
        cursorCommitted: false,
        replyDelivered: false,
        deterministicFailure: true,
      }),
    ).toEqual({
      kind: 'deterministic_failure',
      cursor: 'commit',
      reason: 'configuration_or_input',
    });
  });

  test('wires prompt and startup-budget validation errors to deterministic completion', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const branch = main.slice(
      main.indexOf("errorDetail.startsWith('context_budget_exceeded:')"),
      main.indexOf('// 上下文溢出错误'),
    );

    expect(branch).toContain("errorDetail.startsWith('prompt_plan_invalid:')");
    expect(branch).toContain('deterministicFailure: true');
    // Commits and resolves the attempt (see terminal-system-notice.test.ts).
    expect(branch).toContain('return settleDeterministicFailure(');
  });

  test('does not treat a DB-only interrupted partial as a delivered close reply', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const closedBranch = main.slice(
      main.indexOf("if (output.status === 'closed')"),
      main.indexOf('// Query 出错时'),
    );

    expect(closedBranch).toContain(
      'activeGenuineReplyDelivered || ipcReplyTurnTracker.delivered',
    );
    expect(closedBranch).not.toContain('replyDelivered: sentReply');
  });

  test('commits an already-delivered reply when the runner throws before returning output', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const missingOutputBranch = main.slice(
      main.indexOf('if (!output) {'),
      main.indexOf('const stopDisposition ='),
    );

    expect(missingOutputBranch).toContain(
      'activeGenuineReplyDelivered || ipcReplyTurnTracker.delivered',
    );
    expect(missingOutputBranch).toContain('commitCursor();');
    expect(missingOutputBranch).not.toContain('sentReply');
  });

  test('does not mark or commit a final reply until the physical channel ACKs it', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const deliveryBranch = main.slice(
      main.indexOf('const replySendOutcome = await sendMessageWithOutcome'),
      main.indexOf('// Only reset idle timer on actual results'),
    );

    expect(deliveryBranch).toContain('let replyDeliveryAcknowledged');
    expect(deliveryBranch).toContain(
      'const routedFallbackDelivered = await sendImWithRetry',
    );
    expect(deliveryBranch).toContain(
      'replyDeliveryAcknowledged =\n                    routedFallbackDelivered',
    );
    expect(deliveryBranch).toContain(
      'postFinalizationStaticDelivered = await sendImWithRetry',
    );
    expect(deliveryBranch).toContain(
      'replyDeliveryAcknowledged &&\n                isGenuineReplyResult',
    );
    expect(deliveryBranch).toContain('if (result.inputTurnCompleted) {');
    expect(deliveryBranch).toContain(
      'if (!(await completeChannelRuntimesForOutput(result)))',
    );
    expect(deliveryBranch).toContain(
      'replyDeliveryAcknowledged ||\n                  Boolean(',
    );
    expect(deliveryBranch).toContain('getFailedChannelOutboxForTurn(');
    expect(deliveryBranch).not.toContain(
      'if (result.inputTurnCompleted) commitCursor()',
    );
  });

  test('routes streaming-card local images through the exact turn outbox and includes their ACK', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const cardAttachmentBranch = main.slice(
      main.indexOf(
        '// Streaming card strips local image references (only img_xxx keys',
      ),
      main.indexOf('// Skip IM send to the original chatJid when:'),
    );
    const deliveryAckBranch = main.slice(
      main.indexOf('let replyDeliveryAcknowledged ='),
      main.indexOf('// For routed IM (web JID with IM source)'),
    );

    expect(cardAttachmentBranch).toContain(
      'const delivered = await sendTaskImageWithRetry',
    );
    expect(cardAttachmentBranch).toContain(
      'scopeToken: outputChannelScope.scope.token',
    );
    expect(cardAttachmentBranch).toContain(
      'ordinalSlot: `streaming-card-image:${imageIndex}`',
    );
    expect(cardAttachmentBranch).not.toContain('imManager.sendImage');
    expect(deliveryAckBranch).toContain(
      'resolveStreamingCardReplyAcknowledgement({',
    );
    expect(deliveryAckBranch).toContain(
      'streamingDeliveryUncertain: streamingCardDeliveryUncertain',
    );
    expect(deliveryAckBranch).toContain(
      'attachmentsDelivered: streamingCardAttachmentsDelivered',
    );
    expect(deliveryAckBranch).toContain('postFinalizationStaticRequired');
  });

  test('conversation card safe fallback never replays ACKed images and requires their ACK', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const agentStart = main.indexOf('async function processAgentConversation(');
    const branchStart = main.indexOf(
      '// Provider cards cannot embed local filesystem images.',
      agentStart,
    );
    const branch = main.slice(
      branchStart,
      main.indexOf(
        '// Optional mirror mode for linked IM channels',
        branchStart,
      ),
    );
    const acknowledgementBranch = main.slice(
      main.indexOf('const agentReplyDeliveryAcknowledged =', branchStart),
      main.indexOf('if (agentReplyDeliveryAcknowledged &&', branchStart),
    );

    expect(
      branch.indexOf('const delivered = await sendTaskImageWithRetry'),
    ).toBeLessThan(branch.indexOf('await finalizeChannelCardAfterDelivery('));
    expect(
      branch.indexOf('await finalizeChannelCardAfterDelivery('),
    ).toBeLessThan(
      branch.indexOf('const agentStaticTextDelivered = await sendImWithRetry'),
    );
    expect(branch).toContain(
      'pendingAgentCardCompletion ? [] : localImagePaths',
    );
    expect(branch).toContain(
      'agentStaticTextDelivered && agentCardAttachmentsDelivered',
    );
    expect(acknowledgementBranch).toContain('agentStaticImDelivered');
  });

  test('does not emit a second channel error after an uncertain durable file send', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const fileBranch = main.slice(
      main.indexOf('const regularFileOutboxRef'),
      main.indexOf("'No IM route for send_file, skipped IM delivery'"),
    );

    expect(fileBranch).toContain('const durableScopedFile');
    expect(fileBranch).toContain('投递结果待确认');
    expect(fileBranch).toContain('if (!durableScopedFile)');
    expect(fileBranch).toContain(
      'await imManager.sendMessage(regularFileImRoute, failMsg)',
    );
  });

  test('main and agent definitive outbox failures terminalize failed with an independent notice', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const mainCompletion = main.slice(
      main.indexOf('const completeChannelRuntimesForOutput'),
      main.indexOf('const channelScopeForOutput'),
    );
    const agentCompletion = main.slice(
      main.indexOf('const completeAgentChannelRuntimesForOutput'),
      main.indexOf('const agentScopeForOutput'),
    );
    for (const branch of [mainCompletion, agentCompletion]) {
      expect(branch).toContain('getFailedChannelOutboxForTurn(runtime.runId)');
      expect(branch.indexOf('getUncertainChannelOutboxForTurn')).toBeLessThan(
        branch.indexOf('getFailedChannelOutboxForTurn'),
      );
      expect(branch).toContain('runtime.fail(');
      expect(branch).toContain('deliverChannelDefinitiveFailureNotice({');
      expect(branch).toContain('getDeliveredChannelOutboxForTurn');
      expect(branch).not.toContain('runtime.retry(');
    }
  });

  test('returns a negative MCP image acknowledgement when physical delivery is unconfirmed', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const imageBranch = main.slice(
      main.indexOf('let regularImageDelivered'),
      main.indexOf("'IPC image sent'"),
    );

    expect(imageBranch).toContain(
      'regularImageDelivered = await sendTaskImageWithRetry',
    );
    expect(imageBranch).toContain('regularImageDelivered\n');
    expect(imageBranch).toContain('success: false');
    expect(imageBranch).toContain('do not retry automatically');
  });

  test('interrupts and commits an uncertain turn instead of scheduling another Agent loop', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const mainCleanup = main.slice(
      main.indexOf('if (channelTurnRuntimes.size > 0)'),
      main.indexOf('// ── 保存中断内容到数据库'),
    );
    expect(mainCleanup).toContain('getUncertainChannelOutboxForTurn');
    expect(mainCleanup).toContain('runtime.interrupt');
    expect(mainCleanup).toContain('commitCursor();');
    expect(mainCleanup).toContain(
      'await deliverChannelManualReconciliationNotice',
    );
    expect(mainCleanup).toContain(
      "interactionMode === 'proactive' ? 'native' : 'default'",
    );

    const postCleanup = main.slice(
      main.indexOf('// runAgent threw — output is undefined'),
      main.indexOf('const stopDisposition ='),
    );
    expect(postCleanup).toContain(
      'if (channelDeliveryNeedsManualReconciliation)',
    );
    expect(postCleanup).toContain(
      'return channelManualNoticesAcknowledged && activeCursorCommitted;',
    );

    const agentCleanup = main.slice(
      main.indexOf('if (agentChannelTurnRuntimes.size > 0)'),
      main.indexOf('// ── 保存中断内容 ──'),
    );
    expect(agentCleanup).toContain('getUncertainChannelOutboxForTurn');
    expect(agentCleanup).toContain('runtime.interrupt');
    expect(agentCleanup).toContain('retryUnfinishedTurn = false');
    expect(agentCleanup).toContain('retryUnfinishedTurn = true');
  });

  test('projects MCP send_message to Web but delivers raw native content through the exact input Outbox', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const branchStart = main.indexOf(
      '// Feishu card JSON: store extracted markdown for web',
    );
    const branch = main.slice(
      branchStart,
      main.indexOf(
        'recordSuccessfulIpcSend(sourceGroup, data.chatJid, data.text)',
        branchStart,
      ),
    );

    expect(branch).toContain('sendToIM: false');
    expect(branch).toContain('effectiveChatJid');
    expect(branch).toContain('projectionMessageId');
    expect(branch).toContain('resolveImRoute({');
    expect(branch).toContain('ipcAgentId,');
    expect(branch).toContain('data.inputTurnId');
    expect(branch).toContain('const messageScopeKey = channelTurnScope(');
    // The IM leg must receive the raw native payload, not the Web projection.
    // Whitespace-insensitive so nesting changes (e.g. adding a guard around the
    // send) do not break an assertion about argument order.
    expect(branch.replace(/\s+/g, ' ')).toContain(
      'sendImWithRetry( ipcImRoute, data.text,',
    );
    expect(branch.indexOf('sendImWithRetry(')).toBeLessThan(
      branch.indexOf('const sendOutcome = await sendMessageWithOutcome'),
    );
    expect(branch).not.toContain('imTextOverride: webText');
  });
});
