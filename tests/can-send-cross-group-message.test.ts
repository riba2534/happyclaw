import { describe, expect, test, vi } from 'vitest';

import { canSendCrossGroupMessage } from '../src/cross-group-acl.js';
import type { RegisteredGroup } from '../src/types.js';

/**
 * Regression tests for the cross-group ACL helper in src/cross-group-acl.ts.
 *
 * The 4 branches:
 *  1. admin home → always allowed
 *  2. target.folder === sourceFolder (same workspace)
 *  3. member home + same created_by (cross-workspace, same user)
 *  4. target.target_main_jid → bound workspace folder === sourceFolder
 *     (added in f93d922 — without this, agent in non-home sub-workspaces
 *      could not reply to its IM channel after agent-runner started
 *      rewriting ctx.chatJid to the IM source jid)
 *
 * Mutation checks (run by QA): removing branch 4 should turn the
 * "bound IM jid" cases red. Flipping `bound?.folder === sourceFolder`
 * to `===` against anything else should also fail.
 */

function makeGroup(partial: Partial<RegisteredGroup>): RegisteredGroup {
  return {
    name: partial.name ?? 'g',
    folder: partial.folder ?? 'f',
    added_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('canSendCrossGroupMessage', () => {
  test('admin home can send to any target', () => {
    const target = makeGroup({ folder: 'other', created_by: 'someoneelse' });
    expect(
      canSendCrossGroupMessage(true, true, 'main', undefined, target, () =>
        undefined,
      ),
    ).toBe(true);
  });

  test('non-home group can send to a target sharing the same folder', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const target = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    expect(
      canSendCrossGroupMessage(false, false, 'flow-x', source, target, () =>
        undefined,
      ),
    ).toBe(true);
  });

  test('member home can send to a target created by the same user', () => {
    const source = makeGroup({ folder: 'home-u1', created_by: 'u1' });
    const target = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    expect(
      canSendCrossGroupMessage(false, true, 'home-u1', source, target, () =>
        undefined,
      ),
    ).toBe(true);
  });

  test('non-home + different folder + different owner → denied', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const target = makeGroup({ folder: 'flow-y', created_by: 'u2' });
    expect(
      canSendCrossGroupMessage(false, false, 'flow-x', source, target, () =>
        undefined,
      ),
    ).toBe(false);
  });

  // Branch 4: the f93d922 fix. Sub-workspace flow-x is bound to an IM
  // chat (qq:c2c:xxx) via target_main_jid; replies must succeed.
  test('IM chat bound to source workspace via target_main_jid → allowed', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    // The IM "group" entry has target_main_jid pointing at the workspace's
    // web jid. The lookup resolves that jid to the bound workspace whose
    // folder matches sourceFolder.
    const imTarget = makeGroup({
      folder: 'main', // home folder of admin (where IM messages land)
      target_main_jid: 'web:flow-x',
    });
    const lookupGroup = vi.fn((jid: string) =>
      jid === 'web:flow-x'
        ? makeGroup({ folder: 'flow-x', created_by: 'u1' })
        : undefined,
    );
    expect(
      canSendCrossGroupMessage(false, false, 'flow-x', source, imTarget, lookupGroup),
    ).toBe(true);
    expect(lookupGroup).toHaveBeenCalledWith('web:flow-x');
  });

  test('IM chat bound to a DIFFERENT workspace → denied', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const imTarget = makeGroup({
      folder: 'main',
      target_main_jid: 'web:flow-y',
    });
    const lookupGroup = vi.fn((jid: string) =>
      jid === 'web:flow-y'
        ? makeGroup({ folder: 'flow-y', created_by: 'u2' })
        : undefined,
    );
    expect(
      canSendCrossGroupMessage(false, false, 'flow-x', source, imTarget, lookupGroup),
    ).toBe(false);
  });

  test('target_main_jid points to an unknown jid → denied', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const imTarget = makeGroup({
      folder: 'main',
      target_main_jid: 'web:does-not-exist',
    });
    const lookupGroup = vi.fn(() => undefined);
    expect(
      canSendCrossGroupMessage(false, false, 'flow-x', source, imTarget, lookupGroup),
    ).toBe(false);
  });

  test('undefined target → denied (regardless of source flags)', () => {
    expect(
      canSendCrossGroupMessage(false, false, 'flow-x', undefined, undefined, () =>
        undefined,
      ),
    ).toBe(false);
  });
});
