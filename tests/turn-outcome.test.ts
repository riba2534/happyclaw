import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  hasUnfinishedProactiveOutput,
  resolveTurnOutcome,
} from '../src/turn-outcome.js';

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
      main.indexOf('const settleAgentErrorExit = async'),
      main.indexOf("errorDetail.startsWith('context_overflow:')"),
    );

    expect(branch).toContain(
      'const budgetError = /^(?:context_budget_exceeded|prompt_plan_invalid):\\s*/;',
    );
    // Commits and resolves the attempt (see terminal-system-notice.test.ts).
    expect(branch).toMatch(
      /await settleAgentDeterministicFailure\(\s*'context-budget',/,
    );
  });

  test('does not treat a DB-only interrupted partial as a delivered close reply', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const closedBranch = main.slice(
      main.indexOf(
        "} else if (output.status === 'closed' && !runnerClosedBySteer) {",
      ),
      main.indexOf("'Conversation agent close resolved without replay',"),
    );

    expect(closedBranch).toContain(
      'replyDelivered: activeAgentInputPhysicallyAcknowledged',
    );
    expect(closedBranch).not.toContain('agentReplySentByInput');
  });

  test('commits an already-delivered reply when the runner throws before returning output', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const start = main.indexOf(
      '// The runner threw before returning a terminal output.',
    );
    const missingOutputBranch = main.slice(
      start,
      main.indexOf('  } finally {', start),
    );

    expect(missingOutputBranch).toContain('wasGenuineReplyDeliveredForInput(');
    expect(missingOutputBranch).toContain('agentIpcReplyTracker.delivered');
    expect(missingOutputBranch).toContain('commitCursor();');
    expect(missingOutputBranch).toContain('retryUnfinishedTurn = true;');
    expect(missingOutputBranch).not.toContain('agentReplySentByInput');
  });

  test('does not complete a final reply until the physical channel ACKs it', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const deliveryBranch = main.slice(
      main.indexOf('const agentReplyDeliveryAcknowledged ='),
      main.indexOf('// Per-turn snapshot cleanup'),
    );

    expect(deliveryBranch).toContain('if (!agentReplyDeliveryAcknowledged) {');
    expect(deliveryBranch).toContain(
      'host_turn_settlement_failed: final agent reply was not physically acknowledged',
    );
    expect(
      deliveryBranch.indexOf('if (!agentReplyDeliveryAcknowledged) {'),
    ).toBeLessThan(
      deliveryBranch.indexOf('completeAgentChannelRuntimesForOutput(output)'),
    );
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

  test('definitive outbox failures terminalize failed with an independent notice', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const agentCompletion = main.slice(
      main.indexOf('const completeAgentChannelRuntimesForOutput'),
      main.indexOf('const agentScopeForOutput'),
    );
    for (const branch of [agentCompletion]) {
      expect(branch).toContain('getFailedChannelOutboxForTurn(runtime.runId)');
      expect(branch.indexOf('getUncertainChannelOutboxForTurn')).toBeLessThan(
        branch.indexOf('getFailedChannelOutboxForTurn'),
      );
      expect(branch).toContain('settleChannelTurnDefinitiveFailure({');
      expect(branch).not.toContain('runtime.retry(');
    }
    // The shared settlement fails the Turn with a reasoned notice, except a
    // vanished target (recalled anchor) which closes quietly as cancelled.
    const settlement = main.slice(
      main.indexOf('async function settleChannelTurnDefinitiveFailure('),
      main.indexOf('async function deliverIndependentChannelSystemNotice('),
    );
    expect(settlement).toContain('runtime.fail(');
    expect(settlement).toContain('deliverChannelDefinitiveFailureNotice({');
    expect(settlement).toContain('getDeliveredChannelOutboxForTurn');
    expect(settlement).toContain('detail?.targetUnavailable');
    expect(settlement).toContain('runtime.cancel(');
    expect(settlement).toContain('reason: detail?.reason');
    expect(settlement).not.toContain('runtime.retry(');
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
    const agentCleanup = main.slice(
      main.indexOf('if (agentChannelTurnRuntimes.size > 0)'),
      main.indexOf('// ── 保存中断内容 ──'),
    );
    expect(agentCleanup).toContain('getUncertainChannelOutboxForTurn');
    expect(agentCleanup).toContain('runtime.interrupt');
    expect(agentCleanup).toContain('retryUnfinishedTurn = false');
    expect(agentCleanup).toContain('retryUnfinishedTurn = true');
    expect(agentCleanup).toContain(
      'await deliverChannelManualReconciliationNotice',
    );
    expect(agentCleanup).toContain(
      "interactionMode === 'proactive' ? 'native' : 'default'",
    );
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
