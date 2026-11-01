#!/usr/bin/env node
// npm run build && node tests/e2e/codex-gateway-sdk.mjs
// Real installed Agent SDK/CLI -> real Hono HTTP gateway -> local Responses SSE.
// No accounts are needed. All config, credentials and Bash output are temporary.
// A second scenario covers a conversation that picked another model and an
// effort in the composer: the model arrives as the runner's ANTHROPIC_MODEL and
// the effort (`ultra`, which the SDK cannot express) through the runner's
// gateway grant, which can also be changed while the runner is warm.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalLogLevel = process.env.LOG_LEVEL;
const scratch = await mkdtemp(path.join(os.tmpdir(), 'hc-codex-sdk-e2e-'));
const workspace = path.join(scratch, 'workspace');
const claudeConfig = path.join(scratch, 'claude-config');
// The provider's stored identifier; runners authenticate with a minted token.
const gatewayIdentifier = 'e2e-gateway-identifier-not-a-real-secret';
let gatewayKey = '';
let overrideKey = '';
let observedCliEffort;
let scenario = 'tools';
const upstreamKey = 'e2e-upstream-not-a-real-secret';
const accountId = 'e2e-account';
const model = 'gpt-6-sol';
const callId = 'call_gateway_e2e';
const parallelCallId = 'call_gateway_parallel';
const longToolName = 'verify_' + 'protocol_'.repeat(9);
const fullMcpName = 'mcp__compat__' + longToolName;
const encryptedReasoning = Buffer.concat([
  Buffer.from([0x80]),
  Buffer.alloc(8),
  Buffer.alloc(16, 3),
  Buffer.alloc(32, 4),
  Buffer.alloc(32, 5),
]).toString('base64url');
let mcpExecutions = 0;
const toolMarker = 'CODEX_GATEWAY_TOOL_EXECUTED';
const finalText = 'CODEX_GATEWAY_SDK_OK ✓';
const command = `printf '${toolMarker}\\n' > codex-gateway-probe.txt && cat codex-gateway-probe.txt`;
const servers = [];
const requests = [];
const upstreamRequests = [];
const gatewayStreams = [];
const overrideRequests = [];
const overrideUpstream = [];
const overrideStreams = [];
const sdkMessages = [];
const checks = {};
let blockedFetches = 0;
let modelsCatalogFetches = 0;
let blockedProxyRequests = 0;
let unexpectedHttpRequests = 0;
let sdkStderrBytes = 0;
let sdkFreshInputTokens = 0;
let sdkCachedInputTokens = 0;
let sdkOutputTokens = 0;
let phase = 'setup';
let querySession;
let abortController;
let timer;
let sdkVersion;
let cliVersion;

function check(name, condition) {
  checks[name] = Boolean(condition);
  assert.ok(condition, name);
}

async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/** Function tools of a Responses body: top-level, or the Lite prefix. */
function upstreamTools(body) {
  if (Array.isArray(body.tools)) return body.tools;
  const prefix = body.input?.find((item) => item.type === 'additional_tools');
  return (prefix?.tools ?? []).flatMap((tool) =>
    tool.type === 'namespace' ? (tool.tools ?? []) : [tool],
  );
}

async function jsonBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    assert.ok(bytes < 2 * 1024 * 1024, 'fixture body limit');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  // The gateway compresses bodies with zstd like the official client.
  const decoded =
    request.headers['content-encoding'] === 'zstd'
      ? zlib.zstdDecompressSync(raw)
      : raw;
  return JSON.parse(decoded.toString('utf8'));
}

function fixtureEvents(turn, shortenedMcp) {
  const id = `resp_gateway_e2e_${turn}`;
  const usage =
    turn === 1
      ? {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 10,
        }
      : {
          input_tokens: 150,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens: 12,
        };
  const output =
    turn === 1
      ? {
          id: 'fc_gateway_e2e',
          type: 'function_call',
          call_id: callId,
          name: 'Bash',
          arguments: JSON.stringify({
            command,
            description: 'Write the temporary gateway probe file',
          }),
        }
      : {
          id: 'msg_gateway_e2e',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: finalText, annotations: [] }],
        };
  const reasoning = {
    type: 'reasoning',
    id: 'rs_gateway_e2e',
    summary: [{ type: 'summary_text', text: 'Use Bash and MCP.' }],
    encrypted_content: encryptedReasoning,
  };
  const parallel = {
    type: 'function_call',
    id: 'fc_parallel',
    call_id: parallelCallId,
    name: shortenedMcp,
    arguments: JSON.stringify({ marker: 'MCP_PROTOCOL_OK' }),
  };
  const nativeSearch = {
    type: 'web_search_call',
    id: 'ws_gateway_e2e',
    status: 'completed',
    action: {
      type: 'search',
      query: 'controlled compatibility case',
      sources: [
        { url: 'https://example.invalid/protocol', title: 'Protocol fixture' },
      ],
    },
  };
  return [
    {
      type: 'response.created',
      response: { id, model, status: 'in_progress' },
    },
    ...(turn === 1
      ? [
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...reasoning, summary: [] },
          },
          {
            type: 'response.reasoning_summary_part.added',
            item_id: reasoning.id,
            summary_index: 0,
          },
          {
            type: 'response.reasoning_summary_text.delta',
            item_id: reasoning.id,
            summary_index: 0,
            delta: 'Use Bash and MCP.',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: reasoning,
          },
        ]
      : []),
    {
      type: 'response.output_item.added',
      output_index: turn === 1 ? 1 : 0,
      item:
        turn === 1 ? { ...output, arguments: '' } : { ...output, content: [] },
    },
    ...(turn === 2
      ? [
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: nativeSearch,
          },
        ]
      : []),
    ...(turn === 1
      ? [
          {
            type: 'response.output_item.added',
            output_index: 2,
            item: { ...parallel, arguments: '' },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: output.id,
            output_index: 1,
            delta: output.arguments.slice(0, 20),
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: parallel.id,
            output_index: 2,
            delta: parallel.arguments,
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: parallel.id,
            output_index: 2,
            arguments: parallel.arguments,
          },
          {
            type: 'response.output_item.done',
            output_index: 2,
            item: parallel,
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: output.id,
            output_index: 1,
            delta: output.arguments.slice(20),
          },
        ]
      : [
          {
            type: 'response.output_text.delta',
            item_id: output.id,
            output_index: 0,
            content_index: 0,
            delta: finalText,
          },
        ]),
    {
      type: 'response.output_item.done',
      output_index: turn === 1 ? 1 : 0,
      item: output,
    },
    {
      type: 'response.completed',
      response: {
        id,
        model,
        status: 'completed',
        output:
          turn === 1 ? [reasoning, output, parallel] : [output, nativeSearch],
        usage,
      },
    },
  ];
}

const overrideText = 'CODEX_GATEWAY_CONVERSATION_OVERRIDE_OK';

/** One plain text turn, served by whatever model the request named. */
function overrideEvents(servedModel) {
  const id = 'resp_gateway_override';
  const output = {
    id: 'msg_gateway_override',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: overrideText, annotations: [] }],
  };
  return [
    {
      type: 'response.created',
      response: { id, model: servedModel, status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...output, content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: output.id,
      output_index: 0,
      content_index: 0,
      delta: overrideText,
    },
    { type: 'response.output_item.done', output_index: 0, item: output },
    {
      type: 'response.completed',
      response: {
        id,
        model: servedModel,
        status: 'completed',
        output: [output],
        usage: {
          input_tokens: 30,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
        },
      },
    },
  ];
}

function parseAnthropicStream(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(claudeConfig, { recursive: true });
  const sdkPath = path.join(
    repository,
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  );
  const cliPackagePath = path.join(
    repository,
    'container/agent-runner/node_modules/@anthropic-ai/claude-code/package.json',
  );
  const sdkPackage = JSON.parse(
    await readFile(path.join(path.dirname(sdkPath), 'package.json'), 'utf8'),
  );
  const cliPackage = JSON.parse(await readFile(cliPackagePath, 'utf8'));
  sdkVersion = sdkPackage.version;
  cliVersion = cliPackage.version;
  const cli = path.resolve(path.dirname(cliPackagePath), cliPackage.bin.claude);
  // Crucial: config.ts captures PROJECT_ROOT at import time. No project runtime
  // config can be read before switching into the newly created empty scratch.
  process.chdir(scratch);
  process.env.LOG_LEVEL = 'silent';
  const { Hono } = await import(
    pathToFileURL(path.join(repository, 'node_modules/hono/dist/index.js')).href
  );
  const { serve } = await import(
    pathToFileURL(
      path.join(repository, 'node_modules/@hono/node-server/dist/index.mjs'),
    ).href
  );
  const { query, createSdkMcpServer, tool } = await import(
    pathToFileURL(sdkPath).href
  );
  const { z } = await import(
    pathToFileURL(path.join(repository, 'node_modules/zod/index.js')).href
  );
  const { writeFile } = await import('node:fs/promises');
  const mcpServer = createSdkMcpServer({
    name: 'compat',
    version: '1.0.0',
    tools: [
      tool(
        longToolName,
        'Verify the protocol with a real SDK MCP handler',
        { marker: z.string() },
        async ({ marker }) => {
          assert.equal(marker, 'MCP_PROTOCOL_OK');
          mcpExecutions++;
          await writeFile(
            path.join(workspace, 'mcp-gateway-probe.txt'),
            marker,
          );
          return { content: [{ type: 'text', text: marker }] };
        },
      ),
    ],
  });
  const { createProvider, getProviders } = await import(
    pathToFileURL(path.join(repository, 'dist/runtime-config.js')).href
  );
  const { codexGatewayApp } = await import(
    pathToFileURL(path.join(repository, 'dist/codex-gateway/gateway.js')).href
  );
  const {
    CodexGatewayRunnerLease,
    resolveCodexGatewayLaunchConfig,
    updateLiveSessionEffort,
  } = await import(
    pathToFileURL(path.join(repository, 'dist/codex-gateway/runner-tokens.js'))
      .href
  );
  const { CodexMessagesRequestSchema } = await import(
    pathToFileURL(
      path.join(repository, 'dist/codex-gateway/request-validation.js'),
    ).href
  );
  const {
    CODEX_BACKEND_RESPONSES_URL,
    CODEX_GATEWAY_ROUTE,
    CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
  } = await import(
    pathToFileURL(path.join(repository, 'dist/codex-gateway/types.js')).href
  );
  check('emptyTemporaryProviderConfig', getProviders().length === 0);
  createProvider({
    name: 'E2E controlled Codex gateway',
    type: 'third_party',
    enabled: true,
    anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    anthropicAuthToken: gatewayIdentifier,
    anthropicModel: model,
    codexOAuthCredentials: {
      accessToken: upstreamKey,
      refreshToken: 'e2e-refresh-not-a-real-secret',
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId,
      planType: null,
      email: null,
      updatedAt: new Date().toISOString(),
    },
  });

  const upstream = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/responses');
      assert.equal(request.headers.authorization, `Bearer ${upstreamKey}`);
      assert.equal(request.headers['chatgpt-account-id'], accountId);
      const body = await jsonBody(request);
      if (scenario === 'override') {
        overrideUpstream.push(body);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        response.end(
          overrideEvents(body.model)
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(''),
        );
        return;
      }
      check(
        'realSdkStableSessionCache',
        typeof body.prompt_cache_key === 'string' &&
          request.headers['session-id'] === body.prompt_cache_key &&
          (!upstreamRequests.length ||
            upstreamRequests[0].prompt_cache_key === body.prompt_cache_key),
      );
      upstreamRequests.push(body);
      assert.ok(upstreamRequests.length <= 2, 'exactly two model turns');
      const shortenedMcp = upstreamTools(body).find((entry) =>
        entry.name?.includes('verify_'),
      )?.name;
      check(
        'longMcpSchemaMapped',
        typeof shortenedMcp === 'string' && shortenedMcp.length <= 64,
      );
      if (upstreamRequests.length === 2) {
        const result = body.input.find(
          (item) =>
            item.type === 'function_call_output' && item.call_id === callId,
        );
        const replay = body.input.find((item) => item.type === 'reasoning');
        check(
          'realSdkReasoningReplay',
          replay?.encrypted_content === encryptedReasoning && !replay.id,
        );
        const mcpFeedback = body.input.find(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === parallelCallId,
        );
        check(
          'upstreamReceivedMcpFeedback',
          JSON.stringify(mcpFeedback?.output).includes('MCP_PROTOCOL_OK'),
        );
        check(
          'upstreamReceivedBashFeedback',
          JSON.stringify(result?.output).includes(toolMarker),
        );
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      const wire = Buffer.from(
        fixtureEvents(upstreamRequests.length, shortenedMcp)
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(''),
      );
      // Split bytes across event/JSON/UTF-8 boundaries rather than returning a
      // synthesized Response to the converter or testing its pure functions.
      for (let offset = 0; offset < wire.length; offset += 73) {
        response.write(wire.subarray(offset, offset + 73));
      }
      response.end();
    } catch {
      checks.upstreamFixture = false;
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: 'Controlled fixture rejected request' }),
      );
    }
  });
  const upstreamUrl = await listen(upstream);
  // The gateway still requests the official constant. Only this precise URL
  // can be redirected. OAuth, catalog, telemetry or any other fetch fails shut.
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // The gateway refreshes the account's /models catalog in the background
    // like the official client; failing it keeps the synced catalog.
    if (url.startsWith('https://chatgpt.com/backend-api/codex/models')) {
      modelsCatalogFetches++;
      throw new Error('Models catalog fetch failed shut by E2E fixture');
    }
    if (url !== CODEX_BACKEND_RESPONSES_URL) {
      blockedFetches++;
      throw new Error('Unexpected network request blocked by E2E fixture');
    }
    return originalFetch(`${upstreamUrl}/responses`, {
      ...init,
      redirect: 'error',
    });
  };

  // The native CLI is a subprocess, so a parent fetch wrapper cannot constrain
  // it. Disable nonessential traffic and give it a rejecting HTTP(S) proxy;
  // only the explicitly configured loopback gateway bypasses that proxy.
  const denyProxy = createServer((_request, response) => {
    blockedProxyRequests++;
    response.writeHead(403);
    response.end();
  });
  denyProxy.on('connect', (_request, socket) => {
    blockedProxyRequests++;
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  const proxyUrl = await listen(denyProxy);
  const app = new Hono();
  app.use(`${CODEX_GATEWAY_ROUTE}/v1/messages`, async (context, next) => {
    const body = await context.req.raw.clone().json();
    const validation = CodexMessagesRequestSchema.safeParse(body);
    const overriding = scenario === 'override';
    (overriding ? overrideRequests : requests).push({
      body,
      apiKeyCorrect:
        context.req.header('x-api-key') ===
        (overriding ? overrideKey : gatewayKey),
      validationIssues: validation.success
        ? []
        : validation.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
          })),
    });
    await next();
    const record = { status: context.res.status, events: [] };
    (overriding ? overrideStreams : gatewayStreams).push(record);
    if (context.res.ok)
      record.events = parseAnthropicStream(await context.res.clone().text());
    else record.errorType = (await context.res.clone().json())?.error?.type;
  });
  app.route(CODEX_GATEWAY_ROUTE, codexGatewayApp);
  app.notFound((context) => {
    unexpectedHttpRequests++;
    return context.json({ error: 'Unexpected gateway path' }, 404);
  });
  const gateway = await new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      () => resolve(server),
    );
    server.once('error', reject);
  });
  servers.push(gateway);
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}${CODEX_GATEWAY_ROUTE}`;
  // Same substitution the runner launch performs: the stored identifier maps
  // to the provider and is replaced by a runner-scoped token.
  const runnerLease = new CodexGatewayRunnerLease({ kind: 'host' });
  gatewayKey = resolveCodexGatewayLaunchConfig(
    {
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicAuthToken: gatewayIdentifier,
    },
    'host',
    runnerLease,
  ).anthropicAuthToken;
  check(
    'runnerScopedGatewayToken',
    gatewayKey.startsWith('hcgw_') && gatewayKey !== gatewayIdentifier,
  );
  const env = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: claudeConfig,
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_API_KEY: gatewayKey,
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  phase = 'sdkExecution';
  abortController = new AbortController();
  timer = setTimeout(() => abortController.abort(), 60000);
  querySession = query({
    prompt: `Run Bash exactly once to create codex-gateway-probe.txt containing ${toolMarker}, then reply with the confirmation.`,
    options: {
      cwd: workspace,
      env,
      pathToClaudeCodeExecutable: cli,
      model,
      systemPrompt:
        'You are a controlled gateway compatibility test. Use the provided Bash tool and return the final response.',
      tools: ['Bash'],
      allowedTools: ['Bash', fullMcpName],
      permissionMode: 'dontAsk',
      settingSources: [],
      skills: [],
      plugins: [],
      mcpServers: { compat: mcpServer },
      persistSession: false,
      maxTurns: 4,
      includePartialMessages: true,
      abortController,
      stderr: (text) => {
        sdkStderrBytes += Buffer.byteLength(text);
      },
    },
  });
  for await (const message of querySession) sdkMessages.push(message);
  clearTimeout(timer);
  phase = 'assertions';
  check(
    'twoRealSdkRequests',
    requests.length === 2 && upstreamRequests.length === 2,
  );
  check(
    'realAnthropicAuthAndStream',
    requests.every(
      ({ body, apiKeyCorrect }) =>
        apiKeyCorrect &&
        body.stream === true &&
        Array.isArray(body.system) &&
        Array.isArray(body.messages),
    ),
  );
  check(
    'realBashToolSchema',
    requests[0].body.tools.some(
      (tool) => tool.name === 'Bash' && tool.input_schema?.type === 'object',
    ),
  );
  const anthropicFeedback = requests[1].body.messages
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find(
      (block) => block.type === 'tool_result' && block.tool_use_id === callId,
    );
  check(
    'realAnthropicToolResult',
    Boolean(anthropicFeedback && !anthropicFeedback.is_error),
  );
  check(
    'responsesToolIdentity',
    upstreamRequests[1].input.some(
      (item) =>
        item.type === 'function_call' &&
        item.call_id === callId &&
        item.name === 'Bash',
    ),
  );
  check(
    'responsesForcedFlags',
    upstreamRequests.every(
      (body) =>
        body.stream === true &&
        body.store === false &&
        body.model === model &&
        !('max_tokens' in body) &&
        !('metadata' in body),
    ),
  );
  check(
    'sdkSystemInstructionsPreserved',
    requests.every(({ body }, turn) => {
      const systemMessages = body.messages.filter(
        (message) => message.role === 'system',
      );
      const translatedSystemText = [
        upstreamRequests[turn].instructions,
        ...upstreamRequests[turn].input
          .filter(
            (item) =>
              ['system', 'developer'].includes(item.role) ||
              (item.role === 'user' &&
                item.content?.some((block) =>
                  block.text?.includes('<system-reminder>'),
                )),
          )
          .flatMap((item) => item.content?.map((block) => block.text) ?? []),
      ].join('\n');
      return (
        systemMessages.length > 0 &&
        systemMessages.every((message) =>
          (Array.isArray(message.content)
            ? message.content.map((block) => block.text)
            : [message.content]
          ).every((text) => translatedSystemText.includes(text)),
        )
      );
    }),
  );
  check(
    'bashWroteActualFile',
    (await readFile(
      path.join(workspace, 'codex-gateway-probe.txt'),
      'utf8',
    )) === `${toolMarker}\n`,
  );
  const toolUses = sdkMessages
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => message.message.content)
    .filter((block) => block.type === 'tool_use');
  check(
    'sdkExecutedOneBash',
    toolUses.length === 2 &&
      toolUses.some((item) => item.name === 'Bash' && item.id === callId),
  );
  check(
    'realLongMcpToolExecuted',
    mcpExecutions === 1 &&
      toolUses.some(
        (item) => item.name === fullMcpName && item.id === parallelCallId,
      ) &&
      (await readFile(
        path.join(workspace, 'mcp-gateway-probe.txt'),
        'utf8',
      )) === 'MCP_PROTOCOL_OK',
  );
  check(
    'realSdkNativeWebSearchBlocks',
    sdkMessages.some(
      (message) =>
        message.type === 'assistant' &&
        message.message.content.some(
          (block) =>
            block.type === 'web_search_tool_result' &&
            block.content?.some(
              (entry) => entry.url === 'https://example.invalid/protocol',
            ),
        ),
    ),
  );
  const result = sdkMessages.find((message) => message.type === 'result');
  check(
    'sdkFinalText',
    result?.subtype === 'success' &&
      result.result === finalText &&
      !result.is_error,
  );
  sdkFreshInputTokens = result.usage.input_tokens;
  sdkCachedInputTokens = result.usage.cache_read_input_tokens;
  sdkOutputTokens = result.usage.output_tokens;
  const usages = gatewayStreams.flatMap(({ events }) =>
    events
      .filter((event) => event.type === 'message_delta')
      .map((event) => event.usage),
  );
  check(
    'wireCacheExclusiveUsage',
    usages.length === 2 &&
      usages[0].input_tokens === 20 &&
      usages[0].cache_read_input_tokens === 80 &&
      usages[1].input_tokens === 50 &&
      usages[1].cache_read_input_tokens === 100,
  );
  check(
    'sdkCacheExclusiveUsage',
    result.usage.input_tokens === 70 &&
      result.usage.cache_read_input_tokens === 180 &&
      result.usage.output_tokens === 22 &&
      !result.usage.cache_creation_input_tokens,
  );
  check(
    'sdkCachedInputCountedOnce',
    result.usage.input_tokens +
      result.usage.cache_read_input_tokens +
      result.usage.output_tokens ===
      272,
  );
  check(
    'singleTerminalPerRequest',
    gatewayStreams.every(
      ({ status, events }) =>
        status === 200 &&
        events.filter((event) => event.type === 'message_stop').length === 1 &&
        !events.some((event) => event.type === 'error'),
    ),
  );
  check(
    'noUnexpectedNetwork',
    blockedFetches === 0 &&
      blockedProxyRequests === 0 &&
      unexpectedHttpRequests === 0,
  );

  // ── A conversation that picked another model and an effort ─────────────
  phase = 'conversationOverride';
  scenario = 'override';
  abortController = new AbortController();
  timer = setTimeout(() => abortController.abort(), 60000);
  const pickedModel = 'gpt-6-astra';
  const conversation = {
    groupFolder: 'e2e-conversation',
    sessionAgentId: null,
  };
  // What a launch does for a pinned conversation: the picked effort is minted
  // into the runner's grant, the picked model becomes the runner's model.
  const pickLease = new CodexGatewayRunnerLease({
    kind: 'host',
    groupFolder: conversation.groupFolder,
    agentId: conversation.sessionAgentId,
    sessionEffort: 'ultra',
  });
  overrideKey = resolveCodexGatewayLaunchConfig(
    {
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicAuthToken: gatewayIdentifier,
    },
    'host',
    pickLease,
  ).anthropicAuthToken;
  const pickEnv = {
    ...env,
    ANTHROPIC_API_KEY: overrideKey,
    ANTHROPIC_MODEL: pickedModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: pickedModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: pickedModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
    CLAUDE_CODE_SUBAGENT_MODEL: pickedModel,
    // The third-party default the host sets: the CLI sends max on its own.
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
  };
  const askOnce = async () => {
    const messages = [];
    querySession = query({
      prompt: 'Reply with the confirmation.',
      options: {
        cwd: workspace,
        env: pickEnv,
        pathToClaudeCodeExecutable: cli,
        model: pickedModel,
        systemPrompt: 'You are a controlled conversation-override test.',
        tools: [],
        allowedTools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        skills: [],
        plugins: [],
        persistSession: false,
        maxTurns: 2,
        thinking: { type: 'adaptive', display: 'summarized' },
        abortController,
        stderr: (text) => {
          sdkStderrBytes += Buffer.byteLength(text);
        },
      },
    });
    for await (const message of querySession) messages.push(message);
    querySession.close();
    return messages.find((message) => message.type === 'result');
  };

  const pickedResult = await askOnce();
  check(
    'conversationTurnCompleted',
    pickedResult?.subtype === 'success' &&
      pickedResult.result === overrideText &&
      !pickedResult.is_error,
  );
  check(
    'conversationRequestsAreAuthenticated',
    overrideRequests.length === 1 &&
      overrideRequests[0].apiKeyCorrect &&
      overrideRequests[0].validationIssues.length === 0 &&
      overrideStreams.every(({ status }) => status === 200),
  );
  check(
    'conversationModelReachesUpstream',
    overrideRequests[0].body.model === pickedModel &&
      overrideUpstream.length === 1 &&
      overrideUpstream[0].model === pickedModel,
  );
  // The CLI keeps sending its own effort; the pick must not ride on it.
  observedCliEffort = overrideRequests[0].body.output_config?.effort;
  check('cliKeepsItsOwnEffort', observedCliEffort !== 'ultra');
  check(
    'conversationUltraReachesUpstreamUntouched',
    overrideUpstream[0].reasoning?.effort === 'ultra',
  );

  // The effort button while the runner is warm: no new grant, no restart.
  check(
    'liveEffortChangeReachesTheGrant',
    updateLiveSessionEffort(conversation, 'high') === 1,
  );
  const changedResult = await askOnce();
  check(
    'liveEffortChangeTurnCompleted',
    changedResult?.subtype === 'success' && !changedResult.is_error,
  );
  check(
    'liveEffortChangeAppliesToTheNextRequest',
    overrideUpstream.length === 2 &&
      overrideUpstream[1].model === pickedModel &&
      overrideUpstream[1].reasoning?.effort === 'high',
  );
  // Back to the default: the catalog's own level for the model applies.
  updateLiveSessionEffort(conversation, undefined);
  await askOnce();
  check(
    'clearedEffortFallsBackToTheModelDefault',
    overrideUpstream.length === 3 &&
      overrideUpstream[2].reasoning?.effort === 'low',
  );
  clearTimeout(timer);
  pickLease.revoke();
  scenario = 'tools';
  check(
    'noUnexpectedNetworkAfterConversationOverride',
    blockedFetches === 0 &&
      blockedProxyRequests === 0 &&
      unexpectedHttpRequests === 0,
  );
  phase = 'complete';
} catch {
  // No SDK stderr, request bodies, provider credentials or user data are logged.
  checks.completed = false;
} finally {
  clearTimeout(timer);
  abortController?.abort();
  querySession?.close();
  process.chdir(originalCwd);
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
  await Promise.allSettled(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections?.();
        }),
    ),
  );
  await rm(scratch, { recursive: true, force: true });
  // Keep the fail-closed fetch boundary throughout cancellation/server teardown
  // so a late request cannot reach the official upstream during cleanup.
  globalThis.fetch = originalFetch;
}

const passed = phase === 'complete' && Object.values(checks).every(Boolean);
console.log(
  JSON.stringify({
    passed,
    phase,
    sdkVersion,
    cliVersion,
    checks,
    counts: {
      sdkRequests: requests.length,
      responsesRequests: upstreamRequests.length,
      sdkMessages: sdkMessages.length,
      sdkStderrBytes,
      conversationSdkRequests: overrideRequests.length,
      conversationResponsesRequests: overrideUpstream.length,
      sdkFreshInputTokens,
      sdkCachedInputTokens,
      sdkOutputTokens,
      blockedFetches,
      modelsCatalogFetches,
      blockedProxyRequests,
      unexpectedHttpRequests,
    },
    conversationCliEffort: observedCliEffort ?? null,
    statuses: gatewayStreams.map(({ status, errorType }) => ({
      status,
      errorType,
    })),
    requestShapes: requests.map(
      ({ body, apiKeyCorrect, validationIssues }) => ({
        apiKeyCorrect,
        validationIssues,
        keys: Object.keys(body).sort(),
        roles: body.messages.map((message) => message.role),
        contentTypes: [
          ...new Set(
            body.messages.flatMap((message) =>
              Array.isArray(message.content)
                ? message.content.map((block) => block.type)
                : ['string'],
            ),
          ),
        ],
      }),
    ),
  }),
);
process.exitCode = passed ? 0 : 1;
