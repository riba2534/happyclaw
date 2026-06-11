/**
 * Unit tests for the owner-lifecycle subsystem (src/group-owner.ts).
 *
 * The point of consolidating these transitions was to express two
 * previously-copy-pasted invariants in exactly one place:
 *   - releaseOwner downgrades 'owner_mentioned' → 'when_mentioned' (else the
 *     bot goes permanently silent group-wide once the owner is gone)
 *   - claimOwner never touches activation_mode
 * Both are asserted directly below. The transitions are pure, so they need no
 * DB; persistGroupUpdate's db write is exercised against a spy.
 */
import { describe, expect, test, vi } from 'vitest';

const setRegisteredGroupSpy = vi.fn();
vi.mock('../src/db.js', () => ({
  setRegisteredGroup: (...args: unknown[]) => setRegisteredGroupSpy(...args),
}));

const {
  claimOwner,
  releaseOwner,
  addToAllowlist,
  removeFromAllowlist,
  persistGroupUpdate,
} = await import('../src/group-owner.js');

type AnyGroup = any;
const base = (over: Partial<AnyGroup> = {}): AnyGroup => ({
  name: 'G',
  folder: 'f',
  added_at: 't',
  ...over,
});

describe('claimOwner', () => {
  test('sets owner_im_id and leaves activation_mode untouched (invariant #2)', () => {
    const g = base({ activation_mode: 'owner_mentioned' });
    const r = claimOwner(g, 'u1');
    expect(r.owner_im_id).toBe('u1');
    expect(r.activation_mode).toBe('owner_mentioned');
  });

  test('is pure — does not mutate the input group', () => {
    const g = base({ owner_im_id: undefined });
    claimOwner(g, 'u1');
    expect(g.owner_im_id).toBeUndefined();
  });
});

describe('releaseOwner', () => {
  test('clears owner + allowlist and downgrades owner_mentioned → when_mentioned (invariant #1)', () => {
    const g = base({
      owner_im_id: 'u1',
      sender_allowlist: ['u1', 'u2'],
      activation_mode: 'owner_mentioned',
    });
    const r = releaseOwner(g);
    expect(r.owner_im_id).toBeUndefined();
    expect(r.sender_allowlist).toBeUndefined();
    expect(r.activation_mode).toBe('when_mentioned');
  });

  test('preserves every non-owner_mentioned activation mode', () => {
    for (const mode of ['auto', 'always', 'when_mentioned', 'disabled'] as const) {
      const r = releaseOwner(base({ owner_im_id: 'u1', activation_mode: mode }));
      expect(r.activation_mode).toBe(mode);
      expect(r.owner_im_id).toBeUndefined();
    }
  });

  test('leaves an undefined activation_mode undefined', () => {
    const r = releaseOwner(base({ owner_im_id: 'u1' }));
    expect(r.activation_mode).toBeUndefined();
  });
});

describe('addToAllowlist', () => {
  test('seeds with the owner when the allowlist is unset, then appends deduped', () => {
    const { group, added } = addToAllowlist(base({ owner_im_id: 'owner' }), 'owner', [
      'a',
      'b',
    ]);
    expect(group.sender_allowlist).toEqual(['owner', 'a', 'b']);
    expect(added).toEqual(['a', 'b']);
  });

  test('drops already-present ids and returns the original group when nothing is new', () => {
    const g = base({ owner_im_id: 'owner', sender_allowlist: ['owner', 'a'] });
    const { group, added } = addToAllowlist(g, 'owner', ['a']);
    expect(added).toEqual([]);
    // Same reference → caller can skip persistence.
    expect(group).toBe(g);
  });
});

describe('removeFromAllowlist', () => {
  test('removes the given ids and reports the count', () => {
    const { group, removed } = removeFromAllowlist(
      base({ sender_allowlist: ['owner', 'a', 'b'] }),
      ['a', 'b'],
    );
    expect(group.sender_allowlist).toEqual(['owner']);
    expect(removed).toBe(2);
  });

  test('is a no-op on an empty or unset allowlist', () => {
    expect(removeFromAllowlist(base({}), ['a']).removed).toBe(0);
    expect(removeFromAllowlist(base({ sender_allowlist: [] }), ['a']).removed).toBe(0);
  });

  test('reports 0 removed when targets are absent from a non-empty allowlist', () => {
    // Drives handleDisallowCommand's `removed === 0` early-skip (no redundant persist).
    const { group, removed } = removeFromAllowlist(
      base({ sender_allowlist: ['owner', 'a'] }),
      ['not-a-member'],
    );
    expect(removed).toBe(0);
    expect(group.sender_allowlist).toEqual(['owner', 'a']);
  });
});

describe('persistGroupUpdate', () => {
  test('persists via setRegisteredGroup and syncs the in-memory cache together', () => {
    setRegisteredGroupSpy.mockClear();
    const cache: Record<string, AnyGroup> = {};
    const g = base({ owner_im_id: 'u1' });
    persistGroupUpdate('web:x', g, cache);
    expect(setRegisteredGroupSpy).toHaveBeenCalledWith('web:x', g);
    expect(cache['web:x']).toBe(g);
  });
});
