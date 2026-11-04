/**
 * HTTP surface of the developer workbench against real git repositories:
 * creating a session with its own worktree, listing it, the Review panel
 * status/diff, the file panel root, same-directory peers, and the deletion
 * paths that remove worktrees (session, workspace, rebuild) while keeping
 * branches and refusing to drop uncommitted work without confirmation.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

const ROOT =
  process.env.HAPPYCLAW_WORKTREE_ROUTE_TEST_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-worktree-routes-'),
    );
    process.env.HAPPYCLAW_WORKTREE_ROUTE_TEST_DIR = dir;
    return dir;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const root = process.env.HAPPYCLAW_WORKTREE_ROUTE_TEST_DIR!;
  return {
    ...real,
    DATA_DIR: path.join(root, 'data'),
    GROUPS_DIR: path.join(root, 'data', 'groups'),
    STORE_DIR: path.join(root, 'data', 'db'),
    MOUNT_ALLOWLIST_PATH: path.join(root, 'no-mount-allowlist.json'),
    isDockerAvailable: () => false,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const id = process.env.HAPPYCLAW_TEST_USER_ID ?? 'admin-1';
    c.set('user', {
      id,
      username: id,
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'admin',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: vi.fn(),
  broadcastAgentStatus: vi.fn(),
  broadcastAgentRemoved: vi.fn(),
  invalidateAllowedUserCache: vi.fn(),
}));

const db = await import('../src/db.js');
const store = await import('../src/session-worktree-store.js');
const webContext = await import('../src/web-context.js');
const agentRoutes = (await import('../src/routes/agents.js')).default;
const gitRoutes = (await import('../src/routes/git-review.js')).default;
const groupRoutes = (await import('../src/routes/groups.js')).default;
const fileRoutes = (await import('../src/routes/files.js')).default;
const automationStore = await import('../src/automation-store.js');
const { createAutomationCore } = await import('../src/automation-service.js');
const { setAutomationRuntimeService } =
  await import('../src/automation-run-ledger.js');
const automationHarness = await import('./automation-harness.js');
const reliability = await import('../src/channel-reliability-store.js');

const ADMIN = 'admin-1';
const queueGroups: Array<{
  jid: string;
  active: boolean;
  queryInFlight: boolean;
  groupFolder: string | null;
}> = [];
const stopGroup = vi.fn(async () => {});

function asUser(id: string, role: 'admin' | 'member' = 'admin'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = id;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

let seq = 0;
function makeRepo(): string {
  const dir = path.join(ROOT, `repo-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return fs.realpathSync(dir);
}

function seedWorkspace(options: {
  executionMode: 'host' | 'container';
  customCwd?: string;
  owner?: string;
}): { jid: string; folder: string } {
  const id = `ws-${++seq}`;
  const jid = `web:${id}`;
  db.setRegisteredGroup(jid, {
    name: `Workspace ${id}`,
    folder: id,
    added_at: new Date().toISOString(),
    executionMode: options.executionMode,
    customCwd: options.customCwd,
    created_by: options.owner ?? ADMIN,
    is_home: false,
  } as any);
  return { jid, folder: id };
}

async function call(
  router: {
    request: (url: string, init?: RequestInit) => Response | Promise<Response>;
  },
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: any }> {
  const response = await router.request(url, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(init.body),
        }
      : {}),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

const enc = encodeURIComponent;

async function createSession(jid: string, body: Record<string, unknown>) {
  return call(agentRoutes, `/${enc(jid)}/sessions`, {
    method: 'POST',
    body,
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, 'data', 'db'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'data', 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  asUser(ADMIN);
  queueGroups.length = 0;
  stopGroup.mockClear();
  webContext.setWebDeps({
    getRegisteredGroups: () => db.getAllRegisteredGroups(),
    getSessions: () => ({}),
    setLastAgentTimestamp: vi.fn(),
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
    broadcastNewMessage: vi.fn(),
    getLastAgentTimestamp: () => ({}),
    processAgentConversation: vi.fn(async () => {}),
    queue: {
      getStatus: () => ({ groups: queueGroups }),
      stopGroup,
      getActiveQueryId: () => null,
      enqueueTask: vi.fn(),
      listDescendantJids: () => [],
      pauseGroupsForMutation: () => ({ id: 1 }),
      resumeGroupsAfterMutation: vi.fn(),
      discardGroupsAfterMutation: vi.fn(),
      // A real GroupQueue holds lanes in session-delete-lane-hold.test.ts.
      holdLane: vi.fn(),
      releaseLane: vi.fn(),
      discardHeldLane: vi.fn(),
    },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('creating a session with its own worktree', () => {
  test('adds a worktree on a new branch and lists it', async () => {
    const repo = makeRepo();
    const { jid, folder } = seedWorkspace({
      executionMode: 'host',
      customCwd: repo,
    });

    const support = await call(gitRoutes, `/${enc(jid)}/git/worktree-support`);
    expect(support.body).toEqual({ available: true });

    const created = await createSession(jid, {
      name: 'feature',
      worktree: true,
    });
    expect(created.status).toBe(200);
    const sessionId = created.body.session.id as string;
    expect(created.body.session.worktree).toMatchObject({
      branch: `happyclaw/${sessionId.replace(/-/g, '').slice(0, 8)}`,
      status: 'active',
      base_commit: git(repo, 'rev-parse', 'HEAD'),
    });
    const record = store.getSessionWorktree(sessionId)!;
    expect(record.worktree_path).toBe(
      path.join(ROOT, 'data', 'worktrees', folder, sessionId),
    );
    expect(fs.existsSync(path.join(record.worktree_path, 'README.md'))).toBe(
      true,
    );

    const sessions = await call(agentRoutes, `/${enc(jid)}/sessions`);
    expect(
      sessions.body.sessions.find((s: any) => s.id === sessionId).worktree
        .branch,
    ).toBe(record.branch);
    const agents = await call(agentRoutes, `/${enc(jid)}/agents`);
    expect(
      agents.body.agents.find((a: any) => a.id === sessionId).worktree.branch,
    ).toBe(record.branch);

    // A plain session in the same workspace has none.
    const plain = await createSession(jid, { name: 'plain' });
    expect(plain.body.session.worktree).toBeNull();
  });

  test('says when .worktreeinclude copied fewer files than it matched', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), 'env/\n');
    fs.writeFileSync(path.join(repo, '.worktreeinclude'), 'env/\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'include');
    fs.mkdirSync(path.join(repo, 'env'));
    for (let i = 0; i < 101; i++) {
      fs.writeFileSync(path.join(repo, 'env', `${i}.env`), `${i}\n`);
    }
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });

    const created = await createSession(jid, { worktree: true });
    expect(created.status).toBe(200);
    expect(created.body.session.worktree.include_incomplete).toEqual({
      reason: 'file_limit',
      copied_files: 100,
      skipped_files: [expect.stringMatching(/^env\/\d+\.env$/)],
    });
    const record = store.getSessionWorktree(created.body.session.id)!;
    expect(fs.readdirSync(path.join(record.worktree_path, 'env'))).toHaveLength(
      100,
    );
    const [skipped] = created.body.session.worktree.include_incomplete
      .skipped_files as string[];
    expect(fs.existsSync(path.join(record.worktree_path, skipped))).toBe(false);
    // Only the creation response carries it.
    const listed = await call(agentRoutes, `/${enc(jid)}/sessions`);
    expect(
      listed.body.sessions.find((s: any) => s.id === record.agent_id).worktree,
    ).not.toHaveProperty('include_incomplete');

    fs.rmSync(path.join(repo, 'env', '100.env'));
    const complete = await createSession(jid, { worktree: true });
    expect(complete.body.session.worktree.include_incomplete).toBeNull();
  });

  test('refuses container and non-git workspaces without creating a session', async () => {
    const container = seedWorkspace({ executionMode: 'container' });
    const refused = await createSession(container.jid, { worktree: true });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'WORKTREE_UNAVAILABLE',
      reason: 'container_mode',
    });
    expect(db.listAgentsByJid(container.jid)).toHaveLength(0);

    const plainDir = path.join(ROOT, `plain-${++seq}`);
    fs.mkdirSync(plainDir);
    const host = seedWorkspace({ executionMode: 'host', customCwd: plainDir });
    const notGit = await createSession(host.jid, { worktree: true });
    expect(notGit.body).toMatchObject({ reason: 'not_git_repo' });
    expect(db.listAgentsByJid(host.jid)).toHaveLength(0);

    const support = await call(
      gitRoutes,
      `/${enc(host.jid)}/git/worktree-support`,
    );
    expect(support.body).toEqual({
      available: false,
      reason: 'not_git_repo',
      message: '工作目录不是 git 仓库',
    });
  });

  test('a Host workspace still needs host permission', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({
      executionMode: 'host',
      customCwd: repo,
      owner: 'member-1',
    });
    asUser('member-1', 'member');
    const refused = await createSession(jid, { worktree: true });
    expect(refused.status).toBe(403);
    expect(db.listAgentsByJid(jid)).toHaveLength(0);
  });
});

describe('Review panel and file panel roots', () => {
  test('status and diff read the session worktree; the main session reads the repository', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const created = await createSession(jid, { worktree: true });
    const sessionId = created.body.session.id as string;
    const worktree = store.getSessionWorktree(sessionId)!;
    fs.writeFileSync(path.join(worktree.worktree_path, 'README.md'), 'hi\n');
    fs.writeFileSync(path.join(worktree.worktree_path, 'only-here.txt'), 'x\n');

    const status = await call(
      gitRoutes,
      `/${enc(jid)}/git/status?agentId=${sessionId}`,
    );
    expect(status.body).toMatchObject({
      state: 'ok',
      root: worktree.worktree_path,
      branch: worktree.branch,
      worktree: { branch: worktree.branch },
    });
    expect(status.body.files.map((f: any) => f.path).sort()).toEqual([
      'README.md',
      'only-here.txt',
    ]);

    const main = await call(gitRoutes, `/${enc(jid)}/git/status`);
    expect(main.body).toMatchObject({
      state: 'ok',
      root: repo,
      branch: 'main',
      files: [],
      worktree: null,
    });

    const diff = await call(
      gitRoutes,
      `/${enc(jid)}/git/diff?agentId=${sessionId}&path=README.md`,
    );
    expect(diff.body).toMatchObject({ state: 'ok', path: 'README.md' });
    expect(diff.body.diff).toContain('+hi');

    const escape = await call(
      gitRoutes,
      `/${enc(jid)}/git/diff?agentId=${sessionId}&path=${enc('../../../etc/passwd')}`,
    );
    expect(escape.status).toBe(400);
    const absolute = await call(
      gitRoutes,
      `/${enc(jid)}/git/diff?path=${enc('/etc/passwd')}`,
    );
    expect(absolute.status).toBe(400);

    const files = await call(
      fileRoutes,
      `/${enc(jid)}/files?agentId=${sessionId}`,
    );
    expect(files.body.files.map((f: any) => f.name)).toContain('only-here.txt');
    const mainFiles = await call(fileRoutes, `/${enc(jid)}/files`);
    expect(mainFiles.body.files.map((f: any) => f.name)).not.toContain(
      'only-here.txt',
    );

    // Committing in the worktree leaves working scope empty, while scope=branch
    // shows committed changes since base_commit and baseAhead=1.
    git(worktree.worktree_path, 'add', '.');
    git(worktree.worktree_path, 'commit', '-qm', 'worktree commit');

    const workingAfterCommit = await call(
      gitRoutes,
      `/${enc(jid)}/git/status?agentId=${sessionId}`,
    );
    expect(workingAfterCommit.body).toMatchObject({
      state: 'ok',
      baseCommit: worktree.base_commit,
      baseAhead: 1,
      files: [],
      total_files: 0,
    });

    const branchAfterCommit = await call(
      gitRoutes,
      `/${enc(jid)}/git/status?agentId=${sessionId}&scope=branch`,
    );
    expect(branchAfterCommit.body).toMatchObject({
      state: 'ok',
      baseCommit: worktree.base_commit,
      baseAhead: 1,
      scope: 'branch',
      total_files: 2,
    });
    expect(branchAfterCommit.body.files.map((f: any) => f.path).sort()).toEqual(
      ['README.md', 'only-here.txt'],
    );

    const branchDiff = await call(
      gitRoutes,
      `/${enc(jid)}/git/diff?agentId=${sessionId}&path=only-here.txt&scope=branch`,
    );
    expect(branchDiff.body).toMatchObject({
      state: 'ok',
      path: 'only-here.txt',
      untracked: false,
    });
    expect(branchDiff.body.diff).toContain('+x');
  });

  test('after merging main, the branch review shows only the session’s work', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const created = await createSession(jid, { worktree: true });
    const sessionId = created.body.session.id as string;
    const worktree = store.getSessionWorktree(sessionId)!;
    fs.writeFileSync(path.join(worktree.worktree_path, 'own.txt'), 'own\n');
    git(worktree.worktree_path, 'add', '.');
    git(worktree.worktree_path, 'commit', '-qm', 'session work');
    fs.writeFileSync(path.join(repo, 'upstream.txt'), 'upstream\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'upstream work');
    git(worktree.worktree_path, 'merge', '-q', '--no-edit', 'main');
    const mergeBase = git(worktree.worktree_path, 'rev-parse', 'main');

    const status = await call(
      gitRoutes,
      `/${enc(jid)}/git/status?agentId=${sessionId}&scope=branch`,
    );
    expect(status.body).toMatchObject({
      state: 'ok',
      baseCommit: mergeBase,
      baseAhead: 2,
      scope: 'branch',
    });
    expect(status.body.files.map((f: any) => f.path)).toEqual(['own.txt']);
    const upstream = await call(
      gitRoutes,
      `/${enc(jid)}/git/diff?agentId=${sessionId}&path=upstream.txt&scope=branch`,
    );
    expect(upstream.body).toMatchObject({ state: 'ok', diff: '' });
  });

  test('explains unsupported workspaces instead of failing', async () => {
    const container = seedWorkspace({ executionMode: 'container' });
    const status = await call(gitRoutes, `/${enc(container.jid)}/git/status`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      state: 'unavailable',
      reason: 'container_mode',
    });

    const plainDir = path.join(ROOT, `plain-${++seq}`);
    fs.mkdirSync(plainDir);
    const host = seedWorkspace({ executionMode: 'host', customCwd: plainDir });
    const notGit = await call(gitRoutes, `/${enc(host.jid)}/git/status`);
    expect(notGit.body).toMatchObject({ state: 'not_git_repo' });
  });

  test('a broken worktree reports itself instead of showing the main checkout', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const created = await createSession(jid, { worktree: true });
    const sessionId = created.body.session.id as string;
    fs.rmSync(store.getSessionWorktree(sessionId)!.worktree_path, {
      recursive: true,
      force: true,
    });
    const status = await call(
      gitRoutes,
      `/${enc(jid)}/git/status?agentId=${sessionId}`,
    );
    expect(status.body).toMatchObject({
      state: 'unavailable',
      reason: 'worktree_broken',
    });
  });

  test('follows workspace access: 404 for others, 403 without host permission', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    asUser('someone-else', 'admin');
    expect((await call(gitRoutes, `/${enc(jid)}/git/status`)).status).toBe(404);
    expect(
      (await call(gitRoutes, `/${enc(jid)}/git/diff?path=README.md`)).status,
    ).toBe(404);

    const memberHost = seedWorkspace({
      executionMode: 'host',
      customCwd: repo,
      owner: 'member-2',
    });
    asUser('member-2', 'member');
    expect(
      (await call(gitRoutes, `/${enc(memberHost.jid)}/git/status`)).status,
    ).toBe(403);

    asUser(ADMIN);
    expect(
      (await call(gitRoutes, `/${enc(jid)}/git/status?agentId=not-a-session`))
        .status,
    ).toBe(404);
    expect(
      (await call(fileRoutes, `/${enc(jid)}/files?agentId=not-a-session`))
        .status,
    ).toBe(404);
  });
});

describe('same-directory peers', () => {
  test('reports other running sessions in the same directory only', async () => {
    const repo = makeRepo();
    const a = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const b = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const shared = (await createSession(a.jid, { name: 'shared' })).body.session
      .id as string;
    const isolated = (await createSession(a.jid, { worktree: true })).body
      .session.id as string;
    const other = (await createSession(b.jid, { name: 'other' })).body.session
      .id as string;
    const foreign = seedWorkspace({
      executionMode: 'host',
      customCwd: repo,
      owner: 'admin-2',
    });
    db.createAgent({
      id: `foreign-${foreign.folder}`,
      group_folder: foreign.folder,
      chat_jid: foreign.jid,
      name: 'foreign',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'admin-2',
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
    queueGroups.push(
      {
        jid: `${a.jid}#agent:${shared}`,
        active: true,
        queryInFlight: true,
        groupFolder: a.folder,
      },
      {
        jid: `${b.jid}#agent:${other}`,
        active: true,
        queryInFlight: true,
        groupFolder: b.folder,
      },
      // A lane that is no session is no peer.
      { jid: b.jid, active: true, queryInFlight: true, groupFolder: b.folder },
      {
        jid: `${foreign.jid}#agent:foreign-${foreign.folder}`,
        active: true,
        queryInFlight: true,
        groupFolder: foreign.folder,
      },
      // A warm runner between turns is not running.
      {
        jid: `${a.jid}#agent:${isolated}`,
        active: true,
        queryInFlight: false,
        groupFolder: a.folder,
      },
    );

    const root = await call(gitRoutes, `/${enc(a.jid)}/workdir/peers`);
    expect(root.body.hidden_count).toBe(1);
    expect(root.body.peers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_jid: a.jid,
          kind: 'session',
          session_id: shared,
          session_name: 'shared',
        }),
        expect.objectContaining({
          workspace_jid: b.jid,
          kind: 'session',
          session_id: other,
        }),
      ]),
    );
    expect(root.body.peers).toHaveLength(2);

    // The running session itself is not its own peer.
    const self = await call(
      gitRoutes,
      `/${enc(a.jid)}/workdir/peers?agentId=${shared}`,
    );
    expect(self.body.peers.map((p: any) => p.session_id)).toEqual([other]);
    expect(self.body.peers.every((p: any) => p.kind === 'session')).toBe(true);

    // A worktree session works elsewhere.
    queueGroups.push({
      jid: `${a.jid}#agent:${isolated}`,
      active: true,
      queryInFlight: true,
      groupFolder: a.folder,
    });
    const isolatedPeers = await call(
      gitRoutes,
      `/${enc(a.jid)}/workdir/peers?agentId=${isolated}`,
    );
    expect(isolatedPeers.body).toEqual({ peers: [], hidden_count: 0 });
  });
});

describe('deleting worktree sessions', () => {
  test('uncommitted changes need confirmation; the branch and main checkout survive', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const sessionId = (await createSession(jid, { worktree: true })).body
      .session.id as string;
    const worktree = store.getSessionWorktree(sessionId)!;
    fs.writeFileSync(path.join(worktree.worktree_path, 'wip.txt'), 'wip\n');
    fs.writeFileSync(path.join(worktree.worktree_path, 'README.md'), 'x\n');

    const refused = await call(
      agentRoutes,
      `/${enc(jid)}/sessions/${sessionId}`,
      { method: 'DELETE' },
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'WORKTREE_DIRTY',
      dirty_worktrees: [
        { session_id: sessionId, branch: worktree.branch, changed_files: 2 },
      ],
    });
    expect(db.getAgent(sessionId)).toBeDefined();
    expect(fs.existsSync(worktree.worktree_path)).toBe(true);
    expect(stopGroup).not.toHaveBeenCalled();

    const forced = await call(
      agentRoutes,
      `/${enc(jid)}/sessions/${sessionId}?force_worktree=true`,
      { method: 'DELETE' },
    );
    expect(forced.status).toBe(200);
    expect(db.getAgent(sessionId)).toBeUndefined();
    expect(store.getSessionWorktree(sessionId)).toBeUndefined();
    expect(fs.existsSync(worktree.worktree_path)).toBe(false);
    expect(git(repo, 'branch', '--list', worktree.branch)).toContain(
      worktree.branch,
    );
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('an embedded repository, staged or not, needs confirmation', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const sessionId = (await createSession(jid, { worktree: true })).body
      .session.id as string;
    const worktree = store.getSessionWorktree(sessionId)!;
    const nested = path.join(worktree.worktree_path, 'nested');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');
    git(nested, 'commit', '-q', '--allow-empty', '-m', 'nested');
    const deleteSession = () =>
      call(agentRoutes, `/${enc(jid)}/sessions/${sessionId}`, {
        method: 'DELETE',
      });

    git(worktree.worktree_path, 'add', 'nested');
    const staged = await deleteSession();
    expect(staged.status).toBe(409);
    expect(staged.body).toMatchObject({
      code: 'WORKTREE_DIRTY',
      dirty_worktrees: [{ session_id: sessionId, changed_files: 1 }],
    });

    // Committed gitlink, then a commit that exists only in the nested repo.
    git(worktree.worktree_path, 'commit', '-qm', 'embed');
    git(nested, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const unstaged = await deleteSession();
    expect(unstaged.status).toBe(409);
    expect(unstaged.body.dirty_worktrees).toMatchObject([
      { session_id: sessionId, changed_files: 1 },
    ]);
    expect(db.getAgent(sessionId)).toBeDefined();
    expect(fs.existsSync(path.join(nested, '.git'))).toBe(true);

    // Committed and unchanged: the nested history still lives in the worktree.
    git(worktree.worktree_path, 'add', 'nested');
    git(worktree.worktree_path, 'commit', '-qm', 'bump');
    const committed = await deleteSession();
    expect(committed.status).toBe(409);
    expect(committed.body).toMatchObject({
      error: expect.stringContaining('包含嵌入的 git 仓库'),
      dirty_worktrees: [
        { session_id: sessionId, changed_files: 0, embedded_repos: true },
      ],
    });
    expect(fs.existsSync(path.join(nested, '.git'))).toBe(true);
  });

  test('moving a chat off a worktree session leaves the batch waiting for its retry behind', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const doomed = (await createSession(jid, { worktree: true })).body.session
      .id as string;
    const target = (await createSession(jid, { name: 'target' })).body.session
      .id as string;
    const chatJid = `telegram:${9000 + ++seq}`;
    db.setRegisteredGroup(chatJid, {
      name: 'Chat',
      folder: 'chat',
      added_at: new Date().toISOString(),
      created_by: ADMIN,
      target_agent_id: doomed,
    } as any);
    const doomedLane = `${jid}#agent:${doomed}`;
    db.ensureChatExists(doomedLane);
    const store = (id: string, timestamp: string) =>
      db.storeMessageDirect(
        id,
        doomedLane,
        'tg:user',
        'User',
        `text ${id}`,
        timestamp,
        false,
        { sourceJid: chatJid },
      );
    // A batch of two failed; its turn (for the last input) waits for its retry.
    store('batch-first', '2026-11-01T09:59:00.000Z');
    store('retry-failed', '2026-11-01T10:00:00.000Z');
    store('after-retry', '2026-11-01T10:01:00.000Z');
    const { run } = reliability.createChannelTurnRun({
      provider: 'telegram',
      accountId: 'test-account',
      sourceJid: chatJid,
      idempotencyKey: `turn-${doomed}`,
      agentId: doomed,
      correlationId: 'retry-failed',
    });
    const claim = reliability.claimChannelTurnRunById(run.id, 'owner', 60_000)!;
    expect(
      reliability.retryChannelTurnRun(claim, {
        availableAt: '2099-01-01T00:00:00.000Z',
        error: 'attempt failed',
      }),
    ).toBe(true);

    const deleted = await call(
      agentRoutes,
      `/${enc(jid)}/sessions/${doomed}?confirm_bindings=true&rebind_to=${target}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    expect(db.getRegisteredGroup(chatJid)?.target_agent_id).toBe(target);
    expect(
      db
        .getMessagesSince(`${jid}#agent:${target}`, { timestamp: '', id: '' })
        .map((message) => message.id),
    ).toEqual(['after-retry']);
    expect(reliability.getChannelTurnRun(run.id)?.status).toBe('cancelled');
    db.deleteRegisteredGroup(chatJid);
  });

  test('a clean worktree goes with the legacy /agents delete', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const created = await call(agentRoutes, `/${enc(jid)}/agents`, {
      method: 'POST',
      body: { worktree: true },
    });
    expect(created.status).toBe(200);
    const agentId = created.body.agent.id as string;
    const worktree = store.getSessionWorktree(agentId)!;
    expect(created.body.agent.worktree.branch).toBe(worktree.branch);
    const deleted = await call(agentRoutes, `/${enc(jid)}/agents/${agentId}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(fs.existsSync(worktree.worktree_path)).toBe(false);
    expect(git(repo, 'branch', '--list', worktree.branch)).toContain(
      worktree.branch,
    );
  });

  test('deleting the workspace removes its worktrees after confirmation', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const sessionId = (await createSession(jid, { worktree: true })).body
      .session.id as string;
    const worktree = store.getSessionWorktree(sessionId)!;
    fs.writeFileSync(path.join(worktree.worktree_path, 'wip.txt'), 'wip\n');

    const refused = await call(groupRoutes, `/${enc(jid)}`, {
      method: 'DELETE',
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'WORKTREE_DIRTY',
      dirty_worktrees: [
        { session_id: sessionId, branch: worktree.branch, changed_files: 1 },
      ],
    });
    expect(db.getRegisteredGroup(jid)).toBeDefined();
    // Forcing without naming what was confirmed confirms nothing.
    const unnamed = await call(
      groupRoutes,
      `/${enc(jid)}?force_worktrees=true`,
      {
        method: 'DELETE',
      },
    );
    expect(unnamed.status).toBe(409);

    const forced = await call(
      groupRoutes,
      `/${enc(jid)}?force_worktrees=true&confirmed_worktrees=${sessionId}`,
      { method: 'DELETE' },
    );
    expect(forced.status).toBe(200);
    expect(db.getRegisteredGroup(jid)).toBeUndefined();
    expect(store.getSessionWorktree(sessionId)).toBeUndefined();
    expect(fs.existsSync(worktree.worktree_path)).toBe(false);
    expect(fs.existsSync(path.dirname(worktree.worktree_path))).toBe(false);
    expect(git(repo, 'branch', '--list', worktree.branch)).toContain(
      worktree.branch,
    );
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe(
      'hello\n',
    );
  });

  test('rebuilding the workspace removes its worktrees after confirmation', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const sessionId = (await createSession(jid, { worktree: true })).body
      .session.id as string;
    const worktree = store.getSessionWorktree(sessionId)!;
    fs.writeFileSync(path.join(worktree.worktree_path, 'wip.txt'), 'wip\n');

    // Automations outlive the rebuild; one bound to the removed session pauses.
    const runtime = automationHarness.createFakeRuntime();
    const sessionJid = `${jid}#agent:${sessionId}`;
    runtime.sessions.add(sessionJid);
    const { service } = createAutomationCore(runtime.deps);
    setAutomationRuntimeService(service);
    onTestFinished(() => setAutomationRuntimeService(null));
    const actor = { kind: 'web', userId: ADMIN, isAdmin: true } as const;
    const manual = { schedule: { kind: 'manual' as const } };
    const workspaceLevel = service.create(actor, {
      workspaceJid: jid,
      ...automationHarness.draft(manual),
    });
    const bound = service.create(actor, {
      workspaceJid: jid,
      ...automationHarness.draft({ ...manual, sessionMode: 'bound' }),
      targetSessionJid: sessionJid,
    });

    const refused = await call(groupRoutes, `/${enc(jid)}/clear-history`, {
      method: 'POST',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('WORKTREE_DIRTY');
    expect(db.getAgent(sessionId)).toBeDefined();

    const forced = await call(
      groupRoutes,
      `/${enc(jid)}/clear-history?force_worktrees=true&confirmed_worktrees=${sessionId}`,
      { method: 'POST' },
    );
    expect(forced.status).toBe(200);
    expect(db.getAgent(sessionId)).toBeUndefined();
    expect(automationStore.getAutomation(workspaceLevel.id)?.status).toBe(
      'active',
    );
    expect(automationStore.getAutomation(bound.id)).toMatchObject({
      status: 'paused',
      statusReason: '绑定的会话已删除',
    });
    expect(fs.existsSync(worktree.worktree_path)).toBe(false);
    expect(git(repo, 'branch', '--list', worktree.branch)).toContain(
      worktree.branch,
    );
    // The custom directory itself is never part of a rebuild.
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe(
      'hello\n',
    );
  });

  test.each([
    ['deleting', (jid: string) => `/${enc(jid)}`, 'DELETE'],
    ['rebuilding', (jid: string) => `/${enc(jid)}/clear-history`, 'POST'],
  ] as const)(
    '%s the workspace: work that appears while runners stop asks again',
    async (_label, route, method) => {
      const repo = makeRepo();
      const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
      const confirmed = (await createSession(jid, { worktree: true })).body
        .session.id as string;
      const late = (await createSession(jid, { worktree: true })).body.session
        .id as string;
      const lateWorktree = store.getSessionWorktree(late)!;
      fs.writeFileSync(
        path.join(store.getSessionWorktree(confirmed)!.worktree_path, 'wip'),
        'wip\n',
      );
      // The session's runner writes its last file while it is being stopped.
      stopGroup.mockImplementationOnce(async () => {
        fs.writeFileSync(path.join(lateWorktree.worktree_path, 'late'), 'x\n');
      });
      const queue = webContext.getWebDeps()!.queue as any;

      const again = await call(
        groupRoutes,
        `${route(jid)}?force_worktrees=true&confirmed_worktrees=${confirmed}`,
        { method },
      );
      expect(again.status).toBe(409);
      expect(
        again.body.dirty_worktrees.map((item: any) => item.session_id).sort(),
      ).toEqual([confirmed, late].sort());
      expect(fs.existsSync(path.join(lateWorktree.worktree_path, 'late'))).toBe(
        true,
      );
      // Refused after the stop: every stop kept its queue, and the pause was
      // released so that work resumes.
      expect(stopGroup.mock.calls.length).toBeGreaterThan(0);
      for (const [, options] of stopGroup.mock.calls as any[]) {
        expect(options).toMatchObject({ preserveQueuedWork: true });
      }
      expect(queue.resumeGroupsAfterMutation).toHaveBeenCalledTimes(1);
      expect(queue.discardGroupsAfterMutation).not.toHaveBeenCalled();
      stopGroup.mockClear();

      const both = await call(
        groupRoutes,
        `${route(jid)}?force_worktrees=true&confirmed_worktrees=${confirmed},${late}`,
        { method },
      );
      expect(both.status).toBe(200);
      expect(fs.existsSync(lateWorktree.worktree_path)).toBe(false);
      if (method === 'DELETE') {
        // A committed delete drops everything the pause kept.
        expect(queue.discardGroupsAfterMutation).toHaveBeenCalledTimes(1);
      } else {
        // A rebuild drops the work queued before it, as a plain stop does;
        // what arrives during it runs against the fresh workspace.
        expect(
          (stopGroup.mock.calls as any[]).some(
            ([, options]) => !options?.preserveQueuedWork,
          ),
        ).toBe(true);
      }
    },
  );
});

describe('workspace settings', () => {
  test('cannot switch to Docker while sessions own worktrees', async () => {
    const repo = makeRepo();
    const { jid } = seedWorkspace({ executionMode: 'host', customCwd: repo });
    await createSession(jid, { worktree: true });
    const refused = await call(groupRoutes, `/${enc(jid)}`, {
      method: 'PATCH',
      body: { execution_mode: 'container' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('WORKTREE_SESSIONS_EXIST');
    expect(db.getRegisteredGroup(jid)?.executionMode).toBe('host');
  });

  test('creating a workspace on a directory already in use warns without blocking', async () => {
    const repo = makeRepo();
    const existing = seedWorkspace({ executionMode: 'host', customCwd: repo });
    const created = await call(groupRoutes, '/', {
      method: 'POST',
      body: { name: 'Second', execution_mode: 'host', custom_cwd: repo },
    });
    expect(created.status).toBe(200);
    expect(created.body.warnings).toEqual([
      expect.objectContaining({
        code: 'shared_custom_cwd',
        workspaces: [
          { jid: existing.jid, name: `Workspace ${existing.folder}` },
        ],
      }),
    ]);

    const other = path.join(ROOT, `fresh-${++seq}`);
    fs.mkdirSync(other);
    const unique = await call(groupRoutes, '/', {
      method: 'POST',
      body: { name: 'Third', execution_mode: 'host', custom_cwd: other },
    });
    expect(unique.status).toBe(200);
    expect(unique.body.warnings).toEqual([]);
  });
});
