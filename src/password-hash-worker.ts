import { createRequire } from 'node:module';
import os from 'node:os';
import { Worker } from 'node:worker_threads';

import bcrypt from 'bcryptjs';

import { logger } from './logger.js';

/**
 * bcrypt at cost 12 is ~350 ms of pure JS per hash/compare. bcryptjs' async
 * API still runs on the main thread, yielding only every ~100 ms, and N
 * concurrent logins queue their slices into the same loop iteration — four
 * parallel logins measured a 400 ms event-loop stall for every Web request,
 * WebSocket and IM connector in the process.
 *
 * The work now runs in a small worker_threads pool. Same library, cost factor
 * and `$2b$` hash format, so existing hashes verify unchanged. If a worker
 * cannot start, crashes or hangs, the affected call falls back to the
 * in-thread async API: slower for the event loop, never a failed login.
 *
 * The worker is an inline CommonJS script (`eval: true`) that `require`s the
 * bcryptjs path resolved here, so it needs no sibling .js file and behaves the
 * same under tsx (`src/*.ts`), compiled `dist/*.js` and vitest.
 */

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.on('message', (msg) => {
  try {
    const result =
      msg.op === 'hash'
        ? bcrypt.hashSync(msg.password, msg.rounds)
        : bcrypt.compareSync(msg.password, msg.hash);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      ok: false,
      message: err && err.message ? String(err.message) : String(err),
    });
  }
});
`;

/** One task is ~350 ms; this only trips for a wedged or starved worker. */
const DEFAULT_TASK_TIMEOUT_MS = 15_000;
/** Workers that die before completing a single task count as start failures. */
const MAX_CONSECUTIVE_START_FAILURES = 3;

function defaultPoolSize(): number {
  // Keep at least one core for the main thread; never more than two workers,
  // login bursts beyond that are better queued than allowed to eat the box.
  return Math.max(1, Math.min(2, os.availableParallelism() - 1));
}

type HashTask = {
  id: number;
  op: 'hash';
  password: string;
  rounds: number;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
};
type CompareTask = {
  id: number;
  op: 'compare';
  password: string;
  hash: string;
  resolve: (value: boolean) => void;
  reject: (err: Error) => void;
};
type Task = HashTask | CompareTask;

interface Slot {
  worker: Worker;
  task: Task | null;
  timer: NodeJS.Timeout | null;
  completed: number;
  gone: boolean;
}

type WorkerReply =
  | { id: number; ok: true; result: string | boolean }
  | { id: number; ok: false; message: string };

let poolSize = defaultPoolSize();
let taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS;
let workerSource = WORKER_SOURCE;
let bcryptPath: string | null | undefined;

const slots: Slot[] = [];
const queue: Task[] = [];
let nextTaskId = 1;
let consecutiveStartFailures = 0;
let disabled = false;
let fallbackCount = 0;

function resolveBcryptPath(): string | null {
  if (bcryptPath !== undefined) return bcryptPath;
  try {
    // The `require` condition of bcryptjs' exports is its UMD build, which a
    // plain CommonJS worker script can load.
    bcryptPath = createRequire(import.meta.url).resolve('bcryptjs');
  } catch (err) {
    logger.warn(
      { err },
      'password hashing: cannot resolve bcryptjs for worker, using main thread',
    );
    bcryptPath = null;
  }
  return bcryptPath;
}

function runInThread(task: Task): void {
  fallbackCount += 1;
  if (task.op === 'hash') {
    bcrypt.hash(task.password, task.rounds).then(task.resolve, task.reject);
  } else {
    bcrypt.compare(task.password, task.hash).then(task.resolve, task.reject);
  }
}

function disablePool(reason: unknown): void {
  if (disabled) return;
  disabled = true;
  logger.warn(
    { err: reason },
    'password hashing: worker pool disabled, falling back to main thread',
  );
  for (const task of queue.splice(0)) runInThread(task);
}

function noteStartFailure(reason: unknown): void {
  consecutiveStartFailures += 1;
  if (consecutiveStartFailures >= MAX_CONSECUTIVE_START_FAILURES) {
    disablePool(reason);
  }
}

function retire(slot: Slot, reason: unknown): void {
  if (slot.gone) return;
  slot.gone = true;
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  const index = slots.indexOf(slot);
  if (index !== -1) slots.splice(index, 1);
  const task = slot.task;
  slot.task = null;
  if (slot.completed === 0) noteStartFailure(reason);
  if (task) {
    logger.warn(
      { err: reason },
      'password hashing: worker lost mid-task, finishing on main thread',
    );
    runInThread(task);
  }
  void slot.worker.terminate().catch(() => {});
  dispatch();
}

function spawn(): Slot | null {
  const modulePath = resolveBcryptPath();
  if (!modulePath) {
    disablePool(new Error('bcryptjs not resolvable'));
    return null;
  }
  let worker: Worker;
  try {
    worker = new Worker(workerSource, {
      eval: true,
      workerData: { bcryptPath: modulePath },
      // Don't boot the parent's loaders (tsx, vitest) in a plain CJS script.
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
  } catch (err) {
    noteStartFailure(err);
    return null;
  }
  // Idle workers must not keep short-lived CLIs (reset-admin) alive; a busy
  // one is ref'd so a pending hash is not abandoned at exit.
  worker.unref();
  const slot: Slot = {
    worker,
    task: null,
    timer: null,
    completed: 0,
    gone: false,
  };
  worker.on('message', (reply: WorkerReply) => onReply(slot, reply));
  worker.on('error', (err) => retire(slot, err));
  worker.on('exit', (code) =>
    retire(slot, new Error(`password hash worker exited with code ${code}`)),
  );
  slots.push(slot);
  return slot;
}

function onReply(slot: Slot, reply: WorkerReply): void {
  const task = slot.task;
  if (!task || task.id !== reply.id) return;
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  slot.task = null;
  slot.completed += 1;
  consecutiveStartFailures = 0;
  slot.worker.unref();
  if (reply.ok) {
    (task.resolve as (value: string | boolean) => void)(reply.result);
  } else {
    task.reject(new Error(reply.message));
  }
  dispatch();
}

function assign(slot: Slot, task: Task): void {
  slot.task = task;
  slot.worker.ref();
  slot.timer = setTimeout(() => {
    retire(
      slot,
      new Error(`password hash worker timed out after ${taskTimeoutMs} ms`),
    );
  }, taskTimeoutMs);
  slot.timer.unref();
  const message =
    task.op === 'hash'
      ? {
          id: task.id,
          op: task.op,
          password: task.password,
          rounds: task.rounds,
        }
      : { id: task.id, op: task.op, password: task.password, hash: task.hash };
  try {
    slot.worker.postMessage(message);
  } catch (err) {
    retire(slot, err);
  }
}

function dispatch(): void {
  while (queue.length > 0) {
    if (disabled) {
      for (const task of queue.splice(0)) runInThread(task);
      return;
    }
    let slot = slots.find((s) => !s.task && !s.gone);
    if (!slot && slots.length < poolSize) slot = spawn() ?? undefined;
    if (!slot) {
      // Every worker is busy (wait for a reply), or a spawn just failed with
      // no worker left to wait on — finish that task here.
      if (slots.length === 0) runInThread(queue.shift()!);
      else return;
      continue;
    }
    assign(slot, queue.shift()!);
  }
}

function enqueue(task: Task): void {
  queue.push(task);
  dispatch();
}

/** bcrypt hash off the main thread. Same output as `bcrypt.hash`. */
export function hashPasswordOffThread(
  password: string,
  rounds: number,
): Promise<string> {
  if (typeof password !== 'string' || !Number.isInteger(rounds)) {
    // Preserve bcryptjs' own argument errors exactly.
    return bcrypt.hash(password, rounds);
  }
  return new Promise((resolve, reject) => {
    enqueue({
      id: nextTaskId++,
      op: 'hash',
      password,
      rounds,
      resolve,
      reject,
    });
  });
}

/** bcrypt compare off the main thread. Same result as `bcrypt.compare`. */
export function comparePasswordOffThread(
  password: string,
  hash: string,
): Promise<boolean> {
  if (typeof password !== 'string' || typeof hash !== 'string') {
    return bcrypt.compare(password, hash);
  }
  return new Promise((resolve, reject) => {
    enqueue({
      id: nextTaskId++,
      op: 'compare',
      password,
      hash,
      resolve,
      reject,
    });
  });
}

/** Terminate all workers. The pool restarts lazily on the next call. */
export async function shutdownPasswordHashPool(): Promise<void> {
  const current = slots.splice(0);
  await Promise.all(
    current.map(async (slot) => {
      slot.gone = true;
      if (slot.timer) clearTimeout(slot.timer);
      const task = slot.task;
      slot.task = null;
      if (task) runInThread(task);
      await slot.worker.terminate().catch(() => {});
    }),
  );
}

export interface PasswordHashPoolStats {
  workers: number;
  busy: number;
  queued: number;
  fallbacks: number;
  disabled: boolean;
  poolSize: number;
}

export function getPasswordHashPoolStats(): PasswordHashPoolStats {
  return {
    workers: slots.length,
    busy: slots.filter((s) => s.task).length,
    queued: queue.length,
    fallbacks: fallbackCount,
    disabled,
    poolSize,
  };
}

/** Test-only knobs. Production code never calls these. */
export const passwordHashPoolForTest = {
  workers(): Worker[] {
    return slots.map((s) => s.worker);
  },
  async reset(
    options: {
      poolSize?: number;
      taskTimeoutMs?: number;
      workerSource?: string;
    } = {},
  ): Promise<void> {
    await shutdownPasswordHashPool();
    queue.splice(0);
    poolSize = options.poolSize ?? defaultPoolSize();
    taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    workerSource = options.workerSource ?? WORKER_SOURCE;
    consecutiveStartFailures = 0;
    disabled = false;
    fallbackCount = 0;
  },
};
