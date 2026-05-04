import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-provider-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => {
  return {
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const {
  initDatabase,
  setSession,
  getSessionProviderId,
  setSessionProviderId,
  deleteSession,
  deleteSessionsByProviderId,
} = await import('../src/db.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('session→provider sticky binding', () => {
  test('returns undefined for unknown session', () => {
    expect(getSessionProviderId('unknown-folder')).toBeUndefined();
    expect(getSessionProviderId('unknown-folder', 'some-agent')).toBeUndefined();
  });

  test('setSessionProviderId creates a row when none exists', () => {
    setSessionProviderId('folder-1', '', 'provider-A');
    expect(getSessionProviderId('folder-1')).toBe('provider-A');
    expect(getSessionProviderId('folder-1', '')).toBe('provider-A');
  });

  test('setSessionProviderId updates existing session row without losing session_id', () => {
    setSession('folder-2', 'session-uuid-2', '');
    setSessionProviderId('folder-2', '', 'provider-B');
    expect(getSessionProviderId('folder-2')).toBe('provider-B');

    // Switching provider must not delete the session_id binding.
    setSessionProviderId('folder-2', '', 'provider-C');
    expect(getSessionProviderId('folder-2')).toBe('provider-C');
  });

  test('agent-scoped bindings are independent of main bindings', () => {
    setSessionProviderId('folder-3', '', 'main-provider');
    setSessionProviderId('folder-3', 'agent-x', 'sub-provider');
    expect(getSessionProviderId('folder-3')).toBe('main-provider');
    expect(getSessionProviderId('folder-3', 'agent-x')).toBe('sub-provider');
  });

  test('clearing binding via null removes provider_id but keeps row', () => {
    setSessionProviderId('folder-4', '', 'provider-D');
    setSessionProviderId('folder-4', '', null);
    expect(getSessionProviderId('folder-4')).toBeUndefined();
  });

  test('deleteSession removes the binding too', () => {
    setSessionProviderId('folder-5', '', 'provider-E');
    deleteSession('folder-5', '');
    expect(getSessionProviderId('folder-5')).toBeUndefined();
  });
});

describe('deleteSessionsByProviderId — narrowed cleanup (issue #476)', () => {
  test('only removes rows bound to the target provider', () => {
    setSession('folder-narrow-1', 'sess-1', '');
    setSessionProviderId('folder-narrow-1', '', 'provider-target');
    setSession('folder-narrow-2', 'sess-2', '');
    setSessionProviderId('folder-narrow-2', '', 'provider-other');

    const result = deleteSessionsByProviderId('provider-target');

    expect(result.deletedCount).toBe(1);
    expect(result.affectedFolders).toEqual(['folder-narrow-1']);
    expect(getSessionProviderId('folder-narrow-1')).toBeUndefined();
    // Unrelated provider's binding survives — this is the core fix.
    expect(getSessionProviderId('folder-narrow-2')).toBe('provider-other');
  });

  test('removes per-agent bindings to the same provider in one folder', () => {
    setSessionProviderId('folder-narrow-3', '', 'provider-shared');
    setSessionProviderId('folder-narrow-3', 'agent-a', 'provider-shared');
    setSessionProviderId('folder-narrow-3', 'agent-b', 'provider-other');

    const result = deleteSessionsByProviderId('provider-shared');

    expect(result.deletedCount).toBe(2);
    expect(result.affectedFolders).toEqual(['folder-narrow-3']);
    expect(getSessionProviderId('folder-narrow-3')).toBeUndefined();
    expect(getSessionProviderId('folder-narrow-3', 'agent-a')).toBeUndefined();
    expect(getSessionProviderId('folder-narrow-3', 'agent-b')).toBe(
      'provider-other',
    );
  });

  test('returns empty result when no sessions match', () => {
    const result = deleteSessionsByProviderId('provider-does-not-exist');
    expect(result.deletedCount).toBe(0);
    expect(result.affectedFolders).toEqual([]);
  });

  test('deduplicates affected folders across multiple agent rows', () => {
    setSessionProviderId('folder-narrow-4', '', 'provider-multi');
    setSessionProviderId('folder-narrow-4', 'agent-x', 'provider-multi');
    setSessionProviderId('folder-narrow-5', '', 'provider-multi');

    const result = deleteSessionsByProviderId('provider-multi');

    expect(result.deletedCount).toBe(3);
    expect(result.affectedFolders.sort()).toEqual([
      'folder-narrow-4',
      'folder-narrow-5',
    ]);
  });
});
