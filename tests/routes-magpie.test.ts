/**
 * The connection routes against a local endpoint that answers like magpie
 * (tests/fixtures/magpie.ts): a model list that shows Claude Code's
 * discovery aliases to a versioned claude-cli agent and the real ids to
 * HappyClaw's, the quotas list, and the catalog sync that keeps a magpie
 * connection's list in step.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

import {
  MAGPIE_MODELS,
  magpieModelList,
  magpieQuotas,
} from './fixtures/magpie.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-magpie-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger }));

const currentUser = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: `magpie-admin-${currentUser.n}`,
        username: 'magpie-admin',
        display_name: 'Admin',
        role: 'admin',
        status: 'active',
        permissions: [],
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const connectivity = await import('../src/provider-connectivity.js');
const catalog = await import('../src/model-catalog-sync.js');

const queue = {
  stopGroup: vi.fn(async () => {}),
  listDescendantJids: () => [],
  pauseGroupsForMutation: vi.fn(() => ({ id: 0 })),
  resumeGroupsAfterMutation: vi.fn(),
  blockGroupsForRuntimeSafety: vi.fn(),
  unblockGroupsForRuntimeSafety: vi.fn(),
  drainProviderRunnersForCredentialRefresh: vi.fn(() => 0),
  getStatus: vi.fn(() => ({ groups: [] as unknown[] })),
};
const app = web.createAppForTest({
  queue,
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

// ─── A magpie on loopback ──────────────────────────────────────

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
}
const seen: Seen[] = [];
let models = magpieModelList;
let quotasStatus = 200;
let server: http.Server;
let magpieUrl = '';

const GATEWAY_KEY = 'magpie-gateway-key-0123456789';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const key =
      req.headers['x-api-key'] ??
      req.headers.authorization?.replace(/^Bearer /, '');
    if (key !== GATEWAY_KEY) {
      send(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid key' },
      });
      return;
    }
    if (req.url?.startsWith('/v1/models')) {
      // magpie's claudeCodeDiscovers: anthropic-version and a Claude agent.
      const ua = req.headers['user-agent'] ?? '';
      const forClaudeCode =
        !!req.headers['anthropic-version'] &&
        (ua.startsWith('claude-code/') || /^claude-cli\/\d/.test(ua));
      send(200, models({ forClaudeCode }));
      return;
    }
    if (req.url === '/v1/magpie/quotas') {
      if (quotasStatus !== 200) {
        send(quotasStatus, { error: { message: 'quotas unavailable' } });
        return;
      }
      send(200, magpieQuotas(Date.parse('2026-11-15T12:00:00.000Z')));
      return;
    }
    send(404, { error: { message: 'magpie knows no route' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  magpieUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  currentUser.n += 1;
  fs.rmSync(path.join(tmpDir, 'config'), { recursive: true, force: true });
  seen.length = 0;
  models = magpieModelList;
  quotasStatus = 200;
  for (const fn of Object.values(queue)) {
    if (vi.isMockFunction(fn)) fn.mockClear();
  }
});

afterEach(() => {
  catalog.stopModelCatalogSync();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/api/config/claude${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function createMagpie(patch: Record<string, unknown> = {}) {
  return runtimeConfig.createProvider({
    name: 'Magpie',
    type: 'third_party',
    presetId: 'magpie',
    anthropicBaseUrl: magpieUrl,
    anthropicAuthToken: GATEWAY_KEY,
    anthropicAuthMode: 'bearer',
    anthropicModel: 'codex/gpt-5.6-sol',
    ...patch,
  });
}

describe('the agent strings', () => {
  test("probes send the bundled Claude Code's version", () => {
    expect(connectivity.bundledClaudeCodeVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(connectivity.claudeCodeUserAgent()).toMatch(
      /^claude-cli\/\d+\.\d+\.\d+ \(external, sdk-ts\)$/,
    );
    expect(connectivity.happyClawUserAgent()).toMatch(/^HappyClaw\//);
    expect(connectivity.happyClawUserAgent()).not.toMatch(/claude/i);
    // A resolver pointing at no SDK falls back to a version-less string.
    expect(
      connectivity.bundledClaudeCodeVersion(() => path.join(tmpDir, 'x.mjs')),
    ).toBeNull();
  });
});

describe('model discovery on magpie', () => {
  test('lists the real model ids, never the aliases magpie shows Claude Code', async () => {
    const { status, body } = await request(
      'POST',
      '/providers/discover-models',
      {
        type: 'third_party',
        presetId: 'magpie',
        anthropicBaseUrl: magpieUrl,
        anthropicAuthToken: GATEWAY_KEY,
      },
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.gateway).toBe('magpie');
    const ids = body.models.map((model: { id: string }) => model.id);
    expect(ids).toEqual(MAGPIE_MODELS.map((model) => model.id));
    expect(ids.some((id: string) => /^anthropic\/magpie-\d+$/.test(id))).toBe(
      false,
    );
    expect(body.models[0]).toMatchObject({
      id: 'codex/gpt-5.6-sol',
      name: 'GPT-5.6-Sol',
      maxOutputTokens: 128_000,
      vendor: 'Codex',
    });
    // Read first as Claude Code, then again as HappyClaw.
    const agents = seen
      .filter((item) => item.url.startsWith('/v1/models'))
      .map((item) => item.headers['user-agent']);
    expect(agents[0]).toMatch(/^claude-cli\/\d/);
    expect(agents[1]).toMatch(/^HappyClaw\//);
  });

  test('aliases are dropped even when the second read shows them too', async () => {
    models = () => magpieModelList({ forClaudeCode: true });
    const { body } = await request('POST', '/providers/discover-models', {
      type: 'third_party',
      anthropicBaseUrl: magpieUrl,
      anthropicAuthToken: GATEWAY_KEY,
    });
    expect(body.ok).toBe(true);
    expect(body.models.map((model: { id: string }) => model.id)).toEqual([
      'claude/claude-opus-5-5',
    ]);
  });

  test('a list without aliases is read once', async () => {
    models = () => magpieModelList({ forClaudeCode: false });
    const { body } = await request('POST', '/providers/discover-models', {
      type: 'third_party',
      anthropicBaseUrl: magpieUrl,
      anthropicAuthToken: GATEWAY_KEY,
    });
    expect(body.gateway).toBe('magpie');
    expect(
      seen.filter((item) => item.url.startsWith('/v1/models')),
    ).toHaveLength(1);
  });

  test("a saved connection's own discovery marks it magpie", async () => {
    const relay = runtimeConfig.createProvider({
      name: 'Relay',
      type: 'third_party',
      anthropicBaseUrl: magpieUrl,
      anthropicAuthToken: GATEWAY_KEY,
      anthropicAuthMode: 'bearer',
      anthropicModel: 'codex/gpt-5.6-sol',
    });
    expect(relay.gateway).toBeUndefined();
    await request('POST', '/providers/discover-models', {
      providerId: relay.id,
    });
    const marked = runtimeConfig.getProviderById(relay.id)!;
    expect(marked.gateway).toBe('magpie');
    expect(marked.catalog?.checkedAt).toBeTruthy();
    // Tool search follows the new default: its runners retire after the turn.
    expect(queue.drainProviderRunnersForCredentialRefresh).toHaveBeenCalledWith(
      relay.id,
    );
    // Detected, not chosen: its WebFetch setting is left as it was.
    expect(marked.webFetchPreflightPolicy).toBeUndefined();
  });
});

describe('magpie connections', () => {
  test('need a model', async () => {
    const refused = await request('POST', '/providers', {
      name: 'Magpie',
      type: 'third_party',
      presetId: 'magpie',
      anthropicBaseUrl: magpieUrl,
      anthropicAuthToken: GATEWAY_KEY,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('MAGPIE_MODELS_REQUIRED');
    const created = createMagpie();
    const patched = await request('PATCH', `/providers/${created.id}`, {
      anthropicModel: '',
      models: [],
    });
    expect(patched.status).toBe(400);
    expect(patched.body.code).toBe('MAGPIE_MODELS_REQUIRED');
  });

  test('changing tool search retires their runners after the turn', async () => {
    const created = createMagpie();
    const { status, body } = await request(
      'PATCH',
      `/providers/${created.id}`,
      {
        toolSearch: 'off',
      },
    );
    expect(status).toBe(200);
    expect(body.provider).toMatchObject({
      toolSearch: 'off',
      toolSearchEnabled: false,
    });
    expect(queue.drainProviderRunnersForCredentialRefresh).toHaveBeenCalledWith(
      created.id,
    );
    expect(queue.stopGroup).not.toHaveBeenCalled();
  });

  test('usage is read from magpie quotas', async () => {
    const created = createMagpie();
    const { status, body } = await request(
      'GET',
      `/providers/${created.id}/usage`,
    );
    expect(status).toBe(200);
    expect(body.kind).toBe('magpie_quotas');
    expect(body.error).toBeNull();
    expect(body.accounts).toHaveLength(4);
    expect(body.accounts[0].windows[0]).toMatchObject({
      name: '5h',
      remaining: 0,
    });
    const quotaRequest = seen.find((item) => item.url === '/v1/magpie/quotas')!;
    expect(quotaRequest.headers.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
    quotasStatus = 500;
    const failed = await request('GET', `/providers/${created.id}/usage`);
    expect(failed.body).toMatchObject({
      kind: 'magpie_quotas',
      accounts: [],
      error: 'quotas unavailable',
    });
  });
});

describe('catalog sync', () => {
  test('takes the names and limits, keeps an admin window, marks what is gone', async () => {
    const created = createMagpie({
      models: [
        { id: 'codex/gpt-5.6-sol' },
        // The admin set this window themselves.
        { id: 'relaya/glm-5', contextWindow: 150_000 },
        { id: 'relaya/retired' },
      ],
    });
    const first = await request(
      'POST',
      `/providers/${created.id}/catalog/sync`,
    );
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({
      ok: true,
      gateway: 'magpie',
      added: [],
      missing: ['relaya/retired'],
    });
    const shown = first.body.provider;
    expect(shown.catalog.syncedAt).toBeTruthy();
    const byId = Object.fromEntries(
      shown.models.map((entry: { id: string }) => [entry.id, entry]),
    );
    expect(byId['codex/gpt-5.6-sol']).toMatchObject({
      displayName: 'GPT-5.6-Sol',
      contextWindow: 400_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      maxOutputTokens: 128_000,
      vendor: 'Codex',
    });
    expect(byId['relaya/glm-5']).toMatchObject({
      contextWindow: 150_000,
      maxOutputTokens: 131_072,
      efforts: [],
      thinks: true,
    });
    expect(byId['relaya/retired'].upstreamMissingSince).toBeTruthy();
    // The first sync learns the list: nothing on it is new.
    expect(shown.catalog.newModels).toEqual([]);
    // Moments later the detail reads what the sync found.
    seen.length = 0;
    const again = await request(
      'POST',
      `/providers/${created.id}/catalog/sync`,
    );
    expect(again.body.result.skipped).toBe('recent');
    expect(seen).toHaveLength(0);
    // A sync changes metadata only: nothing was stopped.
    expect(queue.stopGroup).not.toHaveBeenCalled();
  });

  test('a model that appears later waits to be picked, or joins with auto-add', async () => {
    const created = createMagpie({ models: [{ id: 'codex/gpt-5.6-sol' }] });
    const start = Date.parse('2026-11-15T00:00:00.000Z');
    models = () => {
      const list = magpieModelList();
      return { ...list, data: list.data.slice(0, 2) };
    };
    await catalog.syncProviderCatalog(created.id, { force: true, now: start });
    models = magpieModelList;
    let result = await catalog.syncProviderCatalog(created.id, {
      force: true,
      now: start + 7 * 3_600_000,
    });
    expect(result).toMatchObject({ ok: true, added: [] });
    const waiting = runtimeConfig.getProviderById(created.id)!;
    const appeared = MAGPIE_MODELS.slice(2).map((model) => model.id);
    expect(waiting.catalog?.newModels?.map((entry) => entry.id)).toEqual(
      appeared,
    );
    // Picking one through the ordinary edit takes it off the waiting list.
    await request('PATCH', `/providers/${created.id}`, {
      models: [
        { id: 'codex/gpt-5.6-sol' },
        waiting.catalog!.newModels!.find(
          (entry) => entry.id === 'claude/claude-opus-5-5',
        ),
      ],
      catalogAutoAdd: true,
    });
    const picked = runtimeConfig.getProviderById(created.id)!;
    expect(picked.models?.map((entry) => entry.id)).toEqual([
      'codex/gpt-5.6-sol',
      'claude/claude-opus-5-5',
    ]);
    expect(picked.models?.[1].displayName).toBe('Opus 5.5');
    expect(picked.catalog?.newModels?.map((entry) => entry.id)).not.toContain(
      'claude/claude-opus-5-5',
    );
    // With auto-add on, a model that appears next joins by itself.
    models = () => {
      const list = magpieModelList();
      return {
        ...list,
        data: [
          ...list.data,
          { ...list.data[0], id: 'codex/gpt-6-luna', display_name: 'Luna' },
        ],
      };
    };
    result = await catalog.syncProviderCatalog(created.id, {
      force: true,
      now: start + 14 * 3_600_000,
    });
    expect(result).toMatchObject({ ok: true, added: ['codex/gpt-6-luna'] });
  });

  test('an unchecked connection elsewhere is checked once; failures back off', async () => {
    const relay = runtimeConfig.createProvider({
      name: 'Relay',
      type: 'third_party',
      anthropicBaseUrl: magpieUrl,
      anthropicAuthToken: 'wrong-key-0123456789',
      anthropicAuthMode: 'bearer',
      anthropicModel: 'm',
    });
    const now = Date.parse('2026-11-15T00:00:00.000Z');
    expect(catalog.catalogSyncDue(relay, now)).toBe(true);
    await catalog.runCatalogSyncPass({ now });
    const failed = runtimeConfig.getProviderById(relay.id)!;
    expect(failed.catalog).toMatchObject({ failures: 1 });
    expect(failed.catalog?.error?.code).toBe('AUTH_INVALID');
    // Not again before the backoff.
    expect(catalog.catalogSyncDue(failed, now + 60_000)).toBe(false);
    expect(catalog.catalogSyncDue(failed, now + 16 * 60_000)).toBe(true);
    runtimeConfig.updateProviderSecrets(relay.id, {
      anthropicAuthToken: GATEWAY_KEY,
    });
    await catalog.runCatalogSyncPass({ now: now + 16 * 60_000 });
    const marked = runtimeConfig.getProviderById(relay.id)!;
    expect(marked.gateway).toBe('magpie');
    expect(marked.catalog?.error).toBeUndefined();
    expect(marked.catalog?.syncedAt).toBeTruthy();
    // magpie is synced again only after six hours.
    expect(catalog.catalogSyncDue(marked, now + 17 * 60_000)).toBe(false);
    expect(catalog.catalogSyncDue(marked, now + 7 * 3_600_000)).toBe(true);
  });

  test('official and ChatGPT connections have no catalog', async () => {
    const official = runtimeConfig.createProvider({
      name: 'Claude',
      type: 'official',
      anthropicApiKey: 'sk-ant-api03-abcdefghijklmnop',
    });
    const { status, body } = await request(
      'POST',
      `/providers/${official.id}/catalog/sync`,
    );
    expect(status).toBe(400);
    expect(body.code).toBe('CATALOG_UNSUPPORTED');
  });
});
