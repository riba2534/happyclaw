/**
 * Regression test for riba2534/happyclaw#559 ("notify 失效").
 *
 * Group-mode scheduled tasks inject their prompt into the source workspace as a
 * normal message. When a runner is ALREADY active, delivery goes through
 * GroupQueue.sendMessage() (the IPC-injection path), not the cold-start
 * runContainerAgent() path. That IPC payload must carry `taskId` — otherwise the
 * agent-runner can't attribute the resulting send_message output to the task, so
 * the host's resolveTaskRoutingDecision() returns `none` and the configured
 * notify_channels broadcast (Feishu etc.) is silently skipped.
 *
 * These tests pin the contract at the filesystem boundary: the written IPC input
 * JSON carries `taskId` when (and only when) one is supplied.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = '/tmp/happyclaw-queue-taskid-test';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: TEST_DATA_DIR };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/container-runner.js', () => ({ killProcessTree: () => {} }));

vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 1,
    maxConcurrentHostProcesses: 1,
  }),
}));

vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');

const tick = () => new Promise((r) => setImmediate(r));
const JID = 'web:taskid-inject';
const FOLDER = 'taskid-inject';

let queue: InstanceType<typeof GroupQueue>;
let resolveGate: (() => void) | null;

function readInjectedPayloads(): Array<Record<string, unknown>> {
  const dir = path.join(TEST_DATA_DIR, 'ipc', FOLDER, 'input');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
}

beforeEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  queue = new GroupQueue();
  resolveGate = null;
  // Keep the run gate-blocked so the runner stays active while we inject.
  queue.setProcessMessagesFn(async () => {
    await new Promise<void>((r) => {
      resolveGate = r;
    });
    return true;
  });
});

afterEach(async () => {
  resolveGate?.();
  await tick();
  await tick();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function startActiveRunner(): Promise<void> {
  queue.enqueueMessageCheck(JID); // run goes active, blocks on the gate
  await tick();
  // registerProcess sets groupFolder so resolveActiveState() accepts the state
  // and resolveIpcInputDir() can locate data/ipc/{folder}/input.
  queue.registerProcess(JID, { kill: () => {}, killed: false } as never, {
    containerName: null,
    groupFolder: FOLDER,
  });
}

describe('GroupQueue.sendMessage taskId propagation (#559)', () => {
  test('stamps taskId into the IPC payload when provided', async () => {
    await startActiveRunner();

    const result = queue.sendMessage(
      JID,
      'task output',
      undefined,
      undefined,
      undefined,
      'task-abc',
    );

    expect(result).toBe('sent');
    const payloads = readInjectedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].type).toBe('message');
    expect(payloads[0].text).toBe('task output');
    expect(payloads[0].taskId).toBe('task-abc');
  });

  test('omits taskId for regular user messages', async () => {
    await startActiveRunner();

    const result = queue.sendMessage(
      JID,
      'hi',
      undefined,
      undefined,
      'feishu:u1',
    );

    expect(result).toBe('sent');
    const payloads = readInjectedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].taskId).toBeUndefined();
    expect(payloads[0].sourceJid).toBe('feishu:u1');
  });
});
