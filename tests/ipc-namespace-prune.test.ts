import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { pruneIdleIpcNamespaces } from '../src/ipc-namespace-prune.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const HOUR = 60 * 60 * 1000;

function makeNamespace(base: string, folder: string, agentId: string): string {
  const root = path.join(base, folder, 'agents', agentId);
  for (const sub of ['messages', 'tasks', 'input', 'agents']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

function setup(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ipc-prune-'));
  roots.push(base);
  return base;
}

describe('pruneIdleIpcNamespaces', () => {
  test('removes empty namespaces of deleted, archived and failed sessions only', async () => {
    const base = setup();
    const deleted = makeNamespace(base, 'ws', 'deleted');
    const archived = makeNamespace(base, 'ws', 'archived');
    const failed = makeNamespace(base, 'ws', 'failed');
    const idle = makeNamespace(base, 'ws', 'idle');
    const running = makeNamespace(base, 'ws', 'running');
    const statuses = new Map([
      ['archived', 'completed'],
      ['failed', 'error'],
      ['idle', 'idle'],
      ['running', 'running'],
    ]);

    const result = await pruneIdleIpcNamespaces({
      ipcBaseDir: base,
      isWatched: () => false,
      agentStatuses: () => statuses,
      now: () => Date.now() + HOUR,
    });

    expect(result).toEqual({ removed: 3, scanned: 5 });
    expect(fs.existsSync(deleted)).toBe(false);
    expect(fs.existsSync(archived)).toBe(false);
    expect(fs.existsSync(failed)).toBe(false);
    expect(fs.existsSync(idle)).toBe(true);
    expect(fs.existsSync(running)).toBe(true);
  });

  test('keeps watched, non-empty and recently touched namespaces', async () => {
    const base = setup();
    const watched = makeNamespace(base, 'ws', 'watched');
    const pending = makeNamespace(base, 'ws', 'pending');
    fs.writeFileSync(path.join(pending, 'messages', 'unprocessed.json'), '{}');
    const nested = makeNamespace(base, 'ws', 'nested');
    fs.mkdirSync(path.join(nested, 'agents', 'child', 'tasks'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(nested, 'agents', 'child', 'tasks', 'req.json'),
      '{}',
    );
    const recent = makeNamespace(base, 'ws', 'recent');

    const result = await pruneIdleIpcNamespaces({
      ipcBaseDir: base,
      isWatched: (_folder, ns) => ns.agentId === 'watched',
      agentStatuses: () => new Map(),
      // "recent" was just created; everything else is aged artificially.
      now: () => Date.now(),
      minIdleMs: HOUR,
    });
    expect(result.removed).toBe(0);
    for (const dir of [watched, pending, nested, recent]) {
      expect(fs.existsSync(dir)).toBe(true);
    }

    const aged = await pruneIdleIpcNamespaces({
      ipcBaseDir: base,
      isWatched: (_folder, ns) => ns.agentId === 'watched',
      agentStatuses: () => new Map(),
      now: () => Date.now() + 2 * HOUR,
      minIdleMs: HOUR,
    });
    expect(aged.removed).toBe(1);
    expect(fs.existsSync(recent)).toBe(false);
    expect(fs.existsSync(watched)).toBe(true);
    expect(fs.existsSync(pending)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
  });

  test('keeps a namespace whose session was revived during the scan', async () => {
    const base = setup();
    const revived = makeNamespace(base, 'ws', 'revived');
    const result = await pruneIdleIpcNamespaces({
      ipcBaseDir: base,
      isWatched: () => false,
      agentStatuses: () => new Map([['revived', 'completed']]),
      currentStatus: () => 'running',
      now: () => Date.now() + HOUR,
    });
    expect(result.removed).toBe(0);
    expect(fs.existsSync(revived)).toBe(true);
  });

  test('never touches the workspace root or isolated task namespaces', async () => {
    const base = setup();
    fs.mkdirSync(path.join(base, 'ws', 'messages'), { recursive: true });
    fs.mkdirSync(path.join(base, 'ws', 'tasks-run', 'run-1', 'messages'), {
      recursive: true,
    });
    const result = await pruneIdleIpcNamespaces({
      ipcBaseDir: base,
      isWatched: () => false,
      agentStatuses: () => new Map(),
      now: () => Date.now() + HOUR,
    });
    expect(result).toEqual({ removed: 0, scanned: 0 });
    expect(fs.existsSync(path.join(base, 'ws', 'messages'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'ws', 'tasks-run', 'run-1'))).toBe(
      true,
    );
  });
});
