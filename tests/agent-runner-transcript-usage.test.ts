import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AssistantUsageCollector } from '../container/agent-runner/src/assistant-usage.js';
import {
  createTranscriptUsageLoader,
  loadTranscriptAssistantUsage,
} from '../container/agent-runner/src/transcript-usage.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-usage-'));
  tempDirs.push(dir);
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

function assistantLine(
  id: string,
  usage: Record<string, unknown>,
  model = 'gpt-6-sol',
) {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    message: { id, model, usage, content: [] },
  };
}

describe('loadTranscriptAssistantUsage', () => {
  test('parses assistant usage lines and keeps the largest snapshot per ID', () => {
    const file = writeTranscript([
      { type: 'user', message: { id: 'not-an-assistant' } },
      assistantLine('msg-a', { input_tokens: 0, output_tokens: 0 }),
      assistantLine('msg-a', {
        input_tokens: 51619,
        output_tokens: 113,
        cache_read_input_tokens: 0,
      }),
      assistantLine('msg-b', { input_tokens: 10, output_tokens: 5 }),
      'not json',
      { type: 'assistant', message: { id: 'msg-c' } },
    ]);
    const usage = loadTranscriptAssistantUsage(file);
    expect(usage.get('msg-a')).toMatchObject({
      id: 'msg-a',
      inputTokens: 51619,
      outputTokens: 113,
      total: 51732,
    });
    expect(usage.get('msg-b')).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(usage.has('msg-c')).toBe(false);
  });

  test('returns an empty map for a missing file', () => {
    expect(
      loadTranscriptAssistantUsage('/nonexistent/path/session.jsonl'),
    ).toEqual(new Map());
  });
});

describe('AssistantUsageCollector transcript backfill', () => {
  function zeroAssistant(id: string, model: string) {
    return {
      type: 'assistant',
      uuid: `uuid-${id}`,
      message: { id, model, usage: {}, content: [] },
    };
  }

  test('backfills a zero snapshot from the transcript loader', () => {
    const collector = new AssistantUsageCollector();
    collector.ingest(zeroAssistant('resp_1', 'gpt-6-sol'));
    const loader = vi.fn(() => {
      const map = new Map();
      map.set('resp_1', {
        id: 'resp_1',
        model: 'gpt-6-sol',
        inputTokens: 51619,
        outputTokens: 113,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        total: 51732,
      });
      return map;
    });
    expect(collector.drain('session-1', loader)).toMatchObject({
      eventId: 'claude-code:resp_1',
      tokens: { inputTokens: 51619, outputTokens: 113 },
    });
    expect(loader).toHaveBeenCalledOnce();
  });

  test('keeps the zero snapshot when the transcript has no entry', () => {
    const collector = new AssistantUsageCollector();
    collector.ingest(zeroAssistant('resp_2', 'gpt-6-sol'));
    expect(collector.drain('session-1', () => new Map())).toMatchObject({
      eventId: 'claude-code:resp_2',
      tokens: { inputTokens: 0, outputTokens: 0 },
    });
  });

  // Non-zero live snapshots used to skip the transcript. Their output count
  // is message_start's placeholder, so the transcript's final value must win.
  test('merges the transcript final into a non-zero live snapshot', () => {
    const collector = new AssistantUsageCollector();
    collector.ingest(
      assistantLine('msg-3', {
        input_tokens: 100,
        output_tokens: 1,
      }) as never,
    );
    const loader = vi.fn(() => {
      const map = new Map();
      map.set('msg-3', {
        id: 'msg-3',
        model: 'gpt-6-sol',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        total: 120,
      });
      return map;
    });
    expect(collector.drain('session-1', loader)).toMatchObject({
      eventId: 'claude-code:msg-3',
      tokens: { inputTokens: 100, outputTokens: 20 },
    });
    expect(loader).toHaveBeenCalledOnce();
  });

  // The reconciler drops only final calls at a baseline reset; a call that
  // may not be in modelUsage yet stays pending.
  test('only a message_delta with a stop_reason makes a flush final', () => {
    const usage = { input_tokens: 100, output_tokens: 20 };
    const file = writeTranscript([
      // One line per content block: only the last carries the stop_reason,
      // and an equal snapshot must not hide it.
      assistantLine('msg-ended', usage),
      {
        ...assistantLine('msg-ended', usage),
        message: {
          ...assistantLine('msg-ended', usage).message,
          stop_reason: 'tool_use',
        },
      },
      assistantLine('msg-running', { input_tokens: 2_000, output_tokens: 1 }),
    ]);
    const loader = createTranscriptUsageLoader(() => file);
    const collector = new AssistantUsageCollector();
    // Main thread: message_delta with a stop_reason precedes the flush.
    collector.observeStreamEvent({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'message_start',
        message: { id: 'msg-streamed', usage: { input_tokens: 50 } },
      },
    });
    collector.ingest(
      assistantLine('msg-streamed', {
        input_tokens: 50,
        output_tokens: 1,
      }) as never,
    );
    collector.observeStreamEvent({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      },
    });
    // Non-streaming fallback: the live message carries a stop_reason but is
    // yielded before Claude Code counts the call.
    collector.ingest({
      ...assistantLine('msg-fallback', { input_tokens: 70, output_tokens: 7 }),
      message: {
        ...assistantLine('msg-fallback', {}).message,
        usage: { input_tokens: 70, output_tokens: 7 },
        stop_reason: 'end_turn',
      },
    } as never);
    collector.ingest(
      assistantLine('msg-ended', { ...usage, output_tokens: 1 }) as never,
    );
    collector.ingest(
      assistantLine('msg-running', {
        input_tokens: 2_000,
        output_tokens: 1,
      }) as never,
    );
    const batches = new Map<string, { final: boolean; completed: boolean }>();
    for (let batch = collector.drain('s', loader); batch; ) {
      batches.set(batch.eventId, {
        final: batch.final,
        completed: batch.completed,
      });
      batch = collector.drain('s', loader);
    }
    expect(Object.fromEntries(batches)).toEqual({
      'claude-code:msg-streamed': { final: true, completed: true },
      'claude-code:msg-fallback': { final: false, completed: false },
      'claude-code:msg-ended': { final: false, completed: true },
      'claude-code:msg-running': { final: false, completed: false },
    });
  });
});

describe('createTranscriptUsageLoader', () => {
  test('shares one file scan across lookups and rescans for unknown IDs', () => {
    const file = writeTranscript([
      assistantLine('msg-1', { input_tokens: 7, output_tokens: 3 }),
    ]);
    const loader = createTranscriptUsageLoader(() => file);
    const first = loader(['msg-1']);
    expect(first.get('msg-1')).toMatchObject({ inputTokens: 7 });
    // Cached hit: same value returned without rescanning (file unchanged).
    expect(loader(['msg-1']).get('msg-1')).toMatchObject({ inputTokens: 7 });
    // Unknown ID triggers a rescan against the (still unchanged) file.
    expect(loader(['msg-2']).has('msg-2')).toBe(false);
    // Appended messages are found by the rescan.
    writeFileSync(
      file,
      `${JSON.stringify(assistantLine('msg-1', { input_tokens: 7, output_tokens: 3 }))}\n${JSON.stringify(
        assistantLine('msg-2', { input_tokens: 20, output_tokens: 4 }),
      )}\n`,
    );
    expect(loader(['msg-2']).get('msg-2')).toMatchObject({ inputTokens: 20 });
  });

  test('returns empty hits when no transcript path is available', () => {
    const loader = createTranscriptUsageLoader(() => undefined);
    expect(loader(['msg-1'])).toEqual(new Map());
  });
});
