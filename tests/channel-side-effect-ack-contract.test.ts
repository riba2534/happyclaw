import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/index.ts'),
  'utf8',
);

function sliceBetween(start: string, end: string, from = 0): string {
  const startIndex = source.indexOf(start, from);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(
    0,
  );
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('strict physical acknowledgement contract', () => {
  test('plugin-expander reply owns an auxiliary durable Turn and awaits its exact Outbox ACK', () => {
    const helper = sliceBetween(
      'async function sendPluginExpanderReply(',
      '\nfunction getSessionClaudeDir(',
    );

    expect(helper).toContain(
      'externalMessageId: `${options.originalMessageId}:plugin-expander-reply`',
    );
    expect(helper).toContain('correlationId: options.originalMessageId');
    expect(helper).toContain('const scope = bindChannelOutboxScope(');
    expect(helper).toContain('acknowledged = await sendImWithRetry(');
    expect(helper).toContain('runtime.markFinalizing()');
    expect(helper).toContain('runtime.complete({');
    expect(helper).toContain("if (disposition === 'manual_reconciliation')");
    expect(helper).toContain(
      'await deliverChannelManualReconciliationNotice({',
    );
    expect(helper).not.toContain('void sendImWith');
  });

  test('cold main, cold agent, warm runner and follow-up all await plugin delivery before cursor/release', () => {
    expect(source.match(/await sendPluginExpanderReply\(/g)).toHaveLength(4);
    expect(source).not.toMatch(/void\s+sendPluginExpanderReply\(/);

    const followUp = sliceBetween(
      'async function completeFollowUpReply(',
      '\nfunction enqueueReleasedFollowUp(',
    );
    expect(
      followUp.indexOf('if (!delivery.acknowledged) return false;'),
    ).toBeLessThan(followUp.indexOf('releaseQueuedFollowUp('));

    const callIndexes = [
      ...source.matchAll(/await sendPluginExpanderReply\(/g),
    ].map((match) => match.index);
    // The first call is follow-up (asserted above). Cold main, cold Agent, and
    // warm IPC are the remaining three and must gate their cursor locally.
    for (const callIndex of callIndexes.slice(1)) {
      const callSite = source.slice(callIndex, callIndex + 2_000);
      const ackGate = callSite.indexOf('if (!delivery.acknowledged)');
      const cursorAdvance = callSite.indexOf('advanceReplyCursor(');
      expect(ackGate).toBeGreaterThanOrEqual(0);
      expect(cursorAdvance).toBeGreaterThan(ackGate);
    }
  });

  test('main and agent mirror paths await exact-target durable Outboxes and join primary ACK', () => {
    const mainMirror = sliceBetween(
      '// Optional mirror mode for explicitly bound IM channels',
      '\n              if (occupiesPrimarySlot) {',
    );
    expect(mainMirror).toContain('const mirrorScope = bindChannelOutboxScope(');
    expect(mainMirror).toContain('const delivered = await sendImWithRetry(');
    expect(mainMirror).toContain('scopeToken: mirrorScope.token');
    expect(mainMirror).toContain(
      'replyDeliveryAcknowledged &&= mirrorDeliveryAcknowledged;',
    );
    expect(mainMirror).not.toContain('sendImWithFailTracking');

    const agentMirror = sliceBetween(
      '// Optional mirror mode for linked IM channels',
      '\n        if (agentReplyDeliveryAcknowledged && occupiesPrimarySlot)',
    );
    expect(agentMirror).toContain(
      'const mirrorScope = bindChannelOutboxScope(',
    );
    expect(agentMirror).toContain('const delivered = await sendImWithRetry(');
    expect(agentMirror).toContain('scopeToken: mirrorScope.token');
    expect(agentMirror).toContain('agentMirrorDeliveryAcknowledged;');
    expect(agentMirror).not.toContain('sendImWithFailTracking');
  });
});
