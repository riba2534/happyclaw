/**
 * plugin-inline-bash.ts
 *
 * Execute the `!`<bash>` inline shell template embedded in a plugin command's
 * markdown body. Two execution surfaces:
 *
 *   - host:    spawn('bash', ['-c', rawCmd, '--', ...posArgs], { cwd })
 *   - docker:  spawn('docker', ['exec', '-i', '-u', 'node', '-w', cwd,
 *                               '-e', 'CLAUDE_PLUGIN_ROOT=...',
 *                               '-e', 'ARGUMENTS=...',
 *                               container, 'bash', '-c', rawCmd, '--', ...posArgs])
 *
 * Critical safety rules (mirrors Claude Code CLI semantics):
 *   1. `rawCmdString` is **never** string-interpolated with $ARGUMENTS or
 *      positional args. Interpolation happens in the spawned shell against
 *      env / shell-positional vars, never via JS template strings.
 *   2. $ARGUMENTS is injected via env (single string, includes literal quotes).
 *   3. Positional args $1, $2, ... are injected via `bash -c '<cmd>' -- a b c`.
 *   4. CLAUDE_PLUGIN_ROOT comes from the resolved plugin runtime path (host
 *      absolute / `/workspace/plugins/...` for docker).
 *   5. Failures (non-zero exit, signal, timeout, spawn error) return a result
 *      object — they never throw.
 */

import { spawn } from 'child_process';

/** Default budget for an inline `!` template — matches plan §Step 4. */
export const INLINE_TIMEOUT_MS = 30000;
/**
 * Grace period between SIGTERM and SIGKILL when the watchdog fires. Trap-
 * resistant commands (e.g. `trap '' TERM; sleep 999`) ignore SIGTERM, so we
 * escalate after this delay — guarantees runChildProcess settles within
 * INLINE_TIMEOUT_MS + INLINE_KILL_GRACE_MS (#19 P2-4).
 */
export const INLINE_KILL_GRACE_MS = 5000;
/** stdout/stderr capture cap; bytes beyond this are dropped (best-effort). */
export const INLINE_MAX_BUFFER = 1_048_576;

export interface InlineExecResult {
  /** True iff the process exited with code 0 (and not killed by signal). */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Numeric exit code, or null if killed by signal / failed before spawn. */
  exitCode: number | null;
  /** Signal name when killed by one (e.g. 'SIGTERM' on timeout). */
  signal: NodeJS.Signals | null;
  /** True when terminated by the timeout watchdog. */
  timedOut: boolean;
  /** Spawn-side error (binary missing, EACCES). Empty when spawn succeeded. */
  spawnError?: string;
}

export interface InlineEnvVars {
  CLAUDE_PLUGIN_ROOT: string;
  ARGUMENTS: string;
}

interface RunOptions {
  /** Override for tests. Falsy values inherit module defaults. */
  timeoutMs?: number;
  /** Override for tests. Falsy values inherit module default INLINE_KILL_GRACE_MS. */
  killGraceMs?: number;
  maxBuffer?: number;
  /** Test seam: stub `spawn` to capture argv without launching a real process. */
  spawnImpl?: typeof spawn;
}

function effectiveTimeout(opts?: RunOptions): number {
  return opts?.timeoutMs && opts.timeoutMs > 0
    ? opts.timeoutMs
    : INLINE_TIMEOUT_MS;
}

function effectiveKillGrace(opts?: RunOptions): number {
  return opts?.killGraceMs && opts.killGraceMs > 0
    ? opts.killGraceMs
    : INLINE_KILL_GRACE_MS;
}

function effectiveMaxBuffer(opts?: RunOptions): number {
  return opts?.maxBuffer && opts.maxBuffer > 0
    ? opts.maxBuffer
    : INLINE_MAX_BUFFER;
}

/**
 * Run a child process and collect stdout/stderr into a result, never throwing.
 * Caller has already constructed argv per host/docker rules.
 */
function runChildProcess(
  command: string,
  args: string[],
  childEnv: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
  opts: RunOptions | undefined,
): Promise<InlineExecResult> {
  const spawnFn = opts?.spawnImpl ?? spawn;
  const timeoutMs = effectiveTimeout(opts);
  const killGraceMs = effectiveKillGrace(opts);
  const maxBuffer = effectiveMaxBuffer(opts);

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnFn>;
    try {
      child = spawnFn(command, args, {
        env: childEnv,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: (err as Error).message,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore — already exited
      }
      // Escalate to SIGKILL after a grace period if the child trapped/ignored
      // SIGTERM. Without this a `trap '' TERM` script keeps the expansion
      // pipeline hung forever (#19 P2-4).
      killTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore — already exited
        }
      }, killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdoutTruncated) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const remaining = maxBuffer - Buffer.byteLength(stdout, 'utf-8');
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      const toAppend =
        Buffer.byteLength(text, 'utf-8') > remaining
          ? text.slice(0, remaining)
          : text;
      stdout += toAppend;
      if (Buffer.byteLength(stdout, 'utf-8') >= maxBuffer) {
        stdoutTruncated = true;
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderrTruncated) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const remaining = maxBuffer - Buffer.byteLength(stderr, 'utf-8');
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      const toAppend =
        Buffer.byteLength(text, 'utf-8') > remaining
          ? text.slice(0, remaining)
          : text;
      stderr += toAppend;
      if (Buffer.byteLength(stderr, 'utf-8') >= maxBuffer) {
        stderrTruncated = true;
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        timedOut,
        spawnError: err.message,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ok: !timedOut && code === 0 && signal === null,
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut,
      });
    });
  });
}

/**
 * Execute an inline `!` template on the host (admin home / `host` mode).
 * `cwd` is the absolute working directory passed to bash; agent-runner runs
 * with `cwd = data/groups/{folder}` so that's what callers pass here.
 */
export function executeInlineBashHost(
  rawCmdString: string,
  posArgs: string[],
  env: InlineEnvVars,
  cwd: string,
  opts?: RunOptions,
): Promise<InlineExecResult> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: env.CLAUDE_PLUGIN_ROOT,
    ARGUMENTS: env.ARGUMENTS,
  };
  // bash -c '<cmd>' -- a b c   →  $1=a $2=b $3=c
  const args = ['-c', rawCmdString, '--', ...posArgs];
  return runChildProcess('bash', args, childEnv, cwd, opts);
}

/**
 * Execute an inline `!` template inside the user's docker container.
 * Caller has already verified `containerName` is non-null (active runner).
 */
export function executeInlineBashDocker(
  containerName: string,
  rawCmdString: string,
  posArgs: string[],
  env: InlineEnvVars,
  opts?: RunOptions,
): Promise<InlineExecResult> {
  const args = [
    'exec',
    '-i',
    '-u',
    'node',
    '-w',
    '/workspace/group',
    '-e',
    `CLAUDE_PLUGIN_ROOT=${env.CLAUDE_PLUGIN_ROOT}`,
    '-e',
    `ARGUMENTS=${env.ARGUMENTS}`,
    containerName,
    'bash',
    '-c',
    rawCmdString,
    '--',
    ...posArgs,
  ];
  // env passthrough for docker is via -e flags; child env is the orchestrator's
  // own env (ignored by docker exec).
  return runChildProcess('docker', args, undefined, undefined, opts);
}
