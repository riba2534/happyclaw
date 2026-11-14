import { describe, expect, test } from 'vitest';

import { AssistantUsageCollector } from '../container/agent-runner/src/assistant-usage.js';
import { InputUsageProjection } from '../src/input-usage-projection.js';

const MODEL = 'deepseek-v4-pro';

function assistant(id: string) {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    parent_tool_use_id: null,
    message: {
      id,
      model: MODEL,
      content: [{ type: 'text', text: 'reply' }],
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  };
}

const start = (id: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: {
    type: 'message_start',
    message: { id, usage: { input_tokens: 100, output_tokens: 1 } },
  },
});

const stop = (outputTokens: number) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: outputTokens },
  },
});

describe('stream generation timing', () => {
  test('a finished streamed call reports its output and generation time', () => {
    let now = 1_000;
    const collector = new AssistantUsageCollector(() => now);
    collector.observeStreamEvent(start('msg_1'));
    collector.ingest(assistant('msg_1'));
    now = 5_000;
    collector.observeStreamEvent(stop(200));

    const batch = collector.drain(undefined);
    expect(batch?.tokens.streamOutputTokens).toBe(200);
    expect(batch?.tokens.streamMs).toBe(4_000);
  });

  test('a call still streaming when drained is not timed', () => {
    let now = 1_000;
    const collector = new AssistantUsageCollector(() => now);
    collector.observeStreamEvent(start('msg_1'));
    collector.ingest(assistant('msg_1'));
    now = 3_000;

    const batch = collector.drain(undefined);
    expect(batch?.tokens.streamOutputTokens).toBeUndefined();
    expect(batch?.tokens.streamMs).toBeUndefined();
  });

  test('a call without stream events is not timed', () => {
    const collector = new AssistantUsageCollector(() => 0);
    collector.ingest(assistant('msg_1'));
    expect(collector.drain(undefined)?.tokens.streamMs).toBeUndefined();
  });

  test('the per-input display total sums the timed calls', () => {
    const projection = new InputUsageProjection('input-1');
    const usage = (eventId: string, tokens: number, ms?: number) => ({
      eventId,
      inputTokens: 10,
      outputTokens: tokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
      durationMs: 0,
      numTurns: 0,
      ...(ms ? { streamOutputTokens: tokens, streamMs: ms } : {}),
    });
    const receipt = (eventId: string) => ({
      eventId,
      inserted: true,
      providerEstimatedCostUSD: 0,
    });
    projection.record('input-1', usage('a', 100, 2_000), receipt('a'));
    projection.record('input-1', usage('b', 50), receipt('b'));
    const total = projection.record(
      'input-1',
      usage('c', 300, 3_000),
      receipt('c'),
    );
    expect(total?.streamOutputTokens).toBe(400);
    expect(total?.streamMs).toBe(5_000);
    expect(total?.outputTokens).toBe(450);
  });
});
