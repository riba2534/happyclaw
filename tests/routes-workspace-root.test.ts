import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ws-backend-root-routes-')),
);
const dataDir = path.join(tmp, 'install', 'data');
const storeDir = path.join(dataDir, 'db');
const groupsDir = path.join(dataDir, 'groups');
const workspaceRoot = path.join(tmp, 'root');
const projects = path.join(tmp, 'projects');
for (const dir of [storeDir, groupsDir, projects]) {
  fs.mkdirSync(dir, { recursive: true });
}
process.env.HAPPYCLAW_WORKSPACE_ROOT = workspaceRoot;

const auth = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'member' }));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  MOUNT_ALLOWLIST_PATH: path.join(tmp, 'no-allowlist.json'),
  isDockerAvailable: async () => false,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const id = auth.role === 'admin' ? 'admin-1' : 'member-1';
    c.set('user', {
      id,
      username: id,
      role: auth.role,
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: vi.fn(),
  invalidateAllowedUserCache: vi.fn(),
}));

const db = await import('../src/db.js');
const dir = await import('../src/workspace-dir.js');
const { getRootForNewWorkspaces } = await import('../src/workspace-root.js');
const { ensureMarkedWorkspaceRoot } =
  await import('../src/workspace-root-fs.js');
const webContext = await import('../src/web-context.js');
const groupRoutes = (await import('../src/routes/groups.js')).default;

const NOW = '2026-11-04T00:00:00.000Z';

function createUser(id: string, role: 'admin' | 'member'): void {
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role,
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    must_change_password: false,
  });
}

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  createUser('admin-1', 'admin');
  createUser('member-1', 'member');
  // A root HappyClaw marked, so creating folders in it never reads as
  // someone else's directory; and the resolver main() binds at startup.
  ensureMarkedWorkspaceRoot(workspaceRoot);
  dir.setWorkspaceRootResolver(() =>
    getRootForNewWorkspaces(dir.getWorkspaceRootOccupancy()),
  );
});

beforeEach(() => {
  auth.role = 'admin';
  webContext.setWebDeps({
    getRegisteredGroups: () => db.getAllRegisteredGroups(),
    getSessions: () => ({}),
    setLastAgentTimestamp: vi.fn(),
    queue: {
      listDescendantJids: () => [],
      stopGroup: vi.fn(async () => {}),
      pauseGroupsForMutation: () => ({ id: 1 }),
      resumeGroupsAfterMutation: vi.fn(),
      discardGroupsAfterMutation: vi.fn(),
    },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterAll(() => {
  dir.setWorkspaceRootResolver(null);
  db.closeDatabase();
  delete process.env.HAPPYCLAW_WORKSPACE_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function create(
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await groupRoutes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** Point a workspace's record somewhere else, as a damaged row would. */
function forge(folder: string, workdir: string): void {
  const conn = new Database(path.join(storeDir, 'messages.db'));
  try {
    conn
      .prepare('UPDATE workspace_workdirs SET workdir = ? WHERE folder = ?')
      .run(workdir, folder);
  } finally {
    conn.close();
  }
}

describe('creating workspaces', () => {
  test('a Host workspace without a custom directory lives in the root', async () => {
    const { status, json } = await create({
      name: 'Host',
      execution_mode: 'host',
    });
    expect(status).toBe(200);
    const folder = json.group.folder as string;
    expect(dir.getRecordedWorkdir(folder)).toBe(
      path.join(workspaceRoot, folder),
    );
    expect(fs.statSync(path.join(workspaceRoot, folder)).isDirectory()).toBe(
      true,
    );
    expect(fs.existsSync(path.join(groupsDir, folder))).toBe(false);
  });

  test('a custom directory or a Container workspace records nothing', async () => {
    const cwd = path.join(projects, 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    const host = await create({
      name: 'Custom',
      execution_mode: 'host',
      custom_cwd: cwd,
    });
    expect(host.status).toBe(200);
    expect(dir.getRecordedWorkdir(host.json.group.folder)).toBeNull();

    const container = await create({
      name: 'Container',
      execution_mode: 'container',
    });
    expect(container.status).toBe(200);
    expect(dir.getRecordedWorkdir(container.json.group.folder)).toBeNull();
    expect(dir.workspaceDirOf(container.json.group.folder)).toBe(
      path.join(groupsDir, container.json.group.folder),
    );
  });

  test('a custom directory inside the workspace root is refused', async () => {
    fs.mkdirSync(path.join(workspaceRoot, 'inside'), { recursive: true });
    const { status, json } = await create({
      name: 'Inside',
      execution_mode: 'host',
      custom_cwd: path.join(workspaceRoot, 'inside'),
    });
    expect(status).toBe(400);
    expect(json.error).toContain('工作区根目录');
  });

  test('a custom directory containing the root or a workspace is refused', async () => {
    // ~ and the like: around the root, so around every workspace in it.
    const around = await create({
      name: 'Around',
      execution_mode: 'host',
      custom_cwd: tmp,
    });
    expect(around.status).toBe(400);
    expect(around.json.error).toContain('重叠');

    const ws = await create({ name: 'Has dir', execution_mode: 'host' });
    const workdir = dir.getRecordedWorkdir(ws.json.group.folder)!;
    const sub = path.join(workdir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const inside = await create({
      name: 'Inside ws',
      execution_mode: 'host',
      custom_cwd: sub,
    });
    expect(inside.status).toBe(400);
  });

  test('copying from around or inside a workspace is refused', async () => {
    const res = await create({
      name: 'Copy',
      execution_mode: 'container',
      init_source_path: tmp,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('init_source_path');
  });

  test('GET reports the root to admins only', async () => {
    const admin = await (await groupRoutes.request('/')).json();
    expect(admin.workspace_root).toBe(workspaceRoot);
    auth.role = 'member';
    const member = await (await groupRoutes.request('/')).json();
    expect(member.workspace_root).toBeNull();
  });

  test('with the fallback unusable too, GET reports no root and a new workspace stays in data/groups', async () => {
    // ~/CLAUDE.md rules out ~/happyclaw-workspaces; the env root is inside
    // the install directory.
    const home = path.join(tmp, 'home-with-memory');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), '# mine\n');
    const saved = {
      HOME: process.env.HOME,
      root: process.env.HAPPYCLAW_WORKSPACE_ROOT,
    };
    process.env.HOME = home;
    process.env.HAPPYCLAW_WORKSPACE_ROOT = path.join(dataDir, 'roots');
    try {
      const admin = await (await groupRoutes.request('/')).json();
      expect(admin.workspace_root).toBeNull();
      const { status, json } = await create({
        name: 'No root',
        execution_mode: 'host',
      });
      expect(status).toBe(200);
      const folder = json.group.folder as string;
      expect(dir.getRecordedWorkdir(folder)).toBeNull();
      expect(dir.workspaceDirOf(folder)).toBe(path.join(groupsDir, folder));
      expect(fs.existsSync(path.join(home, 'happyclaw-workspaces'))).toBe(
        false,
      );
    } finally {
      process.env.HOME = saved.HOME;
      process.env.HAPPYCLAW_WORKSPACE_ROOT = saved.root;
    }
  });
});

describe('deleting and rebuilding a recorded directory', () => {
  async function hostWorkspace(name: string) {
    const { json } = await create({ name, execution_mode: 'host' });
    const folder = json.group.folder as string;
    const workdir = dir.getRecordedWorkdir(folder)!;
    const file = path.join(workdir, 'notes.md');
    fs.writeFileSync(file, 'user data');
    return { jid: json.jid as string, folder, workdir, file };
  }

  test('delete removes the directory HappyClaw made', async () => {
    const ws = await hostWorkspace('Delete me');
    const res = await groupRoutes.request(`/${encodeURIComponent(ws.jid)}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(ws.workdir)).toBe(false);
    expect(dir.getRecordedWorkdir(ws.folder)).toBeNull();
  });

  test('delete of a forged record is refused and deletes nothing', async () => {
    const ws = await hostWorkspace('Forged delete');
    const victim = path.join(projects, 'victim');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
    forge(ws.folder, victim);
    const res = await groupRoutes.request(`/${encodeURIComponent(ws.jid)}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'WORKSPACE_DIR_UNSAFE',
      reason: 'basename_mismatch',
    });
    expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(ws.file)).toBe(true);
    expect(db.getRegisteredGroup(ws.jid)).toBeDefined();
  });

  test('rebuild empties the directory in place', async () => {
    const ws = await hostWorkspace('Rebuild me');
    const res = await groupRoutes.request(
      `/${encodeURIComponent(ws.jid)}/clear-history`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(dir.getRecordedWorkdir(ws.folder)).toBe(ws.workdir);
    expect(fs.existsSync(ws.workdir)).toBe(true);
    expect(fs.existsSync(ws.file)).toBe(false);
    expect(
      fs
        .readdirSync(workspaceRoot)
        .filter((n) => n.includes('.rebuild-backup-')),
    ).toEqual([]);
  });

  test('a rebuild whose move fails keeps every original in place', async () => {
    const ws = await hostWorkspace('Rebuild blocked');
    const sessions = path.join(dataDir, 'sessions');
    const sessionFile = path.join(sessions, ws.folder, 'transcript.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, 'history');
    // The workspace directory moves aside; the session directory cannot.
    fs.chmodSync(sessions, 0o555);
    try {
      const res = await groupRoutes.request(
        `/${encodeURIComponent(ws.jid)}/clear-history`,
        { method: 'POST' },
      );
      expect(res.status).toBe(500);
    } finally {
      fs.chmodSync(sessions, 0o755);
    }
    expect(fs.readFileSync(sessionFile, 'utf8')).toBe('history');
    expect(fs.readFileSync(ws.file, 'utf8')).toBe('user data');
    expect(
      fs
        .readdirSync(workspaceRoot)
        .filter((n) => n.includes('.rebuild-backup-')),
    ).toEqual([]);
  });

  test('rebuild of a forged record is refused and moves nothing', async () => {
    const ws = await hostWorkspace('Forged rebuild');
    const outside = path.join(tmp, 'elsewhere', ws.folder);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    forge(ws.folder, outside);
    const res = await groupRoutes.request(
      `/${encodeURIComponent(ws.jid)}/clear-history`,
      { method: 'POST' },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'WORKSPACE_DIR_UNSAFE',
      reason: 'root_mismatch',
    });
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    expect(
      fs
        .readdirSync(path.dirname(outside))
        .some((n) => n.includes('.rebuild-')),
    ).toBe(false);
  });
});
