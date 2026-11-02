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
      '\nasync function clearSessionRuntimeFiles(',
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

  test('cold session and follow-up both await plugin delivery before cursor/release', () => {
    expect(source.match(/await sendPluginExpanderReply\(/g)).toHaveLength(2);
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
    // The first call is follow-up (asserted above). The cold session start is
    // the other and must gate its cursor locally.
    for (const callIndex of callIndexes.slice(1)) {
      const callSite = source.slice(callIndex, callIndex + 2_000);
      const ackGate = callSite.indexOf('if (!delivery.acknowledged)');
      const cursorAdvance = callSite.indexOf('advanceReplyCursor(');
      expect(ackGate).toBeGreaterThanOrEqual(0);
      expect(cursorAdvance).toBeGreaterThan(ackGate);
    }
  });

  test('main and session replies never fan out to other bound channels', () => {
    expect(source).not.toContain('const mirrorScope = bindChannelOutboxScope(');
    expect(source).not.toContain('resolveStickyChannelOwner(');
    expect(source).not.toContain('getSessionChannelOwner(');
    expect(source).toContain('resolveBatchChannelReplySource(missedMessages)');
    expect(source).toContain('activeChannelOutboxScopes.resolveInputScope(');
  });
});
