import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const DATA_DIR = '/tmp/happyclaw-group-queue-mutation-pause';

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
vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Two chats bound to one workspace folder, and one session reached from both
// (sibling lane JIDs sharing a serialization key).
const WEB_JID = 'web:mutation-a';
const IM_JID = 'feishu:mutation-b';
const SESSION_ID = 'session';
const WEB_LANE = `${WEB_JID}#agent:${SESSION_ID}`;
const IM_LANE = `${IM_JID}#agent:${SESSION_ID}`;
const DESCENDANT_JID = `${IM_JID}#agent:new-run`;
const FOLDER = 'mutation-shared-folder';

let queue: InstanceType<typeof GroupQueue>;
let taskSeq = 0;

function enqueueTurn(
  jid: string,
  fn: () => Promise<void | boolean>,
  onDropped?: () => void,
): boolean {
  return queue.enqueueTask(jid, `turn-${++taskSeq}`, fn, { onDropped });
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  queue = new GroupQueue();
  queue.setSerializationKeyResolver((jid: string) => {
    if (jid === WEB_JID || jid === IM_JID) return FOLDER;
    if (jid === WEB_LANE || jid === IM_LANE) return `${FOLDER}#${SESSION_ID}`;
    return jid;
  });
});

afterEach(async () => {
  await queue.shutdown(0);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('GroupQueue mutation pause', () => {
  test('batch pause preserves sibling/new-session work and resumes exactly once', async () => {
    const laneRuns = new Map<string, number>();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const turn = (jid: string) => async () => {
      laneRuns.set(jid, (laneRuns.get(jid) ?? 0) + 1);
      if (jid === WEB_LANE && laneRuns.get(jid) === 1) await activeGate;
      return true;
    };

    enqueueTurn(WEB_LANE, turn(WEB_LANE));
    await tick();
    queue.registerProcess(
      WEB_LANE,
      {
        killed: false,
        kill: () => {
          releaseActive();
          return true;
        },
      } as never,
      { containerName: null, groupFolder: FOLDER, agentId: SESSION_ID },
    );

    const token = queue.pauseGroupsForMutation([WEB_JID, IM_JID]);
    expect(queue.hasActiveRunnerForMessage(IM_LANE)).toBe(false);
    expect(queue.sendMessage(IM_LANE, 'must not hit old runner')).toBe(
      'no_active',
    );
    expect(
      fs.existsSync(
        path.join(DATA_DIR, 'ipc', FOLDER, 'agents', SESSION_ID, 'input'),
      ),
    ).toBe(false);

    const stopFirst = queue.stopGroup(WEB_LANE, {
      force: true,
      preserveQueuedWork: true,
    });

    // These arrive after the first stop has begun but before the sibling lane
    // is quiesced. The folder-wide synchronous token must already cover both
    // and any newly-created session.
    enqueueTurn(IM_LANE, turn(IM_LANE));
    let taskRuns = 0;
    let dropped = 0;
    expect(
      queue.enqueueTask(
        DESCENDANT_JID,
        'manual-task',
        async () => {
          taskRuns++;
        },
        { onDropped: () => dropped++ },
      ),
    ).toBe(true);

    await stopFirst;
    expect(queue.getRecentStopDisposition(WEB_LANE)).toBe('preserve');
    await queue.stopGroup(IM_LANE, {
      force: true,
      preserveQueuedWork: true,
    });
    await queue.stopGroup(DESCENDANT_JID, {
      force: true,
      preserveQueuedWork: true,
    });
    expect(laneRuns.get(IM_LANE)).toBeUndefined();
    expect(taskRuns).toBe(0);
    expect(dropped).toBe(0);

    queue.resumeGroupsAfterMutation(token);
    // The mutation's stop markers go with its pause (both JIDs share a lane).
    expect(queue.isRecentlyStopped(WEB_LANE)).toBe(false);
    expect(queue.isRecentlyStopped(IM_LANE)).toBe(false);
    await tick();
    await tick();
    await tick();

    expect(laneRuns.get(WEB_LANE)).toBe(2);
    expect(laneRuns.get(IM_LANE)).toBe(1);
    expect(taskRuns).toBe(1);
    expect(dropped).toBe(0);
  });

  test('mutation stop resumes an interrupted conversation that reported failure', async () => {
    const agentJid = `${WEB_JID}#agent:conversation`;
    queue.setSerializationKeyResolver((jid: string) =>
      jid === WEB_JID || jid.startsWith(`${WEB_JID}#`) ? FOLDER : jid,
    );

    let taskRuns = 0;
    let releaseFirst!: () => void;
    const firstRunStopped = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    queue.enqueueTask(agentJid, 'agent-conversation', async () => {
      taskRuns += 1;
      if (taskRuns === 1) {
        await firstRunStopped;
        return false;
      }
      return true;
    });
    await tick();
    queue.registerProcess(
      agentJid,
      {
        killed: false,
        kill: () => {
          releaseFirst();
          return true;
        },
      } as never,
      { containerName: null, groupFolder: FOLDER, agentId: 'conversation' },
    );

    const token = queue.pauseGroupsForMutation([WEB_JID]);
    await queue.stopGroup(agentJid, {
      force: true,
      preserveQueuedWork: true,
    });
    expect(taskRuns).toBe(1);
    // The monitor reports the parked turn as the lane's queued work.
    expect(
      queue.getStatus().groups.find((group) => group.jid === agentJid),
    ).toMatchObject({ pendingMessages: true, pendingTasks: 1 });

    queue.resumeGroupsAfterMutation(token);
    await tick();
    await tick();
    expect(taskRuns).toBe(2);
    expect(queue.getRetryCount(agentJid)).toBe(0);
  });

  test('overlapping mutation tokens keep work parked until the last release', async () => {
    let taskRuns = 0;
    expect(queue.isGroupMutationPaused(WEB_JID)).toBe(false);
    const first = queue.pauseGroupsForMutation([WEB_JID]);
    const second = queue.pauseGroupsForMutation([IM_JID]);
    expect(queue.isGroupMutationPaused(WEB_JID)).toBe(true);
    expect(
      queue.isGroupMutationPaused(`${WEB_JID}#agent:created-during-mutation`),
    ).toBe(true);
    queue.enqueueTask(`${WEB_JID}#agent:overlap`, 'overlap', async () => {
      taskRuns++;
    });

    queue.resumeGroupsAfterMutation(first);
    await tick();
    expect(taskRuns).toBe(0);
    expect(queue.isGroupMutationPaused(IM_JID)).toBe(true);

    queue.resumeGroupsAfterMutation(second);
    await tick();
    expect(taskRuns).toBe(1);
    expect(queue.isGroupMutationPaused(WEB_JID)).toBe(false);
  });

  test('preserve stop requires a mutation pause token', async () => {
    await expect(
      queue.stopGroup(WEB_LANE, { preserveQueuedWork: true }),
    ).rejects.toThrow(
      'preserveQueuedWork requires an active mutation pause token',
    );
  });

  test('stop waits for runner teardown and suppresses the killed run retry', async () => {
    let finishRun!: (success: boolean) => void;
    const runFinished = new Promise<boolean>((resolve) => {
      finishRun = resolve;
    });
    enqueueTurn(WEB_LANE, () => runFinished);
    await tick();
    queue.registerProcess(
      WEB_LANE,
      { killed: false, kill: () => true } as never,
      { containerName: null, groupFolder: FOLDER, agentId: SESSION_ID },
    );

    let stopResolved = false;
    const stopped = queue.stopGroup(WEB_LANE, { force: true }).then(() => {
      stopResolved = true;
    });
    await tick();
    expect(stopResolved).toBe(false);

    // Mirrors docker exit 137: the turn reports failure only after the child
    // close handler unwinds. stopGroup must await that teardown and the
    // killed run must not install a fresh backoff retry after stop cleared it.
    finishRun(false);
    await stopped;
    expect(stopResolved).toBe(true);
    expect(queue.getStatus()).toMatchObject({
      activeCount: 0,
      waitingCount: 0,
    });
    const state = (
      queue as unknown as {
        groups: Map<
          string,
          {
            retryTimer: ReturnType<typeof setTimeout> | null;
            teardownWaiters: Set<unknown>;
          }
        >;
      }
    ).groups.get(WEB_LANE);
    expect(state?.retryTimer).toBeNull();
    expect(state?.teardownWaiters.size).toBe(0);
    expect(queue.getRecentStopDisposition(WEB_LANE)).toBe('discard');

    // The next user request is a fresh lifecycle, not another discarded turn.
    enqueueTurn(WEB_LANE, async () => true);
    await tick();
    expect(queue.getRecentStopDisposition(WEB_LANE)).toBe('none');
  });

  test('terminal discard drops parked work while preserving overlapping pause semantics', async () => {
    let turnRuns = 0;
    let oldTaskRuns = 0;
    let newTaskRuns = 0;
    let dropped = 0;
    const turn = async () => {
      turnRuns++;
      return true;
    };

    const deleting = queue.pauseGroupsForMutation([WEB_JID]);
    const overlapping = queue.pauseGroupsForMutation([IM_JID]);
    enqueueTurn(WEB_LANE, turn);
    queue.enqueueTask(
      DESCENDANT_JID,
      'old-task',
      async () => {
        oldTaskRuns++;
      },
      { onDropped: () => dropped++ },
    );

    queue.discardGroupsAfterMutation(deleting);
    await tick();
    expect(turnRuns).toBe(0);
    expect(oldTaskRuns).toBe(0);
    expect(dropped).toBe(1);

    // The resource has been terminally deleted. Work arriving through stale
    // producers while another overlapping pause is still live is dropped and
    // must not resurrect when that final token resumes.
    expect(
      queue.enqueueTask(
        DESCENDANT_JID,
        'new-task',
        async () => {
          newTaskRuns++;
        },
        { onDropped: () => dropped++ },
      ),
    ).toBe(false);
    expect(enqueueTurn(IM_LANE, turn)).toBe(false);
    await tick();
    expect(newTaskRuns).toBe(0);

    queue.resumeGroupsAfterMutation(overlapping);
    await tick();
    await tick();
    expect(turnRuns).toBe(0);
    expect(oldTaskRuns).toBe(0);
    expect(newTaskRuns).toBe(0);
    expect(dropped).toBe(2);

    expect(
      queue.enqueueTask(
        `${WEB_JID}#agent:late-after-resume`,
        'late',
        async () => {
          newTaskRuns++;
        },
        { onDropped: () => dropped++ },
      ),
    ).toBe(false);
    await tick();
    expect(newTaskRuns).toBe(0);
    expect(dropped).toBe(3);
  });

  test('stable mutation key discards parked descendants after resolver data is deleted', async () => {
    let resolverDataExists = true;
    let dropped = 0;
    let taskRuns = 0;
    queue.setSerializationKeyResolver((jid: string) => {
      if (resolverDataExists && (jid === WEB_JID || jid === IM_JID)) {
        return FOLDER;
      }
      return jid;
    });
    const token = queue.pauseGroupsForMutation([WEB_JID, IM_JID]);
    queue.enqueueTask(
      DESCENDANT_JID,
      'parked-before-delete',
      async () => {
        taskRuns++;
      },
      { onDropped: () => dropped++ },
    );

    // Mirrors DELETE committing DB/cache removal before its mutation cleanup.
    resolverDataExists = false;
    queue.discardGroupsAfterMutation(token);
    await tick();

    expect(dropped).toBe(1);
    expect(taskRuns).toBe(0);

    // This descendant did not exist when pause/discard stamped GroupState.
    // The process-lifetime base alias+tombstone must still reject it after the
    // external resolver/cache has disappeared.
    expect(
      queue.enqueueTask(
        `${WEB_JID}#agent:brand-new`,
        'brand-new',
        async () => {
          taskRuns++;
        },
        { onDropped: () => dropped++ },
      ),
    ).toBe(false);
    await tick();
    expect(dropped).toBe(2);
    expect(taskRuns).toBe(0);
  });

  test('runtime safety block parks new work until cleanup is explicitly confirmed', async () => {
    let runs = 0;
    queue.blockGroupsForRuntimeSafety(
      [WEB_JID, IM_JID],
      'post-commit stop failed',
    );
    expect(queue.isGroupRuntimeSafetyBlocked(WEB_JID)).toBe(true);
    enqueueTurn(IM_LANE, async () => {
      runs++;
    });
    await tick();
    expect(runs).toBe(0);

    queue.unblockGroupsForRuntimeSafety([WEB_JID, IM_JID]);
    await tick();
    await tick();
    expect(queue.isGroupRuntimeSafetyBlocked(WEB_JID)).toBe(false);
    expect(runs).toBe(1);
  });

  test('runtime safety sources release independently and drain only after the final source', async () => {
    let runs = 0;
    queue.blockGroupsForRuntimeSafety(
      [WEB_JID, IM_JID],
      'capability repair pending',
    );
    queue.blockGroupsForRuntimeSafety(
      [WEB_JID, IM_JID],
      'provider repair pending',
      'provider-config-mutation',
    );
    enqueueTurn(IM_LANE, async () => {
      runs++;
    });

    queue.unblockGroupsForRuntimeSafety(
      [WEB_JID, IM_JID],
      'provider-config-mutation',
    );
    await tick();
    await tick();
    expect(queue.isGroupRuntimeSafetyBlocked(WEB_JID)).toBe(true);
    expect(runs).toBe(0);

    queue.unblockGroupsForRuntimeSafety([WEB_JID, IM_JID]);
    await tick();
    await tick();
    expect(queue.isGroupRuntimeSafetyBlocked(WEB_JID)).toBe(false);
    expect(runs).toBe(1);
  });
});
