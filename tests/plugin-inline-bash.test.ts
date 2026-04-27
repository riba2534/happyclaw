/**
 * plugin-inline-bash.test.ts
 *
 * Behavior coverage for src/plugin-inline-bash.ts:
 *   - Host spawn: bash -c '<cmd>' -- a b c, env injection
 *   - Docker spawn: docker exec ... -e CLAUDE_PLUGIN_ROOT=... -e ARGUMENTS=... bash -c '<cmd>' -- a b c
 *   - $ARGUMENTS passes through env as a single string with quotes literal
 *   - Failed exit / spawn error / signal kill produce ok=false with diagnostics
 *   - Timeout watchdog kills the child and sets timedOut=true
 *   - maxBuffer truncation drops bytes beyond the cap
 *
 * We exercise both the real `bash` binary (where available) and a stubbed
 * spawn for the docker path / argv-shape assertions, since CI may not have
 * docker installed.
 */

import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

import {
  executeInlineBashHost,
  executeInlineBashDocker,
  INLINE_TIMEOUT_MS,
} from '../src/plugin-inline-bash.js';

// --- Stub spawn that records argv + lets the test drive lifecycle ---------

interface StubChild {
  emitter: EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  killSignal: string | null;
  kill(signal?: string): boolean;
}

function makeStubChild(): StubChild {
  const child: StubChild = {
    emitter: new EventEmitter(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    killSignal: null,
    kill(signal: string = 'SIGTERM') {
      this.killed = true;
      this.killSignal = signal;
      // Emit close after kill so the runner resolves promptly.
      setImmediate(() => this.emitter.emit('close', null, signal));
      return true;
    },
  };
  return child;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: any;
}

function makeSpawnStub() {
  const calls: SpawnCall[] = [];
  let pendingChild: StubChild | null = null;
  const spawnFn: any = (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    const child = makeStubChild();
    pendingChild = child;
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      on: (ev: string, cb: (...a: any[]) => void) => child.emitter.on(ev, cb),
      kill: (sig?: string) => child.kill(sig),
    } as any;
  };
  return {
    spawnFn: spawnFn as any,
    calls,
    getLastChild: (): StubChild => {
      if (!pendingChild) throw new Error('no child spawned');
      return pendingChild;
    },
  };
}

// --- Tests -----------------------------------------------------------------

describe('executeInlineBashHost', () => {
  test('builds argv with bash -c <cmd> -- ...posArgs and injects env', async () => {
    const stub = makeSpawnStub();
    const promise = executeInlineBashHost(
      'echo "$ARGUMENTS"',
      ['--base', 'main'],
      { CLAUDE_PLUGIN_ROOT: '/plugin/root', ARGUMENTS: '--base main' },
      '/cwd/path',
      { spawnImpl: stub.spawnFn },
    );
    // Drive child to clean exit.
    setImmediate(() => {
      const c = stub.getLastChild();
      c.stdout.emit('data', Buffer.from('hello\n'));
      c.emitter.emit('close', 0, null);
    });
    const result = await promise;

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].command).toBe('bash');
    expect(stub.calls[0].args).toEqual([
      '-c',
      'echo "$ARGUMENTS"',
      '--',
      '--base',
      'main',
    ]);
    expect(stub.calls[0].options.cwd).toBe('/cwd/path');
    expect(stub.calls[0].options.env.CLAUDE_PLUGIN_ROOT).toBe('/plugin/root');
    expect(stub.calls[0].options.env.ARGUMENTS).toBe('--base main');

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test('preserves quote literals in rawCmdString — no JS string interpolation', async () => {
    const stub = makeSpawnStub();
    // The `"$ARGUMENTS"` is forwarded verbatim; bash will resolve $ARGUMENTS
    // at exec time. We must not see the value of ARGUMENTS spliced in.
    const rawCmd = 'node script.mjs "$ARGUMENTS"';
    const promise = executeInlineBashHost(
      rawCmd,
      [],
      { CLAUDE_PLUGIN_ROOT: '/p', ARGUMENTS: '--base "main branch"' },
      '/cwd',
      { spawnImpl: stub.spawnFn },
    );
    setImmediate(() => {
      const c = stub.getLastChild();
      c.emitter.emit('close', 0, null);
    });
    await promise;

    // argv must contain rawCmdString unchanged (with original quotes).
    expect(stub.calls[0].args[0]).toBe('-c');
    expect(stub.calls[0].args[1]).toBe(rawCmd);
    // The args following `--` are positional ($1, $2, ...), and posArgs is
    // empty here since $ARGUMENTS goes via env, not split.
    expect(stub.calls[0].args.slice(2)).toEqual(['--']);
    expect(stub.calls[0].options.env.ARGUMENTS).toBe('--base "main branch"');
  });

  test('non-zero exit → ok=false with exitCode preserved', async () => {
    const stub = makeSpawnStub();
    const promise = executeInlineBashHost(
      'exit 7',
      [],
      { CLAUDE_PLUGIN_ROOT: '/p', ARGUMENTS: '' },
      '/cwd',
      { spawnImpl: stub.spawnFn },
    );
    setImmediate(() => {
      const c = stub.getLastChild();
      c.stderr.emit('data', Buffer.from('boom'));
      c.emitter.emit('close', 7, null);
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe('boom');
    expect(result.timedOut).toBe(false);
  });

  test('killed by signal → ok=false with signal', async () => {
    const stub = makeSpawnStub();
    const promise = executeInlineBashHost(
      'sleep 999',
      [],
      { CLAUDE_PLUGIN_ROOT: '/p', ARGUMENTS: '' },
      '/cwd',
      { spawnImpl: stub.spawnFn },
    );
    setImmediate(() => {
      const c = stub.getLastChild();
      c.emitter.emit('close', null, 'SIGKILL');
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.signal).toBe('SIGKILL');
  });

  test('spawn-time error → ok=false, spawnError populated', async () => {
    const stub = makeSpawnStub();
    const promise = executeInlineBashHost(
      'noop',
      [],
      { CLAUDE_PLUGIN_ROOT: '/p', ARGUMENTS: '' },
      '/cwd',
      { spawnImpl: stub.spawnFn },
    );
    setImmediate(() => {
      const c = stub.getLastChild();
      c.emitter.emit('error', new Error('ENOENT bash'));
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.spawnError).toContain('ENOENT bash');
  });

  test('timeout watchdog → ok=false, timedOut=true, child killed', async () => {
    vi.useFakeTimers();
    const stub = makeSpawnStub();
    const promise = executeInlineBashHost(
      'sleep 999',
      [],
      { CLAUDE_PLUGIN_ROOT: '/p', ARGUMENTS: '' },
      '/cwd',
      { spawnImpl: stub.spawnFn, timeoutMs: 100 },
    );
    // Advance past the timeout — watchdog fires + kill() emits close.
    await vi.advanceTimersByTimeAsync(150);
    // setImmediate inside kill() needs the loop to tick once more.
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(stub.getLastChild().killed).toBe(true);
  });

  // #19 P2-4 — trap-resistant child must be SIGKILLed after the grace period.
  test('SIGTERM ignored → SIGKILL after grace period; runChildProcess settles within timeout + grace', async () => {
    vi.useFakeTimers();

    // Stub spawn whose .kill() records the signal but never emits close on
    // SIGTERM (modeling `trap '' TERM`). Only SIGKILL terminates.
    const calls: SpawnCall[] = [];
    let pendingChild: StubChild | null = null;
    const spawnFn: any = (cmd: string, args: string[], options: any) => {
      calls.push({ command: cmd, args, options });
      const child: StubChild = {
        emitter: new EventEmitter(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        killSignal: null,
        kill(signal: string = 'SIGTERM') {
          this.killed = true;
          this.killSignal = signal;
          if (signal === 'SIGKILL') {
            // Real children get reaped on SIGKILL → emit close synchronously.
            setImmediate(() => this.emitter.emit('close', null, 'SIGKILL'));
          }
          // SIGTERM: noop — simulates a trap-resistant command.
          return true;
        },
      };
      pendingChild = child;
      return {
        stdout: child.stdout,
        stderr: child.stderr,
        on: (ev: string, cb: (...a: any[]) => void) => child.emitter.on(ev, cb),
        kill: (sig?: string) => child.kill(sig),
      } as any;
    };

    const promise = executeInlineBashHost(
      "trap '' TERM; sleep 999",
      [],
      { CLAUDE_PLUGIN_ROOT: '/p', ARGUMENTS: '' },
      '/cwd',
      { spawnImpl: spawnFn, timeoutMs: 100, killGraceMs: 50 },
    );

    // Advance past timeoutMs → SIGTERM fires (no effect on this child).
    await vi.advanceTimersByTimeAsync(110);
    expect(pendingChild!.killSignal).toBe('SIGTERM');

    // Advance past killGraceMs → SIGKILL fires; close handler resolves.
    await vi.advanceTimersByTimeAsync(60);
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.signal).toBe('SIGKILL');
    expect(pendingChild!.killSignal).toBe('SIGKILL');
  });

  test('maxBuffer truncates stdout beyond the cap', async () => {
    const stub = makeSpawnStub();
    const promise = executeInlineBashHost(
      'spam',
      [],
      { CLAUDE_PLUGIN_ROOT: '/p', ARGUMENTS: '' },
      '/cwd',
      { spawnImpl: stub.spawnFn, maxBuffer: 10 },
    );
    setImmediate(() => {
      const c = stub.getLastChild();
      c.stdout.emit('data', Buffer.from('1234567890ABCDE'));
      c.stdout.emit('data', Buffer.from('IGNORED'));
      c.emitter.emit('close', 0, null);
    });
    const result = await promise;
    // Cap is bytes; we accept either exact 10 or the first buffered chunk
    // truncated to remaining capacity.
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(10);
    expect(result.stdout).not.toContain('IGNORED');
  });
});

describe('executeInlineBashDocker', () => {
  test('builds docker exec argv with -e CLAUDE_PLUGIN_ROOT/ARGUMENTS + bash -c <cmd> -- posArgs', async () => {
    const stub = makeSpawnStub();
    const promise = executeInlineBashDocker(
      'happyclaw-agent-abc',
      'echo "$ARGUMENTS"',
      ['--flag', 'val'],
      {
        CLAUDE_PLUGIN_ROOT: '/workspace/plugins/snapshots/sha/mp/p',
        ARGUMENTS: '--flag val',
      },
      { spawnImpl: stub.spawnFn },
    );
    setImmediate(() => {
      const c = stub.getLastChild();
      c.stdout.emit('data', Buffer.from('ok\n'));
      c.emitter.emit('close', 0, null);
    });
    const result = await promise;

    expect(stub.calls[0].command).toBe('docker');
    expect(stub.calls[0].args).toEqual([
      'exec',
      '-i',
      '-u',
      'node',
      '-w',
      '/workspace/group',
      '-e',
      'CLAUDE_PLUGIN_ROOT=/workspace/plugins/snapshots/sha/mp/p',
      '-e',
      'ARGUMENTS=--flag val',
      'happyclaw-agent-abc',
      'bash',
      '-c',
      'echo "$ARGUMENTS"',
      '--',
      '--flag',
      'val',
    ]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('ok\n');
  });

  test('rawCmdString preserved with literal quotes for docker path', async () => {
    const stub = makeSpawnStub();
    const rawCmd = 'sh -c \'echo "$ARGUMENTS" | wc -c\'';
    const promise = executeInlineBashDocker(
      'c',
      rawCmd,
      [],
      { CLAUDE_PLUGIN_ROOT: '/x', ARGUMENTS: '"a b c"' },
      { spawnImpl: stub.spawnFn },
    );
    setImmediate(() => {
      const c = stub.getLastChild();
      c.emitter.emit('close', 0, null);
    });
    await promise;
    // Find the index of `bash` in argv, then `-c`, then rawCmd.
    const argv = stub.calls[0].args;
    const bashIdx = argv.indexOf('bash');
    expect(argv[bashIdx]).toBe('bash');
    expect(argv[bashIdx + 1]).toBe('-c');
    expect(argv[bashIdx + 2]).toBe(rawCmd);
    expect(argv[bashIdx + 3]).toBe('--');
    // The ARGUMENTS env line preserves the literal quotes.
    const envLine = argv.find((a) => a.startsWith('ARGUMENTS='));
    expect(envLine).toBe('ARGUMENTS="a b c"');
  });
});

describe('module defaults', () => {
  test('INLINE_TIMEOUT_MS is 30s per spec', () => {
    expect(INLINE_TIMEOUT_MS).toBe(30_000);
  });
});
