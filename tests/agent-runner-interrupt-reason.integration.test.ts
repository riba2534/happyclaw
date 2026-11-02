import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

import { OutputFrameScanner } from '../src/output-frame-scanner.js';

/**
 * The real Agent Runner (tsx, bundled Claude Code CLI, real SDK) against a
 * local fake Anthropic endpoint: the main Agent starts a background sub-agent,
 * whose model call the endpoint holds open, and a long background shell (a
 * dev server). The Host's GroupQueue then interrupts the query through the
 * IPC sentinels.
 *
 * It pins the Claude Code behaviour the runner relies on: interrupt() alone
 * ends the sub-agent, so no interrupt calls stopTask, and the superseded
 * query ends at once instead of waiting for the shell.
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
const SUBAGENT_MARKER = 'HAPPYCLAW_INTERRUPT_SUBAGENT_MARKER';
const QUERY_RUN_ID = 'query-run-1';
/** Far longer than the run may take: the query must not wait for it. */
const SHELL_SECONDS = 40;
const scratchRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-interrupt-reason-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: scratchRoot,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: vi.fn() }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({ maxConcurrentContainers: 20 }),
}));
vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');

afterAll(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };
type Frame = Record<string, any>;

function writeEvent(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendMessage(res: http.ServerResponse, id: string, blocks: Block[]) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  writeEvent(res, 'message_start', {
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
    writeEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block:
        block.type === 'text'
          ? { type: 'text', text: '' }
          : { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    writeEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta:
        block.type === 'text'
          ? { type: 'text_delta', text: block.text }
          : {
              type: 'input_json_delta',
              partial_json: JSON.stringify(block.input),
            },
    });
    writeEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  });
  writeEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: blocks.some((block) => block.type === 'tool_use')
        ? 'tool_use'
        : 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: 8 },
  });
  writeEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

const PROXY_VARIABLES = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]);

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
        ].includes(entry[0]) &&
        // A CI or developer proxy must not carry the local endpoint away.
        !PROXY_VARIABLES.has(entry[0].toUpperCase()),
    ),
  );
  return {
    ...env,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HAPPYCLAW_WORKSPACE_GROUP: dirs.group,
    HAPPYCLAW_WORKSPACE_IPC: dirs.ipc,
    HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE: '1',
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'fake-local-runner-token',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: MODEL,
    CLAUDE_CONFIG_DIR: dirs.config,
    HOME: dirs.home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/** Answer Workspace Memory snapshot requests at once, as a Host without a store. */
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

const firstUserText = (body: { messages?: unknown[] }): string =>
  JSON.stringify(body.messages?.[0] ?? '');

const taskEvents = (frames: Frame[], eventType: string) =>
  frames
    .map((frame) => frame.streamEvent)
    .filter((event) => event?.eventType === eventType);

async function interruptedRun(name: string, reason: 'stop' | 'steer') {
  const scratch = path.join(scratchRoot, name);
  const dirs = {
    group: path.join(scratch, 'group'),
    // Where the Host's GroupQueue writes this session runner's sentinels.
    ipc: path.join(scratchRoot, 'ipc', name, 'agents', 'session'),
    config: path.join(scratch, 'claude-config'),
    home: path.join(scratch, 'home'),
  };
  const inputDir = path.join(dirs.ipc, 'input');
  const tasksDir = path.join(dirs.ipc, 'tasks');
  for (const dir of [dirs.group, inputDir, tasksDir, dirs.config, dirs.home]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(inputDir, '0001-input.json'),
    JSON.stringify({
      type: 'message',
      text: 'Start the audit and the dev server.',
      queryRunId: QUERY_RUN_ID,
      receipt: {
        deliveryId: 'delivery-1',
        chatJid: 'web:interrupt-reason',
        cursor: { timestamp: '2026-10-29T00:00:01.000Z', id: 'message-1' },
      },
    }),
  );

  let mainCalls = 0;
  let heldSubAgent: http.ServerResponse | undefined;
  let interruptedAt = 0;
  let interruptWritten = false;
  const queue = new GroupQueue();
  const laneJid = `web:${name}#agent:session`;
  const lane = (queue as any).getGroup(laneJid);
  Object.assign(lane, {
    active: true,
    groupFolder: name,
    agentId: 'session',
    queryInFlight: true,
    queryId: QUERY_RUN_ID,
  });
  const writeInterrupt = () => {
    if (interruptWritten) return;
    interruptWritten = true;
    interruptedAt = Date.now();
    // As /break (stop) and /steer or 「发送」 (no reason) call it.
    const written =
      reason === 'stop'
        ? queue.interruptQuery(laneJid, QUERY_RUN_ID, 'stop')
        : queue.interruptQuery(laneJid, QUERY_RUN_ID);
    if (!written) throw new Error('GroupQueue did not write the interrupt');
  };
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
      let body: { tools?: unknown[]; messages?: unknown[] } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Answered below as an auxiliary call.
      }
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        sendMessage(response, 'msg_aux', [{ type: 'text', text: 'aux' }]);
        return;
      }
      if (firstUserText(body).includes(SUBAGENT_MARKER)) {
        // The sub-agent stays busy until it is interrupted.
        heldSubAgent = response;
        response.on('close', () => {
          if (heldSubAgent === response) heldSubAgent = undefined;
        });
        return;
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        sendMessage(response, 'msg_main_1', [
          {
            type: 'tool_use',
            id: 'toolu_audit',
            name: 'Agent',
            input: {
              description: 'Audit the repo',
              prompt: `${SUBAGENT_MARKER}: audit the repository.`,
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_dev_server',
            name: 'Bash',
            input: {
              command: `sleep ${SHELL_SECONDS}`,
              description: 'dev server',
              run_in_background: true,
            },
          },
        ]);
        return;
      }
      sendMessage(response, `msg_main_${mainCalls}`, [
        { type: 'text', text: `MAIN_REPLY_${mainCalls}` },
      ]);
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
  const started = new Set<string>();
  const poll = setInterval(() => {
    // Interrupt once both background tasks run and the sub-agent is busy.
    if (!interruptWritten && heldSubAgent && started.size >= 2) {
      writeInterrupt();
    }
  }, 50);
  child.stdout.on('data', (chunk) => {
    for (const event of scanner.push(chunk.toString())) {
      if (event.kind !== 'frame') throw new Error(`runner frame ${event.kind}`);
      const frame = JSON.parse(event.json) as Frame;
      frames.push(frame);
      const streamEvent = frame.streamEvent;
      if (streamEvent?.eventType === 'task_start') {
        started.add(streamEvent.toolUseId);
      }
      if (
        streamEvent?.eventType === 'task_notification' &&
        streamEvent.toolUseId === 'toolu_audit'
      ) {
        // Read only once the superseded query has ended.
        requestClose();
      }
    }
  });
  const guard = setTimeout(() => requestClose(), 45_000);
  const killGuard = setTimeout(() => child.kill('SIGKILL'), 55_000);
  child.stdin.end(
    JSON.stringify({
      prompt: 'Cold start.',
      groupFolder: 'interrupt-reason',
      chatJid: 'web:interrupt-reason',
      turnId: 'cold-turn-1',
      queryRunId: QUERY_RUN_ID,
      isHome: false,
      isAdminHome: false,
    }),
  );
  const exitCode = await new Promise<number | null>((resolve) =>
    child.once('close', (code) => resolve(code)),
  );
  clearTimeout(guard);
  clearTimeout(killGuard);
  clearInterval(memoryResponder);
  clearInterval(poll);
  heldSubAgent?.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return {
    frames,
    stderr,
    exitCode,
    secondsAfterInterrupt: (Date.now() - interruptedAt) / 1000,
  };
}

const subAgentEnd = (frames: Frame[]) =>
  taskEvents(frames, 'task_notification')
    .filter((event) => event.toolUseId === 'toolu_audit')
    .map((event) => event.taskStatus);

describe('Agent Runner interrupt reason against the real SDK', () => {
  test('an explicit stop: the interrupt ends the sub-agent within the deadline and the query does not wait for the shell', async () => {
    const run = await interruptedRun('stop', 'stop');

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('Interrupt sentinel detected (stop)');
    // Two background tasks ran; only the sub-agent is given the deadline.
    expect(run.stderr).toContain(
      'Interrupt sentinel: 1 sub-agent(s) must end within 3s',
    );
    expect(subAgentEnd(run.frames)).toEqual(['stopped']);
    expect(run.stderr).not.toContain('after the stop');
    expect(run.secondsAfterInterrupt).toBeLessThan(SHELL_SECONDS / 2);
  }, 60_000);

  test('a steer (or an interrupt without a reason) only interrupts, as before', async () => {
    const run = await interruptedRun('steer', 'steer');

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain('Interrupt sentinel detected (steer)');
    expect(run.stderr).not.toContain('must end within');
    // Claude Code's interrupt ends the sub-agent on its own.
    expect(subAgentEnd(run.frames)).toEqual(['stopped']);
    expect(run.secondsAfterInterrupt).toBeLessThan(SHELL_SECONDS / 2);
  }, 60_000);
});
