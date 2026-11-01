import { describe, expect, test, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: { get: vi.fn() } }));

const { isWorkspaceRunning, useGroupsStore } = await import('./groups');

describe('a workspace at work', () => {
  test('is one with any of its sessions running', () => {
    const states = {
      'web:alpha#agent:s1': 'running' as const,
      'web:alphabet#agent:s2': 'running' as const,
    };
    expect(isWorkspaceRunning(states, 'web:alpha')).toBe(true);
    expect(isWorkspaceRunning(states, 'web:beta')).toBe(false);
    // A workspace JID is no session's: its own state counts for nothing.
    expect(isWorkspaceRunning({ 'web:beta': 'running' }, 'web:beta')).toBe(
      false,
    );
  });

  test('a runner reporting what it already said changes nothing', () => {
    const { setRunnerState } = useGroupsStore.getState();
    setRunnerState('web:alpha#agent:s1', 'running');
    const before = useGroupsStore.getState().runnerStates;
    setRunnerState('web:alpha#agent:s1', 'running');
    expect(useGroupsStore.getState().runnerStates).toBe(before);
    setRunnerState('web:alpha#agent:s1', 'idle');
    expect(useGroupsStore.getState().runnerStates).toEqual({});
    setRunnerState('web:alpha#agent:s1', 'idle');
    expect(useGroupsStore.getState().runnerStates).toEqual({});
  });
});
