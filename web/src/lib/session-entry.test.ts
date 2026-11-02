import { describe, expect, test } from 'vitest';
import {
  mostRecentSession,
  resolveLanding,
  resolveWorkspaceEntry,
} from './session-entry';

const session = (
  id: string,
  lastActive: string | null,
  over: { kind?: 'conversation' | 'spawn'; pinned_at?: string | null } = {},
) => ({
  id,
  kind: over.kind ?? ('conversation' as const),
  created_at: '2026-01-01T00:00:00.000Z',
  last_active_at: lastActive,
  pinned_at: over.pinned_at ?? null,
});

const sessions = [
  session('old', '2026-03-01T00:00:00.000Z'),
  // Pinned, but not the most recently active: pins order lists, not entry.
  session('pinned', '2026-02-01T00:00:00.000Z', {
    pinned_at: '2026-04-01T00:00:00.000Z',
  }),
  session('recent', '2026-05-01T00:00:00.000Z'),
  session('spawn', '2026-06-01T00:00:00.000Z', { kind: 'spawn' }),
];

describe('entering a workspace', () => {
  test('opens the session last opened there while it exists', () => {
    expect(resolveWorkspaceEntry(sessions, 'old', true)).toEqual({
      kind: 'open',
      sessionId: 'old',
    });
  });

  test('otherwise the most recently active conversation', () => {
    expect(resolveWorkspaceEntry(sessions, 'gone', true)).toEqual({
      kind: 'open',
      sessionId: 'recent',
    });
    expect(resolveWorkspaceEntry(sessions, null, false)).toEqual({
      kind: 'open',
      sessionId: 'recent',
    });
    // A spawned agent is no conversation to open.
    expect(resolveWorkspaceEntry(sessions, 'spawn', true)).toEqual({
      kind: 'open',
      sessionId: 'recent',
    });
  });

  test('with none, makes one for its owner and shows the empty state to others', () => {
    const none = [session('spawn', null, { kind: 'spawn' })];
    expect(resolveWorkspaceEntry(none, null, true)).toEqual({ kind: 'create' });
    expect(resolveWorkspaceEntry([], 'gone', false)).toEqual({
      kind: 'empty',
    });
  });

  test('the most recent session falls back to when it was made', () => {
    expect(
      mostRecentSession([
        { ...session('a', null), created_at: '2026-01-02T00:00:00.000Z' },
        { ...session('b', null), created_at: '2026-01-03T00:00:00.000Z' },
      ])?.id,
    ).toBe('b');
    expect(mostRecentSession([])).toBeNull();
  });
});

describe('opening the app', () => {
  const home = 'web:home';
  const other = 'web:other';
  const loaded: Record<string, ReturnType<typeof session>[]> = {
    [home]: sessions,
    [other]: [session('elsewhere', '2026-01-01T00:00:00.000Z')],
  };
  const sessionsOf = (jid: string) => loaded[jid] ?? [];

  test('returns to the session last opened on this device, in any workspace', () => {
    expect(
      resolveLanding({
        last: { jid: other, sessionId: 'elsewhere' },
        homeJid: home,
        sessionsOf,
      }),
    ).toEqual({ kind: 'open', jid: other, sessionId: 'elsewhere' });
  });

  test("goes to Home's most recently active session when that one is gone", () => {
    expect(
      resolveLanding({
        last: { jid: other, sessionId: 'deleted' },
        homeJid: home,
        sessionsOf,
      }),
    ).toEqual({ kind: 'open', jid: home, sessionId: 'recent' });
    expect(resolveLanding({ last: null, homeJid: home, sessionsOf })).toEqual({
      kind: 'open',
      jid: home,
      sessionId: 'recent',
    });
  });

  test('starts one in Home when Home has none, and nothing without a Home', () => {
    expect(
      resolveLanding({ last: null, homeJid: 'web:empty', sessionsOf }),
    ).toEqual({ kind: 'create', jid: 'web:empty' });
    expect(resolveLanding({ last: null, homeJid: null, sessionsOf })).toEqual({
      kind: 'none',
    });
  });
});
