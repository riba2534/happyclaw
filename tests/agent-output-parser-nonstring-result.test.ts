import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';

import {
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
  attachStdoutHandler,
  classifyProviderLimitNotice,
  createStdoutParserState,
  isProviderFailureResult,
  type StdoutParserState,
} from '../src/agent-output-parser.js';
import type { ContainerOutput } from '../src/agent-runtime-contracts.js';
import { DingTalkStreamingCardController } from '../src/dingtalk-streaming-card.js';
import { DiscordStreamingEditController } from '../src/discord-streaming-edit.js';

// Framed stdout is untrusted JSON: anything inside the agent sandbox that can
// write to the runner's stdout can emit a well-framed object whose `result` is
// not a string. Before the fix, the synchronous 'data' handler fed that value
// to classifyProviderLimitNotice(), whose `result.trim()` threw a TypeError
// outside the outputChain .catch. Delivered from the event loop, that is an
// uncaughtException, which exits the shared host process.

const frame = (payload: unknown): string =>
  `${OUTPUT_START_MARKER}${JSON.stringify(payload)}${OUTPUT_END_MARKER}`;

// Capture any uncaught exception raised while a test runs, instead of letting
// vitest's own handler swallow it into a run-level error.
let uncaught: unknown[] = [];
let savedListeners: NodeJS.UncaughtExceptionListener[] = [];
const onUncaught = (err: unknown) => {
  uncaught.push(err);
};

beforeEach(() => {
  uncaught = [];
  savedListeners = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  process.removeListener('uncaughtException', onUncaught);
  for (const l of savedListeners) process.on('uncaughtException', l);
});

interface Harness {
  stream: PassThrough;
  state: StdoutParserState;
  outputs: ContainerOutput[];
}

function attach(): Harness {
  const stream = new PassThrough();
  const state = createStdoutParserState();
  const outputs: ContainerOutput[] = [];
  attachStdoutHandler(stream, state, {
    groupName: 'nonstring-result-test',
    label: 'Container',
    resetTimeout: () => {},
    onOutput: async (o) => {
      outputs.push(o);
    },
  });
  return { stream, state, outputs };
}

async function settle(h: Harness): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
  await h.state.outputChain;
}

/** Write each frame through the real stream; a throw here is the host crash. */
async function feed(chunks: string[]): Promise<Harness> {
  const h = attach();
  for (const c of chunks) {
    expect(() => h.stream.write(c)).not.toThrow();
  }
  h.stream.end();
  await settle(h);
  expect(uncaught).toEqual([]);
  return h;
}

describe('attachStdoutHandler — non-string framed result', () => {
  test.each([
    ['number', 1],
    ['zero', 0],
    ['boolean', true],
    ['empty object', {}],
    ['object', { x: 1 }],
    ['array', ['a']],
  ])(
    'a success frame with a %s result does not throw and reaches onOutput as result null',
    async (_label, result) => {
      const h = await feed([frame({ status: 'success', result })]);
      expect(h.outputs).toHaveLength(1);
      expect(h.outputs[0].status).toBe('success');
      expect(h.outputs[0].result).toBeNull();
      expect(h.state.hasSuccessOutput).toBe(true);
      expect(h.state.hasProviderFailureOutput).toBe(false);
      expect(h.outputs[0].providerFailure).toBeUndefined();
    },
  );

  test('direct data delivery (event-loop path) does not throw', async () => {
    const h = attach();
    expect(() =>
      h.stream.emit(
        'data',
        Buffer.from(frame({ status: 'success', result: { evil: true } })),
      ),
    ).not.toThrow();
    await settle(h);
    expect(uncaught).toEqual([]);
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]).toMatchObject({ status: 'success', result: null });
  });

  test('keeps status and other fields of a non-success frame, nulling only result', async () => {
    const h = await feed([
      frame({ status: 'stream', result: 42, newSessionId: 'sess-42' }),
      frame({ status: 'error', result: { x: 1 }, error: 'boom' }),
    ]);
    expect(h.outputs).toHaveLength(2);
    expect(h.outputs[0]).toMatchObject({
      status: 'stream',
      result: null,
      newSessionId: 'sess-42',
    });
    expect(h.outputs[1]).toMatchObject({
      status: 'error',
      result: null,
      error: 'boom',
    });
    expect(h.state.newSessionId).toBe('sess-42');
  });

  test('the parser keeps going after a bad frame', async () => {
    const h = await feed([
      frame({ status: 'success', result: 7 }) +
        frame({ status: 'success', result: 'normal reply' }),
    ]);
    expect(h.outputs.map((o) => o.result)).toEqual([null, 'normal reply']);
  });

  test('null and absent results are left as they were', async () => {
    const h = await feed([
      frame({ status: 'success', result: null }),
      frame({ status: 'stream' }),
    ]);
    expect(h.outputs[0].result).toBeNull();
    expect('result' in h.outputs[1]).toBe(false);
  });
});

describe('attachStdoutHandler — string results classify exactly as before', () => {
  test('a normal string result passes through untouched', async () => {
    const h = await feed([frame({ status: 'success', result: 'hi there' })]);
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0].result).toBe('hi there');
    expect(h.outputs[0].providerFailure).toBeUndefined();
    expect(h.state.hasProviderFailureOutput).toBe(false);
  });

  test('an account limit banner is still flagged as a provider failure', async () => {
    const banner = "You're out of extra usage · resets 2:10am (Asia/Shanghai)";
    const h = await feed([frame({ status: 'success', result: banner })]);
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0].result).toBe(banner);
    expect(h.outputs[0].providerFailure).toBe(true);
    expect(h.state.hasProviderFailureOutput).toBe(true);
  });

  test('a model-scoped banner is still not an account failure', async () => {
    const banner = "You've hit your Opus limit.";
    const h = await feed([frame({ status: 'success', result: banner })]);
    expect(h.outputs[0].result).toBe(banner);
    expect(h.outputs[0].providerFailure).toBeUndefined();
    expect(h.state.hasProviderFailureOutput).toBe(false);
  });
});

describe('classifyProviderLimitNotice — non-string input', () => {
  test.each([
    ['number', 1],
    ['boolean', true],
    ['object', {}],
    ['array', ['You have hit your limit']],
  ])('returns null for a %s instead of throwing', (_label, value) => {
    const v = value as unknown as string;
    expect(() => classifyProviderLimitNotice(v)).not.toThrow();
    expect(classifyProviderLimitNotice(v)).toBeNull();
    expect(isProviderFailureResult(v)).toBe(false);
  });

  test('string classification is unchanged', () => {
    expect(classifyProviderLimitNotice(null)).toBeNull();
    expect(classifyProviderLimitNotice('')).toBeNull();
    expect(classifyProviderLimitNotice("You've hit your limit.")).toBe(
      'account',
    );
    expect(classifyProviderLimitNotice("You've hit your Sonnet limit.")).toBe(
      'model',
    );
    expect(
      classifyProviderLimitNotice("You've reached your storage limit."),
    ).toBeNull();
  });
});

describe('attachStdoutHandler — streamEvent string fields', () => {
  const STRING_FIELDS = [
    'agentScope',
    'queryRunId',
    'turnId',
    'sessionId',
    'messageUuid',
    'displayLevel',
    'text',
    'title',
    'summary',
    'detail',
    'rawType',
    'toolName',
    'toolUseId',
    'parentToolUseId',
    'skillName',
    'toolInputSummary',
    'toolResult',
    'hookName',
    'hookEvent',
    'hookOutcome',
    'statusText',
    'taskDescription',
    'taskId',
    'taskStatus',
    'taskSummary',
    'taskType',
    'workflowName',
    'subagentType',
    'lastToolName',
    'outputFile',
  ];

  test('drops a non-string toolInputSummary and keeps the rest of the event', async () => {
    const h = await feed([
      frame({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_progress',
          toolUseId: 'toolu_1',
          toolInputSummary: { length: 100 },
          elapsedSeconds: 3,
        },
      }),
    ]);
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0].status).toBe('stream');
    expect(h.outputs[0].streamEvent).toEqual({
      eventType: 'tool_progress',
      toolUseId: 'toolu_1',
      elapsedSeconds: 3,
    });
  });

  test('drops every string-typed field that arrives as a non-string', async () => {
    const bad: Record<string, unknown> = { eventType: 'status' };
    STRING_FIELDS.forEach((field, i) => {
      bad[field] = i % 2 ? { toString: 0, valueOf: 0 } : 7;
    });
    const h = await feed([
      frame({ status: 'stream', result: null, streamEvent: bad }),
    ]);
    expect(h.outputs[0].streamEvent).toEqual({ eventType: 'status' });
  });

  test('keeps valid string fields and a null parentToolUseId untouched', async () => {
    const good: Record<string, unknown> = { eventType: 'tool_progress' };
    for (const field of STRING_FIELDS) good[field] = `v-${field}`;
    const h = await feed([
      frame({ status: 'stream', result: null, streamEvent: good }),
      frame({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'thinking_delta',
          text: 'hmm',
          parentToolUseId: null,
        },
      }),
    ]);
    expect(h.outputs[0].streamEvent).toEqual(good);
    expect(h.outputs[1].streamEvent).toEqual({
      eventType: 'thinking_delta',
      text: 'hmm',
      parentToolUseId: null,
    });
  });

  test.each([
    ['string', 'tool_progress'],
    ['number', 5],
    ['array', [{ eventType: 'status' }]],
    ['null', null],
    ['object without a string eventType', { eventType: 3, text: 'x' }],
  ])(
    'drops a %s streamEvent and keeps the frame',
    async (_label, streamEvent) => {
      const h = await feed([
        frame({
          status: 'stream',
          result: null,
          streamEvent,
          newSessionId: 'sess-1',
        }),
      ]);
      expect(h.outputs).toHaveLength(1);
      expect(h.outputs[0].status).toBe('stream');
      expect(h.outputs[0].newSessionId).toBe('sess-1');
      expect('streamEvent' in h.outputs[0]).toBe(false);
    },
  );
});

describe('framed streamEvent -> real Discord streaming controller', () => {
  // Host path: container stdout -> attachStdoutHandler -> onOutput ->
  // feedStreamEventToCard (src/index.ts) -> DiscordStreamingEditController.
  // src/index.ts boots the whole host on import, so `dispatch` mirrors the
  // feedStreamEventToCard cases this test exercises (thinking_delta,
  // tool_use_start, tool_progress -> updateToolSummary) verbatim in shape.
  type Edit = { content: string };
  let edits: Edit[];

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    });
    edits = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSession() {
    const message = {
      id: 'discord-msg-1',
      edit: vi.fn(async (content: string) => {
        edits.push({ content });
        return message;
      }),
    };
    const channel = { send: vi.fn(async () => message) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new DiscordStreamingEditController(channel as any);
  }

  function dispatch(
    session: DiscordStreamingEditController,
    o: ContainerOutput,
  ): void {
    const se = o.status === 'stream' ? o.streamEvent : undefined;
    if (!se) return;
    switch (se.eventType) {
      case 'thinking_delta':
        if (se.text) session.appendThinking(se.text);
        break;
      case 'tool_use_start':
        if (se.toolUseId && se.toolName) {
          session.setThinking();
          session.startTool(se.toolUseId, se.toolName);
        }
        break;
      case 'tool_progress':
        if (se.toolUseId && se.toolInputSummary) {
          session.updateToolSummary(se.toolUseId, se.toolInputSummary);
        }
        break;
    }
  }

  /** Feed frames, then let the aux-flush timer fire; return any timer throw. */
  async function run(frames: string[]): Promise<unknown> {
    const session = makeSession();
    const stream = new PassThrough();
    const state = createStdoutParserState();
    attachStdoutHandler(stream, state, {
      groupName: 'discord-tenant',
      label: 'Container',
      resetTimeout: () => {},
      onOutput: async (o) => {
        try {
          // Mirrors the try/catch around the onOutput body in src/index.ts.
          dispatch(session, o);
        } catch {
          // a synchronous throw here is contained by the host; not the bug
        }
      },
    });
    let timerError: unknown;
    for (const f of frames) {
      expect(() => stream.write(f)).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      await state.outputChain;
    }
    try {
      // AUX_FLUSH_INTERVAL is 1500ms: this fires the aux-flush timer.
      await vi.advanceTimersByTimeAsync(5_000);
    } catch (err) {
      timerError = err;
    }
    await state.outputChain;
    return timerError;
  }

  const prelude = [
    frame({
      status: 'stream',
      result: null,
      streamEvent: { eventType: 'thinking_delta', text: 'let me check' },
    }),
    frame({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'tool_use_start',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
      },
    }),
  ];

  test('an object toolInputSummary does not crash the aux flush', async () => {
    const timerError = await run([
      ...prelude,
      frame({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_progress',
          toolUseId: 'toolu_1',
          toolInputSummary: { length: 100 },
        },
      }),
    ]);
    expect(timerError).toBeUndefined();
    expect(uncaught).toEqual([]);
    // The aux flush actually ran and rendered the tool without a summary.
    expect(edits.length).toBeGreaterThan(0);
    const last = edits[edits.length - 1].content;
    expect(last).toContain('`Bash`');
    expect(last).not.toContain('[object Object]');
  });

  test('a valid string toolInputSummary still renders', async () => {
    const timerError = await run([
      ...prelude,
      frame({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_progress',
          toolUseId: 'toolu_1',
          toolInputSummary: 'command: ls -la',
        },
      }),
    ]);
    expect(timerError).toBeUndefined();
    expect(uncaught).toEqual([]);
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[edits.length - 1].content).toMatch(
      /`Bash` \([^)]*\) {2}command: ls -la/,
    );
  });
});

describe('updateToolSummary — non-string guard (defence in depth)', () => {
  test('Discord ignores a non-string summary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const message = { id: 'm', edit: vi.fn(async () => message) };
      const session = new DiscordStreamingEditController({
        send: vi.fn(async () => message),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      session.appendThinking('x');
      await vi.advanceTimersByTimeAsync(0);
      session.startTool('t1', 'Bash');
      // Longer than MAX_TOOL_SUMMARY_CHARS, so buildAuxPrefix() would slice.
      session.updateToolSummary('t1', { length: 100 } as unknown as string);
      let timerError: unknown;
      try {
        await vi.advanceTimersByTimeAsync(5_000);
      } catch (err) {
        timerError = err;
      }
      expect(timerError).toBeUndefined();
      expect(uncaught).toEqual([]);
      expect(message.edit).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('DingTalk ignores a non-string summary', () => {
    const session = new DingTalkStreamingCardController(
      { clientId: 'id', clientSecret: 'secret' },
      { type: 'user', userId: 'u' },
    );
    session.startTool('t1', 'Bash');
    session.updateToolSummary('t1', { length: 9 } as unknown as string);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).tools.get('t1').summary).toBeUndefined();
    session.updateToolSummary('t1', 'command: ls');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any).tools.get('t1').summary).toBe('command: ls');
  });
});
