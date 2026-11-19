import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ResponsesToAnthropicConverter } from '../src/codex-gateway/convert-response.js';
import { resolveCodexUsageAccountingMode } from '../src/codex-gateway/resolve-gateway-url.js';
import { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } from '../src/codex-gateway/types.js';
import { AssistantUsageCollector } from '../container/agent-runner/src/assistant-usage.js';
import { ResultUsageReconciler } from '../container/agent-runner/src/result-usage.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';
import { createTranscriptUsageLoader } from '../container/agent-runner/src/transcript-usage.js';

const MODEL = 'gpt-6.1-sol';
const AUX = 'claude-haiku-5-5';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function assistant(id: string, usage: Record<string, number>, stopped = false) {
  return {
    type: 'assistant',
    message: {
      id,
      model: MODEL,
      usage,
      stop_reason: stopped ? 'end_turn' : null,
    },
  };
}

function start(c: AssistantUsageCollector, id = 'message') {
  const message = assistant(id, {
    input_tokens: 38_249,
    output_tokens: 1,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 40,
  });
  c.observeStreamEvent({
    type: 'stream_event',
    event: { type: 'message_start', message: message.message },
  });
  c.ingest(message);
}

function finish(c: AssistantUsageCollector, usage: Record<string, number>) {
  c.observeStreamEvent({
    type: 'stream_event',
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
  });
}

function tokens(
  inputTokens: number,
  outputTokens = 0,
  cacheReadInputTokens = 0,
) {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    costUSD: 0,
  };
}

describe('Codex final input snapshots', () => {
  test.each([
    [CODEX_GATEWAY_BASE_URL_PLACEHOLDER, undefined, 'codex'],
    [
      CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      'https://relay.example.test',
      undefined,
    ],
    ['https://relay.example.test', undefined, undefined],
    ['', undefined, undefined],
  ])(
    'mode follows the selected endpoint (%s, %s)',
    (endpoint, override, expected) => {
      expect(resolveCodexUsageAccountingMode(endpoint!, override)).toBe(
        expected,
      );
    },
  );
  test.each([true, false])(
    'real gateway start estimate is replaced only in Codex mode (%s)',
    (codex) => {
      const gateway = new ResponsesToAnthropicConverter(MODEL, {
        inputTokenEstimate: 38_249,
      });
      const collector = new AssistantUsageCollector({ codex });
      const wire = [
        { type: 'response.created', response: { id: 'wire', model: MODEL } },
        {
          type: 'response.completed',
          response: {
            id: 'wire',
            model: MODEL,
            output: [],
            usage: {
              input_tokens: 29_078,
              input_tokens_details: { cached_tokens: 27_776 },
              output_tokens: 669,
            },
          },
        },
      ].flatMap((event) => gateway.handleEvent(event));
      for (const event of wire) {
        collector.observeStreamEvent({
          type: 'stream_event',
          event: event.data,
        });
        if (event.event === 'message_start') {
          collector.ingest({ type: 'assistant', message: event.data.message });
        }
      }
      expect(collector.drain('session')?.tokens).toMatchObject({
        inputTokens: codex ? 1_302 : 38_249,
        cacheReadInputTokens: 27_776,
        outputTokens: 669,
      });
      expect(collector.drain('session')).toBeUndefined();
    },
  );

  test('explicit zero final input categories replace estimates', () => {
    const collector = new AssistantUsageCollector({ codex: true });
    start(collector);
    finish(collector, {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 3,
    });
    expect(collector.drain('s')?.tokens).toMatchObject({
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 3,
    });
  });

  test('a missing final field retains its earlier value', () => {
    const collector = new AssistantUsageCollector({ codex: true });
    start(collector);
    finish(collector, { output_tokens: 3 });
    expect(collector.drain('s')?.tokens).toMatchObject({
      inputTokens: 38_249,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 40,
    });
  });

  test('a final live fallback can reduce an earlier snapshot', () => {
    const collector = new AssistantUsageCollector({ codex: true });
    start(collector);
    collector.ingest(
      assistant('message', { input_tokens: 12, output_tokens: 3 }, true),
    );
    // Output only grows: the larger estimate snapshot's placeholder must not win.
    expect(collector.drain('s')?.tokens).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
    });
  });

  test.each([
    ['live', true, 15],
    ['transcript', true, 15],
    ['live', false, 0],
    ['transcript', false, 0],
  ] as const)(
    '%s merges sparse terminal input according to the selected provider (codex=%s)',
    (source, codex, expectedCacheRead) => {
      const first = assistant('sparse', {
        input_tokens: 100,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 8,
      });
      const last = assistant(
        'sparse',
        {
          input_tokens: 125,
          cache_creation_input_tokens: 0,
          output_tokens: 40,
        },
        true,
      );
      const collector = new AssistantUsageCollector({ codex });
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-sparse-'));
      dirs.push(dir);
      const transcript = path.join(dir, 's.jsonl');
      if (source === 'live') {
        collector.ingest(first);
        collector.ingest(last);
      } else {
        collector.ingest(assistant('sparse', { input_tokens: 1 }));
        writeFileSync(
          transcript,
          [first, last].map((line) => JSON.stringify(line)).join('\n') + '\n',
        );
      }
      const loader = createTranscriptUsageLoader(() => transcript, { codex });
      expect(collector.drain('s', loader)?.tokens).toMatchObject({
        inputTokens: 125,
        cacheReadInputTokens: expectedCacheRead,
        cacheCreationInputTokens: 0,
        outputTokens: 40,
      });
    },
  );

  test('final stream fields override transcript and live final values independently', () => {
    const collector = new AssistantUsageCollector({ codex: true });
    start(collector);
    collector.ingest(
      assistant('message', { input_tokens: 99, output_tokens: 3 }, true),
    );
    finish(collector, { inputTokens: 0, outputTokens: 5 });
    expect(
      collector.drain(
        's',
        () =>
          new Map([
            [
              'message',
              {
                id: 'message',
                model: MODEL,
                ...tokens(12, 4, 20),
                total: 36,
                stopped: true,
                finalInputTokens: { inputTokens: 12, cacheReadInputTokens: 20 },
              },
            ],
          ]),
      )?.tokens,
    ).toMatchObject({
      inputTokens: 0,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 40,
      outputTokens: 5,
    });
  });

  test('stream scopes keep concurrent main and subagent finals separate', () => {
    const collector = new AssistantUsageCollector({ codex: true });
    for (const [parent, id] of [
      [null, 'main'],
      ['tool-sub', 'sub'],
    ] as const) {
      collector.observeStreamEvent({
        type: 'stream_event',
        parent_tool_use_id: parent,
        event: {
          type: 'message_start',
          message: { id, usage: { input_tokens: 1000 } },
        },
      });
      collector.ingest(assistant(id, { input_tokens: 1000 }));
    }
    for (const [parent, input] of [
      [null, 12],
      ['tool-sub', 34],
    ] as const) {
      collector.observeStreamEvent({
        type: 'stream_event',
        parent_tool_use_id: parent,
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { input_tokens: input },
        },
      });
    }
    expect(collector.drain('s')?.tokens.inputTokens).toBe(12);
    expect(collector.drain('s')?.tokens.inputTokens).toBe(34);
  });

  test('an unfinished call retains its estimate', () => {
    const collector = new AssistantUsageCollector({ codex: true });
    start(collector);
    collector.observeStreamEvent({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 1 } },
    });
    expect(collector.drain('s')?.tokens.inputTokens).toBe(38_249);
  });

  test.each([true, false])(
    'sidechain final transcript selection is scoped (%s)',
    (codex) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codex-final-input-'));
      dirs.push(dir);
      const main = path.join(dir, 'session.jsonl');
      const side = path.join(dir, 'session', 'subagents', 'agent-side.jsonl');
      mkdirSync(path.dirname(side), { recursive: true });
      writeFileSync(
        side,
        [
          assistant('sub', { input_tokens: 38_249, output_tokens: 1 }),
          assistant(
            'sub',
            {
              input_tokens: 1_302,
              cache_read_input_tokens: 27_776,
              output_tokens: 669,
            },
            true,
          ),
        ]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n',
      );
      const collector = new AssistantUsageCollector({ codex });
      collector.ingest({
        ...assistant('sub', { input_tokens: 38_249, output_tokens: 1 }),
        agent_id: 'side',
      });
      const loader = createTranscriptUsageLoader(() => main, { codex });
      // In Codex mode the ended line's output survives the larger estimate line.
      expect(collector.drain('s', loader)?.tokens).toMatchObject(
        codex
          ? { inputTokens: 1_302, outputTokens: 669 }
          : { inputTokens: 38_249 },
      );
    },
  );

  test('a sidechain written after the last result is settled once when the query ends', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-late-sidechain-'));
    dirs.push(dir);
    const main = path.join(dir, 'session.jsonl');
    const side = path.join(dir, 'session', 'subagents', 'agent-side.jsonl');
    mkdirSync(path.dirname(side), { recursive: true });
    const collector = new AssistantUsageCollector({ codex: true });
    collector.ingest({
      ...assistant('sub', { input_tokens: 38_249 }),
      agent_id: 'side',
    });
    const loader = createTranscriptUsageLoader(() => main, { codex: true });
    expect(collector.drain('s', loader)).toBeUndefined();
    writeFileSync(
      side,
      JSON.stringify(
        assistant(
          'sub',
          {
            input_tokens: 1_302,
            cache_read_input_tokens: 27_776,
            output_tokens: 9,
          },
          true,
        ),
      ) + '\n',
    );
    expect(collector.drain('s', loader, 'query-end')).toMatchObject({
      eventId: 'claude-code:sub',
      completed: true,
      tokens: {
        inputTokens: 1_302,
        cacheReadInputTokens: 27_776,
        outputTokens: 9,
      },
    });
    expect(collector.drain('s', loader, 'query-end')).toBeUndefined();
  });
});

// Run the runner's actual result handler, including its reconciler selection.
function usageAtResult(codex = true) {
  const emit = vi.fn();
  const globals: Record<string, unknown> = {
    containerInput: { usageAccountingMode: codex ? 'codex' : undefined },
    ResultUsageReconciler,
    AssistantUsageCollector,
    runningPendingMs: 60_000,
    sessionId: undefined,
    newSessionId: undefined,
    transcriptUsageLoader: undefined,
    queryModelRuntime: { usageModelKey: MODEL },
    nonNegativeNumber: (v: number | undefined) => v ?? 0,
    emit,
    log: vi.fn(),
  };
  const harness = createRuntimeSourceHarness(
    globals,
    new URL('../container/agent-runner/src/index.ts', import.meta.url),
  );
  harness.install('usageReconciler', 'runQueryAttempt');
  harness.install('usageOptions', 'runQueryAttempt');
  harness.install('assistantUsageCollector', 'runQueryAttempt');
  harness.install('emitResultUsage', 'runQueryAttempt');
  const flush = globals.emitResultUsage as (
    message: Record<string, unknown>,
    fallbackId: string,
    boundary?: 'query-end' | 'interrupt',
  ) => void;
  const collector = globals.assistantUsageCollector as AssistantUsageCollector;
  return {
    collector,
    child(id: string, usage: Record<string, number>, stopped = false) {
      collector.ingest({ ...assistant(id, usage, stopped), agent_id: id });
    },
    reconciler: globals.usageReconciler as ResultUsageReconciler,
    flush(
      modelUsage?: Record<string, ReturnType<typeof tokens>>,
      boundary?: 'query-end' | 'interrupt',
    ) {
      emit.mockClear();
      flush(modelUsage ? { type: 'result', modelUsage } : {}, 'turn', boundary);
      return emit.mock.calls.map(([event]) => event.streamEvent.usage);
    },
  };
}

describe('Codex usage at SDK result boundaries', () => {
  test('a stopped live child is reconciled under the request alias even when the response model has no growth', () => {
    const { child, flush, reconciler } = usageAtResult();
    flush({ [MODEL]: tokens(400) });
    child(
      'sub',
      { input_tokens: 70, cache_read_input_tokens: 180, output_tokens: 9 },
      true,
    );
    const totals = { [MODEL]: tokens(400), [AUX]: tokens(70, 9, 180) };
    expect(flush(totals)).toMatchObject([
      {
        eventId: 'claude-code:sub',
        inputTokens: 70,
        cacheReadInputTokens: 180,
        outputTokens: 9,
      },
    ]);
    expect(flush(totals)).toEqual([]);
    expect(reconciler.pendingAccounted).toEqual({});
  });

  test.each(['query-end', 'interrupt'] as const)(
    'an output-only result cannot settle a late child’s input at %s',
    (boundary) => {
      const { child, flush } = usageAtResult();
      child('sub', { input_tokens: 38_249 });
      expect(flush({ [MODEL]: tokens(0, 7) })).toMatchObject([
        { inputTokens: 0, outputTokens: 7 },
      ]);
      child(
        'sub',
        { input_tokens: 1_302, cache_read_input_tokens: 27_776 },
        true,
      );
      expect(flush(undefined, boundary)).toMatchObject([
        {
          eventId: 'claude-code:sub',
          inputTokens: 1_302,
          cacheReadInputTokens: 27_776,
        },
      ]);
      expect(flush(undefined, boundary)).toEqual([]);
    },
  );

  test('a residual is shared once by the waiting children and cannot pay for a later child', () => {
    const { child, flush, reconciler } = usageAtResult();
    child('a', { input_tokens: 100 });
    child('b', { input_tokens: 100 });
    expect(flush({ [AUX]: tokens(15) })).toMatchObject([{ inputTokens: 15 }]);
    for (const id of ['later', 'a', 'b']) child(id, { input_tokens: 10 }, true);
    expect(flush(undefined, 'query-end')).toMatchObject([
      {
        eventId: 'claude-code:b',
        inputTokens: 5,
        modelUsage: { [MODEL]: { inputTokens: 5 } },
      },
      { eventId: 'claude-code:later', inputTokens: 10 },
    ]);
    expect(reconciler.toBaseline('s').pendingUsage).toMatchObject([
      { model: MODEL, inputTokens: 15 },
    ]);
  });

  test('a subsequent cumulative result still records the full growth once', () => {
    const { child, flush } = usageAtResult();
    child('sub', { input_tokens: 100 });
    expect(flush({ [AUX]: tokens(20) })).toMatchObject([{ inputTokens: 20 }]);
    child('sub', { input_tokens: 30, cache_read_input_tokens: 8 }, true);
    const cumulative = { [AUX]: tokens(50, 0, 8) };
    const events = flush(cumulative);
    expect(events.reduce((n, event) => n + event.inputTokens, 0)).toBe(30);
    expect(events.reduce((n, event) => n + event.cacheReadInputTokens, 0)).toBe(
      8,
    );
    expect(flush(cumulative)).toEqual([]);
  });

  test('a current delta covering a completed child is unavailable to a child that is still running', () => {
    const { child, flush } = usageAtResult();
    child('first', { input_tokens: 100 });
    expect(flush({ [AUX]: tokens(10) })).toMatchObject([{ inputTokens: 10 }]);
    child('later', { input_tokens: 100 });
    child('first', { input_tokens: 10 }, true);
    expect(flush({ [AUX]: tokens(20) })).toMatchObject([{ inputTokens: 10 }]);
    child('later', { input_tokens: 10 }, true);
    expect(flush(undefined, 'query-end')).toMatchObject([
      { eventId: 'claude-code:later', inputTokens: 10 },
    ]);
  });

  test('children finishing together can use only residuals reported after they started', () => {
    const { child, flush, reconciler } = usageAtResult();
    child('older', { input_tokens: 100 });
    flush({ [MODEL]: tokens(10) });
    child('newer', { input_tokens: 100 });
    flush({ [MODEL]: tokens(11) });
    child('older', { input_tokens: 10 }, true);
    child('newer', { input_tokens: 11 }, true);
    // The first 10 can cover only older. The last 1 + 10 can cover newer.
    expect(flush({ [MODEL]: tokens(21) })).toMatchObject([{ inputTokens: 10 }]);
    expect(reconciler.pendingAccounted).toEqual({});
  });

  test('a request alias and a different response model bill the call once', () => {
    const { collector, flush } = usageAtResult();
    start(collector);
    finish(collector, {
      input_tokens: 70,
      cache_read_input_tokens: 180,
      cache_creation_input_tokens: 0,
      output_tokens: 22,
    });
    // The SDK counts the request under Haiku, the gateway labels its response GPT.
    const events = flush({ [AUX]: tokens(70, 22, 180) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'claude-code:message',
      inputTokens: 70,
      cacheReadInputTokens: 180,
      outputTokens: 22,
    });
    expect(flush({ [AUX]: tokens(70, 22, 180) })).toEqual([]);
  });

  test('a child can finish after the main result without blocking another ready call', () => {
    const { collector, flush } = usageAtResult();
    const parent_tool_use_id = 'tool-sub';
    const child = {
      ...assistant('sub', { input_tokens: 38_249, output_tokens: 1 }),
      parent_tool_use_id,
    };
    collector.observeStreamEvent({
      type: 'stream_event',
      parent_tool_use_id,
      event: { type: 'message_start', message: child.message },
    });
    collector.ingest(child);
    collector.ingest(
      assistant('main', { input_tokens: 100, output_tokens: 10 }, true),
    );
    const main = flush({ [MODEL]: tokens(100, 10), [AUX]: tokens(1000, 20) });
    expect(main.map((e) => [e.eventId, e.inputTokens])).toEqual([
      ['claude-code:main', 100],
      ['turn:internal', 1000],
    ]);
    collector.observeStreamEvent({
      type: 'stream_event',
      parent_tool_use_id,
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 1_302,
          cache_read_input_tokens: 27_776,
          output_tokens: 9,
        },
      },
    });
    const cumulative = {
      [MODEL]: tokens(1_402, 19, 27_776),
      [AUX]: tokens(1000, 20),
    };
    const sub = flush(cumulative);
    expect(sub).toHaveLength(1);
    expect(sub[0]).toMatchObject({
      eventId: 'claude-code:sub',
      inputTokens: 1_302,
      cacheReadInputTokens: 27_776,
      outputTokens: 9,
    });
    expect(flush(cumulative)).toEqual([]);
  });

  test.each([true, false])(
    'unfinished child at a result and at interruption (codex=%s)',
    (codex) => {
      const { collector, flush } = usageAtResult(codex);
      collector.ingest({
        ...assistant('sub', { input_tokens: 111 }),
        agent_id: 'subagent',
      });
      const atResult = flush({ [MODEL]: tokens(0) });
      const atInterrupt = flush();
      expect(atResult.map((e) => e.inputTokens)).toEqual(codex ? [] : [111]);
      expect(atInterrupt.map((e) => e.inputTokens)).toEqual(codex ? [111] : []);
      expect(flush()).toEqual([]);
    },
  );

  test('a late sidechain cannot rebill child usage already emitted by a cumulative result', () => {
    const { collector, flush } = usageAtResult();
    const child = {
      ...assistant('sub', { input_tokens: 38_249 }),
      agent_id: 'side',
    };
    collector.ingest(child);
    const cumulative = { [MODEL]: tokens(1_302, 9, 27_776) };
    const events = flush(cumulative);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      inputTokens: 1_302,
      cacheReadInputTokens: 27_776,
    });
    // A later scan discovers the terminal line after the cumulative bill.
    const late = () =>
      new Map([
        [
          'sub',
          {
            id: 'sub',
            model: MODEL,
            total: 29_087,
            stopped: true,
            ...tokens(1_302, 9, 27_776),
            finalInputTokens: { inputTokens: 1_302 },
          },
        ],
      ]);
    expect(collector.drain('s', late, 'query-end')).toBeUndefined();
    expect(flush(cumulative)).toEqual([]);
  });
});
