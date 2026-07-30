import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const DATA_DIR = '/tmp/happyclaw-group-queue-ipc-receipts';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({
  killProcessTree: (proc: { kill: () => boolean }) => proc.kill(),
}));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 10,
    maxConcurrentHostProcesses: 10,
  }),
}));
vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');
type Receipt = import('../src/group-queue.js').IpcDeliveryReceipt;

const JID = 'web:ipc-receipts';
const FOLDER = 'ipc-receipts';
const tick = () => new Promise((resolve) => setImmediate(resolve));

let queue: InstanceType<typeof GroupQueue>;
let releaseRun: (() => void) | undefined;

function inputDir(): string {
  return path.join(DATA_DIR, 'ipc', FOLDER, 'input');
}

function readPayloads(): Array<{ receipt?: Receipt; queryRunId?: string }> {
  return fs
    .readdirSync(inputDir())
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) =>
      JSON.parse(fs.readFileSync(path.join(inputDir(), name), 'utf8')),
    );
}

async function startRunner(
  options: {
    containerName?: string | null;
    feishuCliAccountId?: string | null;
  } = {},
): Promise<void> {
  queue.enqueueMessageCheck(JID);
  await tick();
  queue.registerProcess(
    JID,
    {
      killed: false,
      kill: () => {
        releaseRun?.();
        return true;
      },
    } as never,
    {
      containerName: options.containerName ?? null,
      groupFolder: FOLDER,
      feishuCliAccountId: options.feishuCliAccountId,
    },
  );
}

function cursor(id: string): { timestamp: string; id: string } {
  return { timestamp: '2026-07-10T00:00:00.000Z', id };
}

function inject(id: string, coveredIds: string[] = [id]): Receipt {
  expect(
    queue.sendMessage(JID, id, undefined, undefined, JID, undefined, {
      chatJid: JID,
      coveredCursors: coveredIds.map(cursor),
      cursor: cursor(id),
    }),
  ).toBe('sent');
  return readPayloads().find((payload) => payload.receipt?.cursor.id === id)!
    .receipt!;
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  queue = new GroupQueue();
  queue.setIpcDeliveryCommitEligibilityChecker(() => true);
  queue.setProcessMessagesFn(
    () =>
      new Promise<boolean>((resolve) => {
        releaseRun = () => resolve(true);
      }),
  );
});

afterEach(async () => {
  releaseRun?.();
  await tick();
  await tick();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('GroupQueue IPC delivery receipts', () => {
  test('restarts a container before switching the injected Feishu Bot', async () => {
    await startRunner({
      containerName: 'happyclaw-bot-a',
      feishuCliAccountId: 'account-a',
    });

    expect(
      queue.sendMessage(
        JID,
        'use bot b',
        undefined,
        undefined,
        JID,
        undefined,
        undefined,
        {
          schemaVersion: 1,
          provider: 'feishu',
          channelAccountId: 'account-b',
          sourceJid: 'feishu:chat#account:account-b',
        },
      ),
    ).toBe('no_active');
    expect(readPayloads()).toEqual([]);
    expect(fs.existsSync(path.join(inputDir(), '_drain'))).toBe(true);
  });

  test('keeps a warm container for the same injected Feishu Bot', async () => {
    await startRunner({
      containerName: 'happyclaw-bot-a',
      feishuCliAccountId: 'account-a',
    });

    expect(
      queue.sendMessage(
        JID,
        'still bot a',
        undefined,
        undefined,
        JID,
        undefined,
        undefined,
        {
          schemaVersion: 1,
          provider: 'feishu',
          channelAccountId: 'account-a',
          sourceJid: 'feishu:chat#account:account-a',
        },
      ),
    ).toBe('sent');
    expect(readPayloads()).toHaveLength(1);
    expect(fs.existsSync(path.join(inputDir(), '_drain'))).toBe(false);
  });

  test('restarts a Bot-bound container for an explicitly unbound request', async () => {
    await startRunner({
      containerName: 'happyclaw-bot-a',
      feishuCliAccountId: 'account-a',
    });

    expect(
      queue.requiresFeishuCliContainerRestart(JID, {
        feishuCliAccountId: null,
      }),
    ).toBe(true);
    expect(
      queue.sendMessage(
        JID,
        'use native unbound config',
        undefined,
        undefined,
        JID,
        undefined,
        undefined,
        undefined,
        undefined,
        { feishuCliAccountId: null },
      ),
    ).toBe('no_active');
    expect(readPayloads()).toEqual([]);
    expect(fs.existsSync(path.join(inputDir(), '_drain'))).toBe(true);
  });

  test('keeps compatibility for internal IPC without an identity constraint', async () => {
    await startRunner({
      containerName: 'happyclaw-bot-a',
      feishuCliAccountId: 'account-a',
    });

    expect(
      queue.sendMessage(JID, 'internal message without turn identity'),
    ).toBe('sent');
    expect(readPayloads()).toHaveLength(1);
    expect(fs.existsSync(path.join(inputDir(), '_drain'))).toBe(false);
  });

  test('does not impose container Bot identity on host-mode runners', async () => {
    await startRunner();

    expect(
      queue.sendMessage(
        JID,
        'host native config',
        undefined,
        undefined,
        JID,
        undefined,
        undefined,
        {
          schemaVersion: 1,
          provider: 'feishu',
          channelAccountId: 'account-b',
          sourceJid: 'feishu:chat#account:account-b',
        },
      ),
    ).toBe('sent');
    expect(readPayloads()).toHaveLength(1);
  });

  test('stamps each warm IPC file with its exact query attempt', async () => {
    await startRunner();
    const runA = queue.getActiveQueryId(JID);
    expect(runA).toBeTruthy();

    inject('m1');
    expect(
      readPayloads().find((payload) => payload.receipt?.cursor.id === 'm1')
        ?.queryRunId,
    ).toBe(runA);

    queue.markRunnerQueryIdle(JID);
    expect(queue.getActiveQueryId(JID)).toBeNull();
    inject('m2');
    const runB = queue.getActiveQueryId(JID);
    expect(runB).toBeTruthy();
    expect(runB).not.toBe(runA);
    expect(
      readPayloads().find((payload) => payload.receipt?.cursor.id === 'm2')
        ?.queryRunId,
    ).toBe(runB);
  });

  test('commits only a contiguous per-chat prefix under out-of-order stdout', async () => {
    await startRunner();
    const first = inject('m1');
    const second = inject('m2');
    const third = inject('m3');
    const commits: Receipt[][] = [];
    const commit = (receipts: Receipt[]) => commits.push(receipts);

    queue.acknowledgeIpcDeliveries(JID, [second], commit);
    expect(commits).toEqual([]);

    queue.acknowledgeIpcDeliveries(JID, [first], commit);
    expect(commits.flatMap((batch) => batch.map((r) => r.cursor.id))).toEqual([
      'm1',
      'm2',
    ]);

    queue.acknowledgeIpcDeliveries(JID, [third], commit);
    expect(commits.flatMap((batch) => batch.map((r) => r.cursor.id))).toEqual([
      'm1',
      'm2',
      'm3',
    ]);

    // Duplicate/stale receipts are harmless after registry deletion.
    queue.acknowledgeIpcDeliveries(JID, [first, second], commit);
    expect(commits.flat()).toHaveLength(3);
  });

  test('newest registration and ack cannot cross an older DB cursor registered later', async () => {
    await startRunner();
    let committedId = 'm0';
    const orderedIds = ['m1', 'm2'];
    queue.setIpcDeliveryCommitEligibilityChecker(
      (receipt) =>
        !orderedIds.some((id) => id > committedId && id < receipt.cursor.id),
    );
    const commits: Receipt[] = [];
    const commit = (receipts: Receipt[]) => {
      for (const receipt of receipts) {
        committedId = receipt.cursor.id;
        commits.push(receipt);
      }
    };

    const newest = inject('m2');
    queue.acknowledgeIpcDeliveries(JID, [newest], commit);
    expect(commits).toEqual([]);

    const older = inject('m1');
    queue.acknowledgeIpcDeliveries(JID, [older], commit);
    expect(commits.map((receipt) => receipt.cursor.id)).toEqual(['m1', 'm2']);
    expect(committedId).toBe('m2');
  });

  test('one healthy receipt commits every exact cursor covered by its DB batch', async () => {
    await startRunner();
    let committedId = 'm0';
    const orderedIds = ['m1', 'm2'];
    queue.setIpcDeliveryCommitEligibilityChecker((receipt) => {
      const covered = new Set(
        (receipt.coveredCursors ?? [receipt.cursor]).map((item) => item.id),
      );
      return !orderedIds.some(
        (id) => id > committedId && id <= receipt.cursor.id && !covered.has(id),
      );
    });
    const commits: Receipt[] = [];
    const commit = (receipts: Receipt[]) => {
      for (const receipt of receipts) {
        committedId = receipt.cursor.id;
        commits.push(receipt);
      }
    };

    const batch = inject('m2', ['m1', 'm2']);
    queue.acknowledgeIpcDeliveries(JID, [batch], commit);

    expect(commits).toEqual([batch]);
    expect(committedId).toBe('m2');
  });

  test('preserves each covered input provider route across accounts and channels', async () => {
    await startRunner();
    const coveredCursors = [
      {
        ...cursor('m1'),
        sourceJid: 'feishu:oc_chat#account:account-a',
      },
      {
        ...cursor('m2'),
        sourceJid: 'telegram:-100123#account:account-b',
      },
    ];

    expect(
      queue.sendMessage(JID, 'mixed', undefined, undefined, JID, undefined, {
        chatJid: JID,
        coveredCursors,
        cursor: coveredCursors[1],
      }),
    ).toBe('sent');

    const receipt = readPayloads().find(
      (payload) => payload.receipt?.cursor.id === 'm2',
    )?.receipt;
    expect(receipt?.coveredCursors).toEqual(coveredCursors);
    expect(receipt?.cursor.sourceJid).toBe(
      'telegram:-100123#account:account-b',
    );
  });

  test('rejects an inconsistent terminal before writing an IPC claim', async () => {
    await startRunner();

    expect(
      queue.sendMessage(JID, 'invalid', undefined, undefined, JID, undefined, {
        chatJid: JID,
        coveredCursors: [cursor('m2')],
        cursor: cursor('m1'),
      }),
    ).toBe('no_active');
    expect(readPayloads()).toEqual([]);
  });

  test('pre-publish admission rejection leaves no IPC file or pending receipt', async () => {
    await startRunner();
    const injected = vi.fn();
    const admit = vi.fn(() => false as const);
    const abandoned = vi.fn();
    queue.setOnUnacknowledgedIpcDeliveries(abandoned);

    expect(
      queue.sendMessage(
        JID,
        'must-not-run',
        undefined,
        injected,
        JID,
        undefined,
        {
          chatJid: JID,
          coveredCursors: [cursor('m1')],
          cursor: cursor('m1'),
        },
        undefined,
        admit,
      ),
    ).toBe('no_active');

    expect(admit).toHaveBeenCalledTimes(1);
    expect(injected).not.toHaveBeenCalled();
    expect(readPayloads()).toEqual([]);

    releaseRun?.();
    await tick();
    await tick();
    expect(abandoned).not.toHaveBeenCalled();
  });

  test('completes admission before publishing the runner-visible IPC file', async () => {
    await startRunner();
    const order: string[] = [];

    expect(
      queue.sendMessage(
        JID,
        'bind-before-publish',
        undefined,
        () => {
          order.push('injected');
          expect(readPayloads()).toHaveLength(1);
        },
        JID,
        'scheduled-task',
        {
          chatJid: JID,
          coveredCursors: [cursor('scheduled-prompt')],
          cursor: cursor('scheduled-prompt'),
        },
        undefined,
        (receipt) => {
          order.push('admitted');
          expect(receipt?.deliveryId).toBeTruthy();
          expect(readPayloads()).toEqual([]);
          return {};
        },
      ),
    ).toBe('sent');

    expect(order).toEqual(['admitted', 'injected']);
  });

  test('disk publish failure rolls back admission and removes the temp file', async () => {
    await startRunner();
    const rollback = vi.fn();
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk publish failed');
    });

    expect(
      queue.sendMessage(
        JID,
        'rollback-me',
        undefined,
        undefined,
        JID,
        undefined,
        {
          chatJid: JID,
          coveredCursors: [cursor('m1')],
          cursor: cursor('m1'),
        },
        undefined,
        () => ({ rollback }),
      ),
    ).toBe('no_active');

    rename.mockRestore();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(inputDir())).toEqual([]);
  });

  test('post-publish callback failure cannot misreport a visible IPC file', async () => {
    await startRunner();

    expect(
      queue.sendMessage(
        JID,
        'published',
        undefined,
        () => {
          throw new Error('projection callback failed');
        },
        JID,
        undefined,
        {
          chatJid: JID,
          coveredCursors: [cursor('m1')],
          cursor: cursor('m1'),
        },
      ),
    ).toBe('sent');
    expect(readPayloads()).toHaveLength(1);
  });

  test('post-publish eligibility failure preserves admission and reports sent', async () => {
    await startRunner();
    const rollback = vi.fn();
    queue.setIpcDeliveryCommitEligibilityChecker(() => {
      throw new Error('eligibility storage unavailable');
    });

    expect(
      queue.sendMessage(
        JID,
        'published-before-bookkeeping-error',
        undefined,
        undefined,
        JID,
        undefined,
        {
          chatJid: JID,
          coveredCursors: [cursor('m1')],
          cursor: cursor('m1'),
        },
        undefined,
        () => ({ rollback }),
      ),
    ).toBe('sent');

    expect(readPayloads()).toHaveLength(1);
    expect(rollback).not.toHaveBeenCalled();
  });

  test('an uncovered gap cannot commit and replays in DB order after runner failure', async () => {
    await startRunner();
    const orderedIds = ['m1', 'm2', 'm3'];
    let committedId = 'm0';
    queue.setIpcDeliveryCommitEligibilityChecker((receipt) => {
      const covered = new Set(
        (receipt.coveredCursors ?? [receipt.cursor]).map((item) => item.id),
      );
      return !orderedIds.some(
        (id) => id > committedId && id <= receipt.cursor.id && !covered.has(id),
      );
    });
    const commits: Receipt[] = [];
    const recovered: Receipt[][] = [];
    queue.setOnUnacknowledgedIpcDeliveries((_jid, receipts) => {
      recovered.push(receipts);
    });

    const gapped = inject('m3', ['m1', 'm3']);
    queue.acknowledgeIpcDeliveries(JID, [gapped], (receipts) => {
      commits.push(...receipts);
    });
    expect(commits).toEqual([]);

    releaseRun?.();
    await tick();
    await tick();

    expect(recovered).toEqual([[gapped]]);
    expect(orderedIds.filter((id) => id > committedId)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  test('newer batch stays blocked until an older batch closes the DB prefix', async () => {
    await startRunner();
    let committedId = 'm0';
    const orderedIds = ['m1', 'm2', 'm3', 'm4'];
    queue.setIpcDeliveryCommitEligibilityChecker((receipt) => {
      const covered = new Set(
        (receipt.coveredCursors ?? [receipt.cursor]).map((item) => item.id),
      );
      return !orderedIds.some(
        (id) => id > committedId && id <= receipt.cursor.id && !covered.has(id),
      );
    });
    const commits: Receipt[] = [];
    const commit = (receipts: Receipt[]) => {
      for (const receipt of receipts) {
        committedId = receipt.cursor.id;
        commits.push(receipt);
      }
    };

    const newer = inject('m4', ['m3', 'm4']);
    queue.acknowledgeIpcDeliveries(JID, [newer], commit);
    expect(commits).toEqual([]);

    const older = inject('m2', ['m1', 'm2']);
    queue.acknowledgeIpcDeliveries(JID, [older], commit);

    expect(commits.map((receipt) => receipt.cursor.id)).toEqual(['m2', 'm4']);
    expect(committedId).toBe('m4');
  });

  test('cold/direct cursor advance actively flushes an already-acked newer delivery', async () => {
    await startRunner();
    let committedId = 'm0';
    const orderedIds = ['m1', 'm2'];
    queue.setIpcDeliveryCommitEligibilityChecker(
      (receipt) =>
        !orderedIds.some((id) => id > committedId && id < receipt.cursor.id),
    );
    const commits: Receipt[] = [];
    const commit = (receipts: Receipt[]) => {
      for (const receipt of receipts) {
        committedId = receipt.cursor.id;
        commits.push(receipt);
      }
    };

    const newest = inject('m2');
    queue.acknowledgeIpcDeliveries(JID, [newest], commit);
    expect(commits).toEqual([]);

    committedId = 'm1'; // cold inputTurnCompleted/direct completion chokepoint
    queue.flushAcknowledgedIpcDeliveries(JID, commit);
    expect(commits.map((receipt) => receipt.cursor.id)).toEqual(['m2']);
  });

  test('runner exit removes stale files before requesting DB replay', async () => {
    await startRunner();
    const receipt = inject('crash');
    const recovered: Receipt[][] = [];
    queue.setOnUnacknowledgedIpcDeliveries((_jid, receipts) => {
      expect(readPayloads()).toEqual([]);
      recovered.push(receipts);
    });

    releaseRun?.();
    await tick();
    await tick();

    expect(recovered).toEqual([[receipt]]);
  });

  test('explicit stop abandons instead of replaying accepted deliveries', async () => {
    await startRunner();
    const receipt = inject('cancelled');
    const abandoned: Receipt[][] = [];
    const recovered: Receipt[][] = [];
    queue.setOnAbandonedIpcDeliveries((_jid, receipts) => {
      abandoned.push(receipts);
    });
    queue.setOnUnacknowledgedIpcDeliveries((_jid, receipts) => {
      recovered.push(receipts);
    });

    await queue.stopGroup(JID, { force: true });

    expect(abandoned).toEqual([[receipt]]);
    expect(recovered).toEqual([]);
    expect(readPayloads()).toEqual([]);
  });
});
