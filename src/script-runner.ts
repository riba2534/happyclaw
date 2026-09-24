import { ChildProcess, execFile, spawn } from 'child_process';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { getSystemSettings } from './runtime-config.js';

export interface ScriptRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Set when the process was terminated by a signal (e.g. SIGKILL/OOM). */
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

let activeScriptCount = 0;
let nextScriptRunId = 1;

interface ActiveScriptRun {
  child: ChildProcess;
  ownerId?: string;
  groupFolder: string;
  abort: () => void;
  settled: Promise<void>;
}

const activeScriptRuns = new Map<number, ActiveScriptRun>();

export function getActiveScriptCount(): number {
  return activeScriptCount;
}

function killScriptProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
}

export async function terminateScriptsForOwner(
  userId: string,
): Promise<number> {
  const targets = [...activeScriptRuns.values()].filter(
    (run) => run.ownerId === userId,
  );
  // Use the same state transition as AbortSignal cancellation. Killing the
  // process tree directly would leave `aborted=false`; a SIGKILL close event
  // with a null exit code could then be misclassified as a successful script.
  for (const run of targets) run.abort();
  await Promise.all(
    targets.map((run) =>
      Promise.race([
        run.settled,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timed out terminating host script task')),
            5_000,
          ).unref?.(),
        ),
      ]),
    ),
  );
  return targets.length;
}

const MAX_BUFFER = 1024 * 1024; // 1MB

export async function runScript(
  command: string,
  groupFolder: string,
  options?: { ownerId?: string; signal?: AbortSignal },
): Promise<ScriptRunResult> {
  const { containerTimeout: taskTimeout } = getSystemSettings();
  const cwd = path.join(GROUPS_DIR, groupFolder);
  const startTime = Date.now();

  activeScriptCount++;

  try {
    return await new Promise<ScriptRunResult>((resolve) => {
      const runId = nextScriptRunId++;
      let settleRun!: () => void;
      const settled = new Promise<void>((settle) => {
        settleRun = settle;
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let finished = false;
      const child = spawn(command, {
        cwd,
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG || 'en_US.UTF-8',
          TZ:
            process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
          GROUP_FOLDER: groupFolder,
          HOME: process.env.HOME || cwd,
        },
        shell: '/bin/sh',
        detached: process.platform !== 'win32',
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        killScriptProcessTree(child);
      }, taskTimeout);
      timeout.unref?.();
      const onAbort = () => {
        aborted = true;
        killScriptProcessTree(child);
      };
      if (options?.signal?.aborted) onAbort();
      else options?.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (stdout.length < MAX_BUFFER) stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (stderr.length < MAX_BUFFER) stderr += chunk.toString();
      });
      const finish = (
        exitCode: number | null,
        closeSignal: NodeJS.Signals | null = null,
        spawnError?: Error,
      ) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        options?.signal?.removeEventListener('abort', onAbort);
        activeScriptRuns.delete(runId);
        activeScriptCount--;
        settleRun();
        const durationMs = Date.now() - startTime;

        if (timedOut) {
          logger.warn(
            { command: command.slice(0, 100), groupFolder, durationMs },
            'Script timed out',
          );
        }

        // Never coalesce a missing exit code to 0 unless we intentionally
        // aborted or timed out. External SIGKILL/OOM delivers close(null,
        // signal) with aborted=false; mapping that to 0 marks SUCCESS.
        let resolvedExit: number | null;
        if (timedOut || aborted) {
          resolvedExit = null;
        } else if (exitCode != null) {
          resolvedExit = exitCode;
        } else if (spawnError) {
          resolvedExit = 1;
        } else {
          resolvedExit = null;
        }

        resolve({
          stdout: stdout.slice(0, MAX_BUFFER),
          stderr: (spawnError?.message || stderr).slice(0, MAX_BUFFER),
          exitCode: resolvedExit,
          signal: closeSignal ?? null,
          timedOut,
          aborted,
          durationMs,
        });
      };
      child.once('error', (err) => finish(1, null, err));
      child.once('close', (code, closeSignal) => finish(code, closeSignal));
      activeScriptRuns.set(runId, {
        child,
        ownerId: options?.ownerId,
        groupFolder,
        abort: onAbort,
        settled,
      });
    });
  } catch (err) {
    activeScriptCount--;
    const durationMs = Date.now() - startTime;
    logger.error(
      { command: command.slice(0, 100), groupFolder, err },
      'Script exec() threw synchronously',
    );
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      durationMs,
    };
  }
}
