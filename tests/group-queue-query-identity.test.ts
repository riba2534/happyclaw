import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: '/tmp/happyclaw-query-identity-test' };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: vi.fn() }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 20,
    maxConcurrentHostProcesses: 5,
  }),
}));
vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');

describe('GroupQueue query identity', () => {
  test('clears the completed id before the idle callback reserves the next query', () => {
    const queue = new GroupQueue();
    const jid = 'web:query-id';
    const state = (queue as any).getGroup(jid);
    state.active = true;
    state.groupFolder = 'query-id';
    state.queryInFlight = true;
    state.queryId = 'run-1';

    let completed: string | undefined;
    let next: string | null = null;
    queue.setOnQueryIdle((callbackJid, completedQueryId) => {
      expect(callbackJid).toBe(jid);
      expect(queue.getActiveQueryId(jid)).toBeNull();
      completed = completedQueryId;
      next = queue.reserveNextQuery(jid);
    });

    queue.markRunnerQueryIdle(jid);

    expect(completed).toBe('run-1');
    expect(next).toBeTruthy();
    expect(next).not.toBe('run-1');
    expect(queue.getActiveQueryId(jid)).toBe(next);
    expect(queue.interruptQuery(jid, 'run-1')).toBe(false);
  });

  test('publishes the old exact terminal before a queued callback starts its replacement', () => {
    const queue = new GroupQueue();
    const jid = 'web:query-order';
    const state = (queue as any).getGroup(jid);
    state.active = true;
    state.groupFolder = 'query-order';
    state.queryInFlight = true;
    state.queryId = 'run-old';
    state.queryStartedAt = Date.now();
    state.announcedQueryId = 'run-old';

    const events: string[] = [];
    queue.setOnQueryFinish((_jid, queryId, reason) => {
      events.push(`finish:${queryId}:${reason}`);
    });
    queue.setOnQueryStart((_jid, queryId) => {
      events.push(`start:${queryId}`);
    });
    queue.setOnQueryIdle(() => {
      const next = queue.reserveNextQuery(jid)!;
      queue.announceReservedQuery(jid, next);
    });

    queue.markRunnerQueryIdle(jid);

    expect(events[0]).toBe('finish:run-old:completed');
    expect(events[1]).toMatch(/^start:/);
    expect(queue.getActiveQueryId(jid)).not.toBe('run-old');
  });

  test('stale reservation release cannot terminalize the current query', () => {
    const queue = new GroupQueue();
    const jid = 'web:query-release-fence';
    const state = (queue as any).getGroup(jid);
    state.active = true;
    state.groupFolder = 'query-release-fence';
    state.queryInFlight = true;
    state.queryId = 'run-new';
    state.queryStartedAt = Date.now();
    state.announcedQueryId = 'run-new';

    const finishes: string[] = [];
    queue.setOnQueryFinish((_jid, queryId) => finishes.push(queryId));

    expect(queue.releaseQueryReservation(jid, 'run-old')).toBe(false);
    expect(queue.getActiveQueryId(jid)).toBe('run-new');
    expect(finishes).toEqual([]);
  });
});
