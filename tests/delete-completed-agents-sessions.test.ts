import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'delete-completed-agents-sessions-'),
);
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const {
  initDatabase,
  createAgent,
  getAgent,
  setRegisteredGroup,
  setSession,
  getSession,
  getWorkspaceRuntimeSession,
  deleteCompletedAgents,
} = await import('../src/db.js');

const FOLDER = 'ws-completed-cleanup';
const WS_JID = 'web:ws-completed-cleanup';
const HOUR = 60 * 60 * 1000;

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function seedSpawn(
  id: string,
  opts: {
    status: 'completed' | 'error' | 'running' | 'idle';
    completedAgoMs?: number | null;
    sessionId?: string;
  },
): void {
  createAgent({
    id,
    group_folder: FOLDER,
    chat_jid: WS_JID,
    name: id,
    prompt: '',
    status: opts.status,
    kind: 'spawn',
    created_by: 'owner-1',
    created_at: iso(2 * HOUR),
    completed_at: opts.completedAgoMs == null ? null : iso(opts.completedAgoMs),
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
  if (opts.sessionId) {
    setSession(FOLDER, opts.sessionId, id);
  }
}

beforeAll(() => {
  initDatabase();
  setRegisteredGroup(WS_JID, {
    name: 'Completed cleanup workspace',
    folder: FOLDER,
    added_at: iso(0),
    created_by: 'owner-1',
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('deleteCompletedAgents clears sessions + runtime projections', () => {
  test('old completed spawn loses agent, session, and workspace_runtime_sessions', () => {
    seedSpawn('spawn-old-completed', {
      status: 'completed',
      completedAgoMs: 20 * 60 * 1000,
      sessionId: 'sdk-old-completed',
    });
    expect(getSession(FOLDER, 'spawn-old-completed')).toBe('sdk-old-completed');
    expect(
      getWorkspaceRuntimeSession(FOLDER, 'spawn-old-completed')?.sdk_session_id,
    ).toBe('sdk-old-completed');

    const cutoff = iso(10 * 60 * 1000);
    expect(deleteCompletedAgents(cutoff)).toBeGreaterThanOrEqual(1);

    expect(getAgent('spawn-old-completed')).toBeUndefined();
    expect(getSession(FOLDER, 'spawn-old-completed')).toBeUndefined();
    expect(
      getWorkspaceRuntimeSession(FOLDER, 'spawn-old-completed'),
    ).toBeUndefined();
  });

  test('spawn newer than cutoff, running/idle spawn, and conversation keep all rows', () => {
    seedSpawn('spawn-fresh-completed', {
      status: 'completed',
      completedAgoMs: 2 * 60 * 1000,
      sessionId: 'sdk-fresh-completed',
    });
    seedSpawn('spawn-running', {
      status: 'running',
      completedAgoMs: null,
      sessionId: 'sdk-running',
    });
    seedSpawn('spawn-idle', {
      status: 'idle',
      completedAgoMs: null,
      sessionId: 'sdk-idle',
    });
    createAgent({
      id: 'conversation-keep',
      group_folder: FOLDER,
      chat_jid: WS_JID,
      name: 'conversation-keep',
      prompt: '',
      status: 'completed',
      kind: 'conversation',
      created_by: 'owner-1',
      created_at: iso(2 * HOUR),
      completed_at: iso(20 * 60 * 1000),
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
    setSession(FOLDER, 'sdk-conversation', 'conversation-keep');

    // Unrelated main + other-agent sessions
    setSession(FOLDER, 'sdk-main-session', '');
    seedSpawn('spawn-other-kept', {
      status: 'running',
      completedAgoMs: null,
      sessionId: 'sdk-other',
    });

    const cutoff = iso(10 * 60 * 1000);
    // May delete 0 new rows if only the previous test's agent was deleted;
    // this call must not touch the keepers.
    deleteCompletedAgents(cutoff);

    expect(getAgent('spawn-fresh-completed')?.status).toBe('completed');
    expect(getSession(FOLDER, 'spawn-fresh-completed')).toBe(
      'sdk-fresh-completed',
    );
    expect(
      getWorkspaceRuntimeSession(FOLDER, 'spawn-fresh-completed')
        ?.sdk_session_id,
    ).toBe('sdk-fresh-completed');

    expect(getAgent('spawn-running')?.status).toBe('running');
    expect(getSession(FOLDER, 'spawn-running')).toBe('sdk-running');
    expect(
      getWorkspaceRuntimeSession(FOLDER, 'spawn-running')?.sdk_session_id,
    ).toBe('sdk-running');

    expect(getAgent('spawn-idle')?.status).toBe('idle');
    expect(getSession(FOLDER, 'spawn-idle')).toBe('sdk-idle');

    expect(getAgent('conversation-keep')?.kind).toBe('conversation');
    expect(getSession(FOLDER, 'conversation-keep')).toBe('sdk-conversation');
    expect(
      getWorkspaceRuntimeSession(FOLDER, 'conversation-keep')?.sdk_session_id,
    ).toBe('sdk-conversation');

    expect(getSession(FOLDER, '')).toBe('sdk-main-session');
    expect(getWorkspaceRuntimeSession(FOLDER, '')?.sdk_session_id).toBe(
      'sdk-main-session',
    );
    expect(getSession(FOLDER, 'spawn-other-kept')).toBe('sdk-other');
  });

  test('old completed task with sessions is removed the same way', () => {
    createAgent({
      id: 'task-old-error',
      group_folder: FOLDER,
      chat_jid: WS_JID,
      name: 'task-old-error',
      prompt: '',
      status: 'error',
      kind: 'task',
      created_by: 'owner-1',
      created_at: iso(2 * HOUR),
      completed_at: iso(30 * 60 * 1000),
      result_summary: 'boom',
      last_im_jid: null,
      spawned_from_jid: null,
    });
    setSession(FOLDER, 'sdk-task-old', 'task-old-error');

    expect(deleteCompletedAgents(iso(10 * 60 * 1000))).toBeGreaterThanOrEqual(
      1,
    );
    expect(getAgent('task-old-error')).toBeUndefined();
    expect(getSession(FOLDER, 'task-old-error')).toBeUndefined();
    expect(
      getWorkspaceRuntimeSession(FOLDER, 'task-old-error'),
    ).toBeUndefined();

    // Keepers from prior test still present
    expect(getSession(FOLDER, '')).toBe('sdk-main-session');
    expect(getAgent('spawn-fresh-completed')).toBeTruthy();
  });
});
