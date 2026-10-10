import { describe, expect, test } from 'vitest';

import { createRejectCooldown } from '../src/reject-cooldown.js';
import {
  STALE_STREAMING_STATE_MS,
  sweepStaleStreamingEntries,
} from '../src/streaming-state-sweep.js';

describe('createRejectCooldown', () => {
  test('notifies once per cooldown per chat', () => {
    const gate = createRejectCooldown(60_000);
    expect(gate.shouldNotify('chat', 0)).toBe(true);
    expect(gate.shouldNotify('chat', 59_999)).toBe(false);
    expect(gate.shouldNotify('other', 59_999)).toBe(true);
    expect(gate.shouldNotify('chat', 60_000)).toBe(true);
  });

  test('stays bounded under a stream of distinct unpaired chats', () => {
    const gate = createRejectCooldown(60_000, 100);
    for (let i = 0; i < 10_000; i += 1) {
      gate.shouldNotify(`chat-${i}`, i);
    }
    expect(gate.size).toBeLessThanOrEqual(100);
    // The most recent chats are still rate-limited.
    expect(gate.shouldNotify('chat-9999', 10_000)).toBe(false);
  });

  test('drops expired entries before live ones', () => {
    const gate = createRejectCooldown(1_000, 2);
    gate.shouldNotify('old', 0);
    gate.shouldNotify('live', 5_000);
    gate.shouldNotify('new', 5_100);
    expect(gate.size).toBe(2);
    expect(gate.shouldNotify('live', 5_200)).toBe(false);
    expect(gate.shouldNotify('new', 5_200)).toBe(false);
  });
});

describe('sweepStaleStreamingEntries', () => {
  test('drops stale ended runs, keeps live and fresh ones, and removes orphan texts', () => {
    const now = 10 * STALE_STREAMING_STATE_MS;
    const snapshots = new Map([
      ['stale-ended', { updatedAt: now - STALE_STREAMING_STATE_MS - 1 }],
      ['stale-live', { updatedAt: now - STALE_STREAMING_STATE_MS - 1 }],
      ['fresh', { updatedAt: now - 1_000 }],
    ]);
    const fullTexts = new Map([
      ['stale-ended', 'a'],
      ['stale-live', 'b'],
      ['fresh', 'c'],
      ['orphan', 'd'],
      ['live-without-snapshot', 'e'],
    ]);
    const active = new Set(['stale-live', 'live-without-snapshot']);

    expect(sweepStaleStreamingEntries(snapshots, fullTexts, active, now)).toBe(
      2,
    );
    expect([...snapshots.keys()].sort()).toEqual(['fresh', 'stale-live']);
    expect([...fullTexts.keys()].sort()).toEqual([
      'fresh',
      'live-without-snapshot',
      'stale-live',
    ]);
  });
});
