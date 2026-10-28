import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { OutputFrameScanner } from '../src/output-frame-scanner.js';

/**
 * Drives the real Agent Runner process (tsx, bundled Claude Code CLI, real
 * SDK) against a local fake Anthropic SSE endpoint, the way the Host does:
 * ContainerInput on stdin, an IPC input with a delivery receipt, framed
 * stdout and a `_close` sentinel once the input has settled.
 */

const repoRoot = process.cwd();
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const runnerEntry = path.join(
  repoRoot,
  'container',
  'agent-runner',
  'src',
  'index.ts',
);
const OUTPUT_START = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END = '---HAPPYCLAW_OUTPUT_END---';
const MODEL = 'claude-sonnet-4-5-20250929';
const scratchRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-runner-process-'),
);

afterAll(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

type ReplyBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

type Frame = Record<string, any>;

interface MainRequest {
  max_tokens?: number;
  messages?: unknown[];
  thinking?: { type?: string };
  tools?: Array<{ name?: string; defer_loading?: boolean }>;
}

interface RunnerRun {
  frames: Frame[];
  stderr: string;
  /** Request bodies of main-loop model calls (those that offer tools). */
  mainRequests: MainRequest[];
  exitCode: number | null;
}

function writeEvent(
  response: http.ServerResponse,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendMessage(
  response: http.ServerResponse,
  id: string,
  blocks: ReplyBlock[],
  stopReason = blocks.some((block) => block.type === 'tool_use')
    ? 'tool_use'
    : 'end_turn',
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  writeEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 1 },
    },
  });
  blocks.forEach((block, index) => {
    writeEvent(response, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block:
        block.type === 'text'
          ? { type: 'text', text: '' }
          : block.type === 'tool_use'
            ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
            : { type: 'thinking', thinking: '', signature: '' },
    });
    if (block.type === 'text') {
      writeEvent(response, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else if (block.type === 'tool_use') {
      writeEvent(response, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input),
        },
      });
    } else {
      writeEvent(response, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
      writeEvent(response, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: `sig-${id}-${index}` },
      });
    }
    writeEvent(response, 'content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  });
  writeEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: { output_tokens: 8 },
  });
  writeEvent(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

function runnerEnv(
  baseUrl: string,
  dirs: { group: string; ipc: string; config: string; home: string },
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        !entry[0].startsWith('HAPPYCLAW_') &&
        ![
          'CLAUDE_CODE_OAUTH_TOKEN',
          'ANTHROPIC_BASE_URL',
          'ANTHROPIC_AUTH_TOKEN',
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_MODEL',
          'ANTHROPIC_CUSTOM_HEADERS',
          'CLAUDE_CONFIG_DIR',
          'ENABLE_TOOL_SEARCH',
          'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
        ].includes(entry[0]),
    ),
  );
  return {
    ...env,
    HAPPYCLAW_WORKSPACE_GROUP: dirs.group,
    HAPPYCLAW_WORKSPACE_IPC: dirs.ipc,
    HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE: '1',
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'fake-local-runner-token',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: MODEL,
    CLAUDE_CONFIG_DIR: dirs.config,
    // Keep the developer's own ~/.claude (hooks, skills, CLAUDE.md) out.
    HOME: dirs.home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/**
 * Answer the runner's Workspace Memory snapshot requests at once, as a Host
 * without a memory store would, so a turn does not wait for the 8 s timeout.
 */
function answerMemoryRequests(tasksDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(tasksDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.includes('_result_')) continue;
    const file = path.join(tasksDir, name);
    let request: { type?: string; requestId?: string };
    try {
      request = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    fs.rmSync(file, { force: true });
    if (request.type !== 'workspace_memory' || !request.requestId) continue;
    fs.writeFileSync(
      path.join(tasksDir, `workspace_memory_result_${request.requestId}.json`),
      JSON.stringify({ success: false, error: 'no memory store in test' }),
    );
  }
}

async function runRunner(options: {
  name: string;
  reply?: (call: number) => ReplyBlock[];
  /** Optional async handler for main model calls; overrides `reply` when set. */
  handle?: (ctx: {
    call: number;
    body: { tools?: unknown[]; messages?: unknown[] };
    writeInput: (index: number, text: string) => void;
  }) => Promise<ReplyBlock[]> | ReplyBlock[];
  /** Stop reason of each main call; derived from its blocks by default. */
  stopReason?: (call: number) => string | undefined;
  /**
   * An error the endpoint answers a main call with instead of `reply`. It
   * says not to retry, so Claude Code gives up on the first one.
   */
  reject?: (call: number) => { status: number; body: unknown } | undefined;
  /** Extra ContainerInput fields, as the Host sets them for the launch. */
  input?: Record<string, unknown>;
  /** The workspace's own .claude/settings.json. */
  projectSettings?: object;
  /** Close the runner once this frame arrives. */
  settled: (frame: Frame) => boolean;
  /**
   * Further Host inputs, each written once the previous one settled; the
   * runner takes them into the same query while its stream is still open.
   */
  followUps?: string[];
}): Promise<RunnerRun> {
  const scratch = path.join(scratchRoot, options.name);
  const dirs = {
    group: path.join(scratch, 'group'),
    ipc: path.join(scratch, 'ipc'),
    config: path.join(scratch, 'claude-config'),
    home: path.join(scratch, 'home'),
  };
  const inputDir = path.join(dirs.ipc, 'input');
  const tasksDir = path.join(dirs.ipc, 'tasks');
  for (const dir of [dirs.group, inputDir, tasksDir, dirs.config, dirs.home]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (options.projectSettings) {
    fs.mkdirSync(path.join(dirs.group, '.claude'));
    fs.writeFileSync(
      path.join(dirs.group, '.claude', 'settings.json'),
      JSON.stringify(options.projectSettings),
    );
  }
  // A durable Host input: its receipt must come back exactly once.
  const writeInput = (index: number, text: string): void => {
    fs.writeFileSync(
      path.join(inputDir, `000${index}-input.json`),
      JSON.stringify({
        type: 'message',
        text,
        queryRunId: 'query-run-1',
        receipt: {
          deliveryId: `delivery-${index}`,
          chatJid: 'web:runner-process',
          cursor: {
            timestamp: `2026-10-26T00:00:0${index}.000Z`,
            id: `message-${index}`,
          },
        },
      }),
    );
  };
  writeInput(1, 'Please answer the question.');
  const followUps = [...(options.followUps ?? [])];

  const mainRequests: RunnerRun['mainRequests'] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const url = request.url ?? '';
      if (!url.includes('/v1/messages') || url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      let body: MainRequest = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Answered below as an auxiliary call.
      }
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        sendMessage(response, 'msg_aux', [{ type: 'text', text: 'aux' }]);
        return;
      }
      mainRequests.push(body);
      const call = mainRequests.length;
      const rejection = options.reject?.(call);
      if (rejection) {
        response.writeHead(rejection.status, {
          'content-type': 'application/json',
          'x-should-retry': 'false',
        });
        response.end(JSON.stringify(rejection.body));
        return;
      }
      if (options.handle) {
        void Promise.resolve(options.handle({ call, body, writeInput })).then(
          (blocks) =>
            sendMessage(
              response,
              `msg_main_${call}`,
              blocks,
              options.stopReason?.(call),
            ),
        );
        return;
      }
      sendMessage(
        response,
        `msg_main_${call}`,
        options.reply!(call),
        options.stopReason?.(call),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake Anthropic server did not expose a TCP port');
  }

  const child = spawn(tsxBin, [runnerEntry], {
    cwd: repoRoot,
    env: runnerEnv(`http://127.0.0.1:${address.port}`, dirs),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const memoryResponder = setInterval(() => answerMemoryRequests(tasksDir), 20);
  const frames: Frame[] = [];
  const scanner = new OutputFrameScanner(OUTPUT_START, OUTPUT_END);
  let stderr = '';
  let closeRequested = false;
  const requestClose = () => {
    if (closeRequested) return;
    closeRequested = true;
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  };
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    for (const event of scanner.push(chunk.toString())) {
      if (event.kind !== 'frame') throw new Error(`runner frame ${event.kind}`);
      const frame = JSON.parse(event.json) as Frame;
      frames.push(frame);
      if (!options.settled(frame)) continue;
      const next = followUps.shift();
      if (next === undefined) requestClose();
      else writeInput(options.followUps!.length - followUps.length + 1, next);
    }
  });
  const guard = setTimeout(() => requestClose(), 45_000);
  const killGuard = setTimeout(() => child.kill('SIGKILL'), 55_000);
  child.stdin.end(
    JSON.stringify({
      prompt: 'Cold start.',
      groupFolder: 'runner-process',
      chatJid: 'web:runner-process',
      turnId: 'cold-turn-1',
      queryRunId: 'query-run-1',
      isHome: false,
      isAdminHome: false,
      ...options.input,
    }),
  );
  const exitCode = await new Promise<number | null>((resolve) =>
    // 'close' waits for stdout/stderr to drain as well; 'exit' may come first.
    child.once('close', (code) => resolve(code)),
  );
  clearTimeout(guard);
  clearTimeout(killGuard);
  clearInterval(memoryResponder);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { frames, stderr, mainRequests, exitCode };
}

const isFinalResult = (frame: Frame): boolean =>
  frame.status === 'success' && frame.inputTurnCompleted === true;

/** Whether the silent-stop prompt appears in `value` (a boolean keeps failures short). */
const carriesSilentStopPrompt = (value: unknown): boolean =>
  JSON.stringify(value).includes('without any reply text');

const runnerLines = (stderr: string, prefix: string): string[] =>
  stderr.split('\n').filter((line) => line.includes(prefix));

describe('Agent Runner process against a fake Anthropic endpoint', () => {
  test('each query logs its startup timing once at info level', async () => {
    const run = await runRunner({
      name: 'timing',
      reply: () => [{ type: 'text', text: 'TIMED_ANSWER' }],
      settled: isFinalResult,
    });

    expect(run.exitCode).toBe(0);
    expect(run.frames.filter(isFinalResult).map((f) => f.result)).toEqual([
      'TIMED_ANSWER',
    ]);
    const timing = runnerLines(run.stderr, '[query-timing]');
    expect(timing).toHaveLength(1);
    expect(timing[0]).toMatch(
      /^\[agent-runner:info\] \[query-timing\] mode=fresh source=input init_ms=\d+ first_event_ms=\d+ first_output_ms=\d+ first_output=text queryRunId=query-run-1$/,
    );
    const [, init, event, output] = timing[0]!
      .match(/init_ms=(\d+) first_event_ms=(\d+) first_output_ms=(\d+)/)!
      .map(Number);
    expect(init).toBeLessThanOrEqual(event!);
    expect(event).toBeLessThanOrEqual(output!);
  }, 60_000);

  test('a reply that stopped after thinking is asked for once and the continuation becomes the final reply', async () => {
    const run = await runRunner({
      name: 'silent-stop-recovered',
      // Claude Code answers the first thinking-only response with its own
      // retry (call 2); the runner's continuation is call 3.
      reply: (call) =>
        call <= 2
          ? [{ type: 'thinking', thinking: `Still thinking ${call}.` }]
          : [
              { type: 'thinking', thinking: 'Now I answer.' },
              { type: 'text', text: 'SILENT_STOP_RECOVERED' },
            ],
      settled: isFinalResult,
    });

    expect(run.exitCode).toBe(0);
    expect(run.mainRequests).toHaveLength(3);
    // The empty Result is never published: one final, the continuation's.
    const finals = run.frames.filter(
      (frame) => frame.status === 'success' && frame.sourceKind === 'sdk_final',
    );
    expect(finals.map((frame) => frame.result)).toEqual([
      'SILENT_STOP_RECOVERED',
    ]);
    expect(finals[0]).toMatchObject({
      inputTurnCompleted: true,
      finalizationReason: 'completed',
      inputTurnId: 'delivery-1',
    });
    // The Host input is acknowledged exactly once, by that final.
    expect(
      run.frames.flatMap((frame) =>
        (frame.ipcReceipts ?? []).map(
          (receipt: { deliveryId: string }) => receipt.deliveryId,
        ),
      ),
    ).toEqual(['delivery-1']);
    // The prompt reached the model as the continuation's user turn, but no
    // frame shows it to the Host as a message.
    expect(carriesSilentStopPrompt(run.mainRequests[2]!.messages)).toBe(true);
    expect(carriesSilentStopPrompt(run.frames)).toBe(false);
    // Every model call is billed once, to this input, including the empty one.
    const callUsage = run.frames.filter(
      (frame) =>
        frame.streamEvent?.eventType === 'usage' &&
        String(frame.streamEvent.usage.eventId).startsWith(
          'claude-code:msg_main_',
        ),
    );
    expect(
      callUsage.map((frame) => frame.streamEvent.usage.eventId).sort(),
    ).toEqual([
      'claude-code:msg_main_1',
      'claude-code:msg_main_2',
      'claude-code:msg_main_3',
    ]);
    expect(callUsage.every((frame) => frame.inputTurnId === 'delivery-1')).toBe(
      true,
    );
    const silentStops = runnerLines(run.stderr, '[silent-stop]');
    expect(silentStops).toHaveLength(1);
    expect(silentStops[0]).toMatch(
      /^\[agent-runner:warn\] \[silent-stop\] result #1 ended after thinking without a reply; asking for the reply \(1\/1\) turnId=\S+ inputTurnId=delivery-1 queryRunId=query-run-1$/,
    );
    expect(runnerLines(run.stderr, '[reply-shape]')).toHaveLength(1);
  }, 60_000);

  test('narration before a tool call never becomes the reply when the turn then only thinks', async () => {
    const run = await runRunner({
      name: 'silent-stop-after-tool',
      // Claude Code delivers call 1 as a text frame and a tool_use frame
      // sharing one message id; calls 2-3 only think (3 is the CLI's own
      // retry), and the runner's continuation is call 4.
      reply: (call) =>
        call === 1
          ? [
              { type: 'text', text: 'NARRATION_BEFORE_TOOL' },
              {
                type: 'tool_use',
                id: 'toolu_check',
                name: 'Bash',
                input: { command: 'echo checked', description: 'check' },
              },
            ]
          : call <= 3
            ? [{ type: 'thinking', thinking: `Thinking ${call}.` }]
            : [{ type: 'text', text: 'ANSWER_AFTER_TOOL' }],
      settled: isFinalResult,
    });

    expect(run.exitCode).toBe(0);
    expect(run.mainRequests).toHaveLength(4);
    const finals = run.frames.filter(
      (frame) => frame.status === 'success' && frame.sourceKind === 'sdk_final',
    );
    expect(finals.map((frame) => frame.result)).toEqual(['ANSWER_AFTER_TOOL']);
    expect(runnerLines(run.stderr, '[silent-stop]')).toHaveLength(1);
    expect(runnerLines(run.stderr, '[reply-shape]')).toEqual([
      expect.stringContaining(
        'reason=thinking_only assistant_responses=3 tool_uses=1 last_blocks=thinking',
      ),
    ]);
  }, 60_000);

  test('a thinking-only turn the model did not end itself is not asked for a reply', async () => {
    // Claude Code 2.1.296 resumes a max_tokens response by itself and ends
    // with an assistant max_output_tokens error, and a refusal arrives as an
    // error frame; both take the provider-failure path. A stop sequence is
    // the reason that reaches a healthy Result here.
    const run = await runRunner({
      name: 'silent-stop-stop-sequence',
      reply: (call) => [{ type: 'thinking', thinking: `Thinking ${call}.` }],
      stopReason: () => 'stop_sequence',
      settled: isFinalResult,
    });

    expect(run.exitCode).toBe(0);
    // No continuation prompt; the empty reply is published as before.
    expect(carriesSilentStopPrompt(run.mainRequests)).toBe(false);
    const finals = run.frames.filter(
      (frame) => frame.status === 'success' && frame.sourceKind === 'sdk_final',
    );
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ result: null, inputTurnCompleted: true });
    expect(runnerLines(run.stderr, '[silent-stop]')).toEqual([
      expect.stringContaining(
        'ended after thinking with stop_reason=stop_sequence; skipped, publishing the empty reply',
      ),
    ]);
    expect(runnerLines(run.stderr, '[reply-shape]')).toEqual([
      expect.stringContaining('reason=thinking_only'),
    ]);
  }, 60_000);

  test('a reply that keeps stopping after thinking is asked for only once, then published empty as before', async () => {
    const run = await runRunner({
      name: 'silent-stop-exhausted',
      reply: (call) => [
        { type: 'thinking', thinking: `PRIVATE_THOUGHT ${call}.` },
      ],
      settled: isFinalResult,
    });

    expect(run.exitCode).toBe(0);
    // Two turns of two calls each (Claude Code's retry inside each turn).
    expect(run.mainRequests).toHaveLength(4);
    const finals = run.frames.filter(
      (frame) => frame.status === 'success' && frame.sourceKind === 'sdk_final',
    );
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      result: null,
      inputTurnCompleted: true,
      inputTurnId: 'delivery-1',
    });
    expect(
      finals[0]!.ipcReceipts.map(
        (receipt: { deliveryId: string }) => receipt.deliveryId,
      ),
    ).toEqual(['delivery-1']);
    const silentStops = runnerLines(run.stderr, '[silent-stop]');
    expect(silentStops).toHaveLength(2);
    expect(silentStops[0]).toContain('asking for the reply (1/1)');
    expect(silentStops[1]).toContain(
      'continuations used up (1/1), publishing the empty reply',
    );
    // One shape line per empty Result, with block types and counts only.
    const shapes = runnerLines(run.stderr, '[reply-shape]');
    expect(shapes).toHaveLength(2);
    for (const line of shapes) {
      expect(line).toMatch(
        /^\[agent-runner:warn\] \[reply-shape\] empty final reply reason=thinking_only assistant_responses=2 tool_uses=0 last_blocks=thinking stop_reason=end_turn .*inputTurnId=delivery-1 queryRunId=query-run-1$/,
      );
      expect(line).not.toContain('PRIVATE_THOUGHT');
      expect(line).not.toContain('Please answer');
    }
  }, 60_000);

  test('a repeated tool call is logged once per input as a suspected loop without stopping the turn', async () => {
    const bash = (call: number): ReplyBlock[] => [
      {
        type: 'tool_use',
        id: `toolu_loop_${call}`,
        name: 'Bash',
        input: { command: 'echo LOOP_SECRET_ARG', description: 'same check' },
      },
    ];
    const run = await runRunner({
      name: 'tool-loop',
      // Input 1 repeats one call 12 times (enough for repeat and pingpong),
      // input 2, taken into the same query, repeats it 4 times.
      reply: (call) =>
        call <= 12
          ? bash(call)
          : call === 13
            ? [{ type: 'text', text: 'LOOP_DONE_1' }]
            : call <= 17
              ? bash(call)
              : [{ type: 'text', text: 'LOOP_DONE_2' }],
      settled: isFinalResult,
      followUps: ['Check it again.'],
    });

    expect(run.exitCode).toBe(0);
    // Logging only: each turn runs on and its reply is delivered.
    expect(run.mainRequests).toHaveLength(18);
    expect(run.frames.filter(isFinalResult).map((f) => f.result)).toEqual([
      'LOOP_DONE_1',
      'LOOP_DONE_2',
    ]);
    expect(runnerLines(run.stderr, '[query-timing]')).toHaveLength(1);
    // One line per input and scope: the first rule tripped, nothing after it.
    const loops = runnerLines(run.stderr, '[tool-loop]');
    expect(loops).toHaveLength(2);
    loops.forEach((line, index) => {
      expect(line).toMatch(
        new RegExp(
          `^\\[agent-runner:warn\\] \\[tool-loop\\] suspected rule=repeat tool=Bash count=4 distinct=1 scope=main turnId=\\S+ inputTurnId=delivery-${index + 1} queryRunId=query-run-1$`,
        ),
      );
      expect(line).not.toContain('LOOP_SECRET_ARG');
    });
    // Nothing about it reaches the Host.
    expect(JSON.stringify(run.frames)).not.toContain('suspected rule=');
  }, 60_000);

  test("a model declared not to reason runs without thinking, and the connection's tool search outranks the workspace's settings", async () => {
    const deferred = (request: MainRequest): boolean =>
      (request.tools ?? []).some((tool) => tool.defer_loading === true);
    const run = await runRunner({
      name: 'thinking-off-tool-search',
      reply: () => [{ type: 'text', text: 'PLAIN_ANSWER' }],
      settled: isFinalResult,
      input: { launchEffort: null, thinking: 'disabled', toolSearch: true },
      projectSettings: { env: { ENABLE_TOOL_SEARCH: 'false' } },
    });
    expect(run.exitCode).toBe(0);
    expect(run.frames.filter(isFinalResult).map((f) => f.result)).toEqual([
      'PLAIN_ANSWER',
    ]);
    expect(run.mainRequests.length).toBeGreaterThan(0);
    for (const request of run.mainRequests) {
      // Claude Code 2.1.296 sends {type:'disabled'} for a Claude model name
      // and no thinking field for any other.
      expect(request.thinking ?? { type: 'disabled' }).toEqual({
        type: 'disabled',
      });
      expect(deferred(request)).toBe(true);
    }
    expect(runnerLines(run.stderr, 'Run thinking: off')).toHaveLength(1);

    // Control: without the launch's choices the model thinks, and the
    // workspace's own tool search stands because nothing was pinned.
    const control = await runRunner({
      name: 'thinking-default-tool-search',
      reply: () => [{ type: 'text', text: 'PLAIN_ANSWER' }],
      settled: isFinalResult,
      projectSettings: { env: { ENABLE_TOOL_SEARCH: 'true' } },
    });
    expect(control.exitCode).toBe(0);
    expect(control.mainRequests.length).toBeGreaterThan(0);
    for (const request of control.mainRequests) {
      expect(request.thinking?.type).toBeDefined();
      expect(request.thinking?.type).not.toBe('disabled');
      expect(deferred(request)).toBe(true);
    }
    expect(runnerLines(control.stderr, 'Run thinking: off')).toEqual([]);
  }, 120_000);

  test("the host's reply limit outranks a workspace's settings; without one the settings stand", async () => {
    const run = await runRunner({
      name: 'reply-limit-pinned',
      reply: () => [{ type: 'text', text: 'PLAIN_ANSWER' }],
      settled: isFinalResult,
      // Both values stay under the 64K Claude Code allows this model, so
      // each is sent as set.
      input: { maxOutputTokens: 20_000 },
      projectSettings: { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '50000' } },
    });
    expect(run.exitCode).toBe(0);
    expect(run.mainRequests.length).toBeGreaterThan(0);
    for (const request of run.mainRequests) {
      expect(request.max_tokens).toBe(20_000);
    }
    const control = await runRunner({
      name: 'reply-limit-settings',
      reply: () => [{ type: 'text', text: 'PLAIN_ANSWER' }],
      settled: isFinalResult,
      projectSettings: { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '50000' } },
    });
    expect(control.exitCode).toBe(0);
    expect(control.mainRequests.length).toBeGreaterThan(0);
    for (const request of control.mainRequests) {
      expect(request.max_tokens).toBe(50_000);
    }
  }, 120_000);

  test("an upstream rejection reaches the Host in the upstream's own words", async () => {
    const run = await runRunner({
      name: 'provider-error-text',
      reply: () => [{ type: 'text', text: 'NEVER_SENT' }],
      reject: () => ({
        status: 429,
        body: {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'usage limit reached: resets at 18:00',
          },
        },
      }),
      settled: (frame) => frame.providerFailure === true,
    });
    const failures = run.frames.filter((frame) => frame.providerFailure);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      providerFailureClass: 'account',
      providerErrorText:
        'API Error: Request rejected (429) · usage limit reached: resets at 18:00',
    });
  }, 60_000);

  test('a limit notice in the result text is passed on as the upstream words', async () => {
    const notice = 'Claude usage limit reached. Your limit will reset at 6pm.';
    const run = await runRunner({
      name: 'provider-error-text-compat',
      reply: () => [{ type: 'text', text: notice }],
      settled: (frame) => frame.providerFailure === true,
    });
    const failures = run.frames.filter((frame) => frame.providerFailure);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      providerFailureClass: 'account',
      providerErrorText: notice,
    });
  }, 60_000);

  test('context-overflow retry requeues a follow-up drained during the failed query so it is answered as its own turn', async () => {
    const receiptIds = (frame: Frame): string[] =>
      (frame.ipcReceipts ?? []).map(
        (receipt: { deliveryId: string }) => receipt.deliveryId,
      );
    const run = await runRunner({
      name: 'context-overflow-requeues-later-turn',
      handle: async ({ call, writeInput }) => {
        if (call === 1) {
          writeInput(2, 'SECOND_QUESTION_M2');
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          return [{ type: 'text', text: 'Prompt is too long' }];
        }
        if (call === 2) {
          return [{ type: 'text', text: 'PIPED_DURING_OVERFLOW_DISCARDED' }];
        }
        if (call === 3) {
          return [{ type: 'text', text: 'TURN_1_RETRIED_ANSWER' }];
        }
        return [{ type: 'text', text: 'M2_ANSWERED_SEPARATELY' }];
      },
      settled: (frame) =>
        isFinalResult(frame) &&
        (frame.result === 'M2_ANSWERED_SEPARATELY' ||
          receiptIds(frame).includes('delivery-2')),
    });

    expect(run.exitCode).toBe(0);
    expect(run.mainRequests.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(run.mainRequests[2])).not.toContain(
      'SECOND_QUESTION_M2',
    );
    expect(JSON.stringify(run.mainRequests.at(-1))).toContain(
      'SECOND_QUESTION_M2',
    );

    const finals = run.frames.filter(
      (frame) => frame.status === 'success' && frame.sourceKind === 'sdk_final',
    );
    expect(finals).toHaveLength(2);
    expect(finals[0]).toMatchObject({
      result: 'TURN_1_RETRIED_ANSWER',
      inputTurnCompleted: true,
      inputTurnId: 'delivery-1',
    });
    expect(receiptIds(finals[0]!)).toEqual(['delivery-1']);
    expect(finals[1]).toMatchObject({
      result: 'M2_ANSWERED_SEPARATELY',
      inputTurnCompleted: true,
      inputTurnId: 'delivery-2',
    });
    expect(receiptIds(finals[1]!)).toEqual(['delivery-2']);
    expect(
      runnerLines(
        run.stderr,
        'Re-enqueued 1 later IPC message(s) before context-overflow retry',
      ),
    ).toHaveLength(1);
  }, 60_000);
});
