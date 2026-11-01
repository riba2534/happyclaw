/**
 * The Web `/fresh` handoff snapshots the directory the conversation works in:
 * a session's own worktree, not the workspace's custom directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const ROOT =
  process.env.HAPPYCLAW_WEB_FRESH_TEST_DIR ??
  (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-fresh-worktree-'));
    process.env.HAPPYCLAW_WEB_FRESH_TEST_DIR = dir;
    return dir;
  })();

const snapshots = vi.hoisted(() => ({ dirs: [] as string[] }));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = path.join(process.env.HAPPYCLAW_WEB_FRESH_TEST_DIR!, 'data');
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
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
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
  };
});
vi.mock('../src/fresh-window.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    captureWorkspaceSnapshot: async (dir: string) => {
      snapshots.dirs.push(dir);
      return { available: false, reason: 'test' };
    },
  };
});
vi.mock('../src/commands.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, executeFreshWindowReset: async () => {} };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const store = await import('../src/session-worktree-store.js');

const JID = 'web:fresh-worktree';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const PLAIN_SESSION_ID = '11111111-2222-4333-8444-666666666666';
const FOLDER = 'fresh-worktree';
const CUSTOM_CWD = path.join(ROOT, 'repo');
const WORKTREE = path.join(ROOT, 'data', 'worktrees', FOLDER, SESSION_ID);

const app = web.createAppForTest({
  queue: { stopGroup: async () => {}, getActiveQueryId: () => null },
  getSessions: () => ({}),
  setLastAgentTimestamp: () => {},
  getRegisteredGroups: () => ({}),
  advanceGlobalCursor: () => {},
} as unknown as Parameters<typeof web.createAppForTest>[0]);

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, 'data', 'db'), { recursive: true });
  fs.mkdirSync(CUSTOM_CWD, { recursive: true });
  db.initDatabase();
  db.setRegisteredGroup(JID, {
    name: 'Fresh',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    customCwd: CUSTOM_CWD,
    created_by: 'owner',
  } as any);
  db.createAgent({
    id: SESSION_ID,
    group_folder: FOLDER,
    chat_jid: JID,
    name: 'Feature',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'owner',
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
  db.createAgent({
    id: PLAIN_SESSION_ID,
    group_folder: FOLDER,
    chat_jid: JID,
    name: 'Plain',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'owner',
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
  store.insertSessionWorktree({
    agent_id: SESSION_ID,
    group_folder: FOLDER,
    chat_jid: JID,
    repo_path: CUSTOM_CWD,
    cwd_subpath: '',
    worktree_path: WORKTREE,
    branch: 'happyclaw/s1',
    base_commit: 'abc',
    created_at: new Date().toISOString(),
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function fresh(body: Record<string, unknown>) {
  const res = await app.request('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatJid: JID, content: '/fresh 交接', ...body }),
  });
  return res.status;
}

describe('Web /fresh snapshot directory', () => {
  test('a worktree session snapshots its worktree; another session the custom directory', async () => {
    snapshots.dirs.length = 0;
    expect(await fresh({ agentId: SESSION_ID })).toBe(200);
    expect(await fresh({ agentId: PLAIN_SESSION_ID })).toBe(200);
    expect(snapshots.dirs).toEqual([WORKTREE, CUSTOM_CWD]);
  });

  test('without a session nothing is switched', async () => {
    snapshots.dirs.length = 0;
    expect(await fresh({})).toBe(400);
    expect(snapshots.dirs).toEqual([]);
  });
});
