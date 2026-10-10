import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'password-hash-worker-test-secret';
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { hashPassword, verifyPassword } = await import('../src/auth.js');
const {
  comparePasswordOffThread,
  getPasswordHashPoolStats,
  passwordHashPoolForTest,
  shutdownPasswordHashPool,
} = await import('../src/password-hash-worker.js');

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// The constant the login route compares against when the user doesn't exist.
const LOGIN_DUMMY_HASH =
  '$2b$12$GBXvNon/zJbUI4jtleGnP.YX03zXP5eSXjppo7a3vyWEUK/2YwdP.';

// Low cost keeps the functional tests fast; the stall test uses the real 12.
const FAST_ROUNDS = 4;

afterEach(async () => {
  await passwordHashPoolForTest.reset();
});

afterAll(async () => {
  await shutdownPasswordHashPool();
});

async function outcome<T>(p: Promise<T>): Promise<unknown> {
  try {
    return { value: await p };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

describe('password hashing worker pool', () => {
  test('hash/verify round-trip runs in the worker with the same format and cost', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{53}$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
    // Interop both ways with the in-thread library.
    expect(bcrypt.compareSync('correct horse battery', hash)).toBe(true);

    const stats = getPasswordHashPoolStats();
    expect(stats.workers).toBeGreaterThanOrEqual(1);
    expect(stats.fallbacks).toBe(0);
    expect(stats.disabled).toBe(false);
  });

  test('hashes produced before the change still verify', async () => {
    const legacy2b = bcrypt.hashSync('legacy-password-1', FAST_ROUNDS);
    const legacy2a = legacy2b.replace(/^\$2b\$/, '$2a$');
    expect(await verifyPassword('legacy-password-1', legacy2b)).toBe(true);
    expect(await verifyPassword('legacy-password-1', legacy2a)).toBe(true);
    expect(await verifyPassword('legacy-password-2', legacy2b)).toBe(false);
    // The login route's dummy hash must stay a valid compare target.
    expect(await verifyPassword('anything', LOGIN_DUMMY_HASH)).toBe(false);
    expect(getPasswordHashPoolStats().fallbacks).toBe(0);
  });

  test('malformed hashes behave exactly like in-thread bcryptjs', async () => {
    const cases = [
      'not-a-hash',
      '',
      '$2b$12$' + '!'.repeat(53),
      '$9z$12$GBXvNon/zJbUI4jtleGnP.YX03zXP5eSXjppo7a3vyWEUK/2YwdP.',
    ];
    for (const hash of cases) {
      expect(await outcome(verifyPassword('pw', hash))).toEqual(
        await outcome(bcrypt.compare('pw', hash)),
      );
    }
  });

  test('concurrent compares are all answered correctly within the pool size', async () => {
    const hash = bcrypt.hashSync('right-password', FAST_ROUNDS);
    const inputs = Array.from({ length: 12 }, (_, i) =>
      i % 3 === 0 ? 'right-password' : `wrong-${i}`,
    );
    const results = await Promise.all(
      inputs.map((pw) => verifyPassword(pw, hash)),
    );
    expect(results).toEqual(inputs.map((pw) => pw === 'right-password'));
    const stats = getPasswordHashPoolStats();
    expect(stats.workers).toBeLessThanOrEqual(stats.poolSize);
    expect(stats.queued).toBe(0);
    expect(stats.fallbacks).toBe(0);
  });

  test('a cost-12 compare no longer stalls the event loop', async () => {
    const hash = bcrypt.hashSync('stall-check', 12);
    await verifyPassword('warm-up', hash); // spawn the worker outside the window

    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const results = await Promise.all([
      verifyPassword('stall-check', hash),
      verifyPassword('nope', hash),
    ]);
    histogram.disable();

    expect(results).toEqual([true, false]);
    // In-thread bcryptjs measured ~100 ms per compare and ~400 ms with four
    // concurrent ones. Off-thread, only scheduler noise remains.
    expect(histogram.max / 1e6).toBeLessThan(50);
  });

  test('a worker that dies mid-task falls back and the pool recovers', async () => {
    const hash = bcrypt.hashSync('crash-check', 10);
    const pending = verifyPassword('crash-check', hash);
    const [worker] = passwordHashPoolForTest.workers();
    expect(worker).toBeDefined();
    await worker.terminate();

    expect(await pending).toBe(true);
    expect(getPasswordHashPoolStats().fallbacks).toBe(1);

    // Next call spawns a fresh worker instead of staying on the main thread.
    expect(await verifyPassword('crash-check', hash)).toBe(true);
    const stats = getPasswordHashPoolStats();
    expect(stats.fallbacks).toBe(1);
    expect(stats.workers).toBeGreaterThanOrEqual(1);
    expect(stats.disabled).toBe(false);
  });

  test('a worker that cannot start falls back, then the pool disables itself', async () => {
    await passwordHashPoolForTest.reset({
      workerSource: "throw new Error('worker boot failed');",
    });
    const hash = bcrypt.hashSync('boot-check', FAST_ROUNDS);
    for (let i = 0; i < 4; i++) {
      expect(await verifyPassword('boot-check', hash)).toBe(true);
    }
    const created = await hashPassword('boot-check');
    expect(bcrypt.compareSync('boot-check', created)).toBe(true);
    const stats = getPasswordHashPoolStats();
    expect(stats.disabled).toBe(true);
    expect(stats.workers).toBe(0);
    expect(stats.fallbacks).toBe(5);
  });

  test('a hung worker is timed out and the call completes on the main thread', async () => {
    await passwordHashPoolForTest.reset({
      // Accepts work, never answers.
      workerSource:
        "require('node:worker_threads').parentPort.on('message', () => {});",
      taskTimeoutMs: 200,
    });
    const hash = bcrypt.hashSync('hang-check', FAST_ROUNDS);
    const started = Date.now();
    expect(await comparePasswordOffThread('hang-check', hash)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(getPasswordHashPoolStats().fallbacks).toBe(1);
  });

  test('under tsx a short-lived script gets its hash and still exits on its own', async () => {
    // Mirrors reset-admin: a busy worker keeps the process alive until the
    // hash arrives; an idle one must not hold it open afterwards.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-hash-tsx-'));
    const script = path.join(dir, 'run.mts');
    const modulePath = path.join(REPO_ROOT, 'src', 'password-hash-worker.ts');
    fs.writeFileSync(
      script,
      [
        `const m = await import(${JSON.stringify(modulePath)});`,
        `const hash = await m.hashPasswordOffThread('cli-password', 4);`,
        `const ok = await m.comparePasswordOffThread('cli-password', hash);`,
        `console.log(JSON.stringify({ hash, ok, stats: m.getPasswordHashPoolStats() }));`,
      ].join('\n'),
    );
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', script],
        { cwd: REPO_ROOT, timeout: 20_000 },
      );
      const result = JSON.parse(stdout.trim().split('\n').pop()!) as {
        hash: string;
        ok: boolean;
        stats: { workers: number; fallbacks: number };
      };
      expect(result.hash).toMatch(/^\$2b\$04\$/);
      expect(result.ok).toBe(true);
      expect(result.stats.workers).toBe(1);
      expect(result.stats.fallbacks).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
