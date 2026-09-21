import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import {
  abandonStreamingCardOnRouteChange,
  ROUTE_CHANGE_ABORT_REASON,
  type RouteChangeStreamingCard,
} from '../src/reply-route-cross-jid-abandon.js';

const root = process.cwd();
const indexSource = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');

/** Main reply-route rebuild block (cross-jid streaming session replace). */
function replyRouteCrossJidRebuildRegion(source: string): string {
  const marker = 'Rebuild streaming session if the target channel changed.';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(
    'Failed to create streaming session in route updater',
    start,
  );
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('reply-route cross-jid bare-dispose zombie card', () => {
  test('active session + route jid change: abort called before dispose', async () => {
    const calls: string[] = [];
    const session: RouteChangeStreamingCard = {
      isActive: () => true,
      async abort(reason?: string) {
        calls.push(`abort:${reason ?? ''}`);
      },
      dispose() {
        calls.push('dispose');
      },
    };

    const outcome = await abandonStreamingCardOnRouteChange(session);

    expect(outcome).toBe('aborted-disposed');
    // Contract: abort(连接已切换) → dispose. Bare dispose alone orphans
    // permanent 「生成中」 while the new jid session is created.
    expect(calls).toEqual([`abort:${ROUTE_CHANGE_ABORT_REASON}`, 'dispose']);
  });

  test('abort rejection is swallowed; dispose still runs', async () => {
    const calls: string[] = [];
    const session: RouteChangeStreamingCard = {
      isActive: () => true,
      async abort() {
        calls.push('abort');
        throw new Error('provider abort failed');
      },
      dispose() {
        calls.push('dispose');
      },
    };

    await expect(abandonStreamingCardOnRouteChange(session)).resolves.toBe(
      'aborted-disposed',
    );
    expect(calls).toEqual(['abort', 'dispose']);
  });

  test('inactive session: no abort, no dispose (caller unregisters only)', async () => {
    const calls: string[] = [];
    const session: RouteChangeStreamingCard = {
      isActive: () => false,
      async abort() {
        calls.push('abort');
      },
      dispose() {
        calls.push('dispose');
      },
    };

    await expect(abandonStreamingCardOnRouteChange(session)).resolves.toBe(
      'inactive',
    );
    expect(calls).toEqual([]);
  });

  test('no orphaned non-terminal card: active abandon leaves terminalized outcome', async () => {
    let terminal: 'streaming' | 'aborted' | 'disposed-only' = 'streaming';
    const session: RouteChangeStreamingCard = {
      isActive: () => terminal === 'streaming',
      async abort() {
        terminal = 'aborted';
      },
      dispose() {
        if (terminal === 'streaming') {
          terminal = 'disposed-only';
        }
      },
    };

    await abandonStreamingCardOnRouteChange(session);
    // Bare dispose would leave disposed-only (timers cleared, card still 生成中).
    // Fixed path must abort first → terminal === 'aborted'.
    expect(terminal).toBe('aborted');
    expect(terminal).not.toBe('disposed-only');
    expect(terminal).not.toBe('streaming');
  });

  test('index.ts route rebuild uses abandon helper (abort before dispose)', () => {
    const region = replyRouteCrossJidRebuildRegion(indexSource);
    const helperSource = fs.readFileSync(
      path.join(root, 'src', 'reply-route-cross-jid-abandon.ts'),
      'utf8',
    );

    // Must route through the shared abandon helper — not bare dispose.
    expect(region).toContain('abandonStreamingCardOnRouteChange');
    expect(region).not.toMatch(
      /streamingSession\.isActive\(\)\s*\)\s*streamingSession\.dispose\(\)/,
    );

    // Helper itself must abort before dispose.
    const abortIdx = helperSource.indexOf('session.abort(');
    const disposeIdx = helperSource.indexOf('session.dispose()');
    expect(abortIdx).toBeGreaterThanOrEqual(0);
    expect(disposeIdx).toBeGreaterThan(abortIdx);
    expect(helperSource).toContain('.catch(');

    // Contrast siblings already terminalize before dispose (held-card / agent).
    expect(indexSource).toContain("abort('新消息已开始')");
  });
});