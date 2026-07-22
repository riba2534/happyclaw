import { describe, expect, test } from 'vitest';
import { PassThrough } from 'node:stream';

import {
  isApiError,
  isProviderFailureResult,
  createStdoutParserState,
  createStderrState,
  attachStdoutHandler,
  handleNonZeroExit,
} from '../src/agent-output-parser.js';
import type { ContainerOutput } from '../src/container-runner.js';

describe('isProviderFailureResult — positive (genuine Claude limit notices)', () => {
  test('detects Claude extra-usage exhaustion returned as final text', () => {
    const msg = "You're out of extra usage · resets 2:10am (Asia/Shanghai)";
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('detects legacy Claude "hit your limit" final text', () => {
    const msg = "You've hit your limit · resets 3am (Asia/Shanghai)";
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('detects Claude "hit your session limit" banner (qualified limit)', () => {
    // Regression: the real banner qualifies "limit" ("session limit"), which
    // the original pattern missed — the notice leaked to users verbatim and
    // the exhausted account was never marked unhealthy, so weighted pools
    // never rotated off it.
    const msg =
      "You've hit your session limit · resets 11:10pm (Asia/Singapore)";
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('detects other qualified limit variants (weekly/usage, "reached")', () => {
    expect(
      isProviderFailureResult(
        "You've hit your weekly limit · resets 3am (America/New_York)",
      ),
    ).toBe(true);
    expect(isProviderFailureResult("You've reached your usage limit.")).toBe(
      true,
    );
  });

  test('detects "usage limit reached" notice with reset time', () => {
    const msg =
      'Claude usage limit reached. Your limit will reset at 3pm (America/New_York)';
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('detects "out of extra usage" as a short standalone notice (no reset stamp)', () => {
    const msg = "You're out of extra usage.";
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('detects upgrade prompt with reset stamp', () => {
    const msg =
      'Upgrade to increase your usage limit · resets 9:00pm (Asia/Tokyo)';
    expect(isProviderFailureResult(msg)).toBe(true);
  });

  test('tolerates surrounding whitespace', () => {
    const msg =
      "\n  You're out of extra usage · resets 2:10am (Asia/Shanghai)  \n";
    expect(isProviderFailureResult(msg)).toBe(true);
  });
});

describe('isProviderFailureResult — negative (normal replies must NOT be flagged)', () => {
  // CRITICAL regression guard: a false positive here kills the container,
  // clears the Claude session, and marks the provider unhealthy for ALL users.
  // The original PR used generic /rate.limit/ and /quota (exceeded|exhausted)/
  // patterns that fired on ordinary technical conversation. These cases pin
  // that down — they are the 5/8 mislabelled examples called out in review.

  test('does not flag a reply that mentions avoiding the API rate limit', () => {
    const msg =
      '为避免触发 API rate limit，我在循环里加了 200ms 的 sleep，并对 429 做了指数退避重试。';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a reply discussing disk quota exceeded', () => {
    const msg =
      'The upload failed with "disk quota exceeded" — you need to free up space on /var before retrying.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a reply explaining how to handle rate-limited requests', () => {
    const msg =
      'When the endpoint is rate limited it returns HTTP 429; wrap the call in a retry with backoff so the job is not rate-limited again.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a reply about a database quota being exhausted', () => {
    const msg =
      'The connection pool quota was exhausted because every request opened a new connection without closing it.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a reply quoting the word "limit" generically', () => {
    const msg =
      'I lowered the rate limit on the gateway from 1000 to 200 req/s and added a quota per tenant.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a long answer that merely mentions a Claude limit phrase mid-text', () => {
    // A genuine notice is a single short line. A long answer that happens to
    // quote "you've hit your limit" (e.g. explaining the UI) and has no reset
    // stamp must NOT be treated as a provider failure.
    const msg =
      'When Claude shows the banner that says "you\'ve hit your limit", it means the account ran out of usage for the window. ' +
      'To diagnose this in our app you can inspect the ContainerOutput.providerFailure flag, look at the provider-pool health map, ' +
      'and confirm the sticky binding was cleared. The full investigation usually takes a few minutes and involves checking the logs, ' +
      'the session table, and the env overrides for that group folder before you decide whether to switch providers manually.';
    expect(msg.length).toBeGreaterThan(200);
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a short reply saying a generic "rate limit reached"', () => {
    // "usage limit reached" is the Claude phrase; a generic "rate limit
    // reached" must not match even though it is short.
    const msg = 'The gateway rate limit reached its cap, so requests got 429s.';
    expect(msg.length).toBeLessThan(200);
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag a short reply mentioning a request limit reached', () => {
    const msg = 'Heads up: the per-minute request limit reached 100% briefly.';
    expect(isProviderFailureResult(msg)).toBe(false);
  });

  test('does not flag null or empty result', () => {
    expect(isProviderFailureResult(null)).toBe(false);
    expect(isProviderFailureResult('')).toBe(false);
    expect(isProviderFailureResult('   ')).toBe(false);
  });

  test('does not flag an ordinary successful answer', () => {
    const msg =
      '我已经把函数重命名为 buildVolumeMounts 并更新了所有调用点，测试全部通过。';
    expect(isProviderFailureResult(msg)).toBe(false);
  });
});

describe('isApiError — stderr classification still detects provider issues', () => {
  // isApiError runs against STDERR (process error stream), not the agent's
  // reply body, so generic rate-limit/quota matching is appropriate there.
  test('detects rate limit in stderr', () => {
    expect(isApiError('Error: rate limit exceeded (429)')).toBe(true);
  });

  test('detects quota exhausted in stderr', () => {
    expect(isApiError('quota exhausted for this API key')).toBe(true);
  });

  test('detects Claude extra-usage phrasing in stderr', () => {
    expect(isApiError("You're out of extra usage")).toBe(true);
  });

  test('detects connection errors in stderr', () => {
    expect(isApiError('connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
  });

  test('returns false for empty stderr', () => {
    expect(isApiError('')).toBe(false);
  });
});

describe('handleNonZeroExit — provider failure lifecycle', () => {
  test.each([
    {
      label: 'SIGTERM',
      code: null,
      signal: 'SIGTERM' as const,
      status: 'success',
    },
    {
      label: 'SIGKILL',
      code: null,
      signal: 'SIGKILL' as const,
      status: 'success',
    },
    { label: 'code 137', code: 137, signal: null, status: 'success' },
    { label: 'code 143', code: 143, signal: null, status: 'error' },
  ])(
    'preserves providerFailure when docker stop closes with $label',
    async ({ code, signal, status }) => {
      const stdoutState = createStdoutParserState();
      stdoutState.hasSuccessOutput = true;
      stdoutState.hasProviderFailureOutput = true;
      stdoutState.newSessionId = 'session-after-limit';
      const resolved: ContainerOutput[] = [];

      expect(
        handleNonZeroExit(
          {
            groupName: 'fallback-test',
            label: 'Container',
            filePrefix: 'container',
            identifier: 'container-id',
            logsDir: '/tmp',
            input: { prompt: 'prompt', isMain: true },
            stdoutState,
            stderrState: createStderrState(),
            onOutput: async () => {},
            resolvePromise: (output) => resolved.push(output),
            startTime: Date.now(),
            timeoutMs: 1_000,
          },
          code,
          signal,
          10,
          '/tmp/fallback-test.log',
        ),
      ).toBe(true);

      await stdoutState.outputChain;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        status,
        providerFailure: true,
      });
      if (status === 'success') {
        expect(resolved[0]).toMatchObject({
          result: null,
          newSessionId: 'session-after-limit',
        });
      }
    },
  );
});

describe('attachStdoutHandler — framed output parsing (marker collision)', () => {
  // Helper: feed chunks through the parser and collect emitted outputs.
  async function runParser(chunks: string[]): Promise<ContainerOutput[]> {
    const stream = new PassThrough();
    const state = createStdoutParserState();
    const collected: ContainerOutput[] = [];
    attachStdoutHandler(stream, state, {
      groupName: 'test',
      label: 'Test',
      resetTimeout: () => {},
      onOutput: async (o) => {
        collected.push(o);
      },
    });
    for (const c of chunks) stream.write(c);
    stream.end();
    // Let the stream 'data' handlers and the outputChain promise settle.
    await new Promise((r) => setTimeout(r, 10));
    await state.outputChain;
    return collected;
  }

  const S = '---HAPPYCLAW_OUTPUT_START---';
  const E = '---HAPPYCLAW_OUTPUT_END---';

  test('parses a normal framed result', async () => {
    const out = await runParser([
      `${S}${JSON.stringify({ status: 'success', result: 'hi' })}${E}`,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe('hi');
  });

  test('does NOT drop a result whose payload contains the literal END marker', async () => {
    // The agent's reply text mentions the END marker string. The naive
    // indexOf(END) would truncate the JSON and silently drop the message.
    const result = `Here is the marker: ${E} — note it.`;
    const out = await runParser([
      `${S}${JSON.stringify({ status: 'success', result })}${E}`,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe(result);
  });

  test('waits for more data on an incomplete pair instead of dropping it', async () => {
    const payload = JSON.stringify({ status: 'success', result: 'split' });
    const full = `${S}${payload}${E}`;
    const mid = Math.floor(full.length / 2);
    // Deliver in two chunks; the first is an incomplete frame.
    const out = await runParser([full.slice(0, mid), full.slice(mid)]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe('split');
  });

  test('parses two back-to-back framed results', async () => {
    const out = await runParser([
      `${S}${JSON.stringify({ status: 'stream', result: null })}${E}` +
        `${S}${JSON.stringify({ status: 'success', result: 'done' })}${E}`,
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].result).toBe('done');
  });

  test('resyncs past a non-object frame and still emits a following valid frame', async () => {
    // A broken (non-`{`) payload that is fully delimited, followed by a valid
    // frame. The parser must skip the broken frame (not stall until the size
    // cap) and emit the trailing valid one. Guards the resyncPastBrokenFrame
    // non-object branch — a regression (reverting `continue` to `break`) would
    // drop the valid frame.
    const out = await runParser([
      `${S}42${E}${S}${JSON.stringify({ status: 'success', result: 'ok' })}${E}`,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe('ok');
  });

  test('skips a fully-delimited non-object frame with nothing following (no stall)', async () => {
    // START + a bare string + END, no later START. Must resync past this frame's
    // END (it is fully delimited) rather than waiting for a non-existent next
    // START. Asserting it returns (no hang) and emits nothing.
    const out = await runParser([`${S}"just a string"${E}`]);
    expect(out).toHaveLength(0);
  });

  test('resyncs past balanced-but-invalid JSON and emits the next valid frame', async () => {
    // Balanced braces but not parseable JSON → parse-failure branch resyncs by
    // the already-located END index (knownEnd), not by scanning for a later
    // START. The following valid frame must still be emitted.
    const out = await runParser([
      `${S}{not valid json}${E}${S}${JSON.stringify({ status: 'success', result: 'after' })}${E}`,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe('after');
  });

  test('parses a complete frame whose payload contains the literal START marker', async () => {
    // Symmetric to the embedded-END case: the reply text mentions the START
    // marker. The real terminator is present, so it must parse normally.
    const result = `Talking about the ${S} marker here.`;
    const out = await runParser([
      `${S}${JSON.stringify({ status: 'success', result })}${E}`,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe(result);
  });

  test('does NOT drop a still-incomplete frame whose payload contains the literal START marker', async () => {
    // Regression: the old resync logic, on an incomplete frame, searched for a
    // later START marker and — finding the one embedded in the payload —
    // discarded the genuine frame. Deliver the frame split BEFORE the END
    // marker arrives, with a START marker embedded in the still-partial payload.
    // The parser must wait and then emit the frame intact.
    const result = `embedded ${S} inside`;
    const full = `${S}${JSON.stringify({ status: 'success', result })}${E}`;
    // Split right after the embedded START marker so the first chunk is an
    // incomplete frame that already contains a second START marker.
    const splitAt = full.indexOf(S, S.length) + S.length;
    const out = await runParser([full.slice(0, splitAt), full.slice(splitAt)]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe(result);
  });

  test('emits a frame even when its payload embeds both START and END markers', async () => {
    // The hardest collision: the payload quotes both markers and arrives in one
    // piece. The scanner must skip the embedded END (JSON parse fails on the
    // truncated slice) and not be fooled by the embedded START.
    const result = `both ${S} and ${E} quoted`;
    const out = await runParser([
      `${S}${JSON.stringify({ status: 'success', result })}${E}`,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe(result);
  });

  test('recovers a complete frame whose payload embeds 300+ literal END markers', async () => {
    // The payload quotes 300+ literal END markers inside a string value. The
    // brace matcher finds the object's true end regardless, so the frame (and
    // its session id) is recovered, never dropped.
    const result = `${E} `.repeat(300);
    const out = await runParser([
      `${S}${JSON.stringify({ status: 'success', result, newSessionId: 'sid-1' })}${E}`,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe(result);
    expect(out[0].newSessionId).toBe('sid-1');
  });

  test('emits BOTH frames when the first packs many END markers and a second frame trails', async () => {
    // Regression (back-to-back delivery): agent-runner flushes a buffered
    // text_delta then the final result via consecutive console.logs, which the
    // OS pipe routinely coalesces into one chunk. A terminator-scanning parser
    // would mis-bind frame1 to frame2's END and drop frame1; the brace matcher
    // binds each frame to its own JSON object, so both survive.
    const f1 = JSON.stringify({
      status: 'stream',
      result: `${E} `.repeat(300),
    });
    const f2 = JSON.stringify({
      status: 'success',
      result: 'final',
      newSessionId: 'sid-xyz',
    });
    const out = await runParser([`${S}${f1}${E}${S}${f2}${E}`]);
    expect(out).toHaveLength(2);
    expect(out[0].status).toBe('stream');
    expect(out[1].result).toBe('final');
    expect(out[1].newSessionId).toBe('sid-xyz');
  });
});
