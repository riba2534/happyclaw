import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

// A Web send to an idle session awaits its plugin expansion before piping.
// Meanwhile another channel can start a turn on the same runner and the
// runner can be retired (a team-mode work item approval calls
// retireRunnerAfterQuery through drainLane; install_skill's self-mutation
// uses closeAfterQuery). The Web send then gets no_active and must not end
// that other turn.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-conv-retire-'));
const dataDir = path.join(root, 'data');
const expansion = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: dataDir,
  GROUPS_DIR: path.join(dataDir, 'groups'),
  STORE_DIR: path.join(dataDir, 'db'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/plugin-expander-core.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  expandPluginSlashCommandIfNeeded: expansion.run,
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'owner',
      username: 'owner',
      display_name: 'Owner',
      role: 'admin',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const { GroupQueue } = await import('../src/group-queue.js');
const { createAppForTest } = await import('../src/web.js');
const { sessionIpcDir } = await import('../src/utils.js');
const folder = 'conv-retire';
const workspaceJid = `web:${folder}`;
const agentId = '11111111-2222-4333-8444-555555555555';
const laneJid = `${workspaceJid}#agent:${agentId}`;
const closeFile = path.join(sessionIpcDir(folder, agentId), 'input', '_close');

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  db.initDatabase();
  db.setRegisteredGroup(workspaceJid, {
    name: 'Workspace',
    folder,
    added_at: '2026-11-02',
    executionMode: 'host',
    created_by: 'owner',
  });
  db.createAgent({
    id: agentId,
    group_folder: folder,
    chat_jid: workspaceJid,
    name: 'Session',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'owner',
    created_at: '2026-11-02',
    completed_at: null,
    result_summary: null,
  });
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a runner retired during Web plugin expansion finishes the other turn before the cold start', async () => {
  const queue = new GroupQueue();
  queue.setHostModeChecker(() => true);
  let finishRunner!: () => void;
  queue.enqueueTask(
    laneJid,
    'warm-runner',
    () => new Promise<void>((resolve) => (finishRunner = resolve)),
  );
  const kill = vi.fn();
  queue.registerProcess(laneJid, { kill } as never, {
    containerName: null,
    groupFolder: folder,
    agentId,
  });
  queue.markRunnerQueryIdle(laneJid);
  const coldStart = vi.fn(async () => true);
  const app = createAppForTest({
    queue,
    processAgentConversation: coldStart,
    getLastAgentTimestamp: () => ({}),
    setLastAgentTimestamp: () => {},
    getRegisteredGroups: () => ({}),
    formatMessages: () => 'prepared prompt',
    advanceNextPullCursorOnly: () => {},
  } as unknown as Parameters<typeof createAppForTest>[0]);
  let finishExpansion!: () => void;
  const started = new Promise<void>((expansionStarted) => {
    expansion.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishExpansion = () => resolve({ kind: 'miss' });
          expansionStarted();
        }),
    );
  });
  let request: Promise<Response> | undefined;
  try {
    request = app.request('/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatJid: workspaceJid,
        agentId,
        content: '/slow-plugin',
      }),
    });
    await started;
    expect(queue.sendMessage(laneJid, 'another channel input')).toBe('sent');
    const otherTurn = queue.getActiveQueryId(laneJid);
    queue.retireRunnerAfterQuery(laneJid);
    finishExpansion();
    expect((await request).status).toBe(200);

    expect(queue.getActiveQueryId(laneJid)).toBe(otherTurn);
    expect(fs.existsSync(closeFile)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(coldStart).not.toHaveBeenCalled();

    queue.markRunnerQueryIdle(laneJid);
    expect(fs.existsSync(closeFile)).toBe(true);
    finishRunner();
    await new Promise((resolve) => setImmediate(resolve));
    expect(coldStart).toHaveBeenCalledOnce();
  } finally {
    finishExpansion?.();
    finishRunner?.();
    await request;
    await new Promise((resolve) => setImmediate(resolve));
  }
});
