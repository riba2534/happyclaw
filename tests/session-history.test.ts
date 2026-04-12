import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  __test__,
  extractSessionHistory,
  parseTranscript,
} from '../container/agent-runner/src/session-history';

const { RECOVERY_HISTORY_LIMIT, RECOVERY_MESSAGE_TRUNCATE, LONE_SURROGATE_RE } =
  __test__;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-history-test-'));
});

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeTranscript(sessionId: string, lines: object[]): void {
  const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    lines.map((l) => JSON.stringify(l)).join('\n'),
  );
}

describe('parseTranscript', () => {
  test('extracts user and assistant text content', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: { content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hi back' }],
        },
      }),
    ].join('\n');

    const messages = parseTranscript(content);
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi back' },
    ]);
  });

  test('tolerates malformed JSONL lines', () => {
    const content = [
      JSON.stringify({ type: 'user', message: { content: 'first' } }),
      'this is not valid json',
      '{not even close',
      JSON.stringify({ type: 'user', message: { content: 'last' } }),
    ].join('\n');

    const messages = parseTranscript(content);
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'last' },
    ]);
  });

  test('skips messages without text content', () => {
    const content = [
      JSON.stringify({ type: 'user', message: { content: '' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'x' }] },
      }),
    ].join('\n');

    expect(parseTranscript(content)).toEqual([]);
  });
});

describe('extractSessionHistory', () => {
  test('returns null when transcript file missing', () => {
    const result = extractSessionHistory({
      transcriptDir: tmpDir,
      sessionId: 'nonexistent',
    });
    expect(result).toBeNull();
  });

  test('honors RECOVERY_HISTORY_LIMIT (only last N messages)', () => {
    // Write 25 messages, expect only the last 20 to appear
    const messages = Array.from({ length: 25 }, (_, i) => ({
      type: 'user',
      message: { content: `msg-${i}` },
    }));
    writeTranscript('s1', messages);

    const result = extractSessionHistory({
      transcriptDir: tmpDir,
      sessionId: 's1',
    });
    expect(result).not.toBeNull();
    // First 5 messages should be dropped, msg-5..msg-24 should remain
    expect(result).not.toContain('msg-4');
    expect(result).toContain('msg-5');
    expect(result).toContain('msg-24');
    // Quick sanity check: should have exactly RECOVERY_HISTORY_LIMIT entries
    const lineCount = (result!.match(/\[User\]/g) || []).length;
    expect(lineCount).toBe(RECOVERY_HISTORY_LIMIT);
  });

  test('truncates messages longer than RECOVERY_MESSAGE_TRUNCATE characters', () => {
    const longText = 'x'.repeat(RECOVERY_MESSAGE_TRUNCATE + 100);
    writeTranscript('s2', [
      { type: 'user', message: { content: longText } },
    ]);

    const result = extractSessionHistory({
      transcriptDir: tmpDir,
      sessionId: 's2',
    });
    expect(result).not.toBeNull();
    // Should have exactly RECOVERY_MESSAGE_TRUNCATE 'x' characters followed by '…'
    const xRun = 'x'.repeat(RECOVERY_MESSAGE_TRUNCATE);
    expect(result).toContain(xRun + '…');
    // Should NOT contain the truncated tail (one extra x)
    expect(result).not.toContain(xRun + 'x');
  });

  test('strips lone surrogates while preserving valid emoji surrogate pairs', () => {
    // Build a string with: valid emoji 😀 (U+1F600 = D83D DE00),
    // lone high surrogate D800, lone low surrogate DC00, plain ASCII
    const validEmoji = '\uD83D\uDE00'; // 😀
    const loneHigh = '\uD800';
    const loneLow = '\uDC00';
    const input = `hi ${validEmoji} ${loneHigh} ${loneLow} bye`;

    writeTranscript('s3', [
      { type: 'user', message: { content: input } },
    ]);

    const result = extractSessionHistory({
      transcriptDir: tmpDir,
      sessionId: 's3',
    });
    expect(result).not.toBeNull();
    // Valid emoji should be preserved
    expect(result).toContain(validEmoji);
    // Lone surrogates should be stripped
    expect(result).not.toContain(loneHigh);
    expect(result).not.toContain(loneLow);
  });

  test('returns null when transcript has zero recoverable messages', () => {
    writeTranscript('s4', [
      { type: 'system', message: { content: 'meta only' } },
    ]);

    const result = extractSessionHistory({
      transcriptDir: tmpDir,
      sessionId: 's4',
    });
    expect(result).toBeNull();
  });

  test('returns null and does not throw on malformed transcript', () => {
    const transcriptPath = path.join(tmpDir, 'sbad.jsonl');
    fs.writeFileSync(transcriptPath, 'completely invalid jsonl\n!@#$%');

    const result = extractSessionHistory({
      transcriptDir: tmpDir,
      sessionId: 'sbad',
    });
    // parseTranscript tolerates malformed lines and returns []. Then
    // extractSessionHistory returns null because messages.length === 0.
    expect(result).toBeNull();
  });

  test('wraps history in <system_context> block with restart prelude', () => {
    writeTranscript('s5', [
      { type: 'user', message: { content: 'hello' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      },
    ]);

    const result = extractSessionHistory({
      transcriptDir: tmpDir,
      sessionId: 's5',
    });
    expect(result).toContain('<system_context>');
    expect(result).toContain('</system_context>');
    expect(result).toContain('[User] hello');
    expect(result).toContain('[HappyClaw] hi');
  });
});

describe('LONE_SURROGATE_RE invariant', () => {
  // This regex MUST stay byte-for-byte aligned with the inline copy in
  // src/index.ts (recoveryGroups path). If you edit this test, also audit
  // src/index.ts to keep both code paths producing identical strings.
  test('matches lone high surrogate', () => {
    expect('\uD800'.replace(LONE_SURROGATE_RE, '')).toBe('');
  });

  test('matches lone low surrogate', () => {
    expect('\uDC00'.replace(LONE_SURROGATE_RE, '')).toBe('');
  });

  test('preserves valid surrogate pair', () => {
    const pair = '\uD83D\uDE00'; // 😀
    expect(pair.replace(LONE_SURROGATE_RE, '')).toBe(pair);
  });

  test('preserves ASCII text', () => {
    expect('hello world'.replace(LONE_SURROGATE_RE, '')).toBe('hello world');
  });
});
