import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-probe-'));

type ExecFileCallback = (
  err: Error | null,
  stdout: string,
  stderr: string,
) => void;

const docker = vi.hoisted(() => ({
  /** Next fake `docker info` outcome; `throws` makes execFile itself throw. */
  next: {
    stdout: '[]',
    err: null as Error | null,
    delayMs: 0,
    throws: false,
  },
  calls: [] as Array<{ args: readonly string[]; options: unknown }>,
  syncCalls: 0,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = ((
    file: string,
    args: readonly string[],
    options: unknown,
    callback: ExecFileCallback,
  ) => {
    if (file !== 'docker') {
      return (real.execFile as unknown as (...a: unknown[]) => unknown)(
        file,
        args,
        options,
        callback,
      );
    }
    docker.calls.push({ args, options });
    if (docker.next.throws) throw new Error('spawn failed');
    const { stdout, err, delayMs } = docker.next;
    setTimeout(() => callback(err, err ? '' : stdout, ''), delayMs);
    return {};
  }) as unknown as typeof real.execFile;
  const execFileSync = ((...args: Parameters<typeof real.execFileSync>) => {
    if (args[0] === 'docker') docker.syncCalls++;
    return real.execFileSync(...args);
  }) as typeof real.execFileSync;
  return { ...real, execFile, execFileSync };
});

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: path.join(testRoot, 'data'),
  GROUPS_DIR: path.join(testRoot, 'data', 'groups'),
  STORE_DIR: path.join(testRoot, 'data', 'db'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const {
  detectContainerHostIdentity,
  detectContainerHostIdentityAsync,
  probeContainerSecurityOptionsAsync,
} = await import('../src/container-runner.js');

function setDocker(next: Partial<typeof docker.next>): void {
  docker.next = { stdout: '[]', err: null, delayMs: 0, throws: false, ...next };
}

async function withPlatform<T>(
  platform: NodeJS.Platform,
  run: () => T | Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

afterEach(() => {
  docker.calls.length = 0;
  docker.syncCalls = 0;
  setDocker({});
});

describe('async docker security-options probe', () => {
  test('runs the same docker command with the same timeout', async () => {
    setDocker({ stdout: '["name=seccomp,profile=default"]\n' });
    await expect(probeContainerSecurityOptionsAsync()).resolves.toEqual([
      'name=seccomp,profile=default',
    ]);
    expect(docker.calls).toEqual([
      {
        args: ['info', '--format', '{{json .SecurityOptions}}'],
        options: { encoding: 'utf8', timeout: 3_000 },
      },
    ]);
  });

  test.each([
    ['a failed or timed-out command', { err: new Error('timeout') }],
    ['JSON null', { stdout: 'null\n' }],
    ['a non-array', { stdout: '{"name":"rootless"}' }],
    ['non-string entries', { stdout: '["name=userns", 1]' }],
    ['unparseable output', { stdout: 'Cannot connect to the Docker daemon' }],
    ['execFile throwing', { throws: true }],
  ])('returns null for %s', async (_name, next) => {
    setDocker(next);
    await expect(probeContainerSecurityOptionsAsync()).resolves.toBeNull();
  });

  test('does not block the event loop while docker runs', async () => {
    setDocker({ stdout: '[]', delayMs: 50 });
    const order: string[] = [];
    const probe = probeContainerSecurityOptionsAsync().then(() =>
      order.push('probe'),
    );
    setImmediate(() => order.push('immediate'));
    setTimeout(() => order.push('timer-10ms'), 10);
    await probe;
    expect(order).toEqual(['immediate', 'timer-10ms', 'probe']);
    expect(docker.syncCalls).toBe(0);
  });
});

describe('launch identity detection', () => {
  test('re-probes on every launch and maps results like the sync path', async () => {
    if (process.platform !== 'linux' || process.getuid?.() === 0) return;
    const results: Array<readonly string[] | null | Error> = [
      [],
      ['name=userns'],
      ['name=rootless'],
      null,
      new Error('probe rejected'),
      [],
    ];
    let calls = 0;
    const reader = async () => {
      const next = results[calls++];
      if (next instanceof Error) throw next;
      return next;
    };
    const modes = [];
    for (let i = 0; i < results.length; i++) {
      modes.push((await detectContainerHostIdentityAsync(reader)).mode);
    }
    expect(modes).toEqual([
      'direct',
      'userns',
      'rootless',
      'unknown',
      'unknown',
      'direct',
    ]);
    expect(calls).toBe(results.length);
    expect(await detectContainerHostIdentityAsync(async () => [])).toEqual(
      detectContainerHostIdentity(() => []),
    );
  });

  test('skips the probe where security options cannot change the result', async () => {
    const reader = vi.fn(async () => ['name=rootless']);
    const syncReader = vi.fn(() => ['name=rootless']);
    for (const platform of ['darwin', 'win32'] as const) {
      await withPlatform(platform, async () => {
        expect(await detectContainerHostIdentityAsync(reader)).toEqual({
          mode: 'virtualized',
        });
        expect(detectContainerHostIdentity(syncReader)).toEqual({
          mode: 'virtualized',
        });
      });
    }
    await withPlatform('freebsd', async () => {
      expect(await detectContainerHostIdentityAsync(reader)).toEqual({
        mode: 'unknown',
      });
    });
    expect(reader).not.toHaveBeenCalled();
    expect(syncReader).not.toHaveBeenCalled();
  });

  test('container launches await the async probe before provider selection', () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/container-runner.ts'),
      'utf8',
    );
    const start = source.indexOf('export async function runContainerAgent(');
    const end = source.indexOf('export async function runHostAgent(');
    const body = source.slice(start, end);
    const probe = body.indexOf('await detectContainerHostIdentityAsync()');
    expect(probe).toBeGreaterThan(0);
    expect(probe).toBeLessThan(body.indexOf('trySelectPoolProvider('));
    expect(body).not.toContain('detectContainerHostIdentity()');
    // Nothing else is awaited between provider selection and spawn.
    const selection = body.indexOf('trySelectPoolProvider(');
    const spawnSite = body.indexOf("spawn('docker'");
    expect(body.slice(selection, spawnSite)).not.toMatch(
      /\bawait\b(?! new Promise<ContainerOutput>)/,
    );
  });
});
