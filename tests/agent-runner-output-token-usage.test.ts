import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { AssistantUsageCollector } from '../container/agent-runner/src/assistant-usage.js';
import {
  createTranscriptUsageLoader,
  resolveSidechainTranscriptPath,
} from '../container/agent-runner/src/transcript-usage.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'output-token-usage-'));
  dirs.push(dir);
  return dir;
}

const MODEL = 'claude-sonnet-5';

/** The shape Claude Code 2.1.296 emits: usage from message_start. */
function liveAssistant(
  id: string,
  extra: Record<string, unknown> = {},
  parentToolUseId: string | null = null,
) {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    parent_tool_use_id: parentToolUseId,
    ...extra,
    message: {
      id,
      model: MODEL,
      content: [{ type: 'text', text: 'reply' }],
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 50,
      },
    },
  };
}

function streamEvent(event: Record<string, unknown>, parent: string | null) {
  return { type: 'stream_event', parent_tool_use_id: parent, event };
}

function transcriptLine(id: string, outputTokens: number, agentId?: string) {
  return JSON.stringify({
    type: 'assistant',
    uuid: `t-${id}`,
    ...(agentId ? { agentId, isSidechain: true } : {}),
    message: {
      id,
      model: MODEL,
      content: [{ type: 'text', text: 'reply' }],
      usage: {
        input_tokens: 100,
        output_tokens: outputTokens,
        cache_read_input_tokens: 50,
      },
    },
  });
}

describe('output tokens', () => {
  test('bills the message_delta final instead of the live placeholder', () => {
    const collector = new AssistantUsageCollector();
    collector.observeStreamEvent(
      streamEvent(
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            model: MODEL,
            usage: { input_tokens: 100, output_tokens: 1 },
          },
        },
        null,
      ),
    );
    collector.ingest(liveAssistant('msg_1'));
    collector.observeStreamEvent(
      streamEvent(
        { type: 'message_delta', usage: { output_tokens: 321 } },
        null,
      ),
    );
    const batch = collector.drain('session', () => new Map());
    expect(batch?.tokens).toMatchObject({
      inputTokens: 100,
      outputTokens: 321,
      cacheReadInputTokens: 50,
    });
    expect(batch?.tokens.modelUsage?.[MODEL]).toMatchObject({
      outputTokens: 321,
    });
  });

  test('attributes message_delta to the message open in the same scope', () => {
    const collector = new AssistantUsageCollector();
    for (const [id, parent] of [
      ['msg_main', null],
      ['msg_sub', 'toolu_task'],
    ] as const) {
      collector.observeStreamEvent(
        streamEvent(
          { type: 'message_start', message: { id, model: MODEL, usage: {} } },
          parent,
        ),
      );
      collector.ingest(liveAssistant(id, {}, parent));
    }
    collector.observeStreamEvent(
      streamEvent(
        { type: 'message_delta', usage: { output_tokens: 40 } },
        null,
      ),
    );
    collector.observeStreamEvent(
      streamEvent(
        { type: 'message_delta', usage: { output_tokens: 7 } },
        'toolu_task',
      ),
    );
    const outputs = new Map<string, number>();
    for (let batch = collector.drain('s'); batch; batch = collector.drain('s'))
      outputs.set(batch.eventId, batch.tokens.outputTokens);
    expect(outputs.get('claude-code:msg_main')).toBe(40);
    expect(outputs.get('claude-code:msg_sub')).toBe(7);
  });

  test('a subagent message takes its final count from the sidechain transcript', () => {
    const dir = tempDir();
    const main = join(dir, 'session-1.jsonl');
    writeFileSync(main, `${transcriptLine('msg_main', 321)}\n`);
    mkdirSync(join(dir, 'session-1', 'subagents'), { recursive: true });
    writeFileSync(
      join(dir, 'session-1', 'subagents', 'agent-a9d2.jsonl'),
      `${transcriptLine('msg_sub', 222, 'a9d2')}\n`,
    );
    const collector = new AssistantUsageCollector();
    // Subagent stream events are not forwarded; only the placeholder arrives.
    collector.ingest(liveAssistant('msg_sub', { agent_id: 'a9d2' }, 'toolu_1'));
    collector.ingest(liveAssistant('msg_main'));
    const loader = createTranscriptUsageLoader(() => main);
    const outputs = new Map<string, number>();
    for (
      let batch = collector.drain('session-1', loader);
      batch;
      batch = collector.drain('session-1', loader)
    )
      outputs.set(batch.eventId, batch.tokens.outputTokens);
    expect(outputs.get('claude-code:msg_sub')).toBe(222);
    expect(outputs.get('claude-code:msg_main')).toBe(321);
  });

  test('keeps the largest value per field across live, stream and transcript', () => {
    const collector = new AssistantUsageCollector();
    collector.ingest(liveAssistant('msg_x'));
    collector.observeStreamEvent(
      streamEvent(
        { type: 'message_start', message: { id: 'msg_x', usage: {} } },
        null,
      ),
    );
    collector.observeStreamEvent(
      streamEvent(
        { type: 'message_delta', usage: { output_tokens: 90 } },
        null,
      ),
    );
    const loader = () =>
      new Map([
        [
          'msg_x',
          {
            id: 'msg_x',
            model: MODEL,
            inputTokens: 100,
            outputTokens: 80,
            cacheReadInputTokens: 60,
            cacheCreationInputTokens: 0,
            reasoningTokens: 0,
            total: 240,
          },
        ],
      ]);
    expect(collector.drain('s', loader)?.tokens).toMatchObject({
      inputTokens: 100,
      outputTokens: 90,
      cacheReadInputTokens: 60,
    });
  });
});

describe('incremental transcript loader', () => {
  test('reads appended entries and an unterminated tail once it completes', () => {
    const dir = tempDir();
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, `${transcriptLine('a', 5)}\n`);
    const loader = createTranscriptUsageLoader(() => file);
    expect(loader(['a']).get('a')?.outputTokens).toBe(5);
    const partial = transcriptLine('b', 9);
    appendFileSync(file, partial.slice(0, 20));
    expect(loader(['b']).has('b')).toBe(false);
    appendFileSync(file, `${partial.slice(20)}\n`);
    expect(loader(['b']).get('b')?.outputTokens).toBe(9);
    expect(loader(['a']).get('a')?.outputTokens).toBe(5);
  });

  test('rescans a transcript replaced by a rewrite', () => {
    const dir = tempDir();
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, `${transcriptLine('old', 5)}\n`.repeat(4));
    const loader = createTranscriptUsageLoader(() => file);
    expect(loader(['old']).has('old')).toBe(true);
    const replacement = join(dir, 'replacement.jsonl');
    writeFileSync(replacement, `${transcriptLine('new', 11)}\n`);
    renameSync(replacement, file);
    expect(loader(['new']).get('new')?.outputTokens).toBe(11);
  });

  test('finds a workflow agent sidechain nested under subagents', () => {
    const dir = tempDir();
    const main = join(dir, 's.jsonl');
    const nested = join(dir, 's', 'subagents', 'workflows', 'wf_1');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'agent-w1.jsonl'), '');
    expect(resolveSidechainTranscriptPath(main, 'w1')).toBe(
      join(nested, 'agent-w1.jsonl'),
    );
    expect(resolveSidechainTranscriptPath(main, '../escape')).toBeUndefined();
  });
});
