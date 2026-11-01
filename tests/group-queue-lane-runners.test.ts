/**
 * Lane runners the queue starts and retires itself: a runner that serves no
 * conversation input (a terminal warm-up, `acceptsInput: false`) and the
 * relaunch after restartGroup through the host's lane starter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const DATA_DIR = '/tmp/happyclaw-group-queue-lane-runners';

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
const settings = vi.hoisted(() => ({ maxConcurrentContainers: 10 }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => settings,
}));
vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');
type Queue = InstanceType<typeof GroupQueue>;

const FOLDER = 'lane-runners';
const AGENT_ID = 'terminal';
const LANE = `web:${FOLDER}#agent:${AGENT_ID}`;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function inputDir(agentId: string | null = AGENT_ID): string {
  return agentId
    ? path.join(DATA_DIR, 'ipc', FOLDER, 'agents', agentId, 'input')
    : path.join(DATA_DIR, 'ipc', FOLDER, 'input');
}

let queue: Queue;
const exits: Array<() => void> = [];
/** Exit of the runner each lane has registered. */
const runnerExits = new Map<string, () => void>();

/** Let runners honour _close by exiting, as the agent-runner does. */
function exitOnClose(): void {
  const close = queue.closeStdin.bind(queue);
  vi.spyOn(queue, 'closeStdin').mockImplementation((jid: string) => {
    close(jid);
    runnerExits.get(jid)?.();
  });
}

/** Start a task whose runner lives until `exit` resolves it. */
function startRunner(
  jid: string,
  taskId: string,
  options: {
    acceptsInput?: boolean;
    register?: boolean;
    agentId?: string | null;
    containerName?: string | null;
  } = {},
): { exit: () => void; ran: () => boolean } {
  let exit!: () => void;
  let ran = false;
  const done = new Promise<void>((resolve) => {
    exit = resolve;
  });
  exits.push(exit);
  queue.enqueueTask(
    jid,
    taskId,
    async () => {
      ran = true;
      if (options.register ?? true) register(jid, exit, options);
      await done;
    },
    { acceptsInput: options.acceptsInput },
  );
  return { exit: () => exit(), ran: () => ran };
}

function register(
  jid: string,
  exit: () => void,
  options: { agentId?: string | null; containerName?: string | null } = {},
): void {
  runnerExits.set(jid, exit);
  queue.registerProcess(
    jid,
    {
      killed: false,
      kill: () => {
        exit();
        return true;
      },
    } as never,
    {
      containerName: options.containerName ?? null,
      groupFolder: FOLDER,
      agentId:
        options.agentId === null ? undefined : (options.agentId ?? AGENT_ID),
    },
  );
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  queue = new GroupQueue();
  queue.setIpcDeliveryCommitEligibilityChecker(() => true);
});

afterEach(async () => {
  for (const exit of exits.splice(0)) exit();
  runnerExits.clear();
  await settle();
  settings.maxConcurrentContainers = 10;
  vi.restoreAllMocks();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('a runner that serves no conversation input', () => {
  test('takes no IPC turn', async () => {
    startRunner(LANE, 'terminal-warmup', { acceptsInput: false });
    await settle();

    expect(queue.hasActiveRunnerForMessage(LANE)).toBe(false);
    expect(queue.reserveNextQuery(LANE)).toBeNull();
    expect(queue.sendMessage(LANE, 'user turn')).toBe('no_active');
    expect(fs.existsSync(inputDir())).toBe(false);
    // It never announced a conversation query.
    expect(queue.getActiveQueryId(LANE)).toBeNull();
  });

  test('a conversation runner on the lane takes the IPC turn', async () => {
    startRunner(LANE, 'agent-conversation');
    await settle();

    expect(queue.hasActiveRunnerForMessage(LANE)).toBe(true);
    expect(queue.sendMessage(LANE, 'user turn')).toBe('sent');
  });

  test('a turn queued for its lane closes it at once and runs after it exits', async () => {
    const warmup = startRunner(LANE, 'terminal-warmup', {
      acceptsInput: false,
    });
    await settle();
    expect(fs.existsSync(path.join(inputDir(), '_close'))).toBe(false);

    const turn = startRunner(LANE, 'agent-conversation');
    expect(fs.existsSync(path.join(inputDir(), '_close'))).toBe(true);
    await settle();
    expect(turn.ran()).toBe(false);

    // The runner honours _close by exiting; the queued turn takes the lane.
    warmup.exit();
    await settle();
    expect(turn.ran()).toBe(true);
    expect(queue.hasActiveRunnerForMessage(LANE)).toBe(true);
  });

  test('a turn queued on a sibling JID of the lane closes it too', async () => {
    const sibling = `feishu:oc_x#agent:${AGENT_ID}`;
    queue.setSerializationKeyResolver((jid) =>
      jid === LANE || jid === sibling ? `${FOLDER}#${AGENT_ID}` : jid,
    );
    startRunner(LANE, 'terminal-warmup', { acceptsInput: false });
    await settle();

    startRunner(sibling, 'agent-conversation');
    expect(fs.existsSync(path.join(inputDir(), '_close'))).toBe(true);
  });

  test('a turn queued while it boots closes it once it registers', async () => {
    const warmup = startRunner(LANE, 'terminal-warmup', {
      acceptsInput: false,
      register: false,
    });
    await settle();
    // No IPC path yet: nothing to close.
    const turn = startRunner(LANE, 'agent-conversation');
    expect(fs.existsSync(path.join(inputDir(), '_close'))).toBe(false);

    register(LANE, warmup.exit);
    expect(fs.existsSync(path.join(inputDir(), '_close'))).toBe(true);
    warmup.exit();
    await settle();
    expect(turn.ran()).toBe(true);
  });

  test('another lane queuing work leaves it running', async () => {
    startRunner(LANE, 'terminal-warmup', { acceptsInput: false });
    await settle();
    startRunner(`web:${FOLDER}#agent:other`, 'agent-conversation', {
      agentId: 'other',
    });
    await settle();
    expect(fs.existsSync(path.join(inputDir(), '_close'))).toBe(false);
  });

  test('is reported with its container and gives an idle slot back to waiting work', async () => {
    settings.maxConcurrentContainers = 1;
    startRunner(LANE, 'terminal-warmup', {
      acceptsInput: false,
      containerName: 'happyclaw-terminal',
    });
    await settle();
    expect(
      queue.getStatus().groups.find((group) => group.jid === LANE),
    ).toMatchObject({
      active: true,
      containerName: 'happyclaw-terminal',
      queryInFlight: false,
    });

    const other = startRunner(`web:${FOLDER}#agent:other`, 'other-turn', {
      agentId: 'other',
    });
    // The pool is full: the idle warm-up's slot is reclaimed for the turn.
    expect(fs.existsSync(path.join(inputDir(), '_close'))).toBe(true);
    expect(other.ran()).toBe(false);
  });

  test('an idle runner whose lane has a turn queued on a sibling JID keeps its slot', async () => {
    settings.maxConcurrentContainers = 1;
    const sibling = `feishu:oc_x#agent:${AGENT_ID}`;
    queue.setSerializationKeyResolver((jid) =>
      jid === LANE || jid === sibling ? `${FOLDER}#${AGENT_ID}` : jid,
    );
    startRunner(LANE, 'agent-conversation', { containerName: 'c-lane' });
    await settle();
    queue.markRunnerQueryIdle(LANE);
    startRunner(sibling, 'sibling-turn');

    // Closing it would only hand the slot to its own lane's queued turn.
    startRunner(`web:${FOLDER}#agent:other`, 'other-turn', {
      agentId: 'other',
    });
    expect(fs.existsSync(path.join(inputDir(), '_close'))).toBe(false);
  });

  test('a stop ends it like any runner', async () => {
    startRunner(LANE, 'terminal-warmup', { acceptsInput: false });
    await settle();
    await queue.stopGroup(LANE, { force: true });
    expect(queue.getStatus().activeCount).toBe(0);
  });
});

describe('restarting a lane', () => {
  test('runs the lane queued turn and asks the host to start the lane', async () => {
    const starts: string[] = [];
    queue.setLaneStarter((jid) => starts.push(jid));
    exitOnClose();
    const running = startRunner(LANE, 'agent-conversation');
    await settle();
    const queued = startRunner(LANE, 'queued-turn');
    await settle();
    expect(queued.ran()).toBe(false);

    await queue.restartGroup(LANE);
    await settle();
    expect(running.ran()).toBe(true);
    expect(queued.ran()).toBe(true);
    expect(starts).toEqual([LANE]);
    // The queued turn started after the teardown, so the restart never
    // mistook it for the runner it was stopping.
    expect(queue.hasActiveRunnerForMessage(LANE)).toBe(true);
  });

  test('without a lane starter the restart still tears the runner down', async () => {
    exitOnClose();
    startRunner(LANE, 'agent-conversation');
    await settle();
    await queue.restartGroup(LANE);
    expect(queue.getStatus().activeCount).toBe(0);
  });
});

describe('IPC input left behind by a runner without a session', () => {
  test('starts its lane through the host', async () => {
    const starts: string[] = [];
    queue.setLaneStarter((jid) => starts.push(jid));
    const runner = startRunner(LANE, 'terminal-warmup', {
      acceptsInput: false,
      agentId: null,
    });
    await settle();
    fs.mkdirSync(inputDir(null), { recursive: true });
    fs.writeFileSync(path.join(inputDir(null), 'left.json'), '{}');

    runner.exit();
    await settle();
    expect(starts).toEqual([LANE]);
  });
});

describe('lane state after the work is done', () => {
  test.each([LANE, `web:${FOLDER}`])(
    'is dropped once %s is fully idle',
    async (jid) => {
      const runner = startRunner(jid, 'turn');
      await settle();
      expect(queue.getStatus().groups.map((group) => group.jid)).toEqual([jid]);

      runner.exit();
      await settle();
      expect(queue.getStatus().groups).toEqual([]);
    },
  );
});
