import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { writeCliSecretFiles } from '../container/agent-runner/src/cli-secret-files.js';
import { pinBoundProviderSettings } from '../container/agent-runner/src/provider-env-pin.js';
import {
  buildClaudeContextPlan,
  loadHostClaudeSettings,
} from '../src/claude-context-resolver.js';

/**
 * The real pinned Claude CLI against two scripted upstreams: A is the bound
 * connection, B is where a settings file tries to send the run. The admin's
 * layer goes through the host's strip, as HappyClaw writes it into the
 * session settings, and the Runner's flag settings pin what HappyClaw set.
 */
const runnerRoot = path.resolve('container/agent-runner');
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const sdk = (await import(
  pathToFileURL(runnerRequire.resolve('@anthropic-ai/claude-agent-sdk')).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const cli = path.join(runnerRoot, 'node_modules', '.bin', 'claude');
const MODEL = 'claude-sonnet-4-5-20250929';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-pin-'));

interface Hit {
  stub: string;
  auth: string | null;
  key: string | null;
  effort?: string;
}
const hits: Hit[] = [];
/** The tool names each request in `hits` offered the model. */
const requestTools: string[][] = [];
/** When set, the first request of a turn runs this Bash command. */
let bashCommand: string | undefined;

function startStub(name: string) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!req.url?.includes('/messages') || req.url.includes('count')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":1}');
        return;
      }
      const body = JSON.parse(raw || '{}') as {
        messages?: unknown[];
        output_config?: { effort?: string };
        tools?: { name?: string }[];
      };
      requestTools.push((body.tools ?? []).map((tool) => tool.name ?? ''));
      hits.push({
        stub: name,
        auth: req.headers.authorization ?? null,
        key: (req.headers['x-api-key'] as string | undefined) ?? null,
        ...(body.output_config?.effort
          ? { effort: body.output_config.effort }
          : {}),
      });
      const runBash =
        bashCommand !== undefined &&
        !JSON.stringify(body.messages ?? []).includes('tool_result');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type: string, data: object) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      send('message_start', {
        message: {
          id: 'msg_pin',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      if (runBash) {
        send('content_block_start', {
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_env',
            name: 'Bash',
            input: {},
          },
        });
        send('content_block_delta', {
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              command: bashCommand,
              description: 'dump env',
            }),
          },
        });
      } else {
        send('content_block_start', {
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        send('content_block_delta', {
          index: 0,
          delta: { type: 'text_delta', text: `ok-${name}` },
        });
      }
      send('content_block_stop', { index: 0 });
      send('message_delta', {
        delta: { stop_reason: runBash ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 1 },
      });
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise<{ server: http.Server; url: string }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    ),
  );
}

/** JSON-RPC calls the MCP stub received, with the API key header they carried. */
const mcpCalls: { method: string; key: string | null }[] = [];

/** A user's HTTP MCP server (Streamable HTTP, JSON replies) with one tool. */
function startMcpStub() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const call = JSON.parse(raw || '{}') as {
        id?: number | string;
        method?: string;
        params?: { protocolVersion?: string };
      };
      mcpCalls.push({
        method: call.method ?? '',
        key: (req.headers['x-api-key'] as string | undefined) ?? null,
      });
      if (call.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply =
        call.method === 'initialize'
          ? {
              result: {
                protocolVersion: call.params?.protocolVersion ?? '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'remote', version: '1.0.0' },
              },
            }
          : call.method === 'tools/list'
            ? {
                result: {
                  tools: [
                    {
                      name: 'lookup',
                      description: 'Looks a word up.',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                },
              }
            : { error: { code: -32601, message: 'Method not found' } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...reply }));
    });
  });
  return new Promise<{ server: http.Server; url: string }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      }),
    ),
  );
}

let A: Awaited<ReturnType<typeof startStub>>;
let B: Awaited<ReturnType<typeof startStub>>;
let mcp: Awaited<ReturnType<typeof startMcpStub>>;
beforeAll(async () => {
  A = await startStub('A');
  B = await startStub('B');
  mcp = await startMcpStub();
});
afterAll(() => {
  A.server.close();
  B.server.close();
  mcp.server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function* hello() {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content: 'hello' },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/** The admin's ~/.claude/settings.json as HappyClaw projects it. */
function adminLayer(settings: object): object {
  const external = fs.mkdtempSync(path.join(scratch, 'admin-'));
  fs.writeFileSync(
    path.join(external, 'settings.json'),
    JSON.stringify(settings),
  );
  return loadHostClaudeSettings(
    buildClaudeContextPlan({
      executionMode: 'host',
      group: {
        name: 'w',
        folder: 'w',
        added_at: '2026-10-28T00:00:00.000Z',
        created_by: 'admin',
      } as never,
      externalClaudeDir: external,
      projectRoot: path.join(scratch, 'project-root'),
      dataDir: path.join(scratch, 'data'),
      groupSessionsDir: path.join(external, 'session'),
      includeHostClaudeContext: true,
    }),
  );
}

/** One turn as the Runner runs it, with `bound` as HappyClaw's env. */
async function runTurn(options: {
  bound: Record<string, string>;
  admin?: object;
  project?: object;
  local?: object;
  credentials?: object;
  pin?: boolean;
  model?: string;
  dumpEnvTo?: string;
  /** Writes the CLI's own command line here from inside the turn. */
  dumpArgvTo?: string;
  /**
   * The user's MCP servers. With them the turn also gets an in-process
   * `happyclaw` server, as every Runner query has.
   */
  mcpServers?: Record<string, unknown>;
}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'run-'));
  const project = path.join(dir, 'workspace');
  const config = path.join(dir, 'config');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const write = (file: string, value?: object) =>
    value && fs.writeFileSync(file, JSON.stringify(value));
  write(
    path.join(config, 'settings.json'),
    options.admin && adminLayer(options.admin),
  );
  write(path.join(project, '.claude', 'settings.json'), options.project);
  write(path.join(project, '.claude', 'settings.local.json'), options.local);
  write(path.join(config, '.credentials.json'), options.credentials);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === 'string' &&
      !/^(ANTHROPIC_|CLAUDE_|AWS_|HTTPS?_PROXY)/.test(key)
    ) {
      env[key] = value;
    }
  }
  Object.assign(env, options.bound, {
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  const start = hits.length;
  bashCommand = options.dumpEnvTo
    ? `env | grep -E '^(ANTHROPIC|CLAUDE_CODE|CLAUDE_AUTOCOMPACT|AWS_BEARER|CLOUD_ML)' | sort > ${options.dumpEnvTo}`
    : options.dumpArgvTo
      ? // -ww: never cut the line at the terminal width.
        `ps -ww -o command= -p $PPID > ${options.dumpArgvTo}`
      : undefined;
  // As the Runner does: the pin and external MCP servers reach the CLI as
  // files, never argv.
  const files = writeCliSecretFiles(
    options.pin === false ? {} : pinBoundProviderSettings(env),
    options.mcpServers ?? {},
    dir,
  );
  try {
    const stream = sdk.query({
      prompt: hello(),
      options: {
        pathToClaudeCodeExecutable: cli,
        cwd: project,
        model: options.model ?? MODEL,
        env,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        thinking: { type: 'adaptive' },
        settings: files.settingsPath,
        ...(files.mcpConfigPath
          ? {
              extraArgs: { 'mcp-config': files.mcpConfigPath },
              mcpServers: {
                happyclaw: sdk.createSdkMcpServer({
                  name: 'happyclaw',
                  version: '1.0.0',
                  tools: [
                    sdk.tool('ping', 'Answers pong.', {}, async () => ({
                      content: [{ type: 'text' as const, text: 'pong' }],
                    })),
                  ],
                }),
              },
            }
          : {}),
      },
    });
    let result = '';
    let mcpServers: { name: string; status: string }[] | undefined;
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        mcpServers = message.mcp_servers;
      }
      if (message.type === 'result') {
        result = (message as { result?: string }).result ?? '';
        break;
      }
    }
    return {
      result,
      hits: hits.slice(start),
      tools: requestTools.slice(start),
      mcpServers,
    };
  } finally {
    bashCommand = undefined;
    files.dispose();
  }
}

const boundKey = (url: string) => ({
  ANTHROPIC_BASE_URL: url,
  ANTHROPIC_API_KEY: 'bound-key',
});
const atA = [{ stub: 'A', auth: null, key: 'bound-key' }];

describe('the bound connection and the session choices win', () => {
  test('pins only what HappyClaw set, and every backend switch off', () => {
    const pinned = pinBoundProviderSettings({
      ANTHROPIC_BASE_URL: 'http://bound',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'bound-sonnet',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      ANTHROPIC_AUTH_TOKEN: '',
      API_TIMEOUT_MS: '600000',
      HOME: '/home/node',
    });
    expect(pinned).toEqual({
      apiKeyHelper: '',
      env: {
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: '0',
        CLAUDE_CODE_USE_FOUNDRY: '0',
        CLAUDE_CODE_USE_GATEWAY: '0',
        CLAUDE_CODE_USE_MANTLE: '0',
        CLAUDE_CODE_USE_ANTHROPIC_AWS: '0',
        CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '0',
        ANTHROPIC_BASE_URL: 'http://bound',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'bound-sonnet',
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
      },
    });
    // A connection that runs on a backend keeps its switch.
    expect(
      pinBoundProviderSettings({ CLAUDE_CODE_USE_VERTEX: '1' }).env
        .CLAUDE_CODE_USE_VERTEX,
    ).toBe('1');
  });

  test('a project settings file cannot change the endpoint (control: it does without the pin)', async () => {
    const project = { env: { ANTHROPIC_BASE_URL: B.url } };
    const unpinned = await runTurn({
      bound: boundKey(A.url),
      project,
      pin: false,
    });
    expect(unpinned.hits.map((hit) => hit.stub)).toEqual(['B']);
    const pinned = await runTurn({ bound: boundKey(A.url), project });
    expect(pinned.hits).toEqual(atA);
    expect(pinned.result).toBe('ok-A');
  }, 60_000);

  test('a project settings file cannot switch to Bedrock', async () => {
    const pinned = await runTurn({
      bound: boundKey(A.url),
      project: {
        env: {
          CLAUDE_CODE_USE_BEDROCK: '1',
          ANTHROPIC_BEDROCK_BASE_URL: B.url,
          AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
          CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        },
      },
    });
    expect(pinned.hits).toEqual(atA);
  }, 60_000);

  test("a local settings file's apiKeyHelper adds no credential", async () => {
    const pinned = await runTurn({
      bound: boundKey(A.url),
      local: { apiKeyHelper: 'echo helper-key' },
    });
    expect(pinned.hits).toEqual(atA);
  }, 60_000);

  test("the admin's settings cannot change the endpoint, credentials or backend", async () => {
    const pinned = await runTurn({
      bound: boundKey(A.url),
      admin: {
        env: {
          ANTHROPIC_BASE_URL: B.url,
          ANTHROPIC_AUTH_TOKEN: 'admin-token',
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_BEARER_TOKEN_BEDROCK: 'admin-bedrock',
        },
        apiKeyHelper: 'echo admin-helper',
      },
    });
    expect(pinned.hits).toEqual(atA);
  }, 60_000);

  test('official OAuth credentials and a setup token still authenticate', async () => {
    const oauth = await runTurn({
      bound: { ANTHROPIC_BASE_URL: A.url },
      admin: { env: { ANTHROPIC_API_KEY: 'admin-key' } },
      credentials: {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-from-file',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3_600_000,
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
        },
      },
    });
    expect(oauth.hits).toEqual([
      { stub: 'A', auth: 'Bearer sk-ant-oat01-from-file', key: null },
    ]);
    const setupToken = await runTurn({
      bound: {
        ANTHROPIC_BASE_URL: A.url,
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-setup',
      },
    });
    expect(setupToken.hits).toEqual([
      { stub: 'A', auth: 'Bearer sk-ant-oat01-setup', key: null },
    ]);
  }, 60_000);

  test("the session's effort and compaction reach the CLI over the admin's and the project's, and tools see no empty provider env", async () => {
    const dump = path.join(scratch, 'tool-env.txt');
    const run = await runTurn({
      model: 'claude-opus-4-7',
      bound: {
        ...boundKey(A.url),
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000',
      },
      admin: {
        env: {
          CLAUDE_CODE_EFFORT_LEVEL: 'low',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000',
        },
      },
      project: { env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' } },
      dumpEnvTo: dump,
    });
    expect(run.hits.length).toBeGreaterThan(0);
    expect(run.hits.every((hit) => hit.stub === 'A')).toBe(true);
    expect(run.hits.map((hit) => hit.effort)).toContain('high');
    expect(run.hits.map((hit) => hit.effort)).not.toContain('low');
    const toolEnv = fs.readFileSync(dump, 'utf8').trim().split('\n');
    expect(toolEnv).toContain('CLAUDE_CODE_EFFORT_LEVEL=high');
    expect(toolEnv).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000');
    expect(toolEnv).toContain(`ANTHROPIC_BASE_URL=${A.url}`);
    expect(toolEnv.filter((line) => line.endsWith('='))).toEqual([]);
  }, 90_000);

  test('the CLI command line carries no connection key or MCP credential, and the MCP file still loads', async () => {
    const dump = path.join(scratch, 'argv.txt');
    const mcpStart = mcpCalls.length;
    const run = await runTurn({
      bound: {
        ANTHROPIC_BASE_URL: A.url,
        ANTHROPIC_AUTH_TOKEN: 'bound-token-in-settings',
      },
      mcpServers: {
        remote: {
          type: 'http',
          url: mcp.url,
          headers: { 'X-API-KEY': 'mcp-header-secret' },
        },
      },
      dumpArgvTo: dump,
    });
    expect(run.hits.every((hit) => hit.stub === 'A')).toBe(true);
    expect(run.hits[0]?.auth).toBe('Bearer bound-token-in-settings');
    const argv = fs.readFileSync(dump, 'utf8');
    expect(argv).toContain('--settings ');
    expect(argv).toContain('--mcp-config ');
    expect(argv).not.toContain('bound-token-in-settings');
    expect(argv).not.toContain('mcp-header-secret');
    // The user's server came from the file, with its credential, next to
    // the SDK's own: dropping either --mcp-config would lose a server.
    expect(
      mcpCalls
        .slice(mcpStart)
        .filter((call) => call.method === 'tools/list')
        .map((call) => call.key),
    ).toContain('mcp-header-secret');
    expect(run.mcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'remote', status: 'connected' }),
        expect.objectContaining({ name: 'happyclaw', status: 'connected' }),
      ]),
    );
    expect(run.tools[0]).toEqual(
      expect.arrayContaining(['mcp__remote__lookup', 'mcp__happyclaw__ping']),
    );
  }, 90_000);

  test('the Runner passes the pin as its flag settings', () => {
    const runner = fs.readFileSync(
      path.join(runnerRoot, 'src', 'index.ts'),
      'utf8',
    );
    expect(runner).toContain(
      '...pinBoundProviderSettings({\n      ...process.env,\n      ...claudeRuntimeEnv,\n    }),',
    );
    expect(runner).toContain(
      '...webFetchPreflightSettings(containerInput.webFetchPreflightPolicy)',
    );
    // Inside the query's try: a failed write still reaches the finally that
    // closes the IPC watcher.
    expect(runner).toContain(
      '  try {\n    cliSecretFiles = writeCliSecretFiles(flagSettings, externalMcpServers);',
    );
    expect(runner).toContain('    cliSecretFiles?.dispose();\n  }\n}');
    // What a SIGKILLed Runner left is removed when the next one starts.
    expect(runner).toContain(
      'async function main(): Promise<void> {\n  // SIGKILL gives a Runner no chance to remove its CLI secret files.\n  const sweptCliSecretDirs = sweepOrphanCliSecretDirs();',
    );
    expect(runner).toContain('      settings: cliSecretFiles.settingsPath,');
    expect(runner).toContain(
      '      mcpServers: { happyclaw: mcpServerConfig },',
    );
  });
});
