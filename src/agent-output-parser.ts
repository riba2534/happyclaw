/**
 * Shared output parsing and process lifecycle logic for container-runner.
 * Extracted from runContainerAgent() and runHostAgent() to eliminate duplication.
 */
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';

import { getSystemSettings } from './runtime-config.js';
import { logger } from './logger.js';
import { OutputFrameScanner } from './output-frame-scanner.js';
import type { ContainerOutput } from './agent-runtime-contracts.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

/**
 * Parse a framed payload slice, accepting it only if it yields a JSON *object*
 * (a real ContainerOutput). Returns null on any parse error or a non-object.
 */
function tryParseContainerOutput(jsonStr: string): ContainerOutput | null {
  let v: unknown;
  try {
    v = JSON.parse(jsonStr.trim());
  } catch {
    return null;
  }
  return typeof v === 'object' && v !== null ? (v as ContainerOutput) : null;
}

// ─── Stdout Stream Parser ────────────────────────────────────────────

/**
 * Classification carried from the last streamed provider-failure frame to the
 * close-handler outputs below.
 *
 * The host kills the runner right after such a frame, so the final
 * ContainerOutput is synthesized by a close handler rather than parsed from the
 * stream. Re-attaching these fields is what keeps the failure class alive
 * across that boundary: without them `resolveProviderFailureClass()` falls
 * back to its 'account' default, so a transient stall reads as a quota verdict
 * downstream — the scheduled-task replay loop then sees "no availability
 * progress" (a transient failure quarantines nothing) and cancels the very
 * replay the transient ledger just granted, and the user notice degrades to
 * the quota wording.
 */
export type ProviderFailureCarryover = Pick<
  ContainerOutput,
  | 'providerFailureClass'
  | 'providerLivenessTimeout'
  | 'providerFailureNotice'
  | 'providerRateLimitScope'
  | 'providerRateLimitModel'
  | 'providerRateLimitResetsAt'
>;

export interface StdoutParserState {
  /**
   * Diagnostic tail of stdout: at least the most recent
   * `min(containerMaxOutputSize, RUNNER_OUTPUT_RETAIN_LIMIT)` chars and at
   * most twice that. A warm runner keeps this state for its whole lifetime, so
   * the full stream must not accumulate here. Frame parsing never reads it
   * (that is `frameScanner`).
   */
  stdout: string;
  /** Total stdout chars received, including those dropped from `stdout`. */
  stdoutTotalChars: number;
  /** True once older stdout was dropped from the diagnostic tail. */
  stdoutTruncated: boolean;
  /** Stdout prefix `parseLegacyOutput()` reads (callers without onOutput). */
  legacyHead: LegacyStdoutHead;
  /** Incremental START/END frame extractor for `onOutput` callers. */
  frameScanner: OutputFrameScanner;
  newSessionId: string | undefined;
  outputChain: Promise<void>;
  hasSuccessOutput: boolean;
  /** True when agent emitted a { status: 'closed' } marker (exit due to _close sentinel). */
  hasClosedOutput: boolean;
  /** True when SDK returned an API/provider failure as a successful final text. */
  hasProviderFailureOutput: boolean;
  /** Classification of the latest provider-failure frame, if any was streamed. */
  providerFailureCarryover: ProviderFailureCarryover | null;
  /** True when agent emitted a stream event with statusText='interrupted'. */
  hasInterruptedOutput: boolean;
}

/**
 * The stdout prefix the legacy parse reads: accumulated up to
 * `containerMaxOutputSize` like the former head-capped buffer, and frozen once
 * it holds the first START marker followed by the first END marker, since
 * nothing after that can change the parse.
 */
export interface LegacyStdoutHead {
  text: string;
  done: boolean;
  startIdx: number;
  endIdx: number;
  /** Last chars of `text`, so markers split across chunks are still found. */
  carry: string;
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
    stdoutTotalChars: 0,
    stdoutTruncated: false,
    legacyHead: { text: '', done: false, startIdx: -1, endIdx: -1, carry: '' },
    frameScanner: new OutputFrameScanner(
      OUTPUT_START_MARKER,
      OUTPUT_END_MARKER,
    ),
    newSessionId: undefined,
    outputChain: Promise.resolve(),
    hasSuccessOutput: false,
    hasClosedOutput: false,
    hasProviderFailureOutput: false,
    providerFailureCarryover: null,
    hasInterruptedOutput: false,
  };
}

function captureProviderFailureCarryover(
  output: ContainerOutput,
): ProviderFailureCarryover {
  const carry: ProviderFailureCarryover = {};
  if (output.providerFailureClass) {
    carry.providerFailureClass = output.providerFailureClass;
  }
  if (output.providerLivenessTimeout !== undefined) {
    carry.providerLivenessTimeout = output.providerLivenessTimeout;
  }
  if (output.providerFailureNotice) {
    carry.providerFailureNotice = output.providerFailureNotice;
  }
  if (output.providerRateLimitScope) {
    carry.providerRateLimitScope = output.providerRateLimitScope;
  }
  if (output.providerRateLimitModel) {
    carry.providerRateLimitModel = output.providerRateLimitModel;
  }
  if (output.providerRateLimitResetsAt !== undefined) {
    carry.providerRateLimitResetsAt = output.providerRateLimitResetsAt;
  }
  return carry;
}

/**
 * The provider-failure projection a close handler must attach to its
 * synthesized output: the boolean flag plus the classification of the latest
 * streamed failure frame. Deliberately excludes turn-identity fields
 * (`inputTurnId`, `ipcReceipts`) — those are read as delivery evidence and
 * reply-correlation keys elsewhere, and a synthesized close output carries no
 * such evidence.
 */
function providerFailureCloseFields(
  state: StdoutParserState,
): Partial<ContainerOutput> {
  if (!state.hasProviderFailureOutput) return { providerFailure: false };
  return { providerFailure: true, ...(state.providerFailureCarryover ?? {}) };
}

/**
 * Stdout/stderr chars kept per runner stream for diagnostics (the tail buffer
 * holds between this and twice this many). Readers only
 * use the end of the stream (run-log tails, `stderr.slice(-200)` error
 * summaries), and the state lives as long as a warm runner — host mode has no
 * runner cap — so retaining the configured `containerMaxOutputSize` (10 MB by
 * default, x2 for UTF-16 text) per stream was pure memory cost.
 */
export const RUNNER_OUTPUT_RETAIN_LIMIT = 256 * 1024;

/**
 * The logger bounds string fields to their first 2000 chars; structured log
 * fields therefore carry tails of at most this size, so the end of the stream
 * (where the failure reason is) survives.
 */
const LOG_FIELD_TAIL_LIMIT = 2_000;

function runnerOutputRetainLimit(containerMaxOutputSize: number): number {
  return Math.min(containerMaxOutputSize, RUNNER_OUTPUT_RETAIN_LIMIT);
}

/**
 * Append to a rolling tail buffer that always holds at least the last `limit`
 * chars (or the whole shorter stream) and never more than 2 x `limit`.
 * Trimming back to `limit` only at 2 x `limit` amortizes the copy it costs to
 * about two chars per appended char, however small the chunks are; trimming on
 * every chunk would re-copy the whole tail for each streamed token frame.
 */
function appendBoundedTail(
  buffer: string,
  chunk: string,
  limit: number,
): string {
  const combined = buffer + chunk;
  return combined.length > 2 * limit
    ? combined.slice(combined.length - limit)
    : combined;
}

/**
 * Tail of a stream buffer for a structured log field. Starts on a line (else
 * whitespace) boundary so the first token is whole: the logger's credential
 * redaction keys on token prefixes such as `Bearer ` or `sk-`.
 */
function logFieldTail(text: string): string {
  if (text.length <= LOG_FIELD_TAIL_LIMIT) return text;
  const tail = text.slice(text.length - LOG_FIELD_TAIL_LIMIT);
  const lineBreak = tail.indexOf('\n');
  if (lineBreak !== -1) return tail.slice(lineBreak + 1);
  const space = tail.search(/\s/);
  return space !== -1 ? tail.slice(space + 1) : tail;
}

const MARKER_CARRY_LENGTH =
  Math.max(OUTPUT_START_MARKER.length, OUTPUT_END_MARKER.length) - 1;

function appendLegacyHead(
  head: LegacyStdoutHead,
  chunk: string,
  headLimit: number,
): void {
  const prevLength = head.text.length;
  const remaining = headLimit - prevLength;
  const part = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
  head.text += part;
  // Scan only the new chars plus a marker-length carry: indexOf on the whole
  // growing prefix would flatten and rescan it for every chunk.
  const window = head.carry + part;
  const windowStart = prevLength - head.carry.length;
  if (head.startIdx === -1) {
    const idx = window.indexOf(OUTPUT_START_MARKER);
    if (idx !== -1) head.startIdx = windowStart + idx;
  }
  if (head.endIdx === -1) {
    const idx = window.indexOf(OUTPUT_END_MARKER);
    if (idx !== -1) head.endIdx = windowStart + idx;
  }
  head.carry = window.slice(-MARKER_CARRY_LENGTH);
  if (head.startIdx !== -1 && head.endIdx > head.startIdx) {
    head.text = head.text.slice(0, head.endIdx + OUTPUT_END_MARKER.length);
    head.done = true;
  } else if (head.text.length >= headLimit) {
    // At the cap the parse input is final, like the former truncated buffer.
    head.done = true;
  }
}

export function attachStdoutHandler(
  stream: Readable,
  state: StdoutParserState,
  opts: StdoutParserOptions,
): void {
  // Read the limits once per stream: getSystemSettings() stats a file.
  const headLimit = getSystemSettings().containerMaxOutputSize;
  const retainLimit = runnerOutputRetainLimit(headLimit);
  stream.on('data', (data) => {
    const chunk = data.toString();

    // Bounded diagnostic tail, plus the prefix a legacy parse may need.
    const prevTotal = state.stdoutTotalChars;
    state.stdoutTotalChars += chunk.length;
    state.stdout = appendBoundedTail(state.stdout, chunk, retainLimit);
    if (!state.legacyHead.done) {
      appendLegacyHead(state.legacyHead, chunk, headLimit);
    }
    if (state.stdoutTotalChars > state.stdout.length) {
      state.stdoutTruncated = true;
    }
    // Warn at the configured limit, as before; the tail itself is silent.
    if (prevTotal <= headLimit && state.stdoutTotalChars > headLimit) {
      logger.warn(
        {
          group: opts.groupName,
          size: state.stdoutTotalChars,
          retained: retainLimit,
        },
        `${opts.label} stdout truncated due to size limit`,
      );
    }

    // Stream-parse for output markers. The scanner is incremental: each
    // character is examined a bounded number of times however the frames are
    // chunked (the old buffer rescan was quadratic in frame size).
    if (opts.onOutput) {
      for (const event of state.frameScanner.push(chunk)) {
        if (event.kind === 'overflow') {
          logger.warn(
            { group: opts.groupName, chars: event.chars },
            'Framed output object exceeded the size cap, dropping frame',
          );
          continue;
        }
        if (event.kind === 'broken') {
          logger.warn({ group: opts.groupName }, event.reason);
          continue;
        }
        const parsed = tryParseContainerOutput(event.json);
        if (!parsed) {
          // Balanced braces but not a valid ContainerOutput object (should not
          // happen for well-formed output). The frame is fully delimited, so
          // drop it and continue rather than stalling.
          logger.warn(
            { group: opts.groupName },
            'Framed JSON object failed to parse, skipping frame',
          );
          continue;
        }

        if (parsed.newSessionId) {
          state.newSessionId = parsed.newSessionId;
        }
        if (parsed.providerFailure) {
          // Current agent-runners derive this from the SDK's structured
          // rate_limit_event, so it remains authoritative even when the
          // accompanying result is null or the CLI banner wording changes.
          state.hasProviderFailureOutput = true;
          state.providerFailureCarryover =
            captureProviderFailureCarryover(parsed);
        }
        if (parsed.status === 'success') {
          state.hasSuccessOutput = true;
          if (
            !parsed.providerFailure &&
            isProviderFailureResult(parsed.result)
          ) {
            state.hasProviderFailureOutput = true;
            parsed.providerFailure = true;
            state.providerFailureCarryover =
              captureProviderFailureCarryover(parsed);
          }
        }
        if (parsed.status === 'closed') {
          state.hasClosedOutput = true;
        }
        if (
          parsed.status === 'stream' &&
          parsed.streamEvent?.statusText === 'interrupted'
        ) {
          state.hasInterruptedOutput = true;
        }
        // Activity detected — reset the hard timeout
        opts.resetTimeout();
        // Call onOutput for all markers (including null results) so idle timers
        // start even for "silent" query completions.
        const onOutputFn = opts.onOutput;
        const parsedForCallback = parsed;
        state.outputChain = state.outputChain
          .then(() => onOutputFn(parsedForCallback))
          .catch((err) => {
            logger.error(
              { group: opts.groupName, err },
              'onOutput callback error',
            );
          });
      }
    }
  });
}

// ─── Stderr Handler ──────────────────────────────────────────────────

export interface StderrState {
  /** Diagnostic tail of stderr, bounded like `StdoutParserState.stdout`. */
  stderr: string;
  /** Total stderr chars received, including those dropped from `stderr`. */
  stderrTotalChars: number;
  /** True once older stderr was dropped from the diagnostic tail. */
  stderrTruncated: boolean;
}

export function createStderrState(): StderrState {
  return {
    stderr: '',
    stderrTotalChars: 0,
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
  // Read the limits once per stream: getSystemSettings() stats a file.
  const warnLimit = getSystemSettings().containerMaxOutputSize;
  const retainLimit = runnerOutputRetainLimit(warnLimit);
  stream.on('data', (data) => {
    const chunk = data.toString();
    // Runner-side operational failures are prefixed so they survive the
    // debug-level default; without this they are invisible in production
    // (observed: every workspace-memory snapshot failure was dropped).
    const hasRunnerWarning = chunk.includes('[agent-runner:warn]');
    if (hasRunnerWarning || logger.isLevelEnabled('debug')) {
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        if (line.includes('[agent-runner:warn]')) {
          logger.warn(logContext, line);
        } else {
          logger.debug(logContext, line);
        }
      }
    }
    // Don't reset timeout on stderr — SDK writes debug logs continuously.
    // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
    const prevTotal = state.stderrTotalChars;
    state.stderrTotalChars += chunk.length;
    state.stderr = appendBoundedTail(state.stderr, chunk, retainLimit);
    if (state.stderrTotalChars > state.stderr.length) {
      state.stderrTruncated = true;
    }
    if (prevTotal <= warnLimit && state.stderrTotalChars > warnLimit) {
      logger.warn(
        {
          group: groupName,
          size: state.stderrTotalChars,
          retained: retainLimit,
        },
        `${Object.keys(logContext)[0] === 'container' ? 'Container' : 'Host agent'} stderr truncated due to size limit`,
      );
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
  enrichError?: (
    stderr: string,
    exitLabel: string,
  ) => { result: string | null; error: string };
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
    {
      group: ctx.groupName,
      [ctx.filePrefix === 'container' ? 'containerName' : 'processId']:
        ctx.identifier,
      duration,
      code,
    },
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
  const { stderr, stderrTruncated, stderrTotalChars } = ctx.stderrState;
  const { stdout, stdoutTruncated, stdoutTotalChars } = ctx.stdoutState;

  const LOG_TAIL_LIMIT = 4000;
  // Buffers are already tails; counts are against the full stream.
  const formatStreamLog = (retained: string, totalChars: number): string => {
    if (!isVerbose && !isError && retained.length > LOG_TAIL_LIMIT) {
      return (
        `... (truncated ${totalChars - LOG_TAIL_LIMIT} chars) ...\n` +
        retained.slice(-LOG_TAIL_LIMIT)
      );
    }
    const dropped = totalChars - retained.length;
    return dropped > 0
      ? `... (truncated ${dropped} chars) ...\n${retained}`
      : retained;
  };
  const stderrLog = formatStreamLog(stderr, stderrTotalChars);
  const stdoutLog = formatStreamLog(stdout, stdoutTotalChars);
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
    logLines.push(``, `=== Input ===`, JSON.stringify(ctx.input, null, 2));
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

  // Graceful interrupt: agent emitted 'interrupted' status before exiting.
  if (ctx.stdoutState.hasInterruptedOutput && ctx.onOutput) {
    logger.info(
      { group: ctx.groupName, code, signal, duration, newSessionId },
      `${ctx.label} exited after interrupt (treating as success)`,
    );
    waitForOutputChain(
      outputChain,
      ctx.groupName,
      `${ctx.filePrefix} interrupt path`,
      () => {
        ctx.resolvePromise({
          status: 'success',
          result: null,
          newSessionId,
          ...providerFailureCloseFields(ctx.stdoutState),
        });
      },
    );
    return true;
  }

  // A stream terminal already reached the host. Cleanup/PID1 wrappers can
  // still report a bogus non-zero (Docker code 2 after bash EXIT traps).
  // Keep the streamed status instead of inventing a hard failure.
  const hadStreamTerminal =
    ctx.stdoutState.hasSuccessOutput || ctx.stdoutState.hasClosedOutput;
  if (hadStreamTerminal && ctx.onOutput) {
    const finalStatus = ctx.stdoutState.hasSuccessOutput
      ? ('success' as const)
      : ('closed' as const);
    logger.info(
      {
        group: ctx.groupName,
        signal,
        code,
        duration,
        newSessionId,
        finalStatus,
      },
      `${ctx.label} exited non-zero after stream terminal (keeping stream status)`,
    );
    waitForOutputChain(
      outputChain,
      ctx.groupName,
      `${ctx.filePrefix} stream-terminal path`,
      () => {
        ctx.resolvePromise({
          status: finalStatus,
          result: null,
          newSessionId,
          ...providerFailureCloseFields(ctx.stdoutState),
        });
      },
    );
    return true;
  }

  // Graceful shutdown: agent was killed by SIGTERM/SIGKILL (e.g. user
  // clicked stop, session reset, clear-history) before emitting markers.
  const isForceKilled =
    signal === 'SIGTERM' || signal === 'SIGKILL' || code === 137;
  if (isForceKilled && ctx.onOutput) {
    logger.warn(
      { group: ctx.groupName, signal, code, duration },
      `${ctx.label} killed before producing any output — treating as error`,
    );
  }

  // Build error output
  const { stderr } = ctx.stderrState;
  const enriched = ctx.enrichError
    ? ctx.enrichError(stderr, exitLabel)
    : {
        result: null as string | null,
        error: `${ctx.label} exited with ${exitLabel}: ${stderr.slice(-200)}`,
      };

  logger.error(
    {
      group: ctx.groupName,
      code,
      signal,
      duration,
      stderr: logFieldTail(stderr),
      stdout: logFieldTail(ctx.stdoutState.stdout),
      stderrChars: ctx.stderrState.stderrTotalChars,
      stdoutChars: ctx.stdoutState.stdoutTotalChars,
      logFile,
    },
    `${ctx.label} exited with error`,
  );

  const finalizeError = () => {
    ctx.resolvePromise({
      status: 'error',
      result: enriched.result,
      error: enriched.error,
      ...providerFailureCloseFields(ctx.stdoutState),
    });
  };

  // Even on error exits, wait for pending output callbacks to settle.
  if (ctx.onOutput) {
    waitForOutputChain(
      outputChain,
      ctx.groupName,
      `${ctx.filePrefix} error path`,
      finalizeError,
    );
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
    waitForOutputChain(
      outputChain,
      ctx.groupName,
      `${ctx.filePrefix} success path`,
      () => {
        // Propagate 'closed' status so the host can distinguish a _close-interrupted
        // exit from a normal completion and avoid committing the message cursor.
        const finalStatus = hasClosedOutput
          ? ('closed' as const)
          : ('success' as const);
        logger.info(
          { group: ctx.groupName, duration, newSessionId, finalStatus },
          `${ctx.label} completed (streaming mode)`,
        );
        ctx.resolvePromise({
          status: finalStatus,
          result: null,
          newSessionId,
          ...providerFailureCloseFields(ctx.stdoutState),
        });
      },
    );
    return;
  }

  // Legacy mode: parse the last output marker pair from accumulated stdout
  parseLegacyOutput(ctx);
}

/**
 * Parse legacy (non-streaming) output from accumulated stdout.
 */
function parseLegacyOutput(ctx: CloseHandlerContext): void {
  // Same text the former head-capped stdout buffer held for this parse.
  const stdout = ctx.stdoutState.legacyHead.text;
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
        stdout: logFieldTail(ctx.stdoutState.stdout),
        stderr: logFieldTail(ctx.stderrState.stderr),
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

// ─── API Error Classification ────────────────────────────────────────

/** Patterns that indicate an API-level error (provider issue, not user code bug) */
const API_ERROR_PATTERNS = [
  /\bapi[_ ]?key\b.*\b(invalid|missing|expired|required)\b/i,
  /\bauthentication\s+(failed|error|required)\b/i,
  /\b(401|403)\b.*\bunauthorized\b/i,
  /\brate[_ ]?limit(ed)?\b/i,
  /\bquota\s+(exceeded|exhausted)\b/i,
  /\boverloaded\b/i,
  /\binternal\s+server\s+error\b/i,
  /\b(502|503|504|529)\b/,
  /ANTHROPIC_API_KEY/,
  /ANTHROPIC_AUTH_TOKEN/,
  /\binvalid[_ ]?api\b/i,
  /\bbilling\s+(error|issue|limit)\b/i,
  /\bcredit(s)?\s+(exhausted|insufficient)\b/i,
  /\bout of extra usage\b/i,
  /\byou(?:'ve|'re| are)\s+(?:hit|out of)\s+(?:your\s+)?(?:limit|extra usage)\b/i,
  /\bresets?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*\([^)]*\)/i,
  /connection\s*(refused|reset|timed?\s*out)/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT/,
];

/**
 * Detection for "the provider returned a quota/limit notice as the agent's
 * final text" (rather than a normal reply).
 *
 * CRITICAL: this runs against the agent's *normal reply body* (parsed.result),
 * not stderr. A match triggers killing the container, clearing the Claude
 * session and marking the provider unhealthy — all user-visible side effects.
 * So the match must be near-zero false-positive: generic substrings like
 * "rate limit" or "quota exceeded" appear constantly in legitimate technical
 * conversations ("to avoid hitting the API rate limit…", "disk quota
 * exceeded") and must NEVER be treated as a provider failure here.
 *
 * Current agent-runners send an explicit providerFailure derived from the
 * SDK's structured rate_limit_event. This parser remains as compatibility for
 * older runners, so it accepts only anchored Claude banner grammar and known
 * account/model labels. Model-only banners are classified separately and must
 * never make the whole provider profile unhealthy.
 */

export type ProviderLimitScope = 'account' | 'model';

const MODEL_LIMIT_LABELS = new Set(['opus', 'sonnet', 'fable 5']);
const ACCOUNT_LIMIT_LABELS = new Set([
  '',
  'session',
  'weekly',
  'usage',
  'monthly spend',
  'org monthly',
  'organization monthly',
]);

function hasKnownClaudeLimitNoticeTail(tail: string): boolean {
  const normalized = tail.trim();
  if (!normalized || /^[.!]$/.test(normalized)) return true;
  if (/^[.!]?\s*\/model\s+to\s+switch\s+models?[.!]?$/i.test(normalized)) {
    return true;
  }
  return /^[.!]?\s*(?:[·•—–-]\s*)?resets?\b.{0,160}$/i.test(normalized);
}

/**
 * Classify a textual Claude limit banner by blast radius. This is only a
 * compatibility fallback for older agent-runner/CLI builds; current runners
 * emit an explicit providerFailure from the SDK's structured rate_limit_event.
 *
 * Keep the grammar anchored and label-based. This function runs on normal
 * assistant replies, so accepting an arbitrary word before "limit" would turn
 * "You've reached your storage limit" into an account quarantine.
 */
export function classifyProviderLimitNotice(
  result: string | null,
): ProviderLimitScope | null {
  if (!result) return null;
  const normalized = result.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 400) return null;

  const direct = normalized.match(
    /^you(?:'ve| have)\s+(?:hit|reached)\s+your(?:\s+(session|weekly|usage|monthly\s+spend|org\s+monthly|organization\s+monthly|opus|sonnet|fable\s+5))?\s+limit\b(.*)$/i,
  );
  if (direct && hasKnownClaudeLimitNoticeTail(direct[2] ?? '')) {
    const label = (direct[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
    if (MODEL_LIMIT_LABELS.has(label)) return 'model';
    if (ACCOUNT_LIMIT_LABELS.has(label)) return 'account';
  }

  if (/^you(?:'re| are)\s+out\s+of\s+extra\s+usage\b(.*)$/i.test(normalized)) {
    const tail = normalized.replace(
      /^you(?:'re| are)\s+out\s+of\s+extra\s+usage\b/i,
      '',
    );
    return hasKnownClaudeLimitNoticeTail(tail) ? 'account' : null;
  }
  if (
    /^(?:claude\s+)?usage\s+limit\s+reached\b(?:[.!]?\s+your\s+(?:usage\s+)?limit\s+will\s+reset(?:\s+at)?\b.{0,160})?[.!]?$/i.test(
      normalized,
    )
  ) {
    return 'account';
  }
  if (
    /^upgrade\s+to\s+(?:increase|raise)\s+your\s+usage\s+limit\b(.*)$/i.test(
      normalized,
    )
  ) {
    const tail = normalized.replace(
      /^upgrade\s+to\s+(?:increase|raise)\s+your\s+usage\s+limit\b/i,
      '',
    );
    return hasKnownClaudeLimitNoticeTail(tail) ? 'account' : null;
  }
  if (
    /^your\s+(?:usage\s+)?limit\s+will\s+reset(?:\s+at)?\b.{0,160}$/i.test(
      normalized,
    )
  ) {
    return 'account';
  }
  return null;
}

/**
 * Classify whether stderr output indicates an API-level error
 * (provider unreachable, auth failure, rate limit, etc.)
 * vs a normal agent exit or user code issue.
 *
 * Used by container-runner to decide whether to report failure to ProviderPool.
 */
export function isApiError(stderr: string): boolean {
  if (!stderr) return false;
  return API_ERROR_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Whether the agent's final text is actually a Claude account-limit notice the
 * SDK surfaced as a "successful" result. See CLAUDE_LIMIT_* above for why this
 * deliberately avoids generic rate-limit/quota substrings.
 */
export function isProviderFailureResult(result: string | null): boolean {
  return classifyProviderLimitNotice(result) === 'account';
}
