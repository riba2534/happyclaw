import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const settings = vi.hoisted(() => ({ containerMaxOutputSize: 10_485_760 }));
const getSystemSettings = vi.hoisted(() => vi.fn(() => settings));
const logged = vi.hoisted(() => ({
  warn: [] as Array<[Record<string, unknown>, string]>,
  error: [] as Array<[Record<string, unknown>, string]>,
}));

vi.mock('../src/runtime-config.js', () => ({ getSystemSettings }));
vi.mock('../src/logger.js', () => ({
  logger: {
    isLevelEnabled: () => false,
    debug: () => {},
    info: () => {},
    warn: (obj: Record<string, unknown>, msg: string) =>
      logged.warn.push([obj, msg]),
    error: (obj: Record<string, unknown>, msg: string) =>
      logged.error.push([obj, msg]),
  },
}));

const {
  OUTPUT_END_MARKER: E,
  OUTPUT_START_MARKER: S,
  RUNNER_OUTPUT_RETAIN_LIMIT,
  attachStderrHandler,
  attachStdoutHandler,
  createStderrState,
  createStdoutParserState,
  handleNonZeroExit,
  handleSuccessClose,
  writeRunLog,
} = await import('../src/agent-output-parser.js');
type ContainerOutput =
  import('../src/agent-runtime-contracts.js').ContainerOutput;
type CloseHandlerContext =
  import('../src/agent-output-parser.js').CloseHandlerContext;

const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-output-'));
afterAll(() => fs.rmSync(logsDir, { recursive: true, force: true }));

beforeEach(() => {
  settings.containerMaxOutputSize = 10_485_760;
  getSystemSettings.mockClear();
  logged.warn.length = 0;
  logged.error.length = 0;
  delete process.env.LOG_LEVEL;
});

/** Deterministic pseudo-random chunk sizes, including tiny ones. */
function* chunkSizes(seed: number): Generator<number> {
  let x = (seed % 2147483646) + 1;
  for (;;) {
    x = (x * 48271) % 2147483647;
    yield 1 + (x % 70_000);
  }
}

function feed(stream: PassThrough, text: string, seed = 7): void {
  const sizes = chunkSizes(seed);
  for (let i = 0; i < text.length; ) {
    const n = sizes.next().value as number;
    stream.emit('data', Buffer.from(text.slice(i, i + n)));
    i += n;
  }
}

/** At least the last `limit` chars, at most 2 x `limit`, and a true tail. */
function expectBoundedTail(retained: string, full: string, limit: number) {
  expect(retained.length).toBeGreaterThanOrEqual(Math.min(full.length, limit));
  expect(retained.length).toBeLessThanOrEqual(2 * limit);
  expect(retained).toBe(full.slice(full.length - retained.length));
}

function frame(output: ContainerOutput): string {
  return `${S}${JSON.stringify(output)}${E}\n`;
}

function noise(chars: number, tag: string): string {
  const line = `${tag} ${'n'.repeat(120)}\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

function attachStdout(
  onOutput: (o: ContainerOutput) => Promise<void> = async () => {},
) {
  const stream = new PassThrough();
  const state = createStdoutParserState();
  attachStdoutHandler(stream, state, {
    groupName: 'g',
    label: 'Container',
    onOutput,
    resetTimeout: () => {},
  });
  return { stream, state };
}

function closeContext(
  stdoutState: ReturnType<typeof createStdoutParserState>,
  stderrState: ReturnType<typeof createStderrState>,
  resolvePromise: (o: ContainerOutput) => void,
  onOutput?: (o: ContainerOutput) => Promise<void>,
): CloseHandlerContext {
  return {
    groupName: 'g',
    label: 'Container',
    filePrefix: 'container',
    identifier: 'c-1',
    logsDir,
    input: { prompt: 'p', isMain: false },
    stdoutState,
    stderrState,
    onOutput,
    resolvePromise,
    startTime: Date.now(),
    timeoutMs: 1_000,
  };
}

/** The pre-change legacy parse: head-capped buffer, first START/first END. */
function formerLegacyParse(full: string, cap: number): unknown {
  const stdout = full.slice(0, cap);
  try {
    const startIdx = stdout.indexOf(S);
    const endIdx = stdout.indexOf(E);
    const jsonLine =
      startIdx !== -1 && endIdx !== -1 && endIdx > startIdx
        ? stdout.slice(startIdx + S.length, endIdx).trim()
        : stdout.trim().split('\n').at(-1)!;
    return JSON.parse(jsonLine);
  } catch {
    return 'parse-error';
  }
}

describe('runner stdout tail', () => {
  test('retains a bounded tail of a large stream while frames still parse', async () => {
    const outputs: ContainerOutput[] = [];
    const { stream, state } = attachStdout(async (o) => {
      outputs.push(o);
    });
    let full = '';
    for (let i = 0; i < 300; i++) {
      full += noise(10_000, `line-${i}`);
      full += frame({ status: 'stream', result: `r${i} ${S} ${E} }{` });
    }
    feed(stream, full);
    await state.outputChain;

    expect(full.length).toBeGreaterThan(RUNNER_OUTPUT_RETAIN_LIMIT * 10);
    expectBoundedTail(state.stdout, full, RUNNER_OUTPUT_RETAIN_LIMIT);
    expect(state.stdoutTotalChars).toBe(full.length);
    expect(state.stdoutTruncated).toBe(true);
    // The legacy prefix freezes at the first complete frame.
    expect(state.legacyHead.text.length).toBeLessThan(11_000);
    // Marker parsing uses its own buffer and sees every frame.
    expect(outputs.map((o) => o.result)).toEqual(
      Array.from({ length: 300 }, (_, i) => `r${i} ${S} ${E} }{`),
    );
    expect(state.parseBuffer).toBe('\n');
  });

  test('stays linear and bounded under many tiny chunks', () => {
    // No onOutput: exercises the tail and legacy prefix without the frame
    // parser's own buffer.
    const stream = new PassThrough();
    const state = createStdoutParserState();
    attachStdoutHandler(stream, state, {
      groupName: 'g',
      label: 'Host agent',
      resetTimeout: () => {},
    });
    const full =
      noise(600_000, 'tiny') +
      frame({ status: 'success', result: 'mid' }) +
      noise(600_000, 'more');
    const started = Date.now();
    for (let i = 0, n = 1; i < full.length; i += n, n = 1 + (i % 23)) {
      stream.emit('data', Buffer.from(full.slice(i, i + n)));
    }
    expect(Date.now() - started).toBeLessThan(4_000);
    expectBoundedTail(state.stdout, full, RUNNER_OUTPUT_RETAIN_LIMIT);
    expect(state.stdoutTotalChars).toBe(full.length);
    // Markers split across chunks are still located exactly.
    const endIdx = full.indexOf(E);
    expect(state.legacyHead.startIdx).toBe(full.indexOf(S));
    expect(state.legacyHead.endIdx).toBe(endIdx);
    expect(state.legacyHead.done).toBe(true);
    expect(state.legacyHead.text).toBe(full.slice(0, endIdx + E.length));
  });

  test('reads the size setting once per stream, not per chunk', () => {
    const { stream } = attachStdout();
    const err = new PassThrough();
    attachStderrHandler(err, createStderrState(), 'g', { container: 'g' });
    const calls = getSystemSettings.mock.calls.length;
    feed(stream, noise(2_000_000, 'x'));
    feed(err, noise(2_000_000, 'y'));
    expect(calls).toBe(2);
    expect(getSystemSettings.mock.calls.length).toBe(calls);
  });

  test('a smaller configured limit bounds the tail', () => {
    settings.containerMaxOutputSize = 50_000;
    const { stream, state } = attachStdout();
    const full = noise(120_000, 'small');
    feed(stream, full);
    expectBoundedTail(state.stdout, full, 50_000);
    expect(state.legacyHead.text).toBe(full.slice(0, 50_000));
  });

  test('warns once when the configured limit is crossed, not at the tail cap', () => {
    settings.containerMaxOutputSize = 1_048_576;
    const { stream, state } = attachStdout();
    feed(stream, noise(2 * RUNNER_OUTPUT_RETAIN_LIMIT + 10_000, 'a'));
    expect(state.stdoutTruncated).toBe(true);
    expect(logged.warn.filter(([, m]) => m.includes('stdout'))).toHaveLength(0);

    feed(stream, noise(2_000_000, 'b'));
    const warns = logged.warn.filter(([, m]) =>
      m.includes('stdout truncated due to size limit'),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0][0].size).toBeGreaterThan(1_048_576);
  });

  test('small streams are kept whole and not flagged', () => {
    const { stream, state } = attachStdout();
    const full =
      noise(5_000, 'tiny') + frame({ status: 'success', result: 'ok' });
    feed(stream, full);
    expect(state.stdout).toBe(full);
    expect(state.stdoutTotalChars).toBe(full.length);
    expect(state.stdoutTruncated).toBe(false);
  });
});

describe('runner stderr tail', () => {
  test('retains the last chars with exact totals', () => {
    const stream = new PassThrough();
    const state = createStderrState();
    attachStderrHandler(stream, state, 'g', { host: 'g' });
    const full = noise(3_000_000, 'stderr') + 'FINAL: Cannot start';
    feed(stream, full, 11);

    expectBoundedTail(state.stderr, full, RUNNER_OUTPUT_RETAIN_LIMIT);
    expect(state.stderrTotalChars).toBe(full.length);
    expect(state.stderrTruncated).toBe(true);
    expect(
      logged.warn.filter(
        ([, m]) => m === 'Host agent stderr truncated due to size limit',
      ),
    ).toHaveLength(0);
  });
});

describe('close handlers read the tails', () => {
  async function runWithLargeOutput() {
    const { stream, state } = attachStdout();
    const err = new PassThrough();
    const stderrState = createStderrState();
    attachStderrHandler(err, stderrState, 'g', { container: 'g' });
    const fullOut = noise(600_000, 'out') + 'LAST STDOUT LINE';
    const fullErr =
      noise(600_000, 'err') + 'Error: real failure reason at the end';
    feed(stream, fullOut);
    feed(err, fullErr);
    await state.outputChain;
    return { state, stderrState, fullOut, fullErr };
  }

  test('error exit summarises and logs the end of the stream', async () => {
    const { state, stderrState, fullOut, fullErr } = await runWithLargeOutput();
    const result = await new Promise<ContainerOutput>((resolve) =>
      handleNonZeroExit(
        closeContext(state, stderrState, resolve),
        1,
        null,
        5,
        '/dev/null',
      ),
    );
    expect(result.error).toBe(
      `Container exited with code 1: ${fullErr.slice(-200)}`,
    );
    const [fields] = logged.error.find(([, m]) =>
      m.includes('exited with error'),
    )!;
    expect(fields.stderrChars).toBe(fullErr.length);
    expect(fields.stdoutChars).toBe(fullOut.length);
    const stderrField = fields.stderr as string;
    const stdoutField = fields.stdout as string;
    expect(stderrField.length).toBeLessThanOrEqual(2_000);
    expect(stderrField.endsWith('Error: real failure reason at the end')).toBe(
      true,
    );
    expect(fullErr.endsWith(stderrField)).toBe(true);
    // Starts on a line boundary.
    expect(fullErr[fullErr.length - stderrField.length - 1]).toBe('\n');
    expect(stdoutField.endsWith('LAST STDOUT LINE')).toBe(true);
  });

  test('run log reports truncation against the full stream size', async () => {
    const { state, stderrState, fullOut, fullErr } = await runWithLargeOutput();
    const okLog = fs.readFileSync(
      writeRunLog(
        closeContext(state, stderrState, () => {}),
        0,
        5,
      ),
      'utf8',
    );
    expect(okLog).toContain(
      `... (truncated ${fullErr.length - 4000} chars) ...\n${fullErr.slice(-4000)}`,
    );
    expect(okLog).toContain(
      `... (truncated ${fullOut.length - 4000} chars) ...\n${fullOut.slice(-4000)}`,
    );
    expect(okLog).toContain('=== Stdout (TRUNCATED) ===');

    const errLog = fs.readFileSync(
      writeRunLog(
        closeContext(state, stderrState, () => {}),
        1,
        5,
      ),
      'utf8',
    );
    expect(errLog).toContain(
      `... (truncated ${fullErr.length - stderrState.stderr.length} chars) ...\n${stderrState.stderr}`,
    );
  });
});

describe('legacy (no onOutput) parse keeps its former result', () => {
  const cases: Array<[string, string]> = [
    [
      'first frame then a large tail',
      frame({ status: 'success', result: 'first' }) +
        noise(700_000, 'after') +
        frame({ status: 'success', result: 'second' }),
    ],
    [
      'noise before the first frame',
      noise(400_000, 'before') + frame({ status: 'success', result: 'late' }),
    ],
    [
      'stray END before START falls back to the last line of the head',
      `${E}\n` +
        noise(300_000, 'mid') +
        frame({ status: 'success', result: 'x' }) +
        '{"status":"success","result":"last-line"}\n',
    ],
    [
      'no markers: last line',
      noise(1_000, 'n') + '{"status":"error","result":null}',
    ],
    [
      'frame beyond the head cap',
      noise(1_100_000, 'big') + frame({ status: 'success', result: 'z' }),
    ],
  ];

  test.each(cases)('%s', async (_name, full) => {
    settings.containerMaxOutputSize = 1_048_576;
    // container-runner always streams through a handler; legacy is decided
    // by the close context lacking onOutput.
    const { stream, state } = attachStdout();
    feed(stream, full, full.length);
    await state.outputChain;
    const result = await new Promise<ContainerOutput>((resolve) =>
      handleSuccessClose(
        closeContext(state, createStderrState(), resolve, undefined),
        5,
      ),
    );
    const expected = formerLegacyParse(full, settings.containerMaxOutputSize);
    if (expected === 'parse-error') {
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/^Failed to parse container output/);
    } else {
      expect(result).toEqual(expected);
    }
    expect(state.stdout.length).toBeLessThanOrEqual(
      2 * RUNNER_OUTPUT_RETAIN_LIMIT,
    );
  });
});
