import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { buildHappyClawSystemPrompt } from '../container/agent-runner/src/sdk-compat.js';

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
  path.join(os.tmpdir(), 'happyclaw-sdk-system-prompt-'),
);
const cwd = path.join(scratch, 'workspace');
const configDir = path.join(scratch, 'claude-config');

const FIRST_PROMPT_MARKER = 'HAPPYCLAW_QA_FIRST_RUNNER_PROMPT';
const RESUMED_PROMPT_MARKER = 'HAPPYCLAW_QA_RESUMED_RUNNER_PROMPT';
const FIRST_TURN = 'HAPPYCLAW_QA_FIRST_TURN';
const RESUMED_TURN = 'HAPPYCLAW_QA_RESUMED_TURN';

type CapturedRequest = {
  url: string;
  system?: unknown;
  messages?: unknown;
};

const requests: CapturedRequest[] = [];
let server: http.Server;
let baseUrl = '';

function systemText(request: CapturedRequest): string {
  if (typeof request.system === 'string') return request.system;
  if (!Array.isArray(request.system)) return '';
  return request.system
    .map((block) =>
      block && typeof block === 'object' && 'text' in block
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n');
}

function writeEvent(
  response: http.ServerResponse,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendText(response: http.ServerResponse, text: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  writeEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_system_prompt_${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 1 },
    },
  });
  writeEvent(response, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  writeEvent(response, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
  writeEvent(response, 'content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  });
  writeEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  writeEvent(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

function fakeProviderEnv(): Record<string, string> {
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
    ANTHROPIC_AUTH_TOKEN: 'fake-local-system-prompt-token',
    ANTHROPIC_API_KEY: '',
    // Session transcripts must land in a disposable config dir, not ~/.claude.
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

async function runTurn(
  prompt: string,
  promptText: string,
  includeClaudePreset: boolean,
  resume?: string,
): Promise<string> {
  const conversation = runnerSdk.query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: runnerClaudeExecutable,
      cwd,
      model: 'claude-sonnet-4-5-20250929',
      env: fakeProviderEnv(),
      ...(resume ? { resume } : {}),
      systemPrompt: buildHappyClawSystemPrompt(promptText, includeClaudePreset),
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
    },
  });
  let sessionId = '';
  for await (const message of conversation) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
    }
  }
  return sessionId;
}

function turnRequests(turnMarker: string): CapturedRequest[] {
  return requests.filter(
    (request) =>
      request.url.includes('/v1/messages') &&
      !request.url.includes('count_tokens') &&
      JSON.stringify(request.messages ?? []).includes(turnMarker),
  );
}

beforeAll(async () => {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const url = request.url ?? '';
      let body: Omit<CapturedRequest, 'url'> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Non-JSON housekeeping requests are answered below and ignored.
      }
      requests.push({ url, ...body });
      if (!url.includes('/v1/messages') || url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      sendText(response, 'OK');
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
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('HappyClaw system prompt on resumed SDK sessions', () => {
  test.each([
    { form: 'Claude Code preset + append', includeClaudePreset: true },
    { form: 'custom prompt', includeClaudePreset: false },
  ])(
    'a resumed session receives the prompt rebuilt by the new runner ($form)',
    async ({ includeClaudePreset }) => {
      requests.length = 0;
      const firstTurn = `${FIRST_TURN}_${includeClaudePreset}`;
      const resumedTurn = `${RESUMED_TURN}_${includeClaudePreset}`;

      const sessionId = await runTurn(
        firstTurn,
        `<agent-profile>${FIRST_PROMPT_MARKER}</agent-profile>`,
        includeClaudePreset,
      );
      expect(sessionId).not.toBe('');
      expect(
        turnRequests(firstTurn).some((request) =>
          systemText(request).includes(FIRST_PROMPT_MARKER),
        ),
      ).toBe(true);

      // A later runner resumes the same Claude session after the AgentProfile
      // or prompts/*.md changed and rebuilt its PromptPlan.
      await runTurn(
        resumedTurn,
        `<agent-profile>${RESUMED_PROMPT_MARKER}</agent-profile>`,
        includeClaudePreset,
        sessionId,
      );
      const resumed = turnRequests(resumedTurn);
      expect(resumed.length).toBeGreaterThan(0);
      expect(
        resumed.some((request) =>
          systemText(request).includes(RESUMED_PROMPT_MARKER),
        ),
      ).toBe(true);
      expect(
        resumed.some((request) =>
          systemText(request).includes(FIRST_PROMPT_MARKER),
        ),
      ).toBe(false);
    },
    60_000,
  );
});
