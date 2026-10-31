import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const DATA_DIR = '/tmp/happyclaw-background-only-test';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: '/tmp/happyclaw-background-only-test' };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: vi.fn() }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({ maxConcurrentContainers: 20 }),
}));
vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');

afterEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/** A warm runner whose query `run-a` answered input `input-a`. */
function runningQuery(folder: string) {
  const queue = new GroupQueue();
  const jid = `web:${folder}`;
  const state = (queue as any).getGroup(jid);
  state.active = true;
  state.process = { pid: 4242 };
  state.groupFolder = folder;
  state.queryInFlight = true;
  state.queryId = 'run-a';
  state.queryStartedAt = Date.now();
  const idle: string[] = [];
  queue.setOnQueryIdle((_jid, completedQueryId) => {
    idle.push(completedQueryId);
  });
  const inputDir = path.join(DATA_DIR, 'ipc', folder, 'input');
  return { queue, jid, state, idle, inputDir };
}

describe('GroupQueue background-only queries', () => {
  test('ends the query so queued input is released, remembering it for stop', () => {
    const { queue, jid, state, idle } = runningQuery('bg-release');

    expect(queue.markRunnerBackgroundOnly(jid, 'input-a')).toBe(true);

    expect(state.queryInFlight).toBe(false);
    expect(queue.getActiveQueryId(jid)).toBeNull();
    expect(queue.getBackgroundQueryId(jid)).toBe('run-a');
    expect(idle).toEqual(['run-a']);
  });

  test('is refused once a later input was published under the current query', () => {
    const { queue, jid, state, idle } = runningQuery('bg-refused');
    // The held input's own delivery does not count.
    state.pendingIpcQueryIds = new Map([['input-a', 'run-a']]);
    expect(queue.markRunnerBackgroundOnly(jid, 'input-a')).toBe(true);

    // Now the host started query run-b for input B, then the runner re-emits
    // A's interim result (after a notification turn of A).
    state.queryInFlight = true;
    state.queryId = 'run-b';
    state.pendingIpcQueryIds.set('input-b', 'run-b');
    expect(queue.markRunnerBackgroundOnly(jid, 'input-a')).toBe(false);
    expect(state.queryInFlight).toBe(true);
    expect(queue.getActiveQueryId(jid)).toBe('run-b');
    expect(idle).toEqual(['run-a']);
  });

  test('a healthy idle forgets the background query', () => {
    const { queue, jid, state } = runningQuery('bg-forget');
    queue.markRunnerBackgroundOnly(jid, 'input-a');
    state.queryInFlight = true;
    state.queryId = 'run-b';
    // In flight, the active query wins.
    expect(queue.getBackgroundQueryId(jid)).toBeNull();

    queue.markRunnerQueryIdle(jid);
    expect(queue.getBackgroundQueryId(jid)).toBeNull();
    expect(state.backgroundQueryId).toBeNull();
  });

  test('an explicit stop reaches the background tasks; a steer does not', () => {
    const { queue, jid, inputDir } = runningQuery('bg-stop');
    queue.markRunnerBackgroundOnly(jid, 'input-a');

    expect(queue.interruptQuery(jid, undefined, 'steer')).toBe(false);
    expect(fs.existsSync(path.join(inputDir, '_interrupt'))).toBe(false);

    expect(queue.interruptQuery(jid, 'run-other', 'stop')).toBe(false);
    expect(queue.interruptQuery(jid, 'run-a', 'stop')).toBe(true);
    expect(fs.readFileSync(path.join(inputDir, '_interrupt'), 'utf8')).toBe(
      'run-a',
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(inputDir, '_interrupt_reason'), 'utf8'),
      ),
    ).toEqual({ queryId: 'run-a', reason: 'stop' });
  });

  test('neither closes after the query nor reclaims the slot while tasks run', () => {
    const { queue, jid, state } = runningQuery('bg-keep');
    state.runnerRuntime = 'container';
    state.pendingIpcDeliveries = new Map();
    const closed = vi.spyOn(queue, 'closeStdin').mockImplementation(() => {});

    queue.markRunnerBackgroundOnly(jid, 'input-a');
    expect((queue as any).isIdleContainerRunner(jid, state)).toBe(false);

    (queue as any).closeAfterQuery(jid, () => {});
    expect(closed).not.toHaveBeenCalled();

    // The next healthy idle has no background work: close now.
    state.queryInFlight = true;
    state.queryId = 'run-b';
    queue.markRunnerQueryIdle(jid);
    expect(closed).toHaveBeenCalledWith(jid);
  });
});
