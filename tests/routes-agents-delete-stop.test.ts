/**
 * DELETE /:jid/agents/:agentId and DELETE /:jid/sessions/:sessionId stop a
 * live runner once the deletion has committed. The stop must be forced and
 * awaited: a runner's final frame can still call setSession() while it is in
 * flight, and must not leave a ghost `sessions` / `workspace_runtime_sessions`
 * row or its directories behind; a failing stop must not go unhandled.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// vi.mock factories run lazily on the first import below, after this line.
const tmpDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-agents-delete-stop-'),
);
process.env.HAPPYCLAW_DELETE_STOP_TEST_DATA_DIR = tmpDataDir;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_DELETE_STOP_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
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

vi.mock('../src/web.js', () => ({
  broadcastAgentStatus: () => {},
  broadcastAgentRemoved: () => {},
}));

const agentRoutes = (await import('../src/routes/agents.js')).default;
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const OWNER_ID = 'alice';
const GROUP_JID = 'web:agents-delete-stop';
const GROUP_FOLDER = 'agents-delete-stop';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const stopGroup =
  vi.fn<(jid: string, opts?: { force?: boolean }) => Promise<void>>();

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Agents Delete Stop',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  stopGroup.mockReset();
  webContext.setWebDeps({
    getRegisteredGroups: () => ({}),
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
    queue: { stopGroup },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

const routes = [
  { label: 'DELETE /:jid/agents/:agentId', segment: 'agents', kind: 'task' },
  {
    label: 'DELETE /:jid/sessions/:sessionId',
    segment: 'sessions',
    kind: 'conversation',
  },
] as const;

function agentDirs(id: string): string[] {
  return [
    path.join(tmpDataDir, 'ipc', GROUP_FOLDER, 'agents', id),
    path.join(tmpDataDir, 'sessions', GROUP_FOLDER, 'agents', id),
  ];
}

/** A running agent with an SDK session, its runtime projection and dirs. */
function seedRunningAgent(kind: 'task' | 'conversation'): string {
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.createAgent({
    id,
    group_folder: GROUP_FOLDER,
    chat_jid: GROUP_JID,
    name: 'Running agent',
    prompt: '',
    status: 'running',
    kind,
    created_by: OWNER_ID,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
  db.setSession(GROUP_FOLDER, 'sdk-session-before', id);
  for (const dir of agentDirs(id)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'marker'), 'x');
  }
  expect(db.getSession(GROUP_FOLDER, id)).toBe('sdk-session-before');
  expect(db.getWorkspaceRuntimeSession(GROUP_FOLDER, id)).toBeDefined();
  return id;
}

async function deleteRoute(
  segment: string,
  id: string,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/${segment}/${id}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe.each(routes)('$label', ({ segment, kind }) => {
  test('awaits a forced stop after the delete; a late setSession leaves no ghost', async () => {
    const id = seedRunningAgent(kind);
    const stop = deferred();
    stopGroup.mockImplementation(() => stop.promise);

    let settled = false;
    const pending = deleteRoute(segment, id).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(stopGroup).toHaveBeenCalledTimes(1));
    expect(stopGroup).toHaveBeenCalledWith(`${GROUP_JID}#agent:${id}`, {
      force: true,
    });
    // The deletion committed before the stop; the route waits for the stop.
    expect(db.getAgent(id)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    // The runner's final frame lands while the stop is still in flight.
    db.setSession(GROUP_FOLDER, 'sdk-session-final-frame', id);
    for (const dir of agentDirs(id)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'late'), 'x');
    }
    stop.resolve();

    const res = await pending;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.getAgent(id)).toBeUndefined();
    expect(db.getSession(GROUP_FOLDER, id)).toBeUndefined();
    expect(db.getWorkspaceRuntimeSession(GROUP_FOLDER, id)).toBeUndefined();
    for (const dir of agentDirs(id)) expect(fs.existsSync(dir)).toBe(false);
  });

  test('a stop that fails after the delete is handled; the deletion stands', async () => {
    const id = seedRunningAgent(kind);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      stopGroup.mockRejectedValue(new Error('runner refused to exit'));

      const res = await deleteRoute(segment, id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(stopGroup).toHaveBeenCalledWith(`${GROUP_JID}#agent:${id}`, {
        force: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(db.getAgent(id)).toBeUndefined();
      expect(db.getSession(GROUP_FOLDER, id)).toBeUndefined();
      for (const dir of agentDirs(id)) expect(fs.existsSync(dir)).toBe(false);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
