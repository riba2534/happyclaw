import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, test } from 'vitest';

import { isMergedBackgroundCompletionPlaceholder } from '../container/agent-runner/src/background-task-drain.js';

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
});
