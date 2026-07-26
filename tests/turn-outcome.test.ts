import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { resolveTurnOutcome } from '../src/turn-outcome.js';

describe('resolveTurnOutcome', () => {
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
    expect(branch).toContain("turnOutcome.cursor === 'commit'");
    expect(branch).toContain('return true;');
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
      'replyDeliveryAcknowledged = await sendImWithRetry',
    );
    expect(deliveryBranch).toContain(
      'replyDeliveryAcknowledged &&\n                isGenuineReplyResult',
    );
    expect(deliveryBranch).toMatch(
      /result\.inputTurnCompleted\s*&&\s*replyDeliveryAcknowledged/,
    );
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
      'streamingCardHandledIM\n                ? streamingCardAttachmentsDelivered',
    );
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
