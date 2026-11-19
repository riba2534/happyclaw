import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { StreamEventProcessor } from '../container/agent-runner/src/stream-processor.js';
import type {
  ContainerOutput,
  StreamEvent,
} from '../container/agent-runner/src/types.js';

function makeProcessor() {
  const outputs: ContainerOutput[] = [];
  const processor = new StreamEventProcessor(
    (output) => outputs.push(output),
    () => {},
  );
  const events = (): StreamEvent[] =>
    outputs.flatMap((output) =>
      output.streamEvent ? [output.streamEvent] : [],
    );
  return { processor, events };
}

const streamEvent = (event: Record<string, unknown>) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event,
});
const blockStart = (index: number, contentBlock: Record<string, unknown>) =>
  streamEvent({
    type: 'content_block_start',
    index,
    content_block: contentBlock,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tool_progress heartbeat throttle', () => {
  const heartbeat = (
    toolUseId: string,
    seconds: number,
    parentToolUseId: string | null = null,
  ) => ({
    type: 'tool_progress',
    tool_use_id: toolUseId,
    tool_name: 'Bash',
    parent_tool_use_id: parentToolUseId,
    elapsed_time_seconds: seconds,
  });
  const elapsed = (events: StreamEvent[], toolUseId = 't1') =>
    events
      .filter(
        (event) =>
          event.eventType === 'tool_progress' && event.toolUseId === toolUseId,
      )
      .map((event) => event.elapsedSeconds);

  test('forwards the first frame at once and the latest one when the interval ends', () => {
    const { processor, events } = makeProcessor();
    processor.processToolProgress(heartbeat('t1', 1));
    vi.advanceTimersByTime(200);
    processor.processToolProgress(heartbeat('t1', 2));
    vi.advanceTimersByTime(200);
    processor.processToolProgress(heartbeat('t1', 3));
    expect(elapsed(events())).toEqual([1]);

    vi.advanceTimersByTime(599);
    expect(elapsed(events())).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(elapsed(events())).toEqual([1, 3]);

    // Once the interval has passed again the next heartbeat is immediate.
    vi.advanceTimersByTime(1_000);
    processor.processToolProgress(heartbeat('t1', 4));
    expect(elapsed(events())).toEqual([1, 3, 4]);
  });

  test('paces a long-running tool at one frame per second', () => {
    const { processor, events } = makeProcessor();
    for (let step = 0; step < 50; step++) {
      processor.processToolProgress(heartbeat('t1', step * 0.2));
      vi.advanceTimersByTime(200);
    }
    vi.advanceTimersByTime(1_000);
    // 10 seconds of 5 Hz heartbeats: about one frame per second.
    expect(elapsed(events()).length).toBeLessThanOrEqual(11);
    expect(elapsed(events()).length).toBeGreaterThanOrEqual(9);
  });

  test('a returned tool drops its pending frame', () => {
    const { processor, events } = makeProcessor();
    processor.processToolProgress(heartbeat('t1', 1));
    processor.processToolProgress(heartbeat('t1', 2));
    processor.processMainToolResults({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    });
    vi.advanceTimersByTime(5_000);

    expect(elapsed(events())).toEqual([1]);
  });

  test('tool_use_end from any path drops the pending frame', () => {
    const { processor, events } = makeProcessor();
    processor.processStreamEvent(
      blockStart(0, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
    );
    processor.processToolProgress(heartbeat('t1', 1));
    processor.processToolProgress(heartbeat('t1', 2));
    processor.processToolUseSummary({
      preceding_tool_use_ids: ['t1'],
      summary: 'done',
    });
    vi.advanceTimersByTime(5_000);

    expect(elapsed(events())).toEqual([1]);
  });

  test('tools are throttled independently', () => {
    const { processor, events } = makeProcessor();
    processor.processToolProgress(heartbeat('t1', 1));
    processor.processToolProgress(heartbeat('t2', 7));
    processor.processToolProgress(heartbeat('t1', 2));
    expect(elapsed(events(), 't1')).toEqual([1]);
    expect(elapsed(events(), 't2')).toEqual([7]);

    processor.processMainToolResults({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    });
    processor.processToolProgress(heartbeat('t2', 8));
    vi.advanceTimersByTime(1_000);
    expect(elapsed(events(), 't1')).toEqual([1]);
    expect(elapsed(events(), 't2')).toEqual([7, 8]);
  });

  test('a sub-Agent heartbeat is throttled by its own tool_use_id', () => {
    const { processor, events } = makeProcessor();
    processor.processToolProgress(heartbeat('sub-1', 1, 'task-1'));
    processor.processToolProgress(heartbeat('sub-1', 2, 'task-1'));
    vi.advanceTimersByTime(1_000);

    expect(elapsed(events(), 'sub-1')).toEqual([1, 2]);
    expect(events().at(-1)).toMatchObject({
      parentToolUseId: 'task-1',
      isNested: true,
    });
  });

  test('progress built from streamed tool input is never throttled', () => {
    const { processor, events } = makeProcessor();
    processor.processStreamEvent(
      blockStart(0, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }),
    );
    processor.processToolProgress(heartbeat('t1', 1));
    processor.processToolProgress(heartbeat('t1', 2));
    processor.processStreamEvent(
      streamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
      }),
    );

    expect(
      events().filter(
        (event) =>
          event.eventType === 'tool_progress' &&
          event.toolInputSummary === 'command: ls',
      ),
    ).toHaveLength(1);
    expect(elapsed(events())).toEqual([1, undefined]);
  });

  // Agent SDK 0.3.323+: a turn waiting on a long-running hook. The id starts
  // and ends no tool, so a forwarded frame would leave one running.
  test('drops the heartbeat of a hook', () => {
    const { processor, events } = makeProcessor();
    processor.processToolProgress({
      type: 'tool_progress',
      tool_use_id: 'hook-3f2c',
      tool_name: 'PreToolUse',
      parent_tool_use_id: null,
      elapsed_time_seconds: 12,
      heartbeat: true,
    });
    processor.processToolProgress(heartbeat('t1', 1));
    vi.advanceTimersByTime(5_000);
    expect(
      events()
        .filter((event) => event.eventType === 'tool_progress')
        .map((event) => event.toolUseId),
    ).toEqual(['t1']);
  });

  test('cleanup and a discarded stream cancel the pending frame', () => {
    for (const end of ['cleanup', 'discardPendingTextOutput'] as const) {
      const { processor, events } = makeProcessor();
      processor.processToolProgress(heartbeat('t1', 1));
      processor.processToolProgress(heartbeat('t1', 2));
      processor[end]();
      vi.advanceTimersByTime(5_000);
      expect(elapsed(events())).toEqual([1]);
    }
  });
});
