import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import {
  finalizeSilentSuccessCard,
  type SilentSuccessStreamingCard,
} from '../src/silent-success-card-finalize.js';

const root = process.cwd();
const indexSource = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');

/** Agent silent-success branch (!isCursorCommitted → else dispose). */
function agentSilentSuccessCatchRegion(source: string): string {
  const agentClosed = source.lastIndexOf('} else if (agentClosed) {');
  expect(agentClosed).toBeGreaterThanOrEqual(0);
  const start = source.indexOf(
    '} else if (!isCursorCommitted()) {',
    agentClosed,
  );
  expect(start).toBeGreaterThan(agentClosed);
  const end = source.indexOf('} else {', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function mainSilentSuccessCatchRegion(source: string): string {
  const marker = 'Streaming card silent-success finalize failed, aborting card';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('} else {', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('agent silent-success card finalize (abort before dispose)', () => {
  test('stub complete reject: abort called before dispose (no bare-dispose zombie)', async () => {
    const calls: string[] = [];
    const session: SilentSuccessStreamingCard = {
      async complete() {
        calls.push('complete');
        throw new Error('provider reject');
      },
      async abort(reason?: string) {
        calls.push(`abort:${reason ?? ''}`);
      },
      dispose() {
        calls.push('dispose');
      },
    };

    const onFail = vi.fn();
    const outcome = await finalizeSilentSuccessCard(session, 'acc', onFail);

    expect(onFail).toHaveBeenCalledOnce();
    expect(outcome).toBe('aborted-disposed');
    // Contract: complete → abort('') → dispose. Bare dispose alone is the
    // zombie 「生成中」 + turn SUCCESS false-ACK path.
    expect(calls).toEqual(['complete', 'abort:', 'dispose']);
  });

  test('abort rejection is swallowed; dispose still runs (no throw to success path)', async () => {
    const calls: string[] = [];
    const session: SilentSuccessStreamingCard = {
      async complete() {
        calls.push('complete');
        throw new Error('complete failed');
      },
      async abort() {
        calls.push('abort');
        throw new Error('abort also failed');
      },
      dispose() {
        calls.push('dispose');
      },
    };

    await expect(
      finalizeSilentSuccessCard(session, '', () => {}),
    ).resolves.toBe('aborted-disposed');
    expect(calls).toEqual(['complete', 'abort', 'dispose']);
  });

  test('complete success does not abort or dispose', async () => {
    const calls: string[] = [];
    const session: SilentSuccessStreamingCard = {
      async complete(text: string) {
        calls.push(`complete:${text}`);
      },
      async abort() {
        calls.push('abort');
      },
      dispose() {
        calls.push('dispose');
      },
    };

    await expect(
      finalizeSilentSuccessCard(session, 'hello', () => {}),
    ).resolves.toBe('completed');
    expect(calls).toEqual(['complete:hello']);
  });

  test('index.ts agent silent-success catch mirrors main abort-then-dispose', () => {
    const agent = agentSilentSuccessCatchRegion(indexSource);
    const main = mainSilentSuccessCatchRegion(indexSource);
    const helperSource = fs.readFileSync(
      path.join(root, 'src', 'silent-success-card-finalize.ts'),
      'utf8',
    );

    // Main already aborts before dispose (reference contract).
    const mainAbort = main.indexOf(".abort('')");
    const mainDispose = main.indexOf('.dispose()');
    expect(mainAbort).toBeGreaterThanOrEqual(0);
    expect(mainDispose).toBeGreaterThan(mainAbort);

    // Agent catch must route through the shared finalize helper (not bare dispose).
    expect(agent).toContain('finalizeSilentSuccessCard');
    expect(agent).toMatch(/aborting card/);
    expect(agent).not.toMatch(/failed, disposing/);
    // No direct bare dispose in the agent silent-success failure path.
    expect(agent).not.toMatch(
      /silent-success finalize failed[\s\S]*?\.dispose\(\)/,
    );

    // Helper itself must abort('') before dispose (the mirrored main contract).
    const helperAbort = helperSource.indexOf(".abort('')");
    const helperDispose = helperSource.indexOf('.dispose()');
    expect(helperAbort).toBeGreaterThanOrEqual(0);
    expect(helperDispose).toBeGreaterThan(helperAbort);
  });

  test('no acknowledged-as-success zombie: failure outcome is aborted-disposed', async () => {
    // Document the false-ACK chain: bare dispose leaves card streaming while
    // host continues to runtime.complete SUCCESS. Fixed path returns
    // aborted-disposed so callers cannot treat finalize as silent success.
    const session: SilentSuccessStreamingCard = {
      async complete() {
        throw new Error('card finalize rejected');
      },
      async abort() {},
      dispose() {},
    };
    const outcome = await finalizeSilentSuccessCard(session, 'x', () => {});
    expect(outcome).toBe('aborted-disposed');
    expect(outcome).not.toBe('completed');
  });
});