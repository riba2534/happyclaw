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

function isJsonWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Find the end of the JSON object that starts at buf[start] (which must be '{').
 * Returns the index just AFTER the matching closing '}', or -1 if the object is
 * not yet complete in buf. String-aware: braces (and the literal START/END
 * marker strings the payload may quote) inside JSON string values do not affect
 * the brace depth, so this is never fooled by an embedded marker — even when a
 * second frame trails in the same buffer. O(buf length), single pass.
 */
function findJsonObjectEnd(buf: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

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
  /** True when SDK returned an API/provider failure as a successful final text. */
  hasProviderFailureOutput: boolean;
  /** True when agent emitted a stream event with statusText='interrupted'. */
  hasInterruptedOutput: boolean;
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
    hasProviderFailureOutput: false,
    hasInterruptedOutput: false,
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
      const remaining =
        getSystemSettings().containerMaxOutputSize - state.stdout.length;
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
        const lastMarkerIdx =
          state.parseBuffer.lastIndexOf(OUTPUT_START_MARKER);
        state.parseBuffer =
          lastMarkerIdx >= 0
            ? state.parseBuffer.slice(lastMarkerIdx)
            : state.parseBuffer.slice(-512);
      }
      let startIdx: number;
      while (
        (startIdx = state.parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
      ) {
        const contentStart = startIdx + OUTPUT_START_MARKER.length;
        // Locate the framed JSON object by brace matching rather than by
        // scanning for END markers. The agent's reply text can contain literal
        // START/END marker strings inside the JSON payload; deriving the
        // object's true end from the JSON structure is both correct (never
        // fooled by an embedded marker — even when a second frame trails in the
        // same buffer) and O(payload): no repeated slice+parse per candidate
        // terminator, which would stall the shared main-process event loop. The
        // ContainerOutput payload is always a JSON object.
        let objStart = contentStart;
        while (
          objStart < state.parseBuffer.length &&
          isJsonWhitespace(state.parseBuffer[objStart])
        ) {
          objStart++;
        }
        if (objStart >= state.parseBuffer.length) break; // only whitespace yet

        // Resync past a broken/unparseable frame so the buffer never stalls
        // until the size cap (the pre-refactor parser always advanced past a
        // malformed frame). `knownEnd`, when given, is this frame's already
        // located END index — used by the parse-failure path, whose object may
        // legitimately contain literal END marker strings, so we must NOT
        // re-scan for END from contentStart. Without it (non-object payload),
        // skip past whichever boundary arrives first: this frame's END (frame
        // fully delimited but malformed) or a later START. Returns false only
        // when neither boundary exists yet, so the caller waits for more data.
        const resyncPastBrokenFrame = (
          reason: string,
          knownEnd?: number,
        ): boolean => {
          let resyncTo = -1;
          if (knownEnd !== undefined) {
            resyncTo = knownEnd + OUTPUT_END_MARKER.length;
          } else {
            const nextStart = state.parseBuffer.indexOf(
              OUTPUT_START_MARKER,
              contentStart,
            );
            const endIdx = state.parseBuffer.indexOf(
              OUTPUT_END_MARKER,
              contentStart,
            );
            if (endIdx !== -1 && (nextStart === -1 || endIdx < nextStart)) {
              resyncTo = endIdx + OUTPUT_END_MARKER.length;
            } else if (nextStart !== -1) {
              resyncTo = nextStart;
            }
          }
          if (resyncTo === -1) return false;
          logger.warn({ group: opts.groupName }, reason);
          state.parseBuffer = state.parseBuffer.slice(resyncTo);
          return true;
        };

        if (state.parseBuffer[objStart] !== '{') {
          // Payload isn't a JSON object — framing is broken.
          if (
            resyncPastBrokenFrame(
              'Framed payload is not a JSON object, resyncing past broken frame',
            )
          ) {
            continue;
          }
          break;
        }

        const objEnd = findJsonObjectEnd(state.parseBuffer, objStart);
        if (objEnd === -1) break; // object still streaming in — wait
        const endIdx = state.parseBuffer.indexOf(OUTPUT_END_MARKER, objEnd);
        if (endIdx === -1) break; // object complete, END marker not here yet

        const parsed = tryParseContainerOutput(
          state.parseBuffer.slice(objStart, objEnd),
        );
        if (!parsed) {
          // Balanced braces but not a valid ContainerOutput object (should not
          // happen for well-formed output). The frame is fully delimited (END
          // already located at endIdx), so drop it and continue rather than
          // stalling until the buffer cap — no later START is required.
          resyncPastBrokenFrame(
            'Framed JSON object failed to parse, skipping frame',
            endIdx,
          );
          continue;
        }

        state.parseBuffer = state.parseBuffer.slice(
          endIdx + OUTPUT_END_MARKER.length,
        );

        if (parsed.newSessionId) {
          state.newSessionId = parsed.newSessionId;
        }
        if (parsed.status === 'success') {
          state.hasSuccessOutput = true;
          if (isProviderFailureResult(parsed.result)) {
            state.hasProviderFailureOutput = true;
            parsed.providerFailure = true;
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
    const remaining =
      getSystemSettings().containerMaxOutputSize - state.stderr.length;
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
  const { stderr, stderrTruncated } = ctx.stderrState;
  const { stdout, stdoutTruncated } = ctx.stdoutState;

  const LOG_TAIL_LIMIT = 4000;
  const stderrLog =
    !isVerbose && !isError && stderr.length > LOG_TAIL_LIMIT
      ? `... (truncated ${stderr.length - LOG_TAIL_LIMIT} chars) ...\n` +
        stderr.slice(-LOG_TAIL_LIMIT)
      : stderr;
  const stdoutLog =
    !isVerbose && !isError && stdout.length > LOG_TAIL_LIMIT
      ? `... (truncated ${stdout.length - LOG_TAIL_LIMIT} chars) ...\n` +
        stdout.slice(-LOG_TAIL_LIMIT)
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
          providerFailure: ctx.stdoutState.hasProviderFailureOutput,
        });
      },
    );
    return true;
  }

  // Graceful shutdown: agent was killed by SIGTERM/SIGKILL (e.g. user
  // clicked stop, session reset, clear-history). Treat as normal
  // completion instead of an error — BUT only if the agent had already
  // produced some output. If killed before emitting ANY output markers
  // (success/closed), it means the process died during initialization
  // (e.g., race condition) and should be treated as an error so the UI
  // waiting state gets cleared via sendSystemMessage('agent_error').
  const isForceKilled =
    signal === 'SIGTERM' || signal === 'SIGKILL' || code === 137;
  if (isForceKilled && ctx.onOutput) {
    const hadOutput =
      ctx.stdoutState.hasSuccessOutput || ctx.stdoutState.hasClosedOutput;

    if (hadOutput) {
      logger.info(
        { group: ctx.groupName, signal, code, duration, newSessionId },
        `${ctx.label} terminated by signal (user stop / graceful shutdown)`,
      );
      waitForOutputChain(
        outputChain,
        ctx.groupName,
        `${ctx.filePrefix} force-kill path`,
        () => {
          ctx.resolvePromise({
            status: 'success',
            result: null,
            newSessionId,
            providerFailure: ctx.stdoutState.hasProviderFailureOutput,
          });
        },
      );
      return true;
    }

    // Agent was killed before producing any output — fall through to
    // error path so the caller can broadcast an error and clear the UI.
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
      providerFailure: ctx.stdoutState.hasProviderFailureOutput,
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
    const { hasClosedOutput, hasProviderFailureOutput } = ctx.stdoutState;
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
          providerFailure: hasProviderFailureOutput,
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
 * We therefore require a *structured* Claude account-limit signal:
 *  - a Claude-specific limit phrase ("out of extra usage", "you've hit your
 *    limit", "usage limit reached", "upgrade to increase your usage limit"),
 *    AND
 *  - the message reads as a short system-style notice, not a long answer that
 *    merely quotes the phrase. Real Claude limit notices are a single terse
 *    line; agent replies discussing rate limits are much longer.
 *
 * The strongest, length-independent signal is the reset timestamp Claude
 * appends to genuine limit notices ("· resets 2:10am (Asia/Shanghai)"); when a
 * Claude limit phrase co-occurs with that timestamp we accept regardless of
 * length, since no normal reply produces both together.
 */

/** Claude-specific account/usage-limit phrases (not generic provider errors). */
const CLAUDE_LIMIT_PHRASE_PATTERNS = [
  /\bout of extra usage\b/i,
  // Optional qualifier before "limit" so the real Claude banner "you've hit
  // your SESSION limit" (also "weekly"/"usage"/etc.) matches, not just the bare
  // "your limit". Without it, account session limits went undetected — the
  // English notice leaked to the user and the provider was never marked
  // unhealthy, so weighted pools never rotated off the exhausted account.
  /\byou(?:'ve|'re| are)\s+(?:hit|out of|reached)\s+(?:your\s+)?(?:\w+\s+)?(?:limit|extra usage)\b/i,
  // "usage limit reached" — anchored on "usage" so a generic "rate limit
  // reached" / "request limit reached" in a normal reply does not match.
  /\busage\s+limit\s+reached\b/i,
  /\bupgrade\s+to\s+(?:increase|raise)\s+your\s+usage\s+limit\b/i,
  /\byour\s+(?:usage\s+)?limit\s+will\s+reset\b/i,
];

/** The reset-timestamp suffix Claude appends to genuine limit notices. */
const CLAUDE_LIMIT_RESET_PATTERN =
  /\bresets?\b[^.\n]*?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*\([^)]*\)/i;

/**
 * Upper bound (chars) for treating a Claude limit phrase as a *standalone*
 * system notice. Genuine notices are a single short line; this guards against
 * a long agent reply that merely mentions the phrase mid-answer.
 */
const CLAUDE_LIMIT_NOTICE_MAX_LEN = 200;

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
  if (!result) return false;
  const trimmed = result.trim();
  if (!trimmed) return false;

  const hasLimitPhrase = CLAUDE_LIMIT_PHRASE_PATTERNS.some((p) =>
    p.test(trimmed),
  );
  if (!hasLimitPhrase) return false;

  // Accept when a Claude reset timestamp accompanies the phrase (length-
  // independent: no normal reply emits both), or when the whole result is a
  // short standalone notice rather than a long answer quoting the phrase.
  return (
    CLAUDE_LIMIT_RESET_PATTERN.test(trimmed) ||
    trimmed.length <= CLAUDE_LIMIT_NOTICE_MAX_LEN
  );
}
