/**
 * The host records a turn's steps from its stream events (src/turn-steps.ts);
 * the Web builds the same steps live in its chat store. A settled reply shows
 * what the host stored, so the two must agree. This feeds one event sequence,
 * with one clock, to the real Web store and to the host's TurnTraceTracker and
 * compares the steps that come out: ids, kinds, status, titles, texts, tool
 * names, summaries, previews and the times.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupInfo, StreamEvent } from '../web/src/stores/chat';
import {
  finishSteps,
  railSteps,
  stepList,
  type StreamingStep,
  type ToolResultFacts,
} from '../web/src/lib/stream-steps';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-steps-parity-'));
for (const dir of ['data', 'store', 'groups']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: path.join(root, 'data'),
  STORE_DIR: path.join(root, 'store'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
    delete: vi.fn(),
  },
  computeUploadTimeoutMs: vi.fn(() => 8000),
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { useChatStore } = await import('../web/src/stores/chat');
const { TurnTraceTracker, presentTurnTrace } =
  await import('../src/turn-trace.js');
const { projectSdkStreamEventForWeb } =
  await import('../src/workspace-interaction-runtime.js');
const { StreamEventProcessor } =
  await import('../container/agent-runner/src/stream-processor.js');
import type { InteractionMode, ProcessVisibility } from '../src/types.js';

const initialState = useChatStore.getState();
const JID = 'web:parity';
const SESSION = 'session-parity';
const SESSION_JID = `${JID}#agent:${SESSION}`;
const RUN = 'run-parity';
const T0 = Date.parse('2026-10-13T00:00:00.000Z');
const FOLDER = 'parity';

type Script = Array<[number, StreamEvent]>;

const rafCallbacks: FrameRequestCallback[] = [];
function flushRaf(): void {
  for (const cb of rafCallbacks.splice(0)) cb(0);
}

beforeEach(() => {
  rafCallbacks.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks[id - 1] = () => {};
  });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function resetStore(
  mode: InteractionMode,
  visibility: ProcessVisibility,
): void {
  useChatStore.setState(
    {
      ...initialState,
      groups:
        mode === 'proactive'
          ? {
              [JID]: {
                name: 'w',
                folder: FOLDER,
                added_at: '2026-01-01T00:00:00.000Z',
                interaction_mode: 'proactive',
                process_visibility: visibility,
              } as GroupInfo,
            }
          : {},
      activeRuns: {},
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      stopRequests: {},
      settledStreaming: {},
      clearing: {},
      agents: {},
      agentStreaming: {},
      activeAgentTab: {},
      agentMessages: {},
      agentWaiting: {},
      agentHasMore: {},
      unreadReplies: {},
    },
    true,
  );
}

interface Options {
  mode?: InteractionMode;
  /** The turn was stopped by the user. */
  stopped?: boolean;
  /**
   * The Web is fed what the host would broadcast (the events as the Workspace
   * lets the Web see them), as in production, rather than the raw script. The
   * host's own recorder takes the raw script either way and projects it.
   */
  projected?: boolean;
}

/** What the Web shows of the settled reply: the rail, as the timeline lists it. */
function webSteps(
  script: Script,
  end: number,
  options: Options,
): StreamingStep[] {
  const mode = options.mode ?? 'assistant';
  resetStore(mode, 'full');
  vi.setSystemTime(T0);
  const store = useChatStore.getState();
  store.handleRunStarted(SESSION_JID, RUN);
  for (const [offset, event] of script) {
    vi.setSystemTime(T0 + offset);
    const shown = options.projected
      ? projectSdkStreamEventForWeb(mode, 'full', event)
      : event;
    if (!shown) continue;
    useChatStore.getState().handleStreamEvent(JID, shown, SESSION, RUN);
    flushRaf();
  }
  vi.setSystemTime(T0 + end);
  const live = useChatStore.getState().agentStreaming[SESSION];
  expect(live, 'the Web kept a streaming state').toBeDefined();
  // A stop freezes the card with the steps already finished; a run that ends
  // settles them. A proactive turn has no card to settle: finish them here.
  const steps = options.stopped
    ? live!.steps!
    : finishSteps(stepList(live!.steps, live!.stepsDropped), T0 + end, false)
        .steps;
  // The one thing a proactive Workspace's stored steps lack that its live ones
  // have is the text of a call's end (a permission denial's reason, "已停止"):
  // what a tool returned is never served there, and neither is anything a
  // preview could be made of.
  return railSteps(steps).map((step) => {
    if (mode !== 'proactive') return step;
    const { resultPreview: _preview, resultFacts: _facts, ...rest } = step;
    return rest;
  });
}

/** What the host stores for the same turn, read back as the API returns it. */
function hostSteps(
  script: Script,
  end: number,
  options: Options,
): StreamingStep[] {
  const mode = options.mode ?? 'assistant';
  const stored: Array<{ stepsJson?: string; stepsDropped?: number }> = [];
  const tracker = new TurnTraceTracker({
    mode,
    getVisibility: () => 'full',
    store: (input) => stored.push(input),
  });
  for (const [offset, event] of script) {
    tracker.observe('in-1', event, T0 + offset);
  }
  const persisted = tracker.persist({
    chatJid: JID,
    inputId: 'in-1',
    now: T0 + end,
  });
  if (!persisted) return [];
  return presentTurnTrace(
    {
      chat_jid: JID,
      turn_id: 'in-1',
      thinking: '',
      thinking_duration_ms: null,
      trace_json: '[]',
      steps_json: stored[0].stepsJson ?? '[]',
      steps_dropped: stored[0].stepsDropped ?? 0,
      created_at: '2026-10-13T00:00:00.000Z',
    },
    { includeThinking: true, proactive: mode === 'proactive' },
  )!.steps;
}

function expectSameSteps(script: Script, end: number, options: Options = {}) {
  const web = webSteps(script, end, options);
  const host = hostSteps(script, end, options);
  expect(host).toEqual(web);
  return host;
}

const ev = (
  eventType: StreamEvent['eventType'],
  extra: Partial<StreamEvent> = {},
): StreamEvent => ({ eventType, ...extra }) as StreamEvent;

let counter = 0;
/** Ids that no earlier test used (the store remembers finished sub-agents). */
const uid = (name: string) => `${name}-${(counter += 1)}`;

describe('the host records the steps the Web builds', () => {
  it('reasoning, a note, tools, reasoning, tools, reasoning, answer', () => {
    const bash = uid('bash');
    const read = uid('read');
    const script: Script = [
      [0, ev('status', { statusText: 'requesting' })],
      [50, ev('thinking_start')],
      [
        100,
        ev('thinking_delta', { text: '**读取配置**\n\n先看一下目录结构。' }),
      ],
      [900, ev('thinking_end', { thinkingDurationMs: 800 })],
      [950, ev('text_delta', { text: '我先列出文件。' })],
      [
        1000,
        ev('tool_use_start', {
          toolName: 'Bash',
          toolUseId: bash,
          toolInputSummary: 'ls -la',
        }),
      ],
      [
        1100,
        ev('tool_progress', {
          toolName: 'Bash',
          toolUseId: bash,
          elapsedSeconds: 1,
        }),
      ],
      [
        1200,
        ev('tool_result', { toolUseId: bash, toolResult: 'a.txt\nb.txt' }),
      ],
      [1210, ev('tool_use_end', { toolUseId: bash })],
      [1220, ev('status', { statusText: 'requesting' })],
      [1300, ev('thinking_start')],
      [1400, ev('thinking_delta', { text: '**比较方案**\n\n两个入口。' })],
      [2000, ev('thinking_end', { thinkingDurationMs: 900 })],
      [
        2050,
        ev('tool_use_start', {
          toolName: 'Read',
          toolUseId: read,
          toolInputSummary: 'file: a.txt',
        }),
      ],
      [2100, ev('tool_use_end', { toolUseId: read })],
      [2120, ev('status', { statusText: 'requesting' })],
      [2600, ev('thinking_delta', { text: '**收尾**\n\n可以回答了。' })],
      [3000, ev('text_delta', { text: '答案：' })],
      [3100, ev('text_delta', { text: '完成。' })],
    ];
    const steps = expectSameSteps(script, 3500);
    expect(steps.map((s) => s.kind)).toEqual([
      'thinking',
      'text',
      'tool',
      'thinking',
      'tool',
      'thinking',
    ]);
  });

  it('reasoning that returns no text, and a runner that sends no thinking_start', () => {
    const t1 = uid('t');
    expectSameSteps(
      [
        [0, ev('status', { statusText: 'requesting' })],
        [13_000, ev('thinking_start')],
        [13_000, ev('thinking_end', { thinkingDurationMs: 3 })],
        [13_100, ev('tool_use_start', { toolName: 'Grep', toolUseId: t1 })],
        [13_900, ev('tool_use_end', { toolUseId: t1 })],
        [14_000, ev('thinking_delta', { text: '无开始事件的思考。' })],
        [15_000, ev('text_delta', { text: '好了。' })],
      ],
      16_000,
    );
  });

  it('a tool that was never reported done, failed results and a denial', () => {
    const a = uid('a');
    const b = uid('b');
    const c = uid('c');
    expectSameSteps(
      [
        [0, ev('tool_use_start', { toolName: 'Bash', toolUseId: a })],
        [
          10,
          ev('tool_result', { toolUseId: a, toolResult: '⚠️ exit 1\nboom' }),
        ],
        [20, ev('tool_use_start', { toolName: 'Edit', toolUseId: b })],
        [
          30,
          ev('permission_denied', {
            permissionDenied: {
              toolName: 'Edit',
              toolUseId: b,
              message: 'denied',
              reason: '没有权限',
            },
          }),
        ],
        [40, ev('tool_use_start', { toolName: 'Bash', toolUseId: c })],
        [
          50,
          ev('tool_progress', {
            toolName: 'Bash',
            toolUseId: c,
            toolInputSummary: 'sleep 100',
          }),
        ],
      ],
      9_000,
    );
  });

  it('a skill, resolved by its progress, and the call nested under it', () => {
    const skill = uid('skill');
    const inner = uid('inner');
    expectSameSteps(
      [
        [0, ev('tool_use_start', { toolName: 'Skill', toolUseId: skill })],
        [
          10,
          ev('tool_progress', {
            toolName: 'Skill',
            toolUseId: skill,
            skillName: 'pdf',
          }),
        ],
        [
          20,
          ev('tool_use_start', {
            toolName: 'Bash',
            toolUseId: inner,
            parentToolUseId: skill,
            isNested: true,
            toolInputSummary: 'pdftotext a.pdf',
          }),
        ],
        [
          30,
          ev('tool_use_end', {
            toolUseId: inner,
            parentToolUseId: skill,
            isNested: true,
          }),
        ],
        [40, ev('tool_use_end', { toolUseId: skill })],
      ],
      100,
    );
  });

  it('a sub-agent: its task step, its own tools and reasoning kept out', () => {
    const task = uid('task');
    const sub = uid('sub');
    const steps = expectSameSteps(
      [
        [0, ev('thinking_delta', { text: '分派给子代理。' })],
        [
          10,
          ev('tool_use_start', {
            toolName: 'Task',
            toolUseId: task,
            toolInputSummary: 'research',
          }),
        ],
        [
          11,
          ev('task_start', {
            toolUseId: task,
            taskId: task,
            taskDescription: '调研依赖',
          }),
        ],
        [
          20,
          ev('tool_use_start', {
            toolName: 'Read',
            toolUseId: sub,
            parentToolUseId: task,
            toolInputSummary: 'package.json',
          }),
        ],
        [
          25,
          ev('thinking_delta', { text: '子代理在想', parentToolUseId: task }),
        ],
        [26, ev('text_delta', { text: '子代理在说', parentToolUseId: task })],
        [30, ev('tool_use_end', { toolUseId: sub, parentToolUseId: task })],
        [
          40,
          ev('task_progress', {
            toolUseId: task,
            taskId: task,
            summary: '读了 3 个文件',
          }),
        ],
        [
          90,
          ev('task_notification', {
            toolUseId: task,
            taskId: task,
            taskStatus: 'completed',
            taskSummary: '依赖已梳理',
          }),
        ],
        [95, ev('tool_use_end', { toolUseId: task })],
        [100, ev('text_delta', { text: '汇总如下。' })],
      ],
      200,
    );
    expect(steps.map((s) => s.kind)).toEqual(['thinking', 'task']);
  });

  it('a failed and a background task', () => {
    const failed = uid('t-failed');
    const background = uid('t-bg');
    expectSameSteps(
      [
        [0, ev('tool_use_start', { toolName: 'Agent', toolUseId: failed })],
        [
          5,
          ev('task_updated', {
            taskId: failed,
            toolUseId: failed,
            taskPatch: { status: 'failed', error: 'boom' },
          }),
        ],
        [
          10,
          ev('task_start', {
            taskId: background,
            toolUseId: background,
            taskDescription: '后台',
          }),
        ],
        [
          20,
          ev('task_updated', {
            taskId: background,
            toolUseId: background,
            taskPatch: { is_backgrounded: true },
          }),
        ],
      ],
      100,
    );
  });

  it('text that reopens after reasoning, before and after tools', () => {
    const r1 = uid('r');
    const b1 = uid('b');
    expectSameSteps(
      [
        [0, ev('text_delta', { text: '先读配置。' })],
        [10, ev('thinking_delta', { text: '再想想' })],
        [20, ev('text_delta', { text: '然后看日志。' })],
        [30, ev('tool_use_start', { toolName: 'Read', toolUseId: r1 })],
        [40, ev('tool_use_end', { toolUseId: r1 })],
        [50, ev('text_delta', { text: '最后跑测试。' })],
        [60, ev('tool_use_start', { toolName: 'Bash', toolUseId: b1 })],
        [70, ev('text_delta', { text: '全部通过。' })],
      ],
      100,
    );
  });

  it('a stop freezes running tools as failed, on both sides', () => {
    const a = uid('a');
    const b = uid('b');
    const steps = expectSameSteps(
      [
        [0, ev('thinking_delta', { text: '想一下' })],
        [10, ev('tool_use_start', { toolName: 'Read', toolUseId: a })],
        [20, ev('tool_use_end', { toolUseId: a })],
        [30, ev('tool_use_start', { toolName: 'Bash', toolUseId: b })],
        [40, ev('status', { statusText: 'interrupted' })],
      ],
      900,
      { stopped: true },
    );
    expect(steps.at(-1)).toMatchObject({
      toolName: 'Bash',
      status: 'error',
      resultPreview: '已停止',
    });
  });

  it("how a tool ended: the SDK flag, what it did, and a sub-agent's totals", () => {
    const silent = uid('silent');
    const read = uid('read');
    const edit = uid('edit');
    const fine = uid('fine');
    const task = uid('task');
    const steps = expectSameSteps(
      [
        // A failure with no output at all: only the flag says so.
        [0, ev('tool_use_start', { toolName: 'Bash', toolUseId: silent })],
        [10, ev('tool_result', { toolUseId: silent, toolIsError: true })],
        [20, ev('tool_use_end', { toolUseId: silent })],
        [30, ev('tool_use_start', { toolName: 'Read', toolUseId: read })],
        [
          40,
          ev('tool_result', {
            toolUseId: read,
            toolResult: 'x',
            toolIsError: false,
            toolResultFacts: { lines: 40, totalLines: 120 },
          }),
        ],
        [50, ev('tool_use_end', { toolUseId: read })],
        // The flag outranks the text's own failure prefix.
        [60, ev('tool_use_start', { toolName: 'Edit', toolUseId: edit })],
        [
          70,
          ev('tool_result', {
            toolUseId: edit,
            toolResult: '⚠️ was this a failure',
            toolIsError: true,
            toolResultFacts: { added: 2, removed: 1 },
          }),
        ],
        [80, ev('tool_use_start', { toolName: 'Edit', toolUseId: fine })],
        [
          90,
          ev('tool_result', {
            toolUseId: fine,
            toolResult: '⚠️ only looks like one',
            toolIsError: false,
          }),
        ],
        // A sub-agent's totals land on its task step, which runs on.
        [100, ev('tool_use_start', { toolName: 'Agent', toolUseId: task })],
        [
          101,
          ev('task_start', {
            toolUseId: task,
            taskId: task,
            taskDescription: '调研',
          }),
        ],
        [
          120,
          ev('tool_result', {
            toolUseId: task,
            toolResult: 'report',
            toolResultFacts: {
              agent: { toolUses: 3, reads: 2, tokens: 900, durationMs: 4_000 },
            },
          }),
        ],
        [
          130,
          ev('task_notification', {
            toolUseId: task,
            taskId: task,
            taskStatus: 'completed',
            taskSummary: '完成',
          }),
        ],
      ],
      200,
    );
    const byId = (id: string) => steps.find((s) => s.toolUseId === id)!;
    expect(byId(silent)).toMatchObject({ status: 'error' });
    expect(byId(silent)).not.toHaveProperty('resultFacts');
    expect(byId(read)).toMatchObject({
      status: 'done',
      resultFacts: { lines: 40, totalLines: 120 },
    });
    expect(byId(edit)).toMatchObject({
      status: 'error',
      resultFacts: { added: 2, removed: 1 },
    });
    expect(byId(fine)).toMatchObject({ status: 'done' });
    expect(steps.find((s) => s.kind === 'task')).toMatchObject({
      status: 'done',
      resultFacts: { agent: { toolUses: 3, reads: 2 } },
    });
  });

  it('a proactive turn: a failure still shows, the numbers read from output do not', () => {
    const silent = uid('silent');
    const read = uid('read');
    const steps = expectSameSteps(
      [
        [0, ev('tool_use_start', { toolName: 'Bash', toolUseId: silent })],
        [
          10,
          ev('tool_result', {
            toolUseId: silent,
            toolIsError: true,
            toolResultFacts: { exitCode: 2 },
          }),
        ],
        [20, ev('tool_use_end', { toolUseId: silent })],
        [30, ev('tool_use_start', { toolName: 'Read', toolUseId: read })],
        [
          40,
          ev('tool_result', {
            toolUseId: read,
            toolResult: '私有内容',
            toolIsError: false,
            toolResultFacts: { lines: 40, totalLines: 120 },
          }),
        ],
        [50, ev('tool_use_end', { toolUseId: read })],
      ],
      100,
      { mode: 'proactive', projected: true },
    );
    expect(steps.map((s) => [s.toolName, s.status])).toEqual([
      ['Bash', 'error'],
      ['Read', 'done'],
    ]);
    expect(JSON.stringify(steps)).not.toContain('resultFacts');
    expect(JSON.stringify(steps)).not.toContain('私有内容');
  });

  /**
   * The events the real Runner emits for one top-level tool call, as a script:
   * its input streamed in, then the SDK's result message.
   */
  function runnerScript(
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
    result: { content: string; isError?: boolean; structured?: unknown },
  ): Script {
    const events: StreamEvent[] = [];
    const processor = new StreamEventProcessor(
      (output) => {
        if (output.streamEvent) {
          events.push(output.streamEvent as unknown as StreamEvent);
        }
      },
      () => {},
    );
    processor.processStreamEvent({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          name: toolName,
          id: toolUseId,
          input: {},
        },
      },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(input),
        },
      },
    });
    processor.processMainToolResults({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: result.content,
            // The SDK leaves is_error out when a call succeeded.
            ...(result.isError === undefined
              ? {}
              : { is_error: result.isError }),
          },
        ],
      },
      tool_use_result: result.structured,
    });
    return events.map((event, index) => [index * 10, event]);
  }

  it('a successful output that begins with the failure mark stays a success: Runner events to both sides', () => {
    const warn = uid('warn');
    const script = runnerScript(
      'Bash',
      warn,
      { command: 'echo "⚠️ heads up: nothing is wrong"' },
      {
        content: '⚠️ heads up: nothing is wrong',
        structured: { stdout: '⚠️ heads up: nothing is wrong', stderr: '' },
      },
    );
    // The Runner says the call did not fail, so its text is not read as one.
    const ended = script.find(([, e]) => e.eventType === 'tool_result')![1];
    expect(ended).toMatchObject({ toolIsError: false });
    const [step] = expectSameSteps(script, 500);
    expect(step).toMatchObject({
      kind: 'tool',
      status: 'done',
      resultPreview: '⚠️ heads up: nothing is wrong',
    });

    // A failure carries the flag and the mark the Runner adds; the preview is
    // the output without the mark.
    const bad = uid('bad');
    const [failed] = expectSameSteps(
      runnerScript(
        'Bash',
        bad,
        { command: 'exit 3' },
        {
          content: 'Exit code 3\nboom',
          isError: true,
          structured: 'Error: Exit code 3\nboom',
        },
      ),
      500,
    );
    expect(failed).toMatchObject({
      status: 'error',
      resultPreview: 'Exit code 3\nboom',
      resultFacts: { exitCode: 3 },
    });
  });

  it('a Runner that does not send the flag is still read by the mark', () => {
    const old = uid('old');
    const withoutFlag = runnerScript(
      'Bash',
      old,
      { command: 'false' },
      { content: 'Exit code 1', isError: true },
    ).map(([at, event]): [number, StreamEvent] => {
      const { toolIsError: _flag, toolResultFacts: _facts, ...rest } = event;
      return [at, rest as StreamEvent];
    });
    expect(
      withoutFlag.find(([, e]) => e.eventType === 'tool_result')![1],
    ).not.toHaveProperty('toolIsError');
    const [step] = expectSameSteps(withoutFlag, 500);
    expect(step).toMatchObject({
      status: 'error',
      resultPreview: 'Exit code 1',
    });
  });

  it('a proactive turn: a successful ⚠️ output is a success, and its text stays private', () => {
    const warn = uid('warn');
    const [step] = expectSameSteps(
      runnerScript(
        'Bash',
        warn,
        { command: 'cat notes.txt' },
        {
          content: '⚠️ private',
          structured: { stdout: '⚠️ private', stderr: '' },
        },
      ),
      500,
      { mode: 'proactive', projected: true },
    );
    expect(step).toMatchObject({ status: 'done' });
    expect(JSON.stringify(step)).not.toContain('private');
  });

  it('a proactive turn: the speech tool is no step, the rest is the same', () => {
    const read = uid('read');
    const say = uid('say');
    const steps = expectSameSteps(
      [
        [0, ev('status', { statusText: 'requesting' })],
        [100, ev('thinking_start')],
        [200, ev('thinking_delta', { text: '**决定**\n\n先读再回复。' })],
        [400, ev('thinking_end', { thinkingDurationMs: 300 })],
        [
          450,
          ev('tool_use_start', {
            toolName: 'Read',
            toolUseId: read,
            toolInputSummary: 'a.ts',
          }),
        ],
        [460, ev('tool_result', { toolUseId: read, toolResult: '内容' })],
        [470, ev('tool_use_end', { toolUseId: read })],
        [480, ev('status', { statusText: 'requesting' })],
        [600, ev('thinking_delta', { text: '该回复了。' })],
        [
          700,
          ev('tool_use_start', {
            toolName: 'mcp__happyclaw__send_message',
            toolUseId: say,
            toolInputSummary: '你好',
          }),
        ],
        [
          710,
          ev('tool_progress', { toolUseId: say, toolInputSummary: '你好' }),
        ],
        [720, ev('tool_result', { toolUseId: say, toolResult: '已发送' })],
        [730, ev('tool_use_end', { toolUseId: say })],
        // the model's own text never reaches a proactive Workspace's process
        [740, ev('text_delta', { text: '私有的模型文本' })],
      ],
      900,
      { mode: 'proactive' },
    );
    expect(steps.map((s) => [s.kind, s.toolName])).toEqual([
      ['thinking', undefined],
      ['tool', 'Read'],
      ['thinking', undefined],
    ]);
    expect(JSON.stringify(steps)).not.toContain('私有的模型文本');
    expect(JSON.stringify(steps)).not.toContain('内容');
  });
});

// A seeded generator of plausible event sequences, so the two sides are
// compared on more than the cases someone thought of.

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const THINKING_TEXTS = [
  '先看看。',
  '**检查入口**\n\n读一下配置文件。',
  '再比较两种做法，各有利弊。',
  '## 计划\n\n1. 读\n2. 改',
  '*斜体*标记。\n\n第二段。',
];
const REPLY_TEXTS = [
  '我先看一下。',
  '好的，',
  '接下来运行测试。',
  '结论如下：',
];
const TOOL_NAMES = ['Bash', 'Read', 'Grep', 'Edit', 'Skill', 'WebFetch'];
const SUMMARIES = [undefined, 'ls -la', 'file: src/a.ts', 'pattern: foo'];
const RESULTS = [undefined, 'ok', '第一行\n第二行', '⚠️ exit 2\nfailed'];

const FACTS: readonly ToolResultFacts[] = [
  { lines: 40, totalLines: 120 },
  { added: 3, removed: 1 },
  { created: true, added: 12 },
  { files: 4, matches: 9, durationMs: 33 },
  { exitCode: 2 },
  { httpCode: 200, bytes: 2048, durationMs: 310 },
  { searches: 1, durationMs: 470 },
  {
    agent: {
      toolUses: 3,
      reads: 2,
      commands: 1,
      tokens: 900,
      durationMs: 4000,
    },
  },
];

function generate(seed: number, proactive: boolean): Script {
  const rand = rng(seed);
  // How a tool ended is drawn from a stream of its own, so the shape of the
  // sequences does not move when it changes.
  const side = rng((seed ^ 0x5bd1e995) >>> 0);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(rand() * items.length)];
  const script: Script = [];
  let now = 0;
  const push = (event: StreamEvent, advance = Math.floor(rand() * 1_500)) => {
    now += advance;
    script.push([now, event]);
  };
  let n = 0;
  const id = (prefix: string) => `${prefix}-${seed}-${(n += 1)}`;
  push(ev('status', { statusText: 'requesting' }), 0);

  /** The SDK's flag and the numbers of a result; a proactive host has no numbers to give. */
  const ended = (): Partial<StreamEvent> => {
    const flag = side();
    const withFacts = side() < 0.5;
    const facts = FACTS[Math.floor(side() * FACTS.length)];
    return {
      ...(flag < 0.3
        ? { toolIsError: true }
        : flag < 0.5
          ? { toolIsError: false }
          : {}),
      ...(withFacts && !proactive ? { toolResultFacts: facts } : {}),
    };
  };

  const tool = () => {
    const toolUseId = id('tool');
    const toolName = pick(TOOL_NAMES);
    const summary = pick(SUMMARIES);
    push(
      ev('tool_use_start', {
        toolName,
        toolUseId,
        toolInputSummary: summary,
        skillName: toolName === 'Skill' && rand() < 0.5 ? 'pdf' : undefined,
      }),
    );
    if (rand() < 0.4) {
      push(
        ev('tool_progress', {
          toolName,
          toolUseId,
          elapsedSeconds: 1,
          toolInputSummary: rand() < 0.5 ? pick(SUMMARIES) : undefined,
        }),
      );
    }
    const finish = rand();
    if (finish < 0.15) return; // never reports back
    if (finish < 0.25) {
      push(
        ev('permission_denied', {
          permissionDenied: {
            toolName,
            toolUseId,
            message: 'denied',
            reason: rand() < 0.5 ? '不允许' : undefined,
          },
        }),
      );
      return;
    }
    if (finish < 0.8) {
      const result = pick(RESULTS);
      push(ev('tool_result', { toolUseId, toolResult: result, ...ended() }));
    }
    if (rand() < 0.9) push(ev('tool_use_end', { toolUseId }));
  };

  const task = () => {
    const taskId = id('task');
    const named = rand() < 0.7;
    push(
      ev('tool_use_start', {
        toolName: rand() < 0.5 ? 'Task' : 'Agent',
        toolUseId: taskId,
        toolInputSummary: named ? '分头调研' : undefined,
      }),
    );
    push(
      ev('task_start', {
        toolUseId: taskId,
        taskId,
        taskDescription: named ? '调研依赖' : undefined,
      }),
    );
    for (let i = 0, count = Math.floor(rand() * 4); i < count; i += 1) {
      const sub = id('sub');
      const nested = { parentToolUseId: taskId };
      push(
        ev('tool_use_start', {
          toolName: 'Read',
          toolUseId: sub,
          toolInputSummary: 'x',
          ...nested,
        }),
      );
      if (rand() < 0.5) push(ev('thinking_delta', { text: '子', ...nested }));
      if (rand() < 0.5) push(ev('text_delta', { text: '子文', ...nested }));
      push(ev('tool_use_end', { toolUseId: sub, ...nested }));
    }
    if (rand() < 0.6) {
      push(
        ev('task_progress', {
          toolUseId: taskId,
          taskId,
          summary: '进展',
        }),
      );
    }
    const end = rand();
    if (end < 0.5) {
      push(
        ev('task_notification', {
          toolUseId: taskId,
          taskId,
          taskStatus: rand() < 0.8 ? 'completed' : 'failed',
          taskSummary: '总结',
        }),
      );
    } else if (end < 0.7) {
      push(
        ev('task_updated', {
          toolUseId: taskId,
          taskId,
          taskPatch: { status: pick(['completed', 'killed', 'running']) },
        }),
      );
    }
    // The call returns its totals; the task step goes on with its lifecycle.
    if (!proactive && side() < 0.5) {
      push(
        ev('tool_result', {
          toolUseId: taskId,
          toolResult: '报告',
          toolResultFacts: {
            agent: { toolUses: 2, reads: 1, tokens: 500, durationMs: 1200 },
          },
        }),
        5,
      );
    }
    if (rand() < 0.6) push(ev('tool_use_end', { toolUseId: taskId }));
  };

  const reasoning = () => {
    const withMarkers = rand() < 0.7;
    if (withMarkers) push(ev('thinking_start'));
    const silent = rand() < 0.2;
    if (!silent) {
      for (let i = 0, count = 1 + Math.floor(rand() * 3); i < count; i += 1) {
        push(ev('thinking_delta', { text: pick(THINKING_TEXTS) }));
      }
    }
    if (withMarkers && rand() < 0.85) {
      push(
        ev('thinking_end', { thinkingDurationMs: Math.floor(rand() * 4_000) }),
      );
    }
  };

  const speech = () => {
    const say = id('say');
    push(
      ev('tool_use_start', {
        toolName: 'mcp__happyclaw__send_message',
        toolUseId: say,
        toolInputSummary: '你好',
      }),
    );
    if (rand() < 0.5)
      push(ev('tool_result', { toolUseId: say, toolResult: '已发送' }));
    if (rand() < 0.7) push(ev('tool_use_end', { toolUseId: say }));
  };

  for (
    let round = 0, rounds = 1 + Math.floor(rand() * 6);
    round < rounds;
    round += 1
  ) {
    if (rand() < 0.8) push(ev('status', { statusText: 'requesting' }));
    if (rand() < 0.8) reasoning();
    if (!proactive && rand() < 0.4) {
      for (let i = 0, count = 1 + Math.floor(rand() * 2); i < count; i += 1) {
        push(ev('text_delta', { text: pick(REPLY_TEXTS) }));
      }
    }
    if (rand() < 0.1)
      push(ev('hook_started', { hookName: 'h', hookEvent: 'Pre' }));
    if (rand() < 0.1) push(ev('todo_update', { todos: [] }));
    const roll = rand();
    if (roll < 0.15) task();
    else if (proactive && roll < 0.3) speech();
    else if (roll < 0.9) {
      for (let i = 0, count = 1 + Math.floor(rand() * 3); i < count; i += 1)
        tool();
    }
    // some text after the last thing, or reasoning after text
    if (!proactive && rand() < 0.3)
      push(ev('text_delta', { text: pick(REPLY_TEXTS) }));
  }
  if (!proactive && rand() < 0.7)
    push(ev('text_delta', { text: '最终答案。' }));
  return script;
}

describe('generated event sequences', () => {
  const SEEDS = Array.from({ length: 120 }, (_, index) => index + 1);

  it.each(SEEDS)('assistant turn %i', (seed) => {
    const script = generate(seed, false);
    const end = script.at(-1)![0] + 500;
    // a sequence the Web would not keep a card for compares as empty
    const web = webSteps(script, end, {});
    const host = hostSteps(script, end, {});
    expect(host).toEqual(web);
  });

  it.each(SEEDS)('proactive turn %i', (seed) => {
    const script = generate(seed + 1_000, true);
    const end = script.at(-1)![0] + 500;
    const web = webSteps(script, end, { mode: 'proactive' });
    const host = hostSteps(script, end, { mode: 'proactive' });
    expect(host).toEqual(web);
  });
});

describe('the generated sequences are not vacuous', () => {
  it('cover every kind and outcome of a step, in both modes', () => {
    const seen = new Set<string>();
    let withSteps = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      for (const proactive of [false, true]) {
        const script = generate(proactive ? seed + 1_000 : seed, proactive);
        const end = script.at(-1)![0] + 500;
        const steps = webSteps(script, end, {
          mode: proactive ? 'proactive' : 'assistant',
        });
        if (steps.length > 0) withSteps += 1;
        for (const step of steps) {
          seen.add(`${proactive ? 'p' : 'a'}:${step.kind}:${step.status}`);
          if (step.title) seen.add(`${step.kind}:titled`);
          if (step.resultPreview) seen.add('tool:preview');
          if (step.resultFacts) seen.add(`${proactive ? 'p' : 'a'}:facts`);
          if (step.resultFacts?.agent) seen.add('task:agent-facts');
          if (step.kind === 'tool' && step.status === 'error') {
            seen.add(
              step.resultPreview ? 'tool:error-text' : 'tool:error-silent',
            );
          }
          if (step.skillName) seen.add('tool:skill');
          if (step.summary) seen.add(`${step.kind}:summary`);
        }
      }
    }
    expect(withSteps).toBeGreaterThan(200);
    for (const wanted of [
      'a:thinking:done',
      'a:tool:done',
      'a:tool:error',
      'a:task:done',
      'a:task:error',
      'a:text:done',
      'p:thinking:done',
      'p:tool:done',
      'p:task:done',
      'thinking:titled',
      'tool:preview',
      'tool:skill',
      'task:summary',
      'a:facts',
      'task:agent-facts',
      'tool:error-text',
      'tool:error-silent',
    ]) {
      expect(seen, wanted).toContain(wanted);
    }
    expect([...seen].some((key) => key.startsWith('p:text'))).toBe(false);
    // A proactive host never has the numbers to record.
    expect(seen).not.toContain('p:facts');
  });
});
