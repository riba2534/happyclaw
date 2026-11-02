import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const settings = vi.hoisted(() => ({ containerMaxOutputSize: 10_485_760 }));
const getSystemSettings = vi.hoisted(() => vi.fn(() => settings));
const logged = vi.hoisted(() => ({
  info: [] as Array<[Record<string, unknown>, string]>,
  warn: [] as Array<[Record<string, unknown>, string]>,
  error: [] as Array<[Record<string, unknown>, string]>,
}));

vi.mock('../src/runtime-config.js', () => ({ getSystemSettings }));
vi.mock('../src/logger.js', () => ({
  logger: {
    isLevelEnabled: () => false,
    debug: () => {},
    info: (obj: Record<string, unknown>, msg: string) =>
      logged.info.push([obj, msg]),
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
  RUN_LOG_MAX_BYTES,
  handleNonZeroExit,
  handleSuccessClose,
  handleTimeoutClose,
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
    input: { prompt: 'p', agentId: 'session-1' },
    stdoutState,
    stderrState,
    onOutput,
    resolvePromise,
    startTime: Date.now(),
    timeoutMs: 1_000,
  };
}

function readLog(file: string | null): string {
  expect(file).not.toBeNull();
  return fs.readFileSync(file!, 'utf8');
}

/** A stream section of a run log, split into its note and the shown tail. */
function streamSection(log: string, name: 'Stderr' | 'Stdout') {
  const title = log.match(
    new RegExp(`\\n=== ${name}( \\(TRUNCATED\\))? ===\\n`),
  )!;
  const from = title.index! + title[0].length;
  const to =
    name === 'Stderr' ? log.indexOf('\n\n=== Stdout', from) : log.length;
  const body = log.slice(from, to);
  const note = body.match(/^\.\.\. \(truncated (\d+) chars\) \.\.\.\n/);
  return {
    truncated: title[1] !== undefined,
    dropped: note ? Number(note[1]) : 0,
    tail: note ? body.slice(note[0].length) : body,
  };
}

/** The shown tail is the end of the stream, from a line start, and the note counts the rest. */
function expectLineTail(
  section: { dropped: number; tail: string },
  full: string,
): void {
  expect(full.endsWith(section.tail)).toBe(true);
  expect(full[full.length - section.tail.length - 1]).toBe('\n');
  expect(section.dropped).toBe(full.length - section.tail.length);
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
    expect(state.frameScanner.pendingChars).toBeLessThan(64);
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

  test('prefixed runner lines reach production levels; the rest stays debug', () => {
    const stream = new PassThrough();
    attachStderrHandler(stream, createStderrState(), 'g', { host: 'g' });
    const info = '[agent-runner:info] [query-timing] mode=resume init=812ms';
    const warn = '[agent-runner:warn] [tool-loop] suspected rule=repeat';
    stream.write(`[agent-runner] plain line\n${info}\n${warn}\n`);

    expect(logged.info).toContainEqual([{ host: 'g' }, info]);
    expect(logged.warn).toContainEqual([{ host: 'g' }, warn]);
    expect(logged.info.some(([, m]) => m.includes('plain line'))).toBe(false);
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
    const okLog = readLog(
      writeRunLog(
        closeContext(state, stderrState, () => {}),
        0,
        5,
      ),
    );
    // A successful run keeps a short tail of each stream.
    for (const [name, full, end] of [
      ['Stderr', fullErr, 'Error: real failure reason at the end'],
      ['Stdout', fullOut, 'LAST STDOUT LINE'],
    ] as const) {
      const section = streamSection(okLog, name);
      expect(section.truncated, name).toBe(true);
      expect(section.tail.length, name).toBeLessThanOrEqual(4000);
      expect(section.tail.length, name).toBeGreaterThan(3800);
      expect(section.tail.endsWith(end), name).toBe(true);
      expectLineTail(section, full);
    }

    const errLog = readLog(
      writeRunLog(
        closeContext(state, stderrState, () => {}),
        1,
        5,
      ),
    );
    // An error run keeps all it can of the retained tails.
    const stderrSection = streamSection(errLog, 'Stderr');
    expectLineTail(stderrSection, fullErr);
    expect(stderrSection.tail.length).toBeGreaterThan(200_000);
  });
});

describe('run log files', () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  function tmpLogsDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-logs-'));
    tmpDirs.push(dir);
    return dir;
  }

  function logContext(
    overrides: Partial<CloseHandlerContext> & {
      stderr?: string;
      stdout?: string;
    },
  ): CloseHandlerContext {
    const { stderr = '', stdout = '', ...rest } = overrides;
    const stdoutState = Object.assign(createStdoutParserState(), {
      stdout,
      stdoutTotalChars: stdout.length,
    });
    const stderrState = {
      stderr,
      stderrTotalChars: stderr.length,
      stderrTruncated: false,
    };
    return {
      ...closeContext(stdoutState, stderrState, () => {}),
      logsDir: tmpLogsDir(),
      ...rest,
    };
  }

  /** Writes the log of an error exit and checks it stays within the cap. */
  function boundedErrorLog(ctx: CloseHandlerContext): string {
    const log = readLog(writeRunLog(ctx, 1, 5));
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(RUN_LOG_MAX_BYTES);
    return log;
  }

  /** Whole lines of mixed one-, three- and four-byte chars. */
  function multibyte(chars: number, tag: string): string {
    const line = `${tag} 错误输出🙂${'汉字'.repeat(30)} ascii\n`;
    return line.repeat(Math.ceil(chars / line.length));
  }

  const summaryLines = ['', '=== Mounts ===', '/workspace/group', '/home/node'];
  const verboseLines = [
    '=== Container Args ===',
    'run -i --rm --name happyclaw-test',
    '',
    '=== Mounts (detailed) ===',
    '/data/groups/g -> /workspace/group',
  ];

  test('an oversized log keeps the head whole and the end of each stream', () => {
    const stderr = multibyte(500_000, 'err') + 'STDERR END';
    const stdout = multibyte(500_000, 'out') + '\nLAST STDOUT LINE';
    expect(Buffer.byteLength(stderr + stdout)).toBeGreaterThan(
      2 * RUN_LOG_MAX_BYTES,
    );
    const ctx = logContext({
      stderr,
      stdout,
      input: { prompt: 'p'.repeat(321), sessionId: 'sdk-1', agentId: 's-1' },
      extraSummaryLines: summaryLines,
      extraVerboseLines: verboseLines,
    });
    const log = boundedErrorLog(ctx);

    // The budget goes to the streams, not to slack.
    expect(Buffer.byteLength(log)).toBeGreaterThan(RUN_LOG_MAX_BYTES - 1024);
    expect(log).not.toContain('�');
    expect(log.startsWith('=== Container Run Log ===\n')).toBe(true);
    expect(log).toContain(
      [
        'Session: s-1',
        'Duration: 5ms',
        'Exit Code: 1',
        'Stdout Truncated: false',
        'Stderr Truncated: false',
        '',
        '=== Input Summary ===',
        'Prompt length: 321 chars',
        'Session ID: sdk-1',
        ...summaryLines,
        '',
        ...verboseLines,
        '',
        '=== Stderr (TRUNCATED) ===',
      ].join('\n'),
    );

    const err = streamSection(log, 'Stderr');
    const out = streamSection(log, 'Stdout');
    expectLineTail(err, stderr);
    expectLineTail(out, stdout);
    expect(err.tail.endsWith('STDERR END')).toBe(true);
    // Neither stream crowds out the other.
    expect(Buffer.byteLength(err.tail)).toBeGreaterThan(400_000);
    expect(Buffer.byteLength(out.tail)).toBeGreaterThan(400_000);
    // Bug reports read the last 50 lines of the newest log.
    expect(log.split('\n').slice(-50).at(-1)).toBe('LAST STDOUT LINE');
  });

  test('a short stderr leaves its share of the budget to stdout', () => {
    const stdout = multibyte(900_000, 'out') + '\nLAST STDOUT LINE';
    const log = boundedErrorLog(
      logContext({ stderr: 'Error: boom\n', stdout }),
    );
    expect(streamSection(log, 'Stderr')).toEqual({
      truncated: false,
      dropped: 0,
      tail: 'Error: boom\n',
    });
    const out = streamSection(log, 'Stdout');
    expectLineTail(out, stdout);
    expect(Buffer.byteLength(out.tail)).toBeGreaterThan(
      RUN_LOG_MAX_BYTES - 2048,
    );
  });

  test('a stream without line breaks is cut on a char boundary', () => {
    const stdout = '汉🙂'.repeat(400_000) + 'END';
    const log = boundedErrorLog(logContext({ stdout }));
    expect(log).not.toContain('�');
    const out = streamSection(log, 'Stdout');
    expect(out.tail.endsWith('END')).toBe(true);
    expect(stdout.endsWith(out.tail)).toBe(true);
    expect(out.dropped).toBe(stdout.length - out.tail.length);
  });

  test('drops counted before the retained tail are part of the note', () => {
    const stdout = 'partial line\nkept 1\nkept 2';
    const ctx = logContext({ stdout });
    ctx.stdoutState.stdoutTotalChars = 10_000 + stdout.length;
    ctx.stdoutState.stdoutTruncated = true;
    const log = readLog(writeRunLog(ctx, 1, 5));
    // The retained tail starts mid-line, so its first line is not shown.
    expect(streamSection(log, 'Stdout')).toEqual({
      truncated: true,
      dropped: 10_000 + 'partial line\n'.length,
      tail: 'kept 1\nkept 2',
    });
  });

  test('fixed sections that alone overflow the cap keep the start and the end', () => {
    const log = boundedErrorLog(
      logContext({
        stdout: 'LAST STDOUT LINE',
        extraVerboseLines: ['=== Container Args ===', '汉🙂'.repeat(500_000)],
      }),
    );
    expect(log.startsWith('=== Container Run Log ===\n')).toBe(true);
    expect(log).not.toContain('�');
    expect(log).toMatch(
      /\n\.\.\. \(run log of \d+ bytes cut to 1048576\) \.\.\.\n/,
    );
    expect(log.endsWith('=== Stdout ===\nLAST STDOUT LINE')).toBe(true);
  });

  test('error logs carry no runner input, only its summary', () => {
    const secretPrompt = 'PROMPT-TEXT-THAT-MUST-NOT-PERSIST';
    const log = readLog(
      writeRunLog(
        logContext({
          stdout: 'out',
          input: { prompt: secretPrompt, agentId: 's-1' },
        }),
        1,
        5,
      ),
    );
    expect(log).not.toContain(secretPrompt);
    expect(log).not.toContain('=== Input ===');
    expect(log).not.toContain('Additional Diagnostics');
    expect(log).not.toContain('omitted');
    expect(log).toContain(`Prompt length: ${secretPrompt.length} chars`);
    // Without verbose lines the summary runs straight into the streams.
    expect(log).toContain('Session ID: new\n\n=== Stderr ===\n');
  });

  test('successful runs leave out the verbose diagnostics', () => {
    const log = readLog(
      writeRunLog(logContext({ extraVerboseLines: verboseLines }), 0, 5),
    );
    expect(log).not.toContain('=== Container Args ===');
  });

  function seedLogs(dir: string): { container: string[]; kept: string[] } {
    // Older than any log written now; names sort by time.
    const container = Array.from(
      { length: 25 },
      (_, i) =>
        `container-2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z.log`,
    );
    const kept = [
      'host-2019-01-01T00-00-00-000Z.log',
      'host-2019-01-01T00-00-01-000Z.log',
      'container-notes.txt',
      'other.log',
      'containers-2019-01-01T00-00-00-000Z.log',
    ];
    for (const name of [...container, ...kept]) {
      fs.writeFileSync(path.join(dir, name), name);
    }
    fs.mkdirSync(path.join(dir, 'container-2000-01-01T00-00-00-000Z.log'));
    kept.push('container-2000-01-01T00-00-00-000Z.log');
    return { container, kept };
  }

  function containerLogs(dir: string): string[] {
    return fs
      .readdirSync(dir)
      .filter((name) => /^container-\d{4}-.*\.log$/.test(name))
      .filter((name) => fs.statSync(path.join(dir, name)).isFile())
      .sort();
  }

  test('keeps the newest logs of the same prefix and nothing else is touched', () => {
    const ctx = logContext({ stdout: 'out' });
    const { container, kept } = seedLogs(ctx.logsDir);

    const file = writeRunLog(ctx, 0, 5)!;

    // Twenty in all, the new one included.
    expect(containerLogs(ctx.logsDir)).toEqual([
      ...container.slice(-19),
      path.basename(file),
    ]);
    for (const name of kept) {
      expect(fs.existsSync(path.join(ctx.logsDir, name)), name).toBe(true);
    }
  });

  test('a timeout log is pruned the same way', () => {
    const resolved: ContainerOutput[] = [];
    const ctx = logContext({ resolvePromise: (o) => resolved.push(o) });
    const { container, kept } = seedLogs(ctx.logsDir);

    expect(handleTimeoutClose(ctx, 137, 5, true)).toBe(true);

    const logs = containerLogs(ctx.logsDir);
    expect(logs.slice(0, -1)).toEqual(container.slice(-19));
    expect(readLog(path.join(ctx.logsDir, logs.at(-1)!))).toContain(
      '=== Container Run Log (TIMEOUT) ===',
    );
    for (const name of kept) {
      expect(fs.existsSync(path.join(ctx.logsDir, name)), name).toBe(true);
    }
    expect(resolved).toEqual([
      {
        status: 'error',
        result: null,
        error: 'Container timed out after 1000ms',
      },
    ]);
  });

  test('one log that cannot be deleted does not stop the rest of the pruning', () => {
    const ctx = logContext({ stdout: 'out' });
    const { container } = seedLogs(ctx.logsDir);
    const realUnlink = fs.unlinkSync;
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (String(target).endsWith(container[0])) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      realUnlink(target);
    });
    try {
      writeRunLog(ctx, 0, 5);
    } finally {
      unlink.mockRestore();
    }
    const logs = containerLogs(ctx.logsDir);
    expect(logs).toContain(container[0]);
    expect(logs.filter((name) => container.slice(1, 6).includes(name))).toEqual(
      [],
    );
    expect(
      logged.warn.filter(([, m]) => m === 'Failed to prune agent run log'),
    ).toHaveLength(1);
  });

  function blockedLogsDir(): string {
    const blocked = path.join(tmpLogsDir(), 'logs');
    fs.writeFileSync(blocked, 'not a directory');
    return blocked;
  }

  test('a log that cannot be written is reported and the runner still settles', async () => {
    const logsDir = blockedLogsDir();
    for (const [code, status] of [
      [1, 'error'],
      [0, 'success'],
    ] as const) {
      const outputs: ContainerOutput[] = [];
      const ctx = logContext({
        stderr: 'Error: boom',
        logsDir,
        onOutput: async () => {},
        resolvePromise: (output) => outputs.push(output),
      });
      const logFile = writeRunLog(ctx, code, 5);
      expect(logFile).toBeNull();
      if (!handleNonZeroExit(ctx, code, null, 5, logFile)) {
        handleSuccessClose(ctx, 5);
      }
      await vi.waitFor(() => expect(outputs).toHaveLength(1));
      expect(outputs[0].status).toBe(status);
    }
    expect(
      logged.warn.filter(([, m]) => m === 'Failed to write Container run log'),
    ).toHaveLength(2);
    const [fields] = logged.error.find(([, m]) =>
      m.includes('exited with error'),
    )!;
    expect(fields.logFile).toBeNull();
    expect(fs.readFileSync(logsDir, 'utf8')).toBe('not a directory');
  });

  test('a timeout whose log cannot be written still settles', () => {
    const outputs: ContainerOutput[] = [];
    const ctx = logContext({
      logsDir: blockedLogsDir(),
      resolvePromise: (output) => outputs.push(output),
    });
    expect(handleTimeoutClose(ctx, null, 5, true)).toBe(true);
    expect(outputs).toEqual([
      {
        status: 'error',
        result: null,
        error: 'Container timed out after 1000ms',
      },
    ]);
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
