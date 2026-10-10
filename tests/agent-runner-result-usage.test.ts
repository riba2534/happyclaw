import { afterEach, describe, expect, test } from 'vitest';

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_PENDING_IDLE_RESULTS,
  ResultUsageReconciler,
} from '../container/agent-runner/src/result-usage.js';
import { AssistantUsageCollector } from '../container/agent-runner/src/assistant-usage.js';
import {
  readUsageBaseline,
  usageBaselinePath,
  writeUsageBaseline,
} from '../container/agent-runner/src/usage-baseline-store.js';

function assistant(
  id: string,
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    reasoning_output_tokens?: number;
  },
  content: Array<Record<string, unknown>> = [],
) {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    message: { id, model, usage, content },
  };
}

describe('Kaboo-compatible assistant usage collection', () => {
  test('keeps the largest snapshot for one message ID and flushes it once', () => {
    const collector = new AssistantUsageCollector();
    collector.ingest(assistant('msg-1', 'claude-sonnet-4-5', {}));
    collector.ingest(
      assistant('msg-1', 'claude-sonnet-4-5', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40,
      }),
    );
    collector.ingest(
      assistant('msg-1', 'claude-sonnet-4-5', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40,
      }),
    );
    expect(collector.drain('session-1')).toMatchObject({
      eventId: 'claude-code:msg-1',
      tokens: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 40,
      },
    });
    expect(collector.drain('session-1')).toBeUndefined();
  });

  test('counts distinct message IDs even when their usage is identical', () => {
    const collector = new AssistantUsageCollector();
    const usage = {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 4,
    };
    collector.ingest(assistant('msg-a', 'claude-sonnet-4-5', usage));
    collector.ingest(assistant('msg-b', 'claude-sonnet-4-5', usage));
    expect(collector.drain('session-2')).toMatchObject({
      eventId: 'claude-code:msg-a',
      tokens: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 4,
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 4,
          },
        },
      },
    });
    expect(collector.drain('session-2')).toMatchObject({
      eventId: 'claude-code:msg-b',
      tokens: { inputTokens: 10, outputTokens: 2 },
    });
  });

  test('accepts camelCase usage from SDK-compatible live providers', () => {
    const collector = new AssistantUsageCollector();
    collector.ingest({
      type: 'assistant',
      uuid: 'uuid-camel',
      message: {
        id: 'msg-camel',
        model: 'glm-5.2',
        usage: {
          inputTokens: 504,
          outputTokens: 6_182,
          cacheReadInputTokens: 46_656,
          cacheCreationInputTokens: 20,
          reasoningTokens: 300,
        },
        content: [],
      },
    });

    expect(collector.drain('session-camel')).toMatchObject({
      eventId: 'claude-code:msg-camel',
      tokens: {
        inputTokens: 504,
        outputTokens: 6_182,
        cacheReadInputTokens: 46_656,
        cacheCreationInputTokens: 20,
        reasoningTokens: 300,
      },
    });
  });

  test('uses the same event ID when a copied message is replayed in a fork', () => {
    const original = new AssistantUsageCollector();
    const fork = new AssistantUsageCollector();
    const message = assistant('msg-fork-stable', 'claude-sonnet-4-5', {
      input_tokens: 10,
      output_tokens: 2,
    });
    original.ingest(message);
    fork.ingest(message);
    expect(original.drain('original-session')?.eventId).toBe(
      'claude-code:msg-fork-stable',
    );
    expect(fork.drain('different-fork-session')?.eventId).toBe(
      'claude-code:msg-fork-stable',
    );
  });

  test('carves Claude thinking from output using Kaboo turn-level proportions', () => {
    const collector = new AssistantUsageCollector();
    const usage = { input_tokens: 100, output_tokens: 1_000 };
    collector.ingest(
      assistant('msg-thinking', 'claude-opus-4-8', usage, [
        { type: 'thinking', thinking: 'x'.repeat(300), signature: 'ignored' },
      ]),
    );
    collector.ingest(
      assistant('msg-thinking', 'claude-opus-4-8', usage, [
        { type: 'text', text: 'y'.repeat(100) },
      ]),
    );
    // Replayed content blocks must not distort the ratio.
    collector.ingest(
      assistant('msg-thinking', 'claude-opus-4-8', usage, [
        { type: 'thinking', thinking: 'x'.repeat(300), signature: 'ignored' },
      ]),
    );
    expect(collector.drain('session-thinking')).toMatchObject({
      tokens: {
        inputTokens: 100,
        outputTokens: 250,
        reasoningTokens: 750,
        modelUsage: {
          'claude-opus-4-8': {
            outputTokens: 250,
            reasoningTokens: 750,
          },
        },
      },
    });
  });

  test('trusts native reasoning and does not carve non-Anthropic models', () => {
    const native = new AssistantUsageCollector();
    native.ingest(
      assistant(
        'msg-native',
        'claude-opus-4-8',
        {
          output_tokens: 1_000,
          reasoning_output_tokens: 200,
        },
        [{ type: 'thinking', thinking: 'x'.repeat(300) }],
      ),
    );
    expect(native.drain('native')?.tokens).toMatchObject({
      outputTokens: 1_000,
      reasoningTokens: 200,
    });

    const proxy = new AssistantUsageCollector();
    proxy.ingest(
      assistant('msg-proxy', 'gemini-2.5-pro', { output_tokens: 1_000 }, [
        { type: 'thinking', thinking: 'x'.repeat(300) },
      ]),
    );
    expect(proxy.drain('proxy')?.tokens).toMatchObject({
      outputTokens: 1_000,
      reasoningTokens: 0,
    });
  });
});

const MODEL = 'claude-sonnet-5';

function tokens(
  input: number,
  output: number,
  extra: Record<string, number> = {},
) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    costUSD: 0,
    ...extra,
  };
}

/** A per-message event as AssistantUsageCollector emits it. */
function accounted(input: number, output: number, model = MODEL) {
  return { [model]: tokens(input, output) };
}

/** A call whose final usage was known at flush time (message_delta seen). */
const FINAL = { final: true };

function result(
  modelUsage: Record<string, ReturnType<typeof tokens>> | undefined,
  totalCostUSD = 0,
  usage?: Record<string, number>,
) {
  return {
    modelUsage,
    totalCostUSD,
    usage: usage ?? { input_tokens: 100, output_tokens: 321 },
    fallbackModelKey: MODEL,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('result usage reconciliation', () => {
  test('bills the internal remainder that per-message events did not cover', () => {
    const reconciler = new ResultUsageReconciler();
    // Turn 1: main call 100/321 plus a session-title call 500/77.
    reconciler.recordAccounted(accounted(100, 321));
    const first = reconciler.applyResult(
      result({ [MODEL]: tokens(600, 398, { costUSD: 0.006 }) }, 0.006),
    );
    expect(first.residual?.modelUsage).toEqual({
      [MODEL]: tokens(500, 77, { costUSD: 0.006 }),
    });
    expect(first.costUSD).toBeCloseTo(0.006, 9);

    // Turn 2: modelUsage is cumulative; only the new main call happened.
    reconciler.recordAccounted(accounted(100, 321));
    const second = reconciler.applyResult(
      result({ [MODEL]: tokens(700, 719, { costUSD: 0.0095 }) }, 0.0095),
    );
    expect(second.residual).toBeUndefined();
    expect(second.costUSD).toBeCloseTo(0.0035, 9);
  });

  test('matches modelUsage thinking against carved reasoning tokens', () => {
    const reconciler = new ResultUsageReconciler();
    reconciler.recordAccounted({
      [MODEL]: tokens(100, 250, { reasoningTokens: 750 }),
    });
    expect(
      reconciler.applyResult(result({ [MODEL]: tokens(100, 1_000) })).residual,
    ).toBeUndefined();
  });

  test('does not bill tokens twice when a proxy answers under another model ID', () => {
    const reconciler = new ResultUsageReconciler();
    reconciler.recordAccounted(accounted(100, 321, 'GLM-5.2'));
    reconciler.recordAccounted(accounted(10, 5, 'upstream-alias'));
    const reconciled = reconciler.applyResult(
      result({ 'glm-5.2[1m]': tokens(150, 400) }),
    );
    expect(reconciled.residual?.modelUsage).toEqual({
      'glm-5.2[1m]': tokens(40, 74),
    });
  });

  test('omits models whose cumulative totals did not move', () => {
    const reconciler = new ResultUsageReconciler();
    reconciler.applyResult(result({ 'claude-sonnet-4-5': tokens(10, 2) }));
    const next = reconciler.applyResult(
      result({
        'claude-sonnet-4-5': tokens(10, 2),
        'claude-haiku-4-5': tokens(3, 1),
      }),
    );
    expect(Object.keys(next.residual?.modelUsage ?? {})).toEqual([
      'claude-haiku-4-5',
    ]);
  });

  // The old normaliser differenced root usage against the previous result,
  // which under-billed every turn larger than the one before it.
  test('treats root usage as per-turn when modelUsage is unavailable', () => {
    const reconciler = new ResultUsageReconciler();
    const first = reconciler.applyResult(
      result(undefined, 0, { input_tokens: 20, output_tokens: 5 }),
    );
    const second = reconciler.applyResult(
      result(undefined, 0, { input_tokens: 30, output_tokens: 8 }),
    );
    expect(first.residual?.modelUsage[MODEL]).toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
    });
    expect(second.residual?.modelUsage[MODEL]).toMatchObject({
      inputTokens: 30,
      outputTokens: 8,
    });
  });

  test('root usage already covered by per-message events is not billed again', () => {
    const reconciler = new ResultUsageReconciler();
    reconciler.recordAccounted(accounted(100, 321));
    expect(
      reconciler.applyResult(
        result(undefined, 0, { input_tokens: 100, output_tokens: 321 }),
      ).residual,
    ).toBeUndefined();
  });
});

describe('result usage across resumed processes', () => {
  test('a persisted baseline keeps restored history out of the next bill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-baseline-'));
    dirs.push(dir);
    const first = new ResultUsageReconciler();
    first.recordAccounted(accounted(100, 321));
    first.applyResult(result({ [MODEL]: tokens(600, 398) }));
    writeUsageBaseline(dir, first.toBaseline('session-1'));

    // Claude Code restores 600/398 into the resumed process's first result.
    const resumed = new ResultUsageReconciler({
      resumed: true,
      baseline: readUsageBaseline(dir, 'session-1'),
    });
    resumed.recordAccounted(accounted(100, 321));
    expect(
      resumed.applyResult(result({ [MODEL]: tokens(700, 719) })).residual,
    ).toBeUndefined();
    // A compaction call (900/150) later in the resumed process is billed.
    resumed.recordAccounted(accounted(100, 321));
    expect(
      resumed.applyResult(result({ [MODEL]: tokens(1_700, 1_190) })).residual
        ?.modelUsage,
    ).toEqual({ [MODEL]: tokens(900, 150) });
  });

  test('a resumed query without a baseline only establishes one', () => {
    const reconciler = new ResultUsageReconciler({ resumed: true });
    reconciler.recordAccounted(accounted(100, 321), FINAL);
    const first = reconciler.applyResult(
      result({ [MODEL]: tokens(5_000, 9_000, { costUSD: 2 }) }, 2),
    );
    expect(first).toEqual({ costUSD: 0, baselineReset: 'initial_resume' });
    reconciler.recordAccounted(accounted(100, 321), FINAL);
    expect(
      reconciler.applyResult(
        result({ [MODEL]: tokens(5_600, 9_398, { costUSD: 2.1 }) }, 2.1),
      ).residual?.modelUsage[MODEL],
    ).toMatchObject({ inputTokens: 500, outputTokens: 77 });
  });

  test('a stale higher baseline re-baselines instead of billing the cumulative total', () => {
    // The previous runner persisted 1000/800, but the killed CLI restored
    // older totals; the shrinking counter must not be billed as new spend.
    const seeded = new ResultUsageReconciler();
    seeded.applyResult(result({ [MODEL]: tokens(1_000, 800) }, 1));
    const stale = new ResultUsageReconciler({
      resumed: true,
      baseline: seeded.toBaseline('s'),
    });
    stale.recordAccounted(accounted(100, 321), FINAL);
    expect(
      stale.applyResult(result({ [MODEL]: tokens(750, 600) }, 0.8)),
    ).toEqual({ costUSD: 0, baselineReset: 'decrease' });
    stale.recordAccounted(accounted(100, 321), FINAL);
    expect(
      stale.applyResult(result({ [MODEL]: tokens(900, 1_000) }, 0.9)).residual
        ?.modelUsage,
    ).toEqual({ [MODEL]: tokens(50, 79) });
  });

  test('kill and restart never bills more than the session actually spent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-baseline-'));
    dirs.push(dir);
    let billed = { input: 0, output: 0 };
    const bill = (input: number, output: number) => {
      billed = { input: billed.input + input, output: billed.output + output };
    };
    // Process A: two turns, each one main call plus an internal 50/10 call.
    const a = new ResultUsageReconciler();
    for (const cumulative of [
      [150, 331],
      [300, 662],
    ]) {
      a.recordAccounted(accounted(100, 321));
      bill(100, 321);
      const r = a.applyResult(
        result({ [MODEL]: tokens(cumulative[0], cumulative[1]) }),
      );
      bill(
        r.residual?.inputTokens ?? 0,
        (r.residual?.outputTokens ?? 0) + (r.residual?.reasoningTokens ?? 0),
      );
      writeUsageBaseline(dir, a.toBaseline('killed'));
    }
    // SIGKILL. Process B resumes the same session and runs one more turn.
    const b = new ResultUsageReconciler({
      resumed: true,
      baseline: readUsageBaseline(dir, 'killed'),
    });
    b.recordAccounted(accounted(100, 321));
    bill(100, 321);
    const r = b.applyResult(result({ [MODEL]: tokens(450, 993) }));
    bill(r.residual?.inputTokens ?? 0, r.residual?.outputTokens ?? 0);
    expect(billed).toEqual({ input: 450, output: 993 });
  });

  test('ignores a baseline that belongs to another session or is torn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-baseline-'));
    dirs.push(dir);
    writeUsageBaseline(dir, new ResultUsageReconciler().toBaseline('a'));
    expect(readUsageBaseline(dir, 'a')).not.toBeNull();
    expect(readUsageBaseline(dir, 'b')).toBeNull();
    expect(readUsageBaseline(dir, '../a')).toBeNull();
  });
});

/** Sum of every usage event the runner would emit. */
function ledgerTotal(
  events: Array<{
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    reasoningTokens?: number;
  }>,
) {
  return events.reduce(
    (sum, event) => ({
      input: sum.input + event.inputTokens,
      output: sum.output + event.outputTokens + (event.reasoningTokens ?? 0),
      cacheRead: sum.cacheRead + event.cacheReadInputTokens,
    }),
    { input: 0, output: 0, cacheRead: 0 },
  );
}

// Frames recorded from Claude Code 2.1.296: a main call (100/10), then a
// background subagent call whose assistant message (2000/1, cache read 40000)
// arrives before the first result, whose cumulative modelUsage does not
// include that still-running call yet; it ends with 300 output before the
// next turn's result.
const straddleFrames = readFileSync(
  new URL(
    './fixtures/agent-runner/usage-straddle-frames.jsonl',
    import.meta.url,
  ),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, any>);

/**
 * Replay the recorded frames the way runQueryAttempt does, with `restored`
 * added to every result's modelUsage as Claude Code adds a resumed
 * session's saved totals. Returns the ledger and what the provider served.
 */
function replayStraddle(
  reconciler: ResultUsageReconciler,
  restored = tokens(0, 0),
) {
  const collector = new AssistantUsageCollector();
  const events: Parameters<typeof ledgerTotal>[0] = [];
  const finality: Record<string, boolean> = {};
  const resets: string[] = [];
  let served = { input: 0, output: 0, cacheRead: 0 };
  for (const frame of straddleFrames) {
    if (frame.type === 'stream_event') collector.observeStreamEvent(frame);
    if (frame.type === 'assistant') collector.ingest(frame);
    if (frame.type !== 'result') continue;
    for (
      let batch = collector.drain('s');
      batch;
      batch = collector.drain('s')
    ) {
      reconciler.recordAccounted(batch.tokens.modelUsage, {
        final: batch.final,
      });
      finality[batch.eventId] = batch.final;
      events.push(batch.tokens);
    }
    const modelUsage = Object.fromEntries(
      Object.entries(frame.modelUsage as Record<string, any>).map(
        ([model, value]) => [
          model,
          {
            ...value,
            inputTokens: value.inputTokens + restored.inputTokens,
            outputTokens: value.outputTokens + restored.outputTokens,
            cacheReadInputTokens:
              value.cacheReadInputTokens + restored.cacheReadInputTokens,
            costUSD: value.costUSD + restored.costUSD,
          },
        ],
      ),
    );
    const reconciled = reconciler.applyResult({
      usage: frame.usage,
      totalCostUSD: frame.total_cost_usd + restored.costUSD,
      modelUsage,
      fallbackModelKey: 'default',
    });
    if (reconciled.residual) events.push(reconciled.residual);
    if (reconciled.baselineReset) resets.push(reconciled.baselineReset);
    const final = Object.values(frame.modelUsage)[0] as Record<string, number>;
    served = {
      input: final.inputTokens,
      output: final.outputTokens,
      cacheRead: final.cacheReadInputTokens,
    };
  }
  return { ledger: ledgerTotal(events), served, finality, resets };
}

/** Invariant: the ledger never exceeds what Claude Code counted. */
function expectBilledOnce(
  ledger: ReturnType<typeof ledgerTotal>,
  served: ReturnType<typeof ledgerTotal>,
) {
  expect(ledger.input).toBeLessThanOrEqual(served.input);
  expect(ledger.output).toBeLessThanOrEqual(served.output);
  expect(ledger.cacheRead).toBeLessThanOrEqual(served.cacheRead);
  expect(ledger).toEqual(served);
}

describe('per-message usage that modelUsage covers only later', () => {
  test('a background subagent call straddling the main result is billed once', () => {
    const reconciler = new ResultUsageReconciler();
    const { ledger, served, finality, resets } = replayStraddle(reconciler);
    // message_delta proves the main calls ended; the subagent call did not.
    expect(finality).toEqual({
      'claude-code:msg_main_1': true,
      'claude-code:msg_sub_x': false,
      'claude-code:msg_main_2': true,
      'claude-code:msg_main_3': true,
    });
    expect(resets).toEqual([]);
    expect(served).toEqual({ input: 2_200, output: 320, cacheRead: 40_000 });
    expectBilledOnce(ledger, served);
    expect(reconciler.pendingAccounted).toEqual({});
  });

  test('the straddle is billed once when the first result re-baselines a resume without a sidecar', () => {
    // Every session that predates the sidecar takes this path once.
    const reconciler = new ResultUsageReconciler({ resumed: true });
    const { ledger, served, resets } = replayStraddle(
      reconciler,
      tokens(5_000, 900, { cacheReadInputTokens: 80_000, costUSD: 0.5 }),
    );
    expect(resets).toEqual(['initial_resume']);
    expectBilledOnce(ledger, served);
    expect(reconciler.pendingAccounted).toEqual({});
  });

  test('the straddle is billed once when a stale sidecar re-baselines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-baseline-'));
    dirs.push(dir);
    const model = Object.keys(straddleFrames.at(-1)!.modelUsage)[0];
    const stale = new ResultUsageReconciler();
    stale.applyResult({
      modelUsage: { [model]: tokens(9_000, 1_200, { costUSD: 0.9 }) },
      totalCostUSD: 0.9,
      fallbackModelKey: 'default',
    });
    writeUsageBaseline(dir, stale.toBaseline('stale'));
    // The CLI restored older totals than the sidecar holds.
    const reconciler = new ResultUsageReconciler({
      resumed: true,
      baseline: readUsageBaseline(dir, 'stale'),
    });
    const { ledger, served, resets } = replayStraddle(
      reconciler,
      tokens(5_000, 900, { cacheReadInputTokens: 80_000, costUSD: 0.5 }),
    );
    expect(resets).toEqual(['decrease']);
    expectBilledOnce(ledger, served);
    expect(reconciler.pendingAccounted).toEqual({});
  });

  test('usage flushed before close() is not billed again after resume', () => {
    // Claude Code 2.1.296 writes the closed turn's call into the session's
    // cost-state: the resumed process restores 1100/87 and adds 20/2.
    const dir = mkdtempSync(join(tmpdir(), 'usage-baseline-'));
    dirs.push(dir);
    const events: Parameters<typeof ledgerTotal>[0] = [];
    const a = new ResultUsageReconciler();
    a.recordAccounted(accounted(100, 10));
    events.push(tokens(100, 10));
    const first = a.applyResult(result({ [MODEL]: tokens(100, 10) }));
    if (first.residual) events.push(first.residual);
    writeUsageBaseline(dir, a.toBaseline('closed'));
    // Interrupt: the runner flushes msg_turn2_tool without a result, persists
    // the pending usage, then closes the query.
    a.recordAccounted(accounted(1_000, 77));
    events.push(tokens(1_000, 77));
    expect(a.shouldPersist).toBe(true);
    writeUsageBaseline(dir, a.toBaseline('closed'));

    const b = new ResultUsageReconciler({
      resumed: true,
      baseline: readUsageBaseline(dir, 'closed'),
    });
    b.recordAccounted(accounted(20, 2));
    events.push(tokens(20, 2));
    const resumed = b.applyResult(result({ [MODEL]: tokens(1_120, 89) }));
    if (resumed.residual) events.push(resumed.residual);

    const ledger = ledgerTotal(events);
    expect(ledger.input).toBeLessThanOrEqual(1_120);
    expect(ledger.output).toBeLessThanOrEqual(89);
    expect(ledger).toEqual({ input: 1_120, output: 89, cacheRead: 0 });
    expect(b.pendingAccounted).toEqual({});
  });

  test('pending usage is carried per model and never eats another model', () => {
    const reconciler = new ResultUsageReconciler();
    // Main call 150/15 plus a still-running subagent call flushed at 2000/1.
    reconciler.recordAccounted(accounted(2_150, 16));
    const first = reconciler.applyResult(
      result({
        [MODEL]: tokens(150, 15),
        'claude-haiku-5-5': tokens(300, 40),
      }),
    );
    // The Haiku call is a genuine internal call and is billed now; the part
    // of the Sonnet usage the delta does not cover yet stays pending.
    expect(first.residual?.modelUsage).toEqual({
      'claude-haiku-5-5': tokens(300, 40),
    });
    expect(reconciler.pendingAccounted[MODEL]).toMatchObject({
      inputTokens: 2_000,
      outputTokens: 1,
    });
    // The subagent call lands with its real output of 300.
    const second = reconciler.applyResult(
      result({
        [MODEL]: tokens(2_150, 315),
        'claude-haiku-5-5': tokens(300, 40),
      }),
    );
    expect(second.residual?.modelUsage).toEqual({
      [MODEL]: tokens(0, 299),
    });
    expect(reconciler.pendingAccounted).toEqual({});
  });

  test('a baseline reset drops pending usage an earlier process billed', () => {
    const seeded = new ResultUsageReconciler();
    seeded.applyResult(result({ [MODEL]: tokens(1_000, 100) }));
    seeded.recordAccounted(accounted(50, 5));
    const stale = new ResultUsageReconciler({
      resumed: true,
      baseline: seeded.toBaseline('s'),
    });
    expect(stale.pendingAccounted[MODEL]).toMatchObject({ inputTokens: 50 });
    expect(
      stale.applyResult(result({ [MODEL]: tokens(500, 50) })).baselineReset,
    ).toBe('decrease');
    expect(stale.pendingAccounted).toEqual({});
  });

  test('a resumed query without a baseline persists nothing until its first result', () => {
    const reconciler = new ResultUsageReconciler({ resumed: true });
    reconciler.recordAccounted(accounted(10, 1), FINAL);
    expect(reconciler.shouldPersist).toBe(false);
    reconciler.applyResult(result({ [MODEL]: tokens(5_000, 900) }));
    expect(reconciler.shouldPersist).toBe(true);
    expect(reconciler.pendingAccounted).toEqual({});
  });
  test('a call a gateway labels under another modelUsage key is billed once', () => {
    // Haiku requests answered (and labelled) as Opus: modelUsage counts them
    // under Haiku, the per-message events under Opus.
    const opus = 'claude-opus-5-5';
    const haiku = 'claude-haiku-5-5';
    const reconciler = new ResultUsageReconciler();
    for (let turn = 1; turn <= 4; turn++) {
      reconciler.recordAccounted(accounted(100, 10, opus), FINAL);
      reconciler.recordAccounted(accounted(400, 40, opus), FINAL);
      const reconciled = reconciler.applyResult(
        result({
          [opus]: tokens(100 * turn, 10 * turn),
          [haiku]: tokens(400 * turn, 40 * turn),
        }),
      );
      expect(reconciled.residual).toBeUndefined();
      expect(reconciler.pendingAccounted).toEqual({});
    }
  });

  test('a running call stays pending until the result that covers it', () => {
    const reconciler = new ResultUsageReconciler();
    reconciler.recordAccounted(accounted(2_000, 1));
    for (let turn = 1; turn < MAX_PENDING_IDLE_RESULTS; turn++) {
      reconciler.recordAccounted(accounted(10, 1), FINAL);
      const reconciled = reconciler.applyResult(
        result({ [MODEL]: tokens(10 * turn, turn) }),
      );
      expect(reconciled.residual).toBeUndefined();
      expect(reconciled.droppedPending).toBeUndefined();
    }
    const landed = reconciler.applyResult(
      result({
        [MODEL]: tokens(
          10 * (MAX_PENDING_IDLE_RESULTS - 1) + 2_000,
          MAX_PENDING_IDLE_RESULTS - 1 + 300,
        ),
      }),
    );
    expect(landed.residual?.modelUsage).toEqual({ [MODEL]: tokens(0, 299) });
    expect(reconciler.pendingAccounted).toEqual({});
  });

  test('pending usage no result ever covers is dropped after the idle limit', () => {
    // E.g. a call flushed with its placeholder output and never counted by
    // Claude Code, or a gateway label no modelUsage key will ever cover.
    const reconciler = new ResultUsageReconciler();
    reconciler.recordAccounted(accounted(700, 1));
    const dropped: unknown[] = [];
    for (let turn = 1; turn <= MAX_PENDING_IDLE_RESULTS; turn++) {
      reconciler.recordAccounted(accounted(10, 1), FINAL);
      const reconciled = reconciler.applyResult(
        result({ [MODEL]: tokens(10 * turn, turn) }),
      );
      expect(reconciled.residual).toBeUndefined();
      if (reconciled.droppedPending) dropped.push(reconciled.droppedPending);
    }
    expect(dropped).toEqual([{ [MODEL]: tokens(700, 1) }]);
    expect(reconciler.pendingAccounted).toEqual({});
  });

  test('usage flushed before a result without modelUsage stays pending', () => {
    const reconciler = new ResultUsageReconciler();
    reconciler.recordAccounted(accounted(100, 321), FINAL);
    // Root usage covers the main call plus 30/9 no per-message event carried.
    const first = reconciler.applyResult(
      result(undefined, 0, { input_tokens: 130, output_tokens: 330 }),
    );
    expect(first.residual?.modelUsage[MODEL]).toMatchObject({
      inputTokens: 30,
      outputTokens: 9,
    });
    // The next result's cumulative modelUsage holds both turns and a 20/5
    // internal call; only that call is new.
    reconciler.recordAccounted(accounted(50, 10), FINAL);
    const second = reconciler.applyResult(
      result({ [MODEL]: tokens(200, 345) }),
    );
    expect(second.residual?.modelUsage).toEqual({ [MODEL]: tokens(20, 5) });
    expect(reconciler.pendingAccounted).toEqual({});
  });

  test('pending usage carried through root results does not grow without bound', () => {
    const reconciler = new ResultUsageReconciler();
    for (let turn = 0; turn < 50; turn++) {
      reconciler.recordAccounted(accounted(100, 10), FINAL);
      reconciler.applyResult(
        result(undefined, 0, { input_tokens: 100, output_tokens: 10 }),
      );
    }
    expect(reconciler.toBaseline('s').pendingUsage).toHaveLength(1);
    expect(reconciler.pendingAccounted).toEqual({
      [MODEL]: tokens(5_000, 500),
    });
  });
});

describe('usage baseline sidecar', () => {
  function sidecarDir() {
    const dir = mkdtempSync(join(tmpdir(), 'usage-baseline-'));
    dirs.push(dir);
    return dir;
  }

  function asideFiles(dir: string) {
    return readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  }

  test('a missing sidecar is not an error', () => {
    const dir = sidecarDir();
    const warnings: string[] = [];
    expect(readUsageBaseline(dir, 'none', (w) => warnings.push(w))).toBeNull();
    expect(warnings).toEqual([]);
  });

  test.each([
    ['torn', (file: string) => writeFileSync(file, '{"version":2,"sess')],
    [
      'from an older format',
      (file: string) =>
        writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            sessionId: 's',
            updatedAt: '',
            totalCostUSD: 0,
            modelUsage: {},
          }),
        ),
    ],
    ['unreadable', (file: string) => mkdirSync(file)],
  ])(
    'a sidecar that is %s is moved aside so no later process reads it',
    (_label, corrupt) => {
      const dir = sidecarDir();
      const file = usageBaselinePath(dir, 's')!;
      corrupt(file);
      const warnings: string[] = [];
      expect(readUsageBaseline(dir, 's', (w) => warnings.push(w))).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(asideFiles(dir)).toHaveLength(1);
      // The next process finds no sidecar and re-baselines cleanly.
      expect(readUsageBaseline(dir, 's', (w) => warnings.push(w))).toBeNull();
      expect(warnings).toHaveLength(1);
    },
  );

  test('pending usage round-trips with its age', () => {
    const dir = sidecarDir();
    const a = new ResultUsageReconciler();
    a.recordAccounted(accounted(700, 1));
    a.recordAccounted(accounted(10, 1), FINAL);
    a.applyResult(result({ [MODEL]: tokens(10, 1) }));
    writeUsageBaseline(dir, a.toBaseline('s'));
    const loaded = readUsageBaseline(dir, 's');
    expect(loaded?.pendingUsage).toEqual([
      { model: MODEL, ...tokens(700, 1), idleResults: 1 },
    ]);
    expect(
      new ResultUsageReconciler({ resumed: true, baseline: loaded })
        .pendingAccounted,
    ).toEqual({ [MODEL]: tokens(700, 1) });
  });
});
