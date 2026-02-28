/**
 * Shared output parsing and process lifecycle logic for container-runner.
 * Extracted from runContainerAgent() and runHostAgent() to eliminate duplication.
 */
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';

import { getSystemSettings } from './runtime-config.js';
import { logger } from './logger.js';
import type { ContainerOutput } from './container-runner.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

// ─── Stdout Stream Parser ────────────────────────────────────────────

export interface StdoutParserState {
  stdout: string;
  stdoutTruncated: boolean;
  parseBuffer: string;
  newSessionId: string | undefined;
  outputChain: Promise<void>;
  hasSuccessOutput: boolean;
  /** True when agent emitted a { status: 'closed' } marker (exit due to _close sentinel). */
  hasClosedOutput: boolean;
}

export interface StdoutParserOptions {
  groupName: string;
  /** Label used in log messages, e.g. "Container" or "Host agent" */
  label: string;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  resetTimeout: () => void;
}

export function createStdoutParserState(): StdoutParserState {
  return {
    stdout: '',
    stdoutTruncated: false,
    parseBuffer: '',
    newSessionId: undefined,
    outputChain: Promise.resolve(),
    hasSuccessOutput: false,
    hasClosedOutput: false,
  };
}

export function attachStdoutHandler(
  stream: Readable,
  state: StdoutParserState,
  opts: StdoutParserOptions,
): void {
  stream.on('data', (data) => {
    const chunk = data.toString();

    // Always accumulate for logging
    if (!state.stdoutTruncated) {
      const remaining = getSystemSettings().containerMaxOutputSize - state.stdout.length;
      if (chunk.length > remaining) {
        state.stdout += chunk.slice(0, remaining);
        state.stdoutTruncated = true;
        logger.warn(
          { group: opts.groupName, size: state.stdout.length },
          `${opts.label} stdout truncated due to size limit`,
        );
      } else {
        state.stdout += chunk;
      }
    }

    // Stream-parse for output markers
    if (opts.onOutput) {
      state.parseBuffer += chunk;
      const MAX_PARSE_BUFFER = 10 * 1024 * 1024; // 10MB
      if (state.parseBuffer.length > MAX_PARSE_BUFFER) {
        logger.warn(
          { group: opts.groupName },
          'Parse buffer overflow, truncating',
        );
        const lastMarkerIdx = state.parseBuffer.lastIndexOf(OUTPUT_START_MARKER);
        state.parseBuffer =
          lastMarkerIdx >= 0
            ? state.parseBuffer.slice(lastMarkerIdx)
            : state.parseBuffer.slice(-512);
      }
      let startIdx: number;
      while ((startIdx = state.parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = state.parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break; // Incomplete pair, wait for more data

        const jsonStr = state.parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        state.parseBuffer = state.parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          const parsed: ContainerOutput = JSON.parse(jsonStr);
          if (parsed.newSessionId) {
            state.newSessionId = parsed.newSessionId;
          }
          if (parsed.status === 'success') {
            state.hasSuccessOutput = true;
          }
          if (parsed.status === 'closed') {
            state.hasClosedOutput = true;
          }
          // Activity detected — reset the hard timeout
          opts.resetTimeout();
          // Call onOutput for all markers (including null results)
          // so idle timers start even for "silent" query completions.
          const onOutputFn = opts.onOutput;
          state.outputChain = state.outputChain
            .then(() => onOutputFn(parsed))
            .catch((err) => {
              logger.error(
                { group: opts.groupName, err },
                'onOutput callback error',
              );
            });
        } catch (err) {
          logger.warn(
            { group: opts.groupName, error: err },
            'Failed to parse streamed output chunk',
          );
        }
      }
    }
  });
}

// ─── Stderr Handler ──────────────────────────────────────────────────

export interface StderrState {
  stderr: string;
  stderrTruncated: boolean;
}

export function createStderrState(): StderrState {
  return {
    stderr: '',
    stderrTruncated: false,
  };
}

export function attachStderrHandler(
  stream: Readable,
  state: StderrState,
  groupName: string,
  /** Log context key: { container: folder } or { host: folder } */
  logContext: Record<string, string>,
): void {
  stream.on('data', (data) => {
    const chunk = data.toString();
    const lines = chunk.trim().split('\n');
    for (const line of lines) {
      if (line) logger.debug(logContext, line);
    }
    // Don't reset timeout on stderr — SDK writes debug logs continuously.
    // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
    if (state.stderrTruncated) return;
    const remaining = getSystemSettings().containerMaxOutputSize - state.stderr.length;
    if (chunk.length > remaining) {
      state.stderr += chunk.slice(0, remaining);
      state.stderrTruncated = true;
      logger.warn(
        { group: groupName, size: state.stderr.length },
        `${Object.keys(logContext)[0] === 'container' ? 'Container' : 'Host agent'} stderr truncated due to size limit`,
      );
    } else {
      state.stderr += chunk;
    }
  });
}

// ─── Close Event Handlers ────────────────────────────────────────────

export interface CloseHandlerContext {
  groupName: string;
  /** "Container" or "Host Agent" — used for log titles */
  label: string;
  /** "container" or "host" — used for log filenames */
  filePrefix: string;
  /** containerName or processId */
  identifier: string;
  logsDir: string;
  input: { prompt: string; sessionId?: string; isMain: boolean };
  stdoutState: StdoutParserState;
  stderrState: StderrState;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  resolvePromise: (output: ContainerOutput) => void;
  startTime: number;
  timeoutMs: number;
  /** Extra log lines for the "Input Summary" section (e.g. Mounts, Working Directory) */
  extraSummaryLines?: string[];
  /** Extra log lines for verbose/error section (e.g. Container Args, detailed Mounts) */
  extraVerboseLines?: string[];
  /** Custom error enrichment: given stderr, return { result, error } overrides */
  enrichError?: (stderr: string, exitLabel: string) => { result: string | null; error: string };
}

/**
 * Handle the 'close' event for timeout case.
 * Returns true if this was a timeout (caller should return early).
 */
export function handleTimeoutClose(
  ctx: CloseHandlerContext,
  code: number | null,
  duration: number,
  timedOut: boolean,
): boolean {
  if (!timedOut) return false;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(ctx.logsDir, { recursive: true });
  const timeoutLog = path.join(ctx.logsDir, `${ctx.filePrefix}-${ts}.log`);
  fs.writeFileSync(
    timeoutLog,
    [
      `=== ${ctx.label} Run Log (TIMEOUT) ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${ctx.groupName}`,
      `${ctx.label === 'Container' ? 'Container' : 'Process ID'}: ${ctx.identifier}`,
      `Duration: ${duration}ms`,
      `Exit Code: ${code}`,
    ].join('\n'),
  );

  logger.error(
    { group: ctx.groupName, [ctx.filePrefix === 'container' ? 'containerName' : 'processId']: ctx.identifier, duration, code },
    `${ctx.label} timed out`,
  );

  ctx.resolvePromise({
    status: 'error',
    result: null,
    error: `${ctx.label} timed out after ${ctx.timeoutMs}ms`,
  });
  return true;
}

/**
 * Write a run log file. Returns the log file path.
 */
export function writeRunLog(
  ctx: CloseHandlerContext,
  code: number | null,
  duration: number,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(ctx.logsDir, { recursive: true });
  const logFile = path.join(ctx.logsDir, `${ctx.filePrefix}-${timestamp}.log`);
  const isVerbose =
    process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

  const logLines = [
    `=== ${ctx.label} Run Log ===`,
    `Timestamp: ${new Date().toISOString()}`,
    `Group: ${ctx.groupName}`,
    `IsMain: ${ctx.input.isMain}`,
    `Duration: ${duration}ms`,
    `Exit Code: ${code}`,
    `Stdout Truncated: ${ctx.stdoutState.stdoutTruncated}`,
    `Stderr Truncated: ${ctx.stderrState.stderrTruncated}`,
    ``,
  ];

  const isError = code !== 0;
  const { stderr, stderrTruncated } = ctx.stderrState;
  const { stdout, stdoutTruncated } = ctx.stdoutState;

  const LOG_TAIL_LIMIT = 4000;
  const stderrLog = (!isVerbose && !isError && stderr.length > LOG_TAIL_LIMIT)
    ? `... (truncated ${stderr.length - LOG_TAIL_LIMIT} chars) ...\n` + stderr.slice(-LOG_TAIL_LIMIT)
    : stderr;
  const stdoutLog = (!isVerbose && !isError && stdout.length > LOG_TAIL_LIMIT)
    ? `... (truncated ${stdout.length - LOG_TAIL_LIMIT} chars) ...\n` + stdout.slice(-LOG_TAIL_LIMIT)
    : stdout;
  logLines.push(
    `=== Input Summary ===`,
    `Prompt length: ${ctx.input.prompt.length} chars`,
    `Session ID: ${ctx.input.sessionId || 'new'}`,
  );
  if (ctx.extraSummaryLines) {
    logLines.push(...ctx.extraSummaryLines);
  }
  logLines.push(
    ``,
    `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
    stderrLog,
    ``,
    `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
    stdoutLog,
  );

  if (isVerbose || isError) {
    logLines.push(
      ``,
      `=== Input ===`,
      JSON.stringify(ctx.input, null, 2),
    );
    if (ctx.extraVerboseLines) {
      logLines.push(``, ...ctx.extraVerboseLines);
    }
  }

  fs.writeFileSync(logFile, logLines.join('\n'));
  logger.debug({ logFile, verbose: isVerbose }, `${ctx.label} log written`);
  return logFile;
}

const OUTPUT_CHAIN_TIMEOUT = 30_000;

/**
 * Wait for the output chain to settle with a safety timeout.
 * Calls `then` callback on success, always ensures chain timer is cleaned up.
 */
function waitForOutputChain(
  outputChain: Promise<void>,
  groupName: string,
  logLabel: string,
  then: () => void,
): void {
  let chainTimer: ReturnType<typeof setTimeout> | null = null;
  const chainTimeout = new Promise<void>((resolve) => {
    chainTimer = setTimeout(() => {
      logger.warn(
        { group: groupName, timeoutMs: OUTPUT_CHAIN_TIMEOUT },
        `Output chain settle timeout on ${logLabel}`,
      );
      resolve();
    }, OUTPUT_CHAIN_TIMEOUT);
  });
  Promise.race([outputChain, chainTimeout])
    .then(() => {
      if (chainTimer) clearTimeout(chainTimer);
      then();
    })
    .catch(() => {
      if (chainTimer) clearTimeout(chainTimer);
      then();
    });
}

/**
 * Handle the non-zero exit code path (force-kill detection, error output chain, resolve).
 * Returns true if handled (caller should return early).
 */
export function handleNonZeroExit(
  ctx: CloseHandlerContext,
  code: number | null,
  signal: NodeJS.Signals | null,
  duration: number,
  logFile: string,
): boolean {
  if (code === 0) return false;

  const exitLabel =
    code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
  const { newSessionId, outputChain } = ctx.stdoutState;

  // Graceful shutdown: agent was killed by SIGTERM/SIGKILL (e.g. user
  // clicked stop, session reset, clear-history). Treat as normal
  // completion instead of an error.
  const isForceKilled = signal === 'SIGTERM' || signal === 'SIGKILL' || code === 137;
  if (isForceKilled && ctx.onOutput) {
    logger.info(
      { group: ctx.groupName, signal, code, duration, newSessionId },
      `${ctx.label} terminated by signal (user stop / graceful shutdown)`,
    );
    waitForOutputChain(outputChain, ctx.groupName, `${ctx.filePrefix} force-kill path`, () => {
      ctx.resolvePromise({
        status: 'success',
        result: null,
        newSessionId,
      });
    });
    return true;
  }

  // Build error output
  const { stderr } = ctx.stderrState;
  const enriched = ctx.enrichError
    ? ctx.enrichError(stderr, exitLabel)
    : { result: null as string | null, error: `${ctx.label} exited with ${exitLabel}: ${stderr.slice(-200)}` };

  logger.error(
    {
      group: ctx.groupName,
      code,
      signal,
      duration,
      stderr,
      stdout: ctx.stdoutState.stdout,
      logFile,
    },
    `${ctx.label} exited with error`,
  );

  const finalizeError = () => {
    ctx.resolvePromise({
      status: 'error',
      result: enriched.result,
      error: enriched.error,
    });
  };

  // Even on error exits, wait for pending output callbacks to settle.
  if (ctx.onOutput) {
    waitForOutputChain(outputChain, ctx.groupName, `${ctx.filePrefix} error path`, finalizeError);
    return true;
  }

  finalizeError();
  return true;
}

/**
 * Handle the success (code === 0) path — streaming mode or legacy parsing.
 */
export function handleSuccessClose(
  ctx: CloseHandlerContext,
  duration: number,
): void {
  const { newSessionId, outputChain } = ctx.stdoutState;

  // Streaming mode: wait for output chain to settle
  if (ctx.onOutput) {
    const { hasClosedOutput } = ctx.stdoutState;
    waitForOutputChain(outputChain, ctx.groupName, `${ctx.filePrefix} success path`, () => {
      // Propagate 'closed' status so the host can distinguish a _close-interrupted
      // exit from a normal completion and avoid committing the message cursor.
      const finalStatus = hasClosedOutput ? 'closed' as const : 'success' as const;
      logger.info(
        { group: ctx.groupName, duration, newSessionId, finalStatus },
        `${ctx.label} completed (streaming mode)`,
      );
      ctx.resolvePromise({
        status: finalStatus,
        result: null,
        newSessionId,
      });
    });
    return;
  }

  // Legacy mode: parse the last output marker pair from accumulated stdout
  parseLegacyOutput(ctx);
}

/**
 * Parse legacy (non-streaming) output from accumulated stdout.
 */
function parseLegacyOutput(ctx: CloseHandlerContext): void {
  const { stdout } = ctx.stdoutState;
  try {
    const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
    const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

    let jsonLine: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonLine = stdout
        .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
        .trim();
    } else {
      // Fallback: last non-empty line (backwards compatibility)
      const lines = stdout.trim().split('\n');
      jsonLine = lines[lines.length - 1];
    }

    const output: ContainerOutput = JSON.parse(jsonLine);

    logger.info(
      {
        group: ctx.groupName,
        duration: Date.now() - ctx.startTime,
        status: output.status,
        hasResult: !!output.result,
      },
      `${ctx.label} completed`,
    );

    ctx.resolvePromise(output);
  } catch (err) {
    logger.error(
      {
        group: ctx.groupName,
        stdout,
        stderr: ctx.stderrState.stderr,
        error: err,
      },
      `Failed to parse ${ctx.filePrefix} output`,
    );

    ctx.resolvePromise({
      status: 'error',
      result: null,
      error: `Failed to parse ${ctx.filePrefix} output: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
