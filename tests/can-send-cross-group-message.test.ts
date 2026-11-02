import { describe, expect, test, vi } from 'vitest';

import { canSendCrossGroupMessage } from '../src/cross-group-acl.js';
import { resolveIpcDeliveryTargetGroup } from '../src/ipc-delivery-routing.js';
import type { RegisteredGroup } from '../src/types.js';

/**
 * Regression tests for the cross-group ACL helper in src/cross-group-acl.ts.
 *
 * The 5 branches:
 *  1. admin home → always allowed
 *  2. target.folder === sourceFolder (same workspace)
 *  3. member home + same created_by (cross-workspace, same user)
 *  4. topic group target_main_jid → bound workspace folder === sourceFolder
 *     (added in f93d922 — without this, agent in non-home sub-workspaces
 *      could not reply to its IM channel after agent-runner started
 *      rewriting ctx.chatJid to the IM source jid)
 *  5. target.target_agent_id → bound Runtime Session's workspace folder
 *     === sourceFolder. Direct-chat session binds record only
 *     target_agent_id and leave the channel row's own `folder` at the
 *     channel account's default workspace, so branches 2 and 4 both miss
 *     and the session's replies were rejected while the turn itself
 *     completed — a silent channel, not a visible failure.
 *
 * Mutation checks (run by QA): removing branch 4 should turn the
 * "bound IM jid" cases red. Flipping `bound?.folder === sourceFolder`
 * to `===` against anything else should also fail. Removing branch 5
 * should turn the "bound Runtime Session" case red.
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
      canSendCrossGroupMessage(
        true,
        true,
        'main',
        undefined,
        target,
        () => undefined,
        () => undefined,
      ),
    ).toBe(true);
  });

  test('non-home group can send to a target sharing the same folder', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const target = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        target,
        () => undefined,
        () => undefined,
      ),
    ).toBe(true);
  });

  test('member home can send to a target created by the same user', () => {
    const source = makeGroup({ folder: 'home-u1', created_by: 'u1' });
    const target = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    expect(
      canSendCrossGroupMessage(
        false,
        true,
        'home-u1',
        source,
        target,
        () => undefined,
        () => undefined,
      ),
    ).toBe(true);
  });

  test('non-home + different folder + different owner → denied', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const target = makeGroup({ folder: 'flow-y', created_by: 'u2' });
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        target,
        () => undefined,
        () => undefined,
      ),
    ).toBe(false);
  });

  // Branch 4: a topic group bound to workspace flow-x via target_main_jid;
  // replies from its sessions must succeed.
  test('topic group bound to source workspace via target_main_jid → allowed', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    // The topic group's entry has target_main_jid pointing at the workspace's
    // web jid. The lookup resolves that jid to the bound workspace whose
    // folder matches sourceFolder.
    const imTarget = makeGroup({
      folder: 'main', // the channel account's default workspace
      binding_mode: 'thread_map',
      target_main_jid: 'web:flow-x',
    });
    const lookupGroup = vi.fn((jid: string) =>
      jid === 'web:flow-x'
        ? makeGroup({ folder: 'flow-x', created_by: 'u1' })
        : undefined,
    );
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        imTarget,
        lookupGroup,
        () => undefined,
      ),
    ).toBe(true);
    expect(lookupGroup).toHaveBeenCalledWith('web:flow-x');
  });

  test('target_main_jid outside a topic group grants nothing', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const imTarget = makeGroup({
      folder: 'main',
      target_main_jid: 'web:flow-x',
    });
    const lookupGroup = vi.fn((jid: string) =>
      jid === 'web:flow-x'
        ? makeGroup({ folder: 'flow-x', created_by: 'u1' })
        : undefined,
    );
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        imTarget,
        lookupGroup,
        () => undefined,
      ),
    ).toBe(false);
  });

  test('Feishu native topic route inherits its bound conversation ACL', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const topicRoute =
      'feishu:oc_topic#thread:omt_current#root:om_current_root';
    const imTarget = makeGroup({
      folder: 'main',
      binding_mode: 'thread_map',
      target_main_jid: 'web:flow-x',
    });
    const lookupGroup = vi.fn((jid: string) => {
      if (jid === 'feishu:oc_topic') return imTarget;
      if (jid === 'web:flow-x') {
        return makeGroup({ folder: 'flow-x', created_by: 'u1' });
      }
      return undefined;
    });
    const resolvedTarget = resolveIpcDeliveryTargetGroup(
      topicRoute,
      lookupGroup,
    );

    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        resolvedTarget,
        lookupGroup,
        () => undefined,
      ),
    ).toBe(true);
    expect(lookupGroup).toHaveBeenCalledWith('feishu:oc_topic');
  });

  test('IM chat bound to a DIFFERENT workspace → denied', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const imTarget = makeGroup({
      folder: 'main',
      binding_mode: 'thread_map',
      target_main_jid: 'web:flow-y',
    });
    const lookupGroup = vi.fn((jid: string) =>
      jid === 'web:flow-y'
        ? makeGroup({ folder: 'flow-y', created_by: 'u2' })
        : undefined,
    );
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        imTarget,
        lookupGroup,
        () => undefined,
      ),
    ).toBe(false);
  });

  test('target_main_jid points to an unknown jid → denied', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const imTarget = makeGroup({
      folder: 'main',
      binding_mode: 'thread_map',
      target_main_jid: 'web:does-not-exist',
    });
    const lookupGroup = vi.fn(() => undefined);
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        imTarget,
        lookupGroup,
        () => undefined,
      ),
    ).toBe(false);
  });

  // Branch 5: a direct chat bound to a Runtime Session. The channel row keeps
  // `folder` at the channel account's default workspace ('main') and records
  // only target_agent_id, so branches 2 and 4 both miss.
  test('direct chat bound to a Runtime Session in the source workspace → allowed', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const imTarget = makeGroup({
      folder: 'main',
      target_agent_id: 'session-1',
    });
    const lookupAgentFolder = vi.fn((agentId: string) =>
      agentId === 'session-1' ? 'flow-x' : undefined,
    );
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        imTarget,
        () => undefined,
        lookupAgentFolder,
      ),
    ).toBe(true);
    expect(lookupAgentFolder).toHaveBeenCalledWith('session-1');
  });

  test('direct chat bound to a Runtime Session in ANOTHER workspace → denied', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const imTarget = makeGroup({
      folder: 'main',
      target_agent_id: 'session-2',
    });
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        imTarget,
        () => undefined,
        (agentId) => (agentId === 'session-2' ? 'flow-y' : undefined),
      ),
    ).toBe(false);
  });

  test('target_agent_id points to an unknown session → denied', () => {
    const source = makeGroup({ folder: 'flow-x', created_by: 'u1' });
    const imTarget = makeGroup({
      folder: 'main',
      target_agent_id: 'session-gone',
    });
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        source,
        imTarget,
        () => undefined,
        () => undefined,
      ),
    ).toBe(false);
  });

  // An unknown session must not be rescued by an empty sourceFolder: both
  // sides would read as "" and a missing session would silently authorize.
  test('unknown session + empty sourceFolder → still denied', () => {
    const imTarget = makeGroup({
      folder: 'main',
      target_agent_id: 'session-gone',
    });
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        '',
        makeGroup({ folder: '', created_by: 'u1' }),
        imTarget,
        () => undefined,
        () => undefined,
      ),
    ).toBe(false);
  });

  test('undefined target → denied (regardless of source flags)', () => {
    expect(
      canSendCrossGroupMessage(
        false,
        false,
        'flow-x',
        undefined,
        undefined,
        () => undefined,
        () => undefined,
      ),
    ).toBe(false);
  });
});
