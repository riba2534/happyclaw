import { afterEach, describe, expect, test } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ResultUsageReconciler } from '../container/agent-runner/src/result-usage.js';
import { AssistantUsageCollector } from '../container/agent-runner/src/assistant-usage.js';
import {
  readUsageBaseline,
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
    reconciler.recordAccounted(accounted(100, 321));
    const first = reconciler.applyResult(
      result({ [MODEL]: tokens(5_000, 9_000, { costUSD: 2 }) }, 2),
    );
    expect(first).toEqual({ costUSD: 0, baselineReset: 'initial_resume' });
    reconciler.recordAccounted(accounted(100, 321));
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
    stale.recordAccounted(accounted(100, 321));
    expect(
      stale.applyResult(result({ [MODEL]: tokens(750, 600) }, 0.8)),
    ).toEqual({ costUSD: 0, baselineReset: 'decrease' });
    stale.recordAccounted(accounted(100, 321));
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
