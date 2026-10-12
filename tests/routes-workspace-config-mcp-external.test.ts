/**
 * Workspace MCP servers that exist only in `<workspace>/.claude/settings.json`
 * (externally added, not tracked in happyclaw-workspace.json) are listed by
 * GET, imported by PATCH and removed by DELETE. Every write route rebuilds
 * settings.mcpServers via syncMcpToSettings, which must keep those external
 * entries instead of wiping them, and the PATCH import must keep their args,
 * env and headers.
 *
 * Drives the real routes through hono with a temp GROUPS_DIR and a real
 * settings.json on disk.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-routes-workspace-mcp-external-'),
    );
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const workspaceConfigRoutesModule =
  await import('../src/routes/workspace-config.js');
const db = await import('../src/db.js');
const config = await import('../src/config.js');

const workspaceConfigRoutes = workspaceConfigRoutesModule.default;

const OWNER_ID = 'alice';
const GROUP_JID = 'web:mcp-external-group';
const GROUP_FOLDER = 'mcp-external-group';

const GITHUB = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_test_token' },
};
const DOCS = {
  type: 'http',
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: 'Bearer docs-token' },
};
const PERMISSIONS = { allow: ['Bash(ls:*)'], deny: [] };

function seedTestGroup(): void {
  db.setRegisteredGroup(GROUP_JID, {
    name: 'MCP External Group',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
}

function claudeDir(): string {
  return path.join(config.GROUPS_DIR, GROUP_FOLDER, '.claude');
}

function settingsPath(): string {
  return path.join(claudeDir(), 'settings.json');
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(claudeDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function readSettings(): Record<string, any> {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
}

function seedExternalServers(): void {
  writeSettings({
    permissions: PERMISSIONS,
    mcpServers: { github: GITHUB, docs: DOCS },
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  try {
    db.deleteRegisteredGroup(GROUP_JID);
  } catch {
    /* ignore */
  }
  const groupsDir = path.join(tmpDataDir, 'groups');
  if (fs.existsSync(groupsDir)) {
    fs.rmSync(groupsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(groupsDir, { recursive: true });
  seedTestGroup();
});

afterEach(() => {
  try {
    db.deleteRegisteredGroup(GROUP_JID);
  } catch {
    /* ignore */
  }
});

const base = `/${encodeURIComponent(GROUP_JID)}/workspace-config/mcp-servers`;

async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(url, {
    method,
    ...(body !== undefined
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const getMcp = () => call('GET', base);
const postMcp = (body: unknown) => call('POST', base, body);
const patchMcp = (id: string, body: unknown) =>
  call('PATCH', `${base}/${id}`, body);
const deleteMcp = (id: string) => call('DELETE', `${base}/${id}`);

describe('workspace-config MCP — externally added servers survive sync', () => {
  test('control: GET lists settings-only servers', async () => {
    seedExternalServers();
    const { status, body } = await getMcp();
    expect(status).toBe(200);
    const ids = body.servers.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual(['docs', 'github']);
  });

  test('POST of a new server keeps existing external servers', async () => {
    seedExternalServers();
    const res = await postMcp({ id: 'fetch', command: 'uvx', args: ['fetch'] });
    expect(res.status).toBe(200);

    const settings = readSettings();
    expect(settings.mcpServers).toEqual({
      github: GITHUB,
      docs: DOCS,
      fetch: { command: 'uvx', args: ['fetch'] },
    });
    expect(settings.permissions).toEqual(PERMISSIONS);
  });

  test('PATCH of one external server keeps the others', async () => {
    seedExternalServers();
    const res = await patchMcp('github', { description: 'GitHub' });
    expect(res.status).toBe(200);

    const settings = readSettings();
    expect(Object.keys(settings.mcpServers).sort()).toEqual(['docs', 'github']);
    expect(settings.mcpServers.docs).toEqual(DOCS);
  });

  test('DELETE of one external server keeps the others', async () => {
    seedExternalServers();
    const res = await deleteMcp('github');
    expect(res.status).toBe(200);

    const settings = readSettings();
    expect(settings.mcpServers).toEqual({ docs: DOCS });
    expect(settings.permissions).toEqual(PERMISSIONS);

    const list = await getMcp();
    expect(list.body.servers.map((s: { id: string }) => s.id)).toEqual([
      'docs',
    ]);
  });

  test('description-only PATCH keeps args, env and headers', async () => {
    seedExternalServers();

    const gh = await patchMcp('github', { description: 'GitHub' });
    expect(gh.status).toBe(200);
    expect(gh.body.server).toMatchObject({
      id: 'github',
      description: 'GitHub',
      ...GITHUB,
    });

    const docs = await patchMcp('docs', { description: 'Docs' });
    expect(docs.status).toBe(200);
    expect(docs.body.server).toMatchObject({
      id: 'docs',
      description: 'Docs',
      ...DOCS,
    });

    const settings = readSettings();
    expect(settings.mcpServers).toEqual({ github: GITHUB, docs: DOCS });
  });

  test('disable then re-enable of an imported external server restores its full config', async () => {
    seedExternalServers();

    const off = await patchMcp('github', { enabled: false });
    expect(off.status).toBe(200);
    expect(readSettings().mcpServers).toEqual({ docs: DOCS });

    const on = await patchMcp('github', { enabled: true });
    expect(on.status).toBe(200);
    expect(readSettings().mcpServers).toEqual({ docs: DOCS, github: GITHUB });
  });

  test('disabling an API-managed server alongside external ones removes only it', async () => {
    seedExternalServers();
    await postMcp({ id: 'mysrv', type: 'http', url: 'https://x.test/mcp' });
    const off = await patchMcp('mysrv', { enabled: false });
    expect(off.status).toBe(200);

    const settings = readSettings();
    expect(Object.keys(settings.mcpServers).sort()).toEqual(['docs', 'github']);
    expect(settings.permissions).toEqual(PERMISSIONS);
  });
});

describe('workspace-config MCP — API-managed servers (controls)', () => {
  test('add, disable, re-enable and delete behave as before', async () => {
    writeSettings({ permissions: PERMISSIONS });

    const add = await postMcp({
      id: 'mysrv',
      command: 'echo',
      args: ['hello'],
      env: { FOO: 'bar' },
    });
    expect(add.status).toBe(200);
    expect(readSettings().mcpServers).toEqual({
      mysrv: { command: 'echo', args: ['hello'], env: { FOO: 'bar' } },
    });

    const off = await patchMcp('mysrv', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.server.enabled).toBe(false);
    expect(readSettings().mcpServers).toBeUndefined();

    const listed = await getMcp();
    expect(listed.body.servers).toHaveLength(1);
    expect(listed.body.servers[0]).toMatchObject({
      id: 'mysrv',
      enabled: false,
    });

    const on = await patchMcp('mysrv', { enabled: true });
    expect(on.status).toBe(200);
    expect(readSettings().mcpServers).toEqual({
      mysrv: { command: 'echo', args: ['hello'], env: { FOO: 'bar' } },
    });

    const del = await deleteMcp('mysrv');
    expect(del.status).toBe(200);
    expect(readSettings().mcpServers).toBeUndefined();
    expect((await getMcp()).body.servers).toEqual([]);
    expect(await deleteMcp('mysrv')).toMatchObject({ status: 404 });

    expect(readSettings().permissions).toEqual(PERMISSIONS);
  });

  test('non-mcp settings keys are preserved across writes', async () => {
    writeSettings({ permissions: PERMISSIONS, model: 'opus' });
    await postMcp({ id: 'a', command: 'echo' });
    await patchMcp('a', { description: 'A' });
    await deleteMcp('a');
    const settings = readSettings();
    expect(settings.permissions).toEqual(PERMISSIONS);
    expect(settings.model).toBe('opus');
    expect(settings.mcpServers).toBeUndefined();
  });

  test('PATCH / DELETE of an unknown server returns 404', async () => {
    seedExternalServers();
    expect((await patchMcp('nope', { enabled: false })).status).toBe(404);
    expect((await deleteMcp('nope')).status).toBe(404);
    expect(readSettings().mcpServers).toEqual({ github: GITHUB, docs: DOCS });
  });
});
