/**
 * Deleting a Runtime Session that owns a worktree, against a real GroupQueue:
 * only that session's lane is held while its worktree is checked again, so
 * the workspace's other sessions keep running, before and after; a refused
 * delete releases the lane with its work intact, and a completed one drops
 * that lane's work through its own discard hook only.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'session-delete-hold-')),
  );
  const dataDir = path.join(paths.root, 'data');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
    MOUNT_ALLOWLIST_PATH: path.join(paths.root, 'no-mount-allowlist.json'),
    isDockerAvailable: () => false,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'admin-1',
      username: 'admin-1',
      role: 'admin',
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
const worktrees = await import('../src/session-worktree.js');
const webContext = await import('../src/web-context.js');
const { GroupQueue } = await import('../src/group-queue.js');
const agentRoutes = (await import('../src/routes/agents.js')).default;
const groupRoutes = (await import('../src/routes/groups.js')).default;
const runtimeState = await import('../src/runtime-state-store.js');
const usageLimitWait = await import('../src/usage-limit-wait.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

let seq = 0;

/** A Host workspace on a real repository, served by a real GroupQueue. */
async function workspace() {
  const id = `ws-${++seq}`;
  const jid = `web:${id}`;
  const repo = path.join(paths.root, `repo-${seq}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  db.setRegisteredGroup(jid, {
    name: id,
    folder: id,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    customCwd: repo,
    created_by: 'admin-1',
    is_home: false,
  } as any);

  const queue = new GroupQueue();
  // As index.ts: each session has its own lane, the workspace another.
  queue.setSerializationKeyResolver((groupJid: string) => {
    const agentSep = groupJid.indexOf('#agent:');
    if (agentSep >= 0) return `${id}#${groupJid.slice(agentSep + 7)}`;
    return groupJid === jid ? id : groupJid;
  });
  /** Another session of the workspace that keeps taking work. */
  const peer = `${jid}#agent:peer`;
  const runs: string[] = [];
  /** A lane whose next run stays up until the queue closes it. */
  const busy = new Map<string, { exited: ReturnType<typeof deferred> }>();
  const runHooks: Array<(groupJid: string) => void> = [];
  let taskSeq = 0;
  /** Queue one turn on `lane`, as the host does for a session's input. */
  const enqueue = (lane: string) =>
    queue.enqueueTask(lane, `turn-${++taskSeq}`, async () => {
      runs.push(lane);
      for (const hook of runHooks) hook(lane);
      const hold = busy.get(lane);
      if (hold) {
        busy.delete(lane);
        queue.registerProcess(lane, {} as never, {
          containerName: null,
          groupFolder: id,
          agentId: lane.split('#agent:')[1],
        });
        await hold.exited.promise;
      }
      return true;
    });
  const closed: string[] = [];
  const onClose = new Map<string, () => void>();
  vi.spyOn(queue, 'closeStdin').mockImplementation((groupJid: string) => {
    closed.push(groupJid);
    onClose.get(groupJid)?.();
  });
  const discarded: string[] = [];
  queue.setOnLaneDiscarded((groupJid) => discarded.push(groupJid));
  webContext.setWebDeps({
    getRegisteredGroups: () => db.getAllRegisteredGroups(),
    getSessions: () => ({}),
    setLastAgentTimestamp: vi.fn(),
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
    broadcastNewMessage: vi.fn(),
    queue,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

  const createSession = async () => {
    const response = await agentRoutes.request(
      `/${encodeURIComponent(jid)}/sessions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worktree: true }),
      },
    );
    const id = ((await response.json()) as any).session.id as string;
    return { id, lane: `${jid}#agent:${id}` };
  };
  const deleteSession = (
    sessionId: string,
    route: 'sessions' | 'agents' = 'sessions',
  ) =>
    agentRoutes.request(`/${encodeURIComponent(jid)}/${route}/${sessionId}`, {
      method: 'DELETE',
    });
  /** Start a run on `lane` that lasts until `exit` resolves. */
  const keepBusyUntil = async (lane: string, exit: Promise<void>) => {
    const exited = deferred();
    busy.set(lane, { exited });
    void exit.then(exited.resolve);
    enqueue(lane);
    await settle();
  };
  /** Start a run on `lane` that lasts until the queue closes it. */
  const keepBusy = async (lane: string, onStop: () => void = () => {}) => {
    const exited = deferred();
    busy.set(lane, { exited });
    onClose.set(lane, () => {
      onStop();
      exited.resolve();
    });
    enqueue(lane);
    await settle();
  };
  return {
    jid,
    peer,
    queue,
    enqueue,
    runs,
    closed,
    discarded,
    createSession,
    deleteSession,
    keepBusy,
    keepBusyUntil,
    onRun: (hook: (groupJid: string) => void) => runHooks.push(hook),
    onClose: (lane: string, hook: () => void) => onClose.set(lane, hook),
  };
}

beforeAll(() => {
  fs.mkdirSync(path.join(paths.root, 'data', 'db'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

describe('deleting a worktree session holds only its own lane', () => {
  test('the other sessions keep running, during and after', async () => {
    const ws = await workspace();
    const doomed = await ws.createSession();
    const other = await ws.createSession();
    const pausedDuringStop: Record<string, boolean> = {};
    // While the doomed session's runner is being stopped, the rest of the
    // workspace takes new work.
    await ws.keepBusy(doomed.lane, () => {
      for (const lane of [doomed.lane, ws.peer, other.lane]) {
        pausedDuringStop[lane] = ws.queue.isGroupMutationPaused(lane);
      }
      ws.enqueue(ws.peer);
      ws.enqueue(other.lane);
    });
    ws.runs.length = 0;

    const deleted = await ws.deleteSession(doomed.id);
    expect(deleted.status).toBe(200);
    await settle();
    expect(pausedDuringStop).toEqual({
      [doomed.lane]: true,
      [ws.peer]: false,
      [other.lane]: false,
    });
    // Work that arrived while the doomed session was being stopped ran.
    expect(ws.runs.sort()).toEqual([ws.peer, other.lane].sort());
    // Only the deleted session's lane went through its discard hook.
    expect(ws.discarded).toContain(doomed.lane);
    expect(ws.discarded).not.toContain(ws.peer);
    expect(ws.discarded).not.toContain(other.lane);

    ws.runs.length = 0;
    ws.enqueue(ws.peer);
    ws.enqueue(other.lane);
    await settle();
    expect(ws.runs.sort()).toEqual([ws.peer, other.lane].sort());
  });

  test.each(['sessions', 'agents'] as const)(
    'a delete through /%s refused after the stop releases the lane with its work',
    async (route) => {
      const ws = await workspace();
      const session = await ws.createSession();
      const worktree = store.getSessionWorktree(session.id)!;
      // Clean at the first check; the runner's last write lands as it stops.
      await ws.keepBusy(session.lane, () => {
        fs.writeFileSync(path.join(worktree.worktree_path, 'late.txt'), 'x\n');
      });
      ws.runs.length = 0;

      const refused = await ws.deleteSession(session.id, route);
      expect(refused.status).toBe(409);
      await settle();
      expect(db.getAgent(session.id)).toBeDefined();
      expect(fs.existsSync(path.join(worktree.worktree_path, 'late.txt'))).toBe(
        true,
      );
      // The interrupted input waited and runs again once the lane is released;
      // nothing was discarded.
      expect(ws.runs).toEqual([session.lane]);
      expect(ws.discarded).toEqual([]);

      ws.runs.length = 0;
      ws.enqueue(session.lane);
      ws.enqueue(ws.peer);
      await settle();
      expect(ws.runs.sort()).toEqual([session.lane, ws.peer].sort());
    },
  );

  test('a delete that fails after the worktree is gone still releases the lane', async () => {
    const ws = await workspace();
    const session = await ws.createSession();
    // Not running or idle: no plain stop comes first, only the held lane's
    // own discard drops its work.
    db.updateAgentStatus(session.id, 'error', 'earlier failure');
    const failing = vi.spyOn(db, 'deleteSession').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    try {
      const response = await ws.deleteSession(session.id);
      expect(response.status).toBe(500);
    } finally {
      failing.mockRestore();
    }
    // The session row survived but its worktree is gone: it can no longer
    // run anywhere, least of all in the main checkout.
    expect(db.getAgent(session.id)).toBeDefined();
    // Checking it again keeps the reason it was given.
    expect(worktrees.resolveSessionWorkingDirectory(session.id)).toMatchObject({
      kind: 'broken',
      reason: 'worktree removed with its session',
    });
    expect(store.getSessionWorktree(session.id)?.broken_reason).toBe(
      'worktree removed with its session',
    );
    // The lane is not left held: it was dropped like a deleted session's.
    expect(ws.discarded).toContain(session.lane);
    expect(ws.queue.isGroupMutationPaused(session.lane)).toBe(false);
    ws.enqueue(ws.peer);
    await settle();
    expect(ws.runs).toContain(ws.peer);

    // Deleting again finishes the job.
    expect((await ws.deleteSession(session.id)).status).toBe(200);
    expect(db.getAgent(session.id)).toBeUndefined();
    expect(store.getSessionWorktree(session.id)).toBeUndefined();
  });

  test('a stop that fails releases the lane with the session intact', async () => {
    const ws = await workspace();
    const session = await ws.createSession();
    vi.spyOn(ws.queue, 'stopGroup').mockRejectedValueOnce(
      new Error('runner would not stop'),
    );
    const failed = await ws.deleteSession(session.id, 'agents');
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as any).code).toBe('WORKTREE_REMOVE_FAILED');
    expect(db.getAgent(session.id)).toBeDefined();
    expect(store.getSessionWorktree(session.id)?.status).toBe('active');
    expect(ws.queue.isGroupMutationPaused(session.lane)).toBe(false);
    expect(ws.discarded).toEqual([]);
    ws.enqueue(session.lane);
    await settle();
    expect(ws.runs).toEqual([session.lane]);
  });

  test('another session finishing its turn during the hold drains its queue at once', async () => {
    const ws = await workspace();
    const session = await ws.createSession();
    const peerExit = deferred();
    const sessionExit = deferred();
    await ws.keepBusyUntil(ws.peer, peerExit.promise);
    await ws.keepBusyUntil(session.lane, sessionExit.promise);
    // Asked to close, the session's runner keeps going until the peer has run
    // again: a follow-up for the peer queued behind its busy runner, whose
    // turn then ended while the session's lane is held.
    ws.onClose(session.lane, () => {
      ws.enqueue(ws.peer);
      peerExit.resolve();
    });
    let heldWhenPeerRan: boolean | undefined;
    ws.onRun((jid) => {
      if (jid !== ws.peer) return;
      heldWhenPeerRan = ws.queue.isGroupMutationPaused(session.lane);
      sessionExit.resolve();
    });
    const fallback = setTimeout(() => sessionExit.resolve(), 2000);
    ws.runs.length = 0;

    const deleted = await ws.deleteSession(session.id);
    clearTimeout(fallback);
    expect(deleted.status).toBe(200);
    expect(heldWhenPeerRan).toBe(true);
    expect(ws.runs).toEqual([ws.peer]);
  });
});

describe('deleting a whole workspace', () => {
  test('every lane goes through its discard hook, so usage-limit waits end', async () => {
    const ws = await workspace();
    const session = await ws.createSession();
    // A Feishu group of the same workspace, rerouted by the delete.
    const imJid = 'feishu:oc_rerouted';
    db.setRegisteredGroup(imJid, {
      name: 'Rerouted group',
      folder: db.getRegisteredGroup(ws.jid)!.folder,
      added_at: new Date().toISOString(),
      created_by: 'admin-1',
    } as any);
    // As main() wires it: a discarded lane ends its usage-limit wait.
    ws.queue.setOnLaneDiscarded((jid) => {
      ws.discarded.push(jid);
      usageLimitWait.endUsageLimitWait(jid, 'discarded');
    });
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    for (const scopeKey of [imJid, session.lane]) {
      runtimeState.reserveUsageLimitWait({
        scopeKey,
        inputKey: `input-${scopeKey}`,
        resetAt: later,
        resumeAt: later,
        maxWaits: 3,
      });
    }

    const deleted = await groupRoutes.request(
      `/${encodeURIComponent(ws.jid)}?unbind_channels=true`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    expect(ws.discarded).toEqual(expect.arrayContaining([ws.jid, imJid]));
    // The rerouted group's wait ends (and with it its parked input) instead
    // of resuming on the new route; the deleted session's goes with its rows.
    expect(runtimeState.getUsageLimitWait(imJid)).toBeNull();
    expect(runtimeState.getUsageLimitWait(session.lane)).toBeNull();
  });

  test('a rebuild ends the waits of the work it drops, too', async () => {
    const ws = await workspace();
    const imJid = 'feishu:oc_rebuilt';
    db.setRegisteredGroup(imJid, {
      name: 'Rebuilt group',
      folder: db.getRegisteredGroup(ws.jid)!.folder,
      added_at: new Date().toISOString(),
      created_by: 'admin-1',
    } as any);
    ws.queue.setOnLaneDiscarded((jid) => {
      ws.discarded.push(jid);
      usageLimitWait.endUsageLimitWait(jid, 'discarded');
    });
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    runtimeState.reserveUsageLimitWait({
      scopeKey: imJid,
      inputKey: 'input-im',
      resetAt: later,
      resumeAt: later,
      maxWaits: 3,
    });

    const rebuilt = await groupRoutes.request(
      `/${encodeURIComponent(ws.jid)}/clear-history`,
      { method: 'POST' },
    );
    expect(rebuilt.status).toBe(200);
    expect(ws.discarded).toEqual(expect.arrayContaining([ws.jid, imJid]));
    expect(runtimeState.getUsageLimitWait(imJid)).toBeNull();
    // The workspace itself lives on and its sessions take new work.
    ws.runs.length = 0;
    ws.enqueue(ws.peer);
    await settle();
    expect(ws.runs).toEqual([ws.peer]);
  });
});
