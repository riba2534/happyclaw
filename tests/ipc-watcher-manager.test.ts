import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_IPC_ORPHAN_SWEEP_MS,
  DEFAULT_IPC_WATCHER_FALLBACK_MS,
  IpcWatcherManager,
  resolveScopedIpcRoots,
  type IpcProcessScope,
} from '../src/ipc-watcher-manager.js';

const temporaryRoots: string[] = [];

function temporaryIpcRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ipc-watch-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('IpcWatcherManager runtime namespaces', () => {
  test('keeps the default recovery scan below the Runner IPC deadline', () => {
    expect(DEFAULT_IPC_WATCHER_FALLBACK_MS).toBe(2000);
  });

  test.each([
    {
      name: 'conversation agent tasks',
      namespace: { agentId: 'agent-1' },
      relativeDir: path.join('agents', 'agent-1', 'tasks'),
    },
    {
      name: 'isolated task messages',
      namespace: { taskRunId: 'run-1' },
      relativeDir: path.join('tasks-run', 'run-1', 'messages'),
    },
  ])('processes $name without waiting for the full scan', async (fixture) => {
    const ipcBaseDir = temporaryIpcRoot();
    const processGroup = vi.fn(async () => {});
    const processFull = vi.fn(async () => {});
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 5,
      // Do not start fallback: this test proves leaf fs.watch delivery.
      fallbackMs: 60_000,
    });
    manager.bind(processGroup, processFull);
    manager.watchRuntime('workspace', fixture.namespace);
    // Ignore the intentional registration-race drain. The next call must come
    // from the nested leaf watcher because fallback is not running.
    await vi.waitFor(() => expect(processGroup).toHaveBeenCalled());
    processGroup.mockClear();

    const requestDir = path.join(ipcBaseDir, 'workspace', fixture.relativeDir);
    fs.writeFileSync(path.join(requestDir, 'request.json'), '{}');

    await vi.waitFor(() => {
      expect(processGroup).toHaveBeenCalledWith('workspace', {
        all: false,
        namespaces: [
          {
            agentId: fixture.namespace.agentId ?? null,
            taskRunId: fixture.namespace.taskRunId ?? null,
          },
        ],
      });
    });
    expect(processFull).not.toHaveBeenCalled();
    manager.closeAll();
  });

  test('reference counts one namespace and closes it only after the final release', async () => {
    const ipcBaseDir = temporaryIpcRoot();
    const processGroup = vi.fn(async () => {});
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 5,
    });
    manager.bind(processGroup, async () => {});
    const namespace = { agentId: 'agent-refcount' };
    manager.watchRuntime('workspace', namespace);
    manager.watchRuntime('workspace', namespace);
    expect(manager.activeRuntimeCount).toBe(1);
    await vi.waitFor(() => expect(processGroup).toHaveBeenCalled());
    processGroup.mockClear();

    manager.unwatchRuntime('workspace', namespace);
    const requestDir = path.join(
      ipcBaseDir,
      'workspace',
      'agents',
      'agent-refcount',
      'tasks',
    );
    fs.writeFileSync(path.join(requestDir, 'first.json'), '{}');
    await vi.waitFor(() => expect(processGroup).toHaveBeenCalledTimes(1));

    manager.unwatchRuntime('workspace', namespace);
    expect(manager.activeRuntimeCount).toBe(0);
    // The final release drains the namespace once for a request published
    // right before the runner exited; after that no watcher remains.
    await vi.waitFor(() => expect(processGroup).toHaveBeenCalledTimes(2));
    fs.writeFileSync(path.join(requestDir, 'after-release.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(processGroup).toHaveBeenCalledTimes(2);
    manager.closeAll();
  });

  test('immediately drains a request that won the watcher-registration race', async () => {
    const ipcBaseDir = temporaryIpcRoot();
    const requestDir = path.join(
      ipcBaseDir,
      'workspace',
      'agents',
      'agent-race',
      'tasks',
    );
    fs.mkdirSync(requestDir, { recursive: true });
    fs.writeFileSync(path.join(requestDir, 'already-present.json'), '{}');
    const processGroup = vi.fn(async () => {});
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 5,
    });
    manager.bind(processGroup, async () => {});

    manager.watchRuntime('workspace', { agentId: 'agent-race' });

    await vi.waitFor(() =>
      expect(processGroup).toHaveBeenCalledWith('workspace', {
        all: false,
        namespaces: [{ agentId: 'agent-race', taskRunId: null }],
      }),
    );
    manager.closeAll();
  });

  test('falls back within the Runner context deadline when fs.watch is unavailable', async () => {
    const ipcBaseDir = temporaryIpcRoot();
    const watch = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('watch unavailable');
    });
    const processGroup = vi.fn(async () => {});
    const processFull = vi.fn(async () => {});
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 5,
      fallbackMs: 20,
    });
    manager.bind(processGroup, processFull);
    manager.watchRuntime('workspace', { agentId: 'agent-fallback' });
    await vi.waitFor(() => expect(processGroup).toHaveBeenCalled());
    processGroup.mockClear();

    const requestDir = path.join(
      ipcBaseDir,
      'workspace',
      'agents',
      'agent-fallback',
      'tasks',
    );
    fs.writeFileSync(path.join(requestDir, 'request.json'), '{}');
    manager.startFallback();

    // The fast fallback drains the live namespace only; the full-tree sweep
    // is reserved for the slow orphan pass.
    await vi.waitFor(() =>
      expect(processGroup).toHaveBeenCalledWith('workspace', {
        all: false,
        namespaces: [{ agentId: 'agent-fallback', taskRunId: null }],
      }),
    );
    expect(processFull).not.toHaveBeenCalled();
    manager.closeAll();
    watch.mockRestore();
  });

  test('keeps the orphan sweep slow and runs it on its own timer', async () => {
    expect(DEFAULT_IPC_ORPHAN_SWEEP_MS).toBeGreaterThanOrEqual(30_000);
    expect(DEFAULT_IPC_ORPHAN_SWEEP_MS).toBeLessThanOrEqual(60_000);
    const processGroup = vi.fn(async () => {});
    const processFull = vi.fn(async () => {});
    const manager = new IpcWatcherManager({
      ipcBaseDir: temporaryIpcRoot(),
      isShuttingDown: () => false,
      debounceMs: 5,
      fallbackMs: 10,
      orphanSweepMs: 30,
    });
    manager.bind(processGroup, processFull);
    manager.startFallback();
    // No live runner: the fast fallback has nothing to poll.
    await vi.waitFor(() => expect(processFull).toHaveBeenCalled());
    expect(processGroup).not.toHaveBeenCalled();
    manager.closeAll();
  });

  test('merges namespaces of one debounce window and lets a full drain win', async () => {
    const ipcBaseDir = temporaryIpcRoot();
    const scopes: IpcProcessScope[] = [];
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 20,
    });
    manager.bind(
      async (_folder, scope) => {
        scopes.push(scope);
      },
      async () => {},
    );
    manager.triggerProcess('workspace', { agentId: 'a' });
    manager.triggerProcess('workspace', { taskRunId: 't' });
    manager.triggerProcess('workspace', { agentId: 'a' });
    await vi.waitFor(() => expect(scopes).toHaveLength(1));
    expect(scopes[0]).toEqual({
      all: false,
      namespaces: [{ agentId: 'a' }, { taskRunId: 't' }],
    });

    manager.triggerProcess('workspace', { agentId: 'a' });
    manager.triggerProcess('workspace');
    await vi.waitFor(() => expect(scopes).toHaveLength(2));
    expect(scopes[1]).toEqual({ all: true });
    manager.closeAll();
  });

  test('re-runs a scope requested while the folder was being drained', async () => {
    const scopes: IpcProcessScope[] = [];
    let release: () => void = () => {};
    const manager = new IpcWatcherManager({
      ipcBaseDir: temporaryIpcRoot(),
      isShuttingDown: () => false,
      debounceMs: 5,
    });
    manager.bind(
      (_folder, scope) => {
        scopes.push(scope);
        if (scopes.length > 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async () => {},
    );
    manager.triggerProcess('workspace', { agentId: 'first' });
    await vi.waitFor(() => expect(scopes).toHaveLength(1));
    manager.triggerProcess('workspace', { agentId: 'second' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(scopes).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(scopes).toHaveLength(2));
    expect(scopes[1]).toEqual({
      all: false,
      namespaces: [{ agentId: 'second' }],
    });
    manager.closeAll();
  });

  test('drains a request published right before the runner released its namespace', async () => {
    const ipcBaseDir = temporaryIpcRoot();
    const calls: Array<[string, IpcProcessScope]> = [];
    const manager = new IpcWatcherManager({
      ipcBaseDir,
      isShuttingDown: () => false,
      debounceMs: 50,
      fallbackMs: 60_000,
    });
    manager.bind(
      async (folder, scope) => {
        calls.push([folder, scope]);
      },
      async () => {},
    );
    manager.watchRuntime('workspace', { agentId: 'exiting' });
    const requestDir = path.join(
      ipcBaseDir,
      'workspace',
      'agents',
      'exiting',
      'messages',
    );
    fs.writeFileSync(path.join(requestDir, 'last.json'), '{}');
    // Release before the watcher event's debounce fires.
    manager.unwatchRuntime('workspace', { agentId: 'exiting' });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.at(-1)).toEqual([
      'workspace',
      {
        all: false,
        namespaces: [{ agentId: 'exiting', taskRunId: null }],
      },
    ]);
    expect(manager.isWatched('workspace', { agentId: 'exiting' })).toBe(false);
    manager.closeAll();
  });
});

describe('resolveScopedIpcRoots', () => {
  test('returns only the requested roots, main first, without duplicates', () => {
    const roots = resolveScopedIpcRoots('/ipc/ws', [
      { taskRunId: 'run-1' },
      { agentId: 'agent-1' },
      {},
      { agentId: 'agent-1' },
    ]);
    expect(roots).toEqual([
      { path: '/ipc/ws', agentId: null, taskId: null },
      {
        path: path.join('/ipc/ws', 'agents', 'agent-1'),
        agentId: 'agent-1',
        taskId: null,
      },
      {
        path: path.join('/ipc/ws', 'tasks-run', 'run-1'),
        agentId: null,
        taskId: 'run-1',
      },
    ]);
  });

  test('rejects namespace ids that are not a single path segment', () => {
    expect(
      resolveScopedIpcRoots('/ipc/ws', [
        { agentId: '../other' },
        { agentId: 'a/b' },
        { taskRunId: '..' },
        { agentId: 'x', taskRunId: 'y' },
      ]),
    ).toEqual([]);
  });
});
