import fs from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import {
  runSdkControlWithTimeout,
  SdkControlTimeoutError,
  SdkFirstResponseWatchdog,
} from '../container/agent-runner/src/sdk-control.js';

describe('agent-runner SDK control requests', () => {
  test('returns a healthy control response', async () => {
    await expect(
      runSdkControlWithTimeout(
        'getContextUsage',
        async () => ({ totalTokens: 42 }),
        100,
      ),
    ).resolves.toEqual({ totalTokens: 42 });
  });

  test('fails open when a diagnostic control request never settles', async () => {
    vi.useFakeTimers();
    try {
      const pending = runSdkControlWithTimeout(
        'getContextUsage',
        () => new Promise<never>(() => {}),
        5_000,
      );
      const rejection = expect(pending).rejects.toEqual(
        new SdkControlTimeoutError('getContextUsage', 5_000),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  test('preserves a real SDK control error', async () => {
    const failure = new Error('control transport closed');
    await expect(
      runSdkControlWithTimeout(
        'getContextUsage',
        async () => {
          throw failure;
        },
        100,
      ),
    ).rejects.toBe(failure);
  });

  test('fires when the SDK never forwards a first model response', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

      watchdog.observe('system');
      await vi.advanceTimersByTimeAsync(59_999);
      expect(onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(['assistant', 'result', 'stream_event'])(
    'clears the first-response watchdog on %s',
    async (messageType) => {
      vi.useFakeTimers();
      try {
        const onTimeout = vi.fn();
        const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

        watchdog.observe(messageType);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(onTimeout).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('allows a long compaction and clears its deadline on the real response', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

      await vi.advanceTimersByTimeAsync(3_000);
      watchdog.beginCompaction(10 * 60_000);

      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(onTimeout).not.toHaveBeenCalled();

      watchdog.observe('assistant');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('retains a bounded deadline when the post-compaction response stalls', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

      watchdog.beginCompaction(10 * 60_000);
      // Treat the first two minutes as a summarization round-trip whose end
      // was never reported: without PostCompact, compact_boundary or a status
      // compact_result, the same absolute deadline must also bound a provider
      // that never emits the subsequent model response.
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(8 * 60_000 - 1);
      expect(onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(onTimeout).toHaveBeenCalledWith('compaction', 10 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a finished compaction gives the next response the ordinary deadline', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

      watchdog.beginCompaction(10 * 60_000);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      watchdog.endCompaction();
      await vi.advanceTimersByTimeAsync(60_000 - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onTimeout).toHaveBeenCalledWith('first_response', 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test('ending compaction is a no-op outside the compaction phase', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);
      watchdog.observe('assistant');
      watchdog.endCompaction();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('an api_retry restarts the active deadline after the announced delay', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

      await vi.advanceTimersByTimeAsync(50_000);
      watchdog.observeRetry(30_000);
      // The original deadline would have fired at 60s.
      await vi.advanceTimersByTimeAsync(60_000 + 30_000 - 1);
      expect(onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onTimeout).toHaveBeenCalledWith('first_response', 90_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an api_retry after the first response does not re-arm anything', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);
      watchdog.observe('stream_event');
      watchdog.observeRetry(5_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not let repeated compactions extend the hard deadline', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

      watchdog.beginCompaction(10 * 60_000);
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      watchdog.beginCompaction(10 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(onTimeout).toHaveBeenCalledOnce();
      expect(onTimeout).toHaveBeenCalledWith('compaction', 10 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test('arms a fresh bounded deadline for compaction after an earlier response', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

      watchdog.observe('stream_event');
      watchdog.beginCompaction(10 * 60_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(onTimeout).toHaveBeenCalledOnce();
      expect(onTimeout).toHaveBeenCalledWith('compaction', 10 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not arm the main watchdog for a sub-agent compaction', () => {
    const source = fs.readFileSync(
      new URL('../container/agent-runner/src/index.ts', import.meta.url),
      'utf8',
    );
    const hookStart = source.indexOf('function createPreCompactHook');
    const subAgentGuard = source.indexOf('if (preCompact.agent_id)', hookStart);
    const watchdogArm = source.indexOf('deps.onCompactionStart?.()', hookStart);

    expect(hookStart).toBeGreaterThanOrEqual(0);
    expect(subAgentGuard).toBeGreaterThan(hookStart);
    expect(watchdogArm).toBeGreaterThan(subAgentGuard);
  });

  test('does not treat a non-terminal rate-limit warning as a model response', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(1_000, onTimeout);

      watchdog.observe('rate_limit_event');
      vi.advanceTimersByTime(1_000);

      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
