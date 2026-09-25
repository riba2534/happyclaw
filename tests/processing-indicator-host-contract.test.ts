import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

const main = fs.readFileSync('src/index.ts', 'utf8');

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('exact processing indicator host contract', () => {
  test('cold main and conversation-agent batches activate selected batch owners', () => {
    expect(
      main.match(/await activateBatchProcessingIndicators\(/g),
    ).toHaveLength(2);
    expect(main).toContain(
      'initialProcessingIndicatorOwners.map((owner) => owner.inputTurnId)',
    );
    expect(main).toContain(
      'initialAgentProcessingIndicatorOwners.map((owner) => owner.inputTurnId)',
    );
  });

  test('warm delivery ids select one Feishu batch owner from covered inputs', () => {
    expect(main).toMatch(
      /receipt\.coveredCursors \?\? \[receipt\.cursor\]\)\.map\(\(cursor\) => \(\{\s*id: cursor\.id,\s*sourceJid: cursor\.sourceJid/,
    );
    expect(
      main.match(/coveredInputs && coveredInputs\.length > 0/g),
    ).toHaveLength(2);
    expect(
      main.match(/selectBatchProcessingIndicatorOwners\(/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(main).toContain(
      'processingTypingLeaseIdsByCompletion.set(inputTurnId, inputTurnId)',
    );
    expect(main).toContain('agentProcessingTypingLeaseIdsByCompletion.set(');
  });

  test('warm main and agent inputs retain selected cross-route ack ownership', () => {
    expect(main).toMatch(
      /candidateSourceJid = message\.source_jid \?\? message\.chat_jid/,
    );
    expect(
      main.match(
        /selectedIndicatorOwners\.map\(\(owner\) => owner\.inputTurnId\)/g,
      ),
    ).toHaveLength(2);
    expect(
      main.match(
        /(?:agentProcessingIndicatorJidsByInput|processingIndicatorJidsByInput)\.set\(\s*owner\.inputTurnId,\s*owner\.transportJid/g,
      ),
    ).toHaveLength(4);
  });

  test('terminal cleanup releases the delivery typing lease separately and retains failed ack owners', () => {
    expect(
      main.match(/clearTrackedTypingIndicator\(\s*(?:chatJid|virtualChatJid)/g),
    ).toHaveLength(2);
    expect(main).not.toMatch(
      /setTyping\(\s*(?:chatJid|virtualChatJid),\s*false,\s*exactInputId/,
    );
    expect(
      main.match(
        /if \(ackCleared\) \{[\s\S]{0,220}untrackProcessingIndicator/g,
      ),
    ).toHaveLength(2);
    expect(main).toMatch(
      /if \(ackCleared\) untrackProcessingIndicator\(logicalJid, inputTurnId\)/,
    );
  });

  test('a new cold run releases typing leases superseded by a replayed batch', () => {
    // A runner closed mid-turn is replayed with a larger batch keyed by a
    // newer input id; the earlier input's lease must not keep typing alive.
    expect(main).toMatch(
      /await initialTypingReady;\s+await releaseSupersededTypingIndicators\(chatJid, lastProcessed\.id\)/,
    );
    expect(main).toMatch(
      /await initialAgentTypingReady;\s+await releaseSupersededTypingIndicators\(virtualChatJid, lastProcessed\.id\)/,
    );
    const release = sourceBetween(
      main,
      'async function releaseSupersededTypingIndicators(',
      'async function clearTrackedProcessingIndicators(',
    );
    expect(release).toMatch(/leaseId !== currentLeaseId/);
    expect(release).toMatch(
      /clearTrackedTypingIndicator\(logicalJid, leaseId\)/,
    );
  });

  test('queued batch hand-off waits for old provider cleanup before adding the next reaction', () => {
    expect(main).toMatch(
      /await clearTrackedProcessingIndicators\(chatJid\);\s+await beginBatchAckReactions\(chatJid, prePublishedIndicatorOwners\)/,
    );
  });

  test('native message delivery itself does not clear a turn indicator', () => {
    for (const file of [
      'src/feishu.ts',
      'src/discord.ts',
      'src/dingtalk.ts',
      'src/telegram.ts',
    ]) {
      const source = fs.readFileSync(file, 'utf8');
      const sendStart = source.indexOf('async sendMessage(');
      const sendEnd = source.indexOf('\n    },', sendStart) + '\n    },'.length;
      expect(source.slice(sendStart, sendEnd)).not.toMatch(
        /clearAckReaction|ackReactions\.clear/,
      );
    }
  });

  test('provider registry keys omit HappyClaw account scoping on attach', () => {
    const manager = fs.readFileSync('src/im-manager.ts', 'utf8');
    const attach = sourceBetween(
      manager,
      'async beginAckReaction(',
      'async clearAckReaction(',
    );
    const clear = sourceBetween(
      manager,
      'async clearAckReaction(',
      'async createStreamingSession(',
    );
    expect(attach).toMatch(/const chatId = extractProviderTarget\(jid\)/);
    expect(clear).toMatch(/const chatId = extractProviderTarget\(jid\)/);
    expect(attach).not.toMatch(/scopeChannelJid/);
    expect(clear).not.toMatch(/scopeChannelJid/);
  });

  test('ack provider release failures propagate back to the ownership registry', () => {
    const feishu = fs.readFileSync('src/feishu.ts', 'utf8');
    const strictFeishuRemoval = sourceBetween(
      feishu,
      'async function removeReactionStrict(',
      'function clearAckForInput(',
    );
    expect(strictFeishuRemoval).toMatch(/messageReaction\.delete/);
    expect(strictFeishuRemoval).not.toMatch(/\bcatch\b/);
    expect(feishu).toMatch(
      /ackReactions[\s\S]*removeReactionStrict\(messageId, reactionId\)/,
    );

    // The best-effort variant is gone along with its only caller, the
    // chat-level typing reaction that the exact per-input ack replaced.
    // Reintroducing a swallowing wrapper would silently orphan ack handles.
    expect(feishu).not.toMatch(/removeReactionBestEffort/);

    const discord = fs.readFileSync('src/discord.ts', 'utf8');
    const discordRecall = sourceBetween(
      discord,
      'async function recallAckReaction(',
      '// ─── Message Handling',
    );
    expect(discordRecall).toMatch(/reaction\.users\.remove/);
    expect(discordRecall).not.toMatch(/\bcatch\b/);

    const dingtalk = fs.readFileSync('src/dingtalk.ts', 'utf8');
    const dingtalkRecall = sourceBetween(
      dingtalk,
      'async function recallAckReaction(',
      '// ─── Message Sending',
    );
    expect(dingtalkRecall).toMatch(/\/v1\.0\/robot\/emotion\/recall/);
    expect(dingtalkRecall).not.toMatch(/\bcatch\b/);
  });
});
