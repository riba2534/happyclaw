import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, test } from 'vitest';

import {
  isMergedBackgroundCompletionPlaceholder,
  isSdkBookkeepingFrame,
} from '../container/agent-runner/src/background-task-drain.js';
import {
  IpcTurnDeliveryTracker,
  sdkResultAnsweredUserMessageUuids,
  type IpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';

const runnerRoot = path.resolve('container/agent-runner');
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const runnerSdkEntry = runnerRequire.resolve('@anthropic-ai/claude-agent-sdk');
const runnerSdk = (await import(
  pathToFileURL(runnerSdkEntry).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const runnerClaudeExecutable = path.join(
  runnerRoot,
  'node_modules',
  '.bin',
  'claude',
);
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-background-completion-'),
);
const cwd = path.join(scratch, 'workspace');
const configDir = path.join(scratch, 'claude-config');
const markerDir = path.join(scratch, 'markers');
const BACKGROUND_TASKS = 3;

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

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
  blocks: ContentBlock[],
  stopReason: 'end_turn' | 'tool_use',
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
      model: 'claude-sonnet-4-5-20250929',
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
          : { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    writeEvent(response, 'content_block_delta', {
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
    writeEvent(response, 'content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  });
  writeEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  writeEvent(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

function fakeProviderEnv(baseUrl: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  for (const name of [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]) {
    delete env[name];
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'fake-local-background-token',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

async function waitForMarkers(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.readdirSync(markerDir).length >= BACKGROUND_TASKS) {
      // Let the CLI observe the exits and queue their notifications.
      await new Promise((resolve) => setTimeout(resolve, 750));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('background commands did not finish');
}

describe('Claude Code merged background-task completions', () => {
  test('only the empty num_turns=0 placeholders of a shared call are classified as placeholders', async () => {
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(markerDir, { recursive: true });

    let mainCalls = 0;
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
        let body: { tools?: unknown[] } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Answered below as an auxiliary call.
        }
        if (!Array.isArray(body.tools) || body.tools.length === 0) {
          sendMessage(
            response,
            'msg_aux',
            [{ type: 'text', text: 'aux' }],
            'end_turn',
          );
          return;
        }
        mainCalls += 1;
        const call = mainCalls;
        if (call === 1) {
          sendMessage(
            response,
            'msg_start_background',
            Array.from({ length: BACKGROUND_TASKS }, (_, index) => ({
              type: 'tool_use' as const,
              id: `toolu_background_${index}`,
              name: 'Bash',
              input: {
                // Finish only after the main reply request is in flight.
                command: `sleep 1; echo done > ${path.join(markerDir, `task-${index}`)}`,
                description: `background ${index}`,
                run_in_background: true,
              },
            })),
            'tool_use',
          );
          return;
        }
        if (call === 2) {
          // Hold the main reply until every command has exited, so all
          // notifications queue behind this turn and are answered together.
          void waitForMarkers().then(
            () =>
              sendMessage(
                response,
                'msg_started',
                [{ type: 'text', text: 'BACKGROUND_STARTED' }],
                'end_turn',
              ),
            () => response.destroy(),
          );
          return;
        }
        sendMessage(
          response,
          `msg_summary_${call}`,
          [{ type: 'text', text: `BACKGROUND_SUMMARY_${call}` }],
          'end_turn',
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

    let closeInput: () => void = () => {};
    const inputClosed = new Promise<void>((resolve) => {
      closeInput = resolve;
    });
    async function* input() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: 'start background jobs' },
        parent_tool_use_id: null,
        session_id: '',
      };
      await inputClosed;
    }

    const results: Array<Record<string, unknown>> = [];
    const guard = setTimeout(() => closeInput(), 25_000);
    try {
      const conversation = runnerSdk.query({
        prompt: input(),
        options: {
          pathToClaudeCodeExecutable: runnerClaudeExecutable,
          cwd,
          model: 'claude-sonnet-4-5-20250929',
          env: fakeProviderEnv(`http://127.0.0.1:${address.port}`),
          allowedTools: ['Bash'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: [],
        },
      });
      for await (const message of conversation) {
        if (message.type !== 'result') continue;
        results.push(message as unknown as Record<string, unknown>);
        const text = (message as { result?: unknown }).result;
        if (
          typeof text === 'string' &&
          text.startsWith('BACKGROUND_SUMMARY_')
        ) {
          closeInput();
        }
      }
    } finally {
      clearTimeout(guard);
      closeInput();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const placeholders = results.filter(
      isMergedBackgroundCompletionPlaceholder,
    );
    const replies = results.filter(
      (result) => !isMergedBackgroundCompletionPlaceholder(result),
    );
    // One shared call answers every queued completion: all but its last
    // Result are empty num_turns=0 placeholders.
    expect(placeholders).toHaveLength(BACKGROUND_TASKS - 1);
    expect(
      placeholders.every(
        (result) =>
          result.num_turns === 0 &&
          (result.origin as { kind?: string } | undefined)?.kind ===
            'task-notification',
      ),
    ).toBe(true);
    // Everything the runner still treats as a Result carries the reply text.
    expect(replies.map((result) => result.result)).toEqual([
      'BACKGROUND_STARTED',
      'BACKGROUND_SUMMARY_3',
    ]);
    expect(mainCalls).toBe(3);
  }, 40_000);

  test('a uuid-stamped user turn emits command_lifecycle after its Result', async () => {
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const url = request.url ?? '';
        if (!url.includes('/v1/messages') || url.includes('count_tokens')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ input_tokens: 1 }));
          return;
        }
        sendMessage(
          response,
          'msg_lifecycle',
          [{ type: 'text', text: 'LIFECYCLE_DONE' }],
          'end_turn',
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
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    let closeInput: () => void = () => {};
    const inputClosed = new Promise<void>((resolve) => {
      closeInput = resolve;
    });
    async function* input() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: 'hello' },
        parent_tool_use_id: null,
        session_id: '',
        uuid: '00000000-0000-4000-8000-00000000c0de' as const,
      };
      await inputClosed;
    }

    const types: string[] = [];
    const guard = setTimeout(() => closeInput(), 20_000);
    try {
      const conversation = runnerSdk.query({
        prompt: input(),
        options: {
          pathToClaudeCodeExecutable: runnerClaudeExecutable,
          cwd,
          model: 'claude-sonnet-4-5-20250929',
          env: fakeProviderEnv(`http://127.0.0.1:${address.port}`),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: [],
        },
      });
      let resultSeen = false;
      for await (const message of conversation) {
        // command_lifecycle is not in the public SDKMessage union.
        const type = (message as { type: string }).type;
        types.push(type);
        if (type === 'result') resultSeen = true;
        if (resultSeen && type === 'command_lifecycle') closeInput();
      }
    } finally {
      clearTimeout(guard);
      closeInput();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // The runner's quiet-period gate must survive this trailing frame;
    // treating it as Agent activity stranded drain-ready Results until the
    // 30 min idle close.
    expect(types.lastIndexOf('command_lifecycle')).toBeGreaterThan(
      types.indexOf('result'),
    );
    expect(isSdkBookkeepingFrame({ type: 'command_lifecycle' })).toBe(true);
    expect(isSdkBookkeepingFrame({ type: 'result' })).toBe(false);
    expect(
      isSdkBookkeepingFrame({ type: 'system', subtype: 'hook_response' }),
    ).toBe(true);
    expect(
      isSdkBookkeepingFrame({ type: 'system', subtype: 'task_notification' }),
    ).toBe(false);
    // Claude Code 2.1.283+ forwards notices that used to be dropped.
    expect(
      isSdkBookkeepingFrame({ type: 'system', subtype: 'informational' }),
    ).toBe(true);
  }, 30_000);

  test('user messages queued behind a busy turn come back as one Result that completes every merged IPC turn', async () => {
    let releaseFirstReply: () => void = () => {};
    const followUpsQueued = new Promise<void>((resolve) => {
      releaseFirstReply = resolve;
    });
    let firstRequestInFlight: () => void = () => {};
    const firstRequestStarted = new Promise<void>((resolve) => {
      firstRequestInFlight = resolve;
    });
    let mainCalls = 0;
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
        let body: { tools?: unknown[] } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Answered below as an auxiliary call.
        }
        if (!Array.isArray(body.tools) || body.tools.length === 0) {
          sendMessage(
            response,
            'msg_aux',
            [{ type: 'text', text: 'aux' }],
            'end_turn',
          );
          return;
        }
        mainCalls += 1;
        const call = mainCalls;
        if (call === 1) {
          // Hold turn A until B and C are queued inside the CLI.
          firstRequestInFlight();
          void followUpsQueued.then(() =>
            sendMessage(
              response,
              'msg_reply_a',
              [{ type: 'text', text: 'REPLY_A' }],
              'end_turn',
            ),
          );
          return;
        }
        sendMessage(
          response,
          `msg_reply_${call}`,
          [{ type: 'text', text: `REPLY_${call}` }],
          'end_turn',
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
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    // Three accepted IPC turns, each stamped with its own client uuid the way
    // the runner does before pushing it into the SDK stream.
    const turns = ['a', 'b', 'c'].map((id, index) => ({
      sdkUuid: randomUUID(),
      message: {
        text: `message ${id}`,
        receipt: {
          deliveryId: `delivery-${id}`,
          chatJid: 'web:main',
          cursor: { timestamp: `2026-10-09T00:00:0${index}.000Z`, id },
        },
      } satisfies IpcInputMessage,
    }));
    const tracker = new IpcTurnDeliveryTracker([turns[0]!.message]);
    tracker.bindSdkMessageUuid([turns[0]!.message], turns[0]!.sdkUuid);
    for (const turn of turns.slice(1)) {
      tracker.acceptTurn([turn.message]);
      tracker.bindSdkMessageUuid([turn.message], turn.sdkUuid);
    }

    let closeInput: () => void = () => {};
    const inputClosed = new Promise<void>((resolve) => {
      closeInput = resolve;
    });
    const userMessage = (turn: (typeof turns)[number]) => ({
      type: 'user' as const,
      message: { role: 'user' as const, content: turn.message.text },
      parent_tool_use_id: null,
      session_id: '',
      uuid: turn.sdkUuid,
    });
    async function* input() {
      yield userMessage(turns[0]!);
      await firstRequestStarted;
      yield userMessage(turns[1]!);
      yield userMessage(turns[2]!);
      // Let the CLI read both follow-ups into its queue before A finishes.
      setTimeout(() => releaseFirstReply(), 750);
      await inputClosed;
    }

    const results: Array<Record<string, unknown>> = [];
    const completions: string[][] = [];
    const guard = setTimeout(() => closeInput(), 25_000);
    try {
      const conversation = runnerSdk.query({
        prompt: input(),
        options: {
          pathToClaudeCodeExecutable: runnerClaudeExecutable,
          cwd,
          model: 'claude-sonnet-4-5-20250929',
          env: fakeProviderEnv(`http://127.0.0.1:${address.port}`),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: [],
        },
      });
      for await (const message of conversation) {
        if (message.type !== 'result') continue;
        const result = message as unknown as Record<string, unknown>;
        results.push(result);
        // Same sequence the runner applies to each healthy Result.
        tracker.observeAnsweredSdkUuids(
          sdkResultAnsweredUserMessageUuids(result),
        );
        completions.push(
          tracker.completeAnsweredTurns().map((receipt) => receipt.deliveryId),
        );
        if (!tracker.hasPendingTurns) closeInput();
      }
    } finally {
      clearTimeout(guard);
      closeInput();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Three user messages, two model calls, two Results: the CLI merged the
    // two follow-ups queued behind A into one turn.
    expect(mainCalls).toBe(2);
    expect(results.map((result) => result.result)).toEqual([
      'REPLY_A',
      'REPLY_2',
    ]);
    expect(results[1]!.user_message_uuids).toEqual(
      expect.arrayContaining([turns[1]!.sdkUuid, turns[2]!.sdkUuid]),
    );
    // Counting one Result per turn would leave C pending until the idle close.
    expect(completions).toEqual([['delivery-a'], ['delivery-b', 'delivery-c']]);
    expect(tracker.pendingTurnCount).toBe(0);
  }, 40_000);
});
