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
  test('cold main and conversation-agent batches retain every covered DB input', () => {
    expect(main).toMatch(
      /processingIndicatorInputsByCompletion[\s\S]*missedMessages\.map\(\(message\) => message\.id\)/,
    );
    expect(main).toMatch(
      /agentProcessingIndicatorInputsByCompletion[\s\S]*missedMessages\.map\(\(message\) => message\.id\)/,
    );
  });

  test('warm delivery ids expand back to their covered original input ids', () => {
    expect(main).toMatch(
      /receipt\.coveredCursors \?\? \[receipt\.cursor\]\)\.map\(\(cursor\) => \(\{\s*id: cursor\.id,\s*sourceJid: cursor\.sourceJid/,
    );
    expect(main).toMatch(
      /processingIndicatorInputsByCompletion\.set\(inputTurnId, exactInputIds\)/,
    );
    expect(main).toMatch(
      /agentProcessingIndicatorInputsByCompletion\.set\([\s\S]*inputTurnId,[\s\S]*exactInputIds/,
    );
    // Provider ACK owners are only original DB inputs. The delivery id is a
    // separate typing lease, so cleanup cannot confuse one namespace for the
    // other.
    expect(
      main.match(/coveredInputs && coveredInputs\.length > 0/g),
    ).toHaveLength(2);
    expect(
      main.match(/new Set\(exactInputs\.map\(\(input\) => input\.id\)\)/g),
    ).toHaveLength(2);
    expect(main).toContain(
      'processingTypingLeaseIdsByCompletion.set(inputTurnId, inputTurnId)',
    );
    expect(main).toContain('agentProcessingTypingLeaseIdsByCompletion.set(');
  });

  test('warm main and agent inputs retain exact cross-route ack ownership', () => {
    expect(main).toMatch(
      /candidateSourceJid = message\.source_jid \?\? message\.chat_jid/,
    );
    expect(
      main.match(
        /exactInput\.sourceJid && getChannelType\(exactInput\.sourceJid\)/g,
      ),
    ).toHaveLength(2);
    expect(
      main.match(
        /(?:agentProcessingIndicatorJidsByInput|processingIndicatorJidsByInput)\.set\(\s*exactInput\.id,\s*processingIndicatorJid/g,
      ),
    ).toHaveLength(2);
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
    for (const file of ['src/feishu.ts', 'src/discord.ts', 'src/dingtalk.ts']) {
      expect(fs.readFileSync(file, 'utf8')).toMatch(/extractProviderTarget/);
    }
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
      /ackReactions[\s\S]*removeReactionStrict\(ackMessageId, reactionId\)/,
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
