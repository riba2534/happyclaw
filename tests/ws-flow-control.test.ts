import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createBackpressureTracker,
  createStreamFlowControl,
} from '../src/ws-flow-control.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createStreamFlowControl', () => {
  test('pauses past the high-water mark and resumes below the low-water mark', async () => {
    vi.useFakeTimers();
    let buffered = 0;
    const pause = vi.fn();
    const resume = vi.fn();
    const flow = createStreamFlowControl({
      getBufferedAmount: () => buffered,
      pause,
      resume,
      highWaterBytes: 1_000,
      lowWaterBytes: 100,
      pollMs: 10,
    });

    buffered = 900;
    flow.afterSend();
    expect(pause).not.toHaveBeenCalled();

    buffered = 1_500;
    flow.afterSend();
    flow.afterSend();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(flow.paused).toBe(true);

    buffered = 500; // draining but still above low water
    await vi.advanceTimersByTimeAsync(50);
    expect(resume).not.toHaveBeenCalled();

    buffered = 50;
    await vi.advanceTimersByTimeAsync(10);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(flow.paused).toBe(false);

    buffered = 2_000;
    flow.afterSend();
    expect(pause).toHaveBeenCalledTimes(2);
    flow.dispose();
    buffered = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe('createBackpressureTracker', () => {
  test('drops only a client that stays backed up across checks and time', () => {
    const tracker = createBackpressureTracker({
      graceMs: 10_000,
      minChecks: 3,
    });
    const client = {};
    expect(tracker.observe(client, true, 0)).toBe(false);
    expect(tracker.observe(client, true, 1_000)).toBe(false);
    // Enough checks but not enough time.
    expect(tracker.observe(client, true, 5_000)).toBe(false);
    expect(tracker.observe(client, true, 10_000)).toBe(true);

    // Draining once resets the window.
    const bursty = {};
    tracker.observe(bursty, true, 0);
    tracker.observe(bursty, true, 6_000);
    expect(tracker.observe(bursty, false, 7_000)).toBe(false);
    expect(tracker.observe(bursty, true, 12_000)).toBe(false);
    expect(tracker.observe(bursty, true, 13_000)).toBe(false);
  });
});

describe('TerminalManager.pause/resume', () => {
  test('pauses the output streams of the running session only', async () => {
    const { TerminalManager } = await import('../src/terminal-manager.js');
    const manager = new TerminalManager();
    const stream = () => ({ pause: vi.fn(), resume: vi.fn() });
    const pty = { stdout: stream(), stderr: stream() };
    const pipe = { stdout: stream(), stderr: stream() };
    const sessions = (manager as any).sessions as Map<string, unknown>;
    sessions.set('web:pty', { mode: 'pty', process: pty });
    sessions.set('web:pipe', { mode: 'pipe', process: pipe });

    manager.pause('web:pty');
    manager.pause('web:pipe');
    manager.pause('web:missing');
    expect(pty.stdout.pause).toHaveBeenCalledTimes(1);
    // PTY stderr carries worker logs, not terminal output.
    expect(pty.stderr.pause).not.toHaveBeenCalled();
    expect(pipe.stdout.pause).toHaveBeenCalledTimes(1);
    expect(pipe.stderr.pause).toHaveBeenCalledTimes(1);

    manager.resume('web:pty');
    manager.resume('web:pipe');
    expect(pty.stdout.resume).toHaveBeenCalledTimes(1);
    expect(pipe.stdout.resume).toHaveBeenCalledTimes(1);
    expect(pipe.stderr.resume).toHaveBeenCalledTimes(1);
  });
});
