import fs from 'node:fs';
import path from 'node:path';

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
  test('drains only matching Provider runners without interrupting the current query', () => {
    const queue = new GroupQueue();
    const matchingJid = 'web:credential-drain-match';
    const otherJid = 'web:credential-drain-other';
    const matching = (queue as any).getGroup(matchingJid);
    matching.active = true;
    matching.groupFolder = 'credential-drain-match';
    matching.selectedProviderId = 'provider-refresh';
    matching.queryInFlight = true;
    matching.queryId = 'query-in-progress';
    const other = (queue as any).getGroup(otherJid);
    other.active = true;
    other.groupFolder = 'credential-drain-other';
    other.selectedProviderId = 'provider-other';

    expect(
      queue.drainProviderRunnersForCredentialRefresh('provider-refresh'),
    ).toBe(1);

    const matchingInput = path.join(
      '/tmp/happyclaw-query-identity-test',
      'ipc',
      'credential-drain-match',
      'input',
    );
    const otherInput = path.join(
      '/tmp/happyclaw-query-identity-test',
      'ipc',
      'credential-drain-other',
      'input',
    );
    expect(fs.existsSync(path.join(matchingInput, '_drain'))).toBe(true);
    expect(fs.existsSync(path.join(matchingInput, '_close'))).toBe(false);
    expect(fs.existsSync(path.join(otherInput, '_drain'))).toBe(false);
    expect(matching.queryInFlight).toBe(true);
    expect(matching.pendingMessages).toBe(false);
    expect(
      queue.drainProviderRunnersForCredentialRefresh('provider-refresh'),
    ).toBe(0);

    fs.rmSync(path.join('/tmp/happyclaw-query-identity-test', 'ipc'), {
      recursive: true,
      force: true,
    });
  });

  test('matches coalescing only against physical inputs covered by the active query', () => {
    const queue = new GroupQueue();
    const jid = 'web:query-covered-input';
    const state = (queue as any).getGroup(jid);
    state.active = true;
    state.groupFolder = 'query-covered-input';
    state.queryInFlight = true;
    state.queryId = 'run-root';

    expect(queue.activeQueryExclusivelyCoversMessage(jid, 'om_root')).toBe(
      false,
    );
    const rootSnapshot = {
      coveredCursors: [
        { timestamp: '2026-08-14T00:00:00.000Z', id: 'om_root' },
      ],
      cursor: {
        timestamp: '2026-08-14T00:00:00.000Z',
        id: 'om_root',
      },
    };
    expect(queue.setMessageRetrySnapshot(jid, rootSnapshot)).toBe(true);
    expect(queue.setCurrentQueryCoverage(jid, 'run-root', rootSnapshot)).toBe(
      true,
    );
    expect(queue.activeQueryExclusivelyCoversMessage(jid, 'om_root')).toBe(
      true,
    );
    expect(queue.activeQueryExclusivelyCoversMessage(jid, 'om_unrelated')).toBe(
      false,
    );

    const mixedSnapshot = {
      coveredCursors: [
        { timestamp: '2026-08-14T00:00:00.000Z', id: 'om_root' },
        { timestamp: '2026-08-14T00:00:01.000Z', id: 'om_unrelated' },
      ],
      cursor: {
        timestamp: '2026-08-14T00:00:01.000Z',
        id: 'om_unrelated',
      },
    };
    queue.setMessageRetrySnapshot(jid, mixedSnapshot);
    queue.setCurrentQueryCoverage(jid, 'run-root', mixedSnapshot);
    expect(queue.activeQueryExclusivelyCoversMessage(jid, 'om_root')).toBe(
      false,
    );

    state.queryInFlight = false;
    expect(queue.activeQueryExclusivelyCoversMessage(jid, 'om_root')).toBe(
      false,
    );
  });

  test('defers a cold-boot interrupt until the runner IPC path is registered', () => {
    const queue = new GroupQueue();
    const jid = 'web:boot-interrupt';
    const state = (queue as any).getGroup(jid);
    state.active = true;
    state.groupFolder = null;
    state.queryInFlight = true;
    state.queryId = 'run-boot';

    expect(queue.interruptQuery(jid, 'run-boot')).toBe(true);
    expect(state.pendingInterruptQueryId).toBe('run-boot');

    queue.registerProcess(jid, { pid: 123 } as any, {
      containerName: null,
      groupFolder: 'boot-interrupt',
    });
    const sentinel = path.join(
      '/tmp/happyclaw-query-identity-test',
      'ipc',
      'boot-interrupt',
      'input',
      '_interrupt',
    );
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('run-boot');
    expect(state.pendingInterruptQueryId).toBeNull();
    fs.rmSync(
      path.join('/tmp/happyclaw-query-identity-test', 'ipc', 'boot-interrupt'),
      { recursive: true, force: true },
    );
  });

  test('tracks conversation-agent coverage without creating a task retry snapshot', () => {
    const queue = new GroupQueue();
    const jid = 'web:home#agent:conversation-a';
    const state = (queue as any).getGroup(jid);
    state.active = true;
    state.groupFolder = 'home';
    state.activeRunnerIsTask = true;
    state.queryInFlight = true;
    state.queryId = 'agent-root';

    const agentSnapshot = {
      coveredCursors: [
        { timestamp: '2026-08-14T00:00:00.000Z', id: 'om_root' },
      ],
      cursor: {
        timestamp: '2026-08-14T00:00:00.000Z',
        id: 'om_root',
      },
    };
    expect(queue.setMessageRetrySnapshot(jid, agentSnapshot)).toBe(true);
    expect(
      queue.setCurrentQueryCoverage(jid, 'agent-root', agentSnapshot),
    ).toBe(true);
    expect(queue.activeQueryExclusivelyCoversMessage(jid, 'om_root')).toBe(
      true,
    );
    expect(state.messageRetrySnapshot).toBeNull();

    const scheduledJid = 'web:home#task:scheduled-a';
    const scheduledState = (queue as any).getGroup(scheduledJid);
    scheduledState.active = true;
    scheduledState.groupFolder = 'home';
    scheduledState.activeRunnerIsTask = true;
    scheduledState.queryInFlight = false;
    expect(
      queue.setMessageRetrySnapshot(scheduledJid, {
        coveredCursors: [
          { timestamp: '2026-08-14T00:00:00.000Z', id: 'task-input' },
        ],
        cursor: {
          timestamp: '2026-08-14T00:00:00.000Z',
          id: 'task-input',
        },
      }),
    ).toBe(false);
  });

  test('does not let a later warm input replace current-query coverage', () => {
    const queue = new GroupQueue();
    const jid = 'web:warm-later-input';
    const state = (queue as any).getGroup(jid);
    state.active = true;
    state.groupFolder = 'warm-later-input';
    state.queryInFlight = true;
    state.queryId = 'run-current';
    queue.setCurrentQueryCoverage(jid, 'run-current', {
      coveredCursors: [
        { timestamp: '2026-08-14T00:00:00.000Z', id: 'om_current' },
      ],
      cursor: {
        timestamp: '2026-08-14T00:00:00.000Z',
        id: 'om_current',
      },
    });

    expect(
      queue.setCurrentQueryCoverage(jid, 'run-later', {
        coveredCursors: [
          { timestamp: '2026-08-14T00:00:01.000Z', id: 'om_forward' },
        ],
        cursor: {
          timestamp: '2026-08-14T00:00:01.000Z',
          id: 'om_forward',
        },
      }),
    ).toBe(false);
    expect(queue.activeQueryExclusivelyCoversMessage(jid, 'om_current')).toBe(
      true,
    );
    expect(queue.activeQueryExclusivelyCoversMessage(jid, 'om_forward')).toBe(
      false,
    );
  });

  test('binds an IPC batch immediately when an idle warm runner starts it', () => {
    const queue = new GroupQueue();
    const jid = 'web:warm-idle-root';
    const state = (queue as any).getGroup(jid);
    state.active = true;
    state.groupFolder = 'warm-idle-root';
    state.queryInFlight = false;
    state.queryId = null;

    expect(
      queue.sendMessage(
        jid,
        'forward root',
        undefined,
        undefined,
        undefined,
        undefined,
        {
          chatJid: jid,
          coveredCursors: [
            { timestamp: '2026-08-14T00:00:00.000Z', id: 'om_root' },
          ],
          cursor: {
            timestamp: '2026-08-14T00:00:00.000Z',
            id: 'om_root',
          },
        },
      ),
    ).toBe('sent');
    expect(queue.activeQueryExclusivelyCoversMessage(jid, 'om_root')).toBe(
      true,
    );

    fs.rmSync(
      path.join('/tmp/happyclaw-query-identity-test', 'ipc', 'warm-idle-root'),
      { recursive: true, force: true },
    );
  });

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

  test('a reservation released before it was announced publishes no terminal', () => {
    const queue = new GroupQueue();
    const jid = 'web:query-release-unannounced';
    const state = (queue as any).getGroup(jid);
    state.active = true;
    state.groupFolder = 'query-release-unannounced';

    const finishes: string[] = [];
    queue.setOnQueryFinish((_jid, queryId, reason) =>
      finishes.push(`${queryId}:${reason}`),
    );

    const silent = queue.reserveNextQuery(jid)!;
    expect(queue.releaseQueryReservation(jid, silent, true)).toBe(true);
    expect(finishes).toEqual([]);

    const announced = queue.reserveNextQuery(jid)!;
    expect(queue.announceReservedQuery(jid, announced)).toBe(true);
    expect(queue.releaseQueryReservation(jid, announced)).toBe(true);
    expect(finishes).toEqual([`${announced}:released`]);
  });
});
