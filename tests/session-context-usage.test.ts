/**
 * How full a conversation's context is: read on the host from the SDK
 * transcript of its current session, served by GET context-usage and pushed
 * over the WebSocket after each turn and when the conversation is cleared.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const harness = vi.hoisted(() => ({
  clients: new Map<any, any>(),
  sessions: new Map<string, any>(),
  userId: 'ctx-owner',
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-context-usage-'));
const dataDir = path.join(root, 'data');
for (const dir of ['data', 'store', 'groups']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: path.join(root, 'store'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/web-context.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    wsClients: harness.clients,
    getCachedSessionWithUser: (sessionId: string) =>
      harness.sessions.get(sessionId),
    invalidateSessionCache: vi.fn(),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: harness.userId,
      username: harness.userId,
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const usage = await import('../src/session-context-usage.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { clearRunContextSnapshots, recordRunContextSnapshot } =
  await import('../src/run-context-snapshot.js');
const { broadcastContextUsage } = await import('../src/web.js');
const { executeSessionReset } = await import('../src/commands.js');
const groupRoutes = (await import('../src/routes/groups.js')).default;

const OWNER = 'ctx-owner';
const JID = 'web:ctx-usage';
const FOLDER = 'ctx-usage';
const AGENT = 'ctx-agent';

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(JID, {
    name: 'Context usage',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    created_by: OWNER,
    executionMode: 'container',
  });
  db.createAgent({
    id: AGENT,
    group_folder: FOLDER,
    chat_jid: JID,
    name: 'Side conversation',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  } as never);
});

beforeEach(() => {
  harness.userId = OWNER;
  clearRunContextSnapshots();
  db.deleteAllSessionsForFolder(FOLDER);
  fs.rmSync(path.join(dataDir, 'sessions'), { recursive: true, force: true });
});

afterEach(() => {
  harness.clients.clear();
  harness.sessions.clear();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

const assistant = (
  model: string,
  input: number,
  cacheRead: number,
  cacheCreation: number,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-28T08:00:00.000Z',
    message: {
      id: `msg-${Math.random()}`,
      model,
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: 99,
      },
    },
    ...extra,
  });

/** A session of the conversation with its transcript on disk. */
function session(
  lines: string[],
  options: { agentId?: string; model?: string } = {},
): void {
  const sessionId = `sdk-${options.agentId ?? 'main'}`;
  db.setSession(FOLDER, sessionId, options.agentId ?? null);
  if (options.model) {
    db.setSessionModel(FOLDER, options.agentId ?? null, options.model);
  }
  const claudeDir = options.agentId
    ? path.join(
        dataDir,
        'sessions',
        FOLDER,
        'agents',
        options.agentId,
        '.claude',
      )
    : path.join(dataDir, 'sessions', FOLDER, '.claude');
  const projectDir = path.join(claudeDir, 'projects', '-workspace-group');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${lines.join('\n')}\n`,
  );
}

function addClient(userId: string) {
  const client = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
  const sessionId = `ws-${userId}`;
  harness.sessions.set(sessionId, {
    id: sessionId,
    user_id: userId,
    username: userId,
    role: 'member',
    status: 'active',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  harness.clients.set(client, { sessionId });
  return client;
}

const pushed = (client: ReturnType<typeof addClient>) =>
  client.send.mock.calls
    .map(([raw]) => JSON.parse(raw))
    .filter((message) => message.type === 'context_usage');

describe('reading how full a context is', () => {
  test('nothing ran: everything is null', async () => {
    expect(await usage.readSessionContextUsage(FOLDER, null)).toEqual(
      usage.NO_CONTEXT_USAGE,
    );
  });

  test("the last main-thread request's prompt, in a window capped at Claude Code's default", async () => {
    session(
      [
        assistant('glm-5.3', 900, 10_000, 100),
        assistant('glm-5.3', 1_200, 30_000, 500),
        // A sub-agent's request and a synthetic message are not the context.
        assistant('glm-5.3', 50_000, 90_000, 0, { isSidechain: true }),
        assistant('<synthetic>', 1, 0, 0),
        JSON.stringify({ type: 'user', message: { content: 'next' } }),
      ],
      { model: 'glm-5.3' },
    );
    expect(await usage.readSessionContextUsage(FOLDER, null)).toEqual({
      usedTokens: 31_700,
      // glm-5.3 has a 1M window, but Claude Code is given 200K without [1m].
      contextWindow: 200_000,
      percentage: 15.9,
      model: 'glm-5.3',
      updatedAt: '2026-10-28T08:00:00.000Z',
    });
  });

  test('a [1m] model works with 1M; Claude Code’s own report wins over both', async () => {
    session([assistant('glm-5.3', 100_000, 0, 0)], { model: 'glm-5.3[1m]' });
    expect(await usage.readSessionContextUsage(FOLDER, null)).toMatchObject({
      contextWindow: 1_000_000,
      percentage: 10,
    });

    recordRunContextSnapshot({
      chatJid: JID,
      audit: {
        executionMode: 'container',
        claudeMd: { status: 'loaded' },
        rules: { fileCount: 0 },
        skills: { sources: [] },
        happyclawPrompt: { files: [], totalBytes: 0 },
        warnings: [],
        sdkContextUsage: {
          model: 'glm-5.3[1m]',
          totalTokens: 1,
          maxTokens: 800_000,
          percentage: 0,
          mcpTools: [],
        },
      } as never,
    });
    expect(await usage.readSessionContextUsage(FOLDER, null)).toMatchObject({
      contextWindow: 800_000,
      percentage: 12.5,
    });
    // Another model's report does not apply.
    session([assistant('kimi-k3', 100_000, 0, 0)], { model: 'kimi-k3' });
    expect(await usage.readSessionContextUsage(FOLDER, null)).toMatchObject({
      contextWindow: 200_000,
    });
  });

  test('just compacted: unknown until the next answer', async () => {
    session([
      assistant('glm-5.3', 1_200, 30_000, 500),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
    ]);
    expect(await usage.readSessionContextUsage(FOLDER, null)).toEqual(
      usage.NO_CONTEXT_USAGE,
    );
  });

  test('an answer far behind long tool results is still found', async () => {
    const toolResult = JSON.stringify({
      type: 'user',
      message: { content: 'x'.repeat(100_000) },
    });
    session([
      assistant('glm-5.3', 2_000, 0, 0),
      ...Array.from({ length: 6 }, () => toolResult),
    ]);
    expect(await usage.readSessionContextUsage(FOLDER, null)).toMatchObject({
      usedTokens: 2_000,
    });
  });
});

describe('the window when Claude Code has not reported one', () => {
  function bound(provider: { id: string }) {
    db.setSessionProviderId(FOLDER, null, provider.id);
  }

  test('an official connection: the declared window, else 1M for a [1m] name, else 200K', async () => {
    // The registry's 1M for opus is not used: on an official connection
    // `[1m]` is the billed opt-in, which only a declared window turns on.
    session([assistant('claude-opus-5-5', 150_000, 0, 0)], { model: 'opus' });
    const official = runtimeConfig.createProvider({
      name: 'Claude',
      type: 'official',
      anthropicApiKey: 'sk-ant-api03-official-key',
      anthropicModel: 'opus',
    });
    bound(official);
    expect(await usage.readSessionContextUsage(FOLDER, null)).toMatchObject({
      contextWindow: 200_000,
      percentage: 75,
    });
    // A session recorded with `[1m]` before the window was a field.
    session([assistant('claude-opus-5-5', 150_000, 0, 0)], {
      model: 'opus[1m]',
    });
    bound(official);
    expect(await usage.readSessionContextUsage(FOLDER, null)).toMatchObject({
      contextWindow: 1_000_000,
      percentage: 15,
    });
  });

  test("a connection model's declared window is the window", async () => {
    session([assistant('glm-5.3', 100_000, 0, 0)], { model: 'glm-5.3' });
    bound(
      runtimeConfig.createProvider({
        name: 'GLM',
        type: 'third_party',
        anthropicBaseUrl: 'https://glm.example.test',
        anthropicAuthToken: 'glm-token-123456',
        anthropicModel: 'glm-5.3',
        models: [{ id: 'glm-5.3', contextWindow: 500_000 }],
      }),
    );
    expect(await usage.readSessionContextUsage(FOLDER, null)).toMatchObject({
      contextWindow: 500_000,
      percentage: 20,
    });
  });

  test('a prompt past the window takes the larger window, and never reads past 100%', async () => {
    // glm-5.3 is given 200K behind an endpoint, but a 300K prompt fit.
    session([assistant('glm-5.3', 300_000, 0, 0)], { model: 'glm-5.3' });
    expect(await usage.readSessionContextUsage(FOLDER, null)).toMatchObject({
      contextWindow: 1_000_000,
      percentage: 30,
    });
    // A model of unknown size: the ring is full, not past it.
    session([assistant('relay-x', 450_000, 0, 0)], { model: 'relay-x' });
    expect(await usage.readSessionContextUsage(FOLDER, null)).toMatchObject({
      usedTokens: 450_000,
      contextWindow: 200_000,
      percentage: 100,
    });
  });

  test('a session cleared while its transcript was read reads empty', async () => {
    session([assistant('glm-5.3', 1_000, 0, 0)]);
    const pending = usage.readSessionContextUsage(FOLDER, null);
    db.deleteSession(FOLDER);
    expect(await pending).toEqual(usage.NO_CONTEXT_USAGE);
  });
});

describe('GET /:jid/context-usage', () => {
  const get = async (query = '') => {
    const res = await groupRoutes.request(
      `/${encodeURIComponent(JID)}/context-usage${query}`,
    );
    return { status: res.status, body: await res.json() };
  };

  test("reads the named session's own; a workspace has none", async () => {
    session([assistant('glm-5.3', 1_000, 0, 0)]);
    session([assistant('kimi-k3', 3_000, 0, 0)], { agentId: AGENT });
    expect(await get(`?agentId=${AGENT}`)).toMatchObject({
      status: 200,
      body: { usedTokens: 3_000, model: 'kimi-k3' },
    });
    expect(await get()).toEqual({
      status: 400,
      body: { error: 'Session required', code: 'session_required' },
    });
  });

  test('hides another account’s workspace', async () => {
    harness.userId = 'ctx-other';
    expect((await get(`?agentId=${AGENT}`)).status).toBe(404);
  });
});

describe('the push to the Web', () => {
  test('tells the workspace owner after a turn, and nobody else', async () => {
    session([assistant('glm-5.3', 1_000, 0, 0)]);
    const owner = addClient(OWNER);
    const other = addClient('ctx-other');
    await broadcastContextUsage(FOLDER, null);
    expect(pushed(owner)).toEqual([
      {
        type: 'context_usage',
        chatJid: JID,
        usedTokens: 1_000,
        contextWindow: 200_000,
        percentage: 0.5,
        model: 'glm-5.3',
        updatedAt: '2026-10-28T08:00:00.000Z',
      },
    ]);
    expect(pushed(other)).toEqual([]);

    await broadcastContextUsage(FOLDER, AGENT);
    expect(pushed(owner).at(-1)).toMatchObject({
      agentId: AGENT,
      usedTokens: null,
    });
  });

  test('a cleared conversation reads empty until its next turn', async () => {
    session([assistant('glm-5.3', 1_000, 0, 0)]);
    const owner = addClient(OWNER);
    await executeSessionReset(JID, FOLDER, {
      queue: { stopGroup: async () => {} },
      sessions: {},
      broadcast: () => {},
      setLastAgentTimestamp: () => {},
    });
    expect(pushed(owner)).toEqual([
      { type: 'context_usage', chatJid: JID, ...usage.NO_CONTEXT_USAGE },
    ]);
    expect(await usage.readSessionContextUsage(FOLDER, null)).toEqual(
      usage.NO_CONTEXT_USAGE,
    );
  });
});
