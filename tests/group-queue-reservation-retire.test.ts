import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// dispatchNextQueuedFollowUp holds a query reservation while it awaits
// prepareFollowUp. A runner can be retired meanwhile (a team-mode work item
// approval calls retireRunnerAfterQuery through drainLane), and another path
// can publish IPC under the reservation before its owner releases it.
const DATA_DIR = '/tmp/happyclaw-group-queue-reservation-retire';
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: vi.fn() }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 10,
    maxConcurrentHostProcesses: 10,
  }),
}));
vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');
const { sessionIpcDir } = await import('../src/utils.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
let queue: InstanceType<typeof GroupQueue>;
let releaseRunner: (() => void) | undefined;

/** A registered, idle Host runner for one session lane. */
function idleRunner(agentId: string) {
  const jid = `web:reservation#agent:${agentId}`;
  const kill = vi.fn();
  queue.enqueueTask(
    jid,
    `run-${agentId}`,
    () => new Promise<void>((resolve) => (releaseRunner = resolve)),
  );
  queue.registerProcess(jid, { kill } as never, {
    containerName: null,
    groupFolder: 'reservation',
    agentId,
  });
  queue.markRunnerQueryIdle(jid);
  const closeFile = path.join(
    sessionIpcDir('reservation', agentId),
    'input',
    '_close',
  );
  return { jid, kill, closed: () => fs.existsSync(closeFile) };
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  queue = new GroupQueue();
  queue.setHostModeChecker(() => true);
  releaseRunner = undefined;
});

afterEach(async () => {
  releaseRunner?.();
  await tick();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('releasing a follow-up reservation', () => {
  test('closes a runner retired while the reservation was held', async () => {
    const run = idleRunner('retired');
    const reservation = queue.reserveNextQuery(run.jid)!;
    expect(queue.retireRunnerAfterQuery(run.jid)).toBe(true);
    expect(run.closed()).toBe(false);
    expect(queue.sendMessage(run.jid, 'prepared batch')).toBe('no_active');
    const coldStart = vi.fn(async () => {});
    queue.enqueueTask(run.jid, 'cold-start', coldStart);

    expect(queue.releaseQueryReservation(run.jid, reservation)).toBe(true);
    // Without the close the runner idles until IDLE_TIMEOUT and the cold
    // start queued behind it waits as long.
    expect(run.closed()).toBe(true);
    expect(run.kill).not.toHaveBeenCalled();
    releaseRunner!();
    await tick();
    expect(coldStart).toHaveBeenCalledOnce();
  });

  test('keeps a turn whose IPC was published under the reservation', () => {
    const run = idleRunner('published');
    const reservation = queue.reserveNextQuery(run.jid)!;
    // A Web send that saw an idle lane before awaiting its plugin expansion.
    expect(queue.sendMessage(run.jid, 'direct turn')).toBe('sent');

    expect(queue.releaseQueryReservation(run.jid, reservation)).toBe(false);
    expect(queue.getActiveQueryId(run.jid)).toBe(reservation);
  });

  test('a retired runner serving such a turn closes only after it ends', () => {
    const run = idleRunner('published-retired');
    const reservation = queue.reserveNextQuery(run.jid)!;
    expect(queue.sendMessage(run.jid, 'direct turn')).toBe('sent');
    queue.retireRunnerAfterQuery(run.jid);

    expect(queue.releaseQueryReservation(run.jid, reservation)).toBe(false);
    expect(run.closed()).toBe(false);
    queue.markRunnerQueryIdle(run.jid);
    expect(run.closed()).toBe(true);
  });
});
