import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const DATA_DIR = '/tmp/happyclaw-group-queue-provider-refresh';
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
const WORKSPACE = 'web:refresh';
const OTHER_WORKSPACE = 'web:refresh-other';
const tick = () => new Promise((resolve) => setImmediate(resolve));
let queue: InstanceType<typeof GroupQueue>;
let releases: Array<() => void>;

function startRun(
  agentId: string,
  workspace = WORKSPACE,
  register = true,
  providerId = 'connection',
) {
  const jid = `${workspace}#agent:${agentId}`;
  const folder = workspace.slice(4);
  const kill = vi.fn();
  let release!: () => void;
  queue.enqueueTask(
    jid,
    `run-${agentId}`,
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  releases.push(() => release());
  const registerProcess = () =>
    queue.registerProcess(jid, { kill } as never, {
      containerName: null,
      groupFolder: folder,
      agentId,
      selectedProviderId: providerId,
    });
  if (register) registerProcess();
  const inputDir = path.join(
    DATA_DIR,
    'ipc',
    folder,
    'agents',
    agentId,
    'input',
  );
  return { jid, kill, release: () => release(), registerProcess, inputDir };
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  queue = new GroupQueue();
  queue.setHostModeChecker(() => true);
  releases = [];
});

afterEach(async () => {
  for (const release of releases) release();
  await tick();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('provider runtime refresh', () => {
  test('blocks consecutive inputs immediately while preserving every current turn', async () => {
    const first = startRun('first');
    const second = startRun('second', OTHER_WORKSPACE);
    const other = startRun('other', WORKSPACE, true, 'other-connection');

    queue.requestProviderRuntimeRefresh('connection');
    queue.requestProviderRuntimeRefresh('connection');

    for (const run of [first, second]) {
      expect(queue.getActiveQueryId(run.jid)).not.toBeNull();
      expect(run.kill).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(run.inputDir, '_close'))).toBe(false);
      expect(queue.hasActiveRunnerForMessage(run.jid)).toBe(false);
      expect(queue.sendMessage(run.jid, 'next turn')).toBe('no_active');
      expect(queue.sendMessage(run.jid, 'another input')).toBe('no_active');
    }
    expect(queue.sendMessage(other.jid, 'unrelated connection')).toBe('sent');

    const nextTurn = vi.fn(async () => {});
    queue.enqueueTask(first.jid, 'next-turn', nextTurn);
    expect(nextTurn).not.toHaveBeenCalled();
    queue.markRunnerQueryIdle(first.jid);
    expect(fs.existsSync(path.join(first.inputDir, '_close'))).toBe(true);
    expect(fs.existsSync(path.join(second.inputDir, '_close'))).toBe(false);
    expect(queue.sendMessage(first.jid, 'idle race')).toBe('no_active');

    first.release();
    await tick();
    expect(nextTurn).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(first.inputDir, '_close'))).toBe(false);
  });

  test('retires an idle runner immediately without killing it', () => {
    const run = startRun('idle');
    queue.markRunnerQueryIdle(run.jid);
    queue.requestProviderRuntimeRefresh('connection');
    expect(fs.existsSync(path.join(run.inputDir, '_close'))).toBe(true);
    expect(queue.sendMessage(run.jid, 'next')).toBe('no_active');
    expect(run.kill).not.toHaveBeenCalled();
  });

  test('does not retire a preparing launch that will read the latest connection policy', () => {
    const run = startRun('preparing', WORKSPACE, false);
    queue.requestProviderRuntimeRefresh('connection');
    run.registerProcess();
    expect(queue.sendMessage(run.jid, 'after registration')).toBe('sent');
    expect(fs.existsSync(path.join(run.inputDir, '_close'))).toBe(false);
    queue.markRunnerQueryIdle(run.jid);
    expect(fs.existsSync(path.join(run.inputDir, '_close'))).toBe(false);
  });

  test('closes after releasing a reservation that overlapped the save', async () => {
    const run = startRun('reserved');
    queue.markRunnerQueryIdle(run.jid);
    const reservation = queue.reserveNextQuery(run.jid)!;
    expect(reservation).toBeTruthy();
    queue.requestProviderRuntimeRefresh('connection');
    expect(queue.sendMessage(run.jid, 'prepared after save')).toBe('no_active');
    expect(fs.existsSync(path.join(run.inputDir, '_close'))).toBe(false);

    const replacement = vi.fn(async () => {});
    queue.enqueueTask(run.jid, 'replacement', replacement);
    expect(queue.releaseQueryReservation(run.jid, reservation)).toBe(true);
    expect(fs.existsSync(path.join(run.inputDir, '_close'))).toBe(true);
    expect(run.kill).not.toHaveBeenCalled();
    run.release();
    await tick();
    expect(replacement).toHaveBeenCalledOnce();
  });

  test('a released reservation never closes a turn whose IPC was already published', () => {
    const run = startRun('published');
    queue.markRunnerQueryIdle(run.jid);
    const reservation = queue.reserveNextQuery(run.jid)!;
    expect(queue.sendMessage(run.jid, 'already admitted')).toBe('sent');
    queue.requestProviderRuntimeRefresh('connection');
    expect(queue.releaseQueryReservation(run.jid, reservation)).toBe(false);
    expect(queue.getActiveQueryId(run.jid)).toBe(reservation);
    expect(fs.existsSync(path.join(run.inputDir, '_close'))).toBe(false);
    queue.markRunnerQueryIdle(run.jid);
    expect(fs.existsSync(path.join(run.inputDir, '_close'))).toBe(true);
  });

  test('a connection with no live runner retains no barrier for its next launch', () => {
    queue.requestProviderRuntimeRefresh('connection');
    const run = startRun('new');
    expect(queue.hasActiveRunnerForMessage(run.jid)).toBe(true);
    expect(queue.sendMessage(run.jid, 'new configuration')).toBe('sent');
  });
});
