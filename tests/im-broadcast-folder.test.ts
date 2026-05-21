import { describe, expect, test, vi } from 'vitest';

import {
  broadcastToOwnerIMChannels,
  type BroadcastToOwnerIMChannelsDeps,
} from '../src/task-routing.js';

// Mirror of src/channel-prefixes.ts prefix → type mapping, inlined for test
// independence. If CHANNEL_PREFIXES ever changes, update this alongside.
const PREFIX_TO_TYPE: Record<string, string> = {
  feishu: 'feishu',
  tg: 'telegram',
  qq: 'qq',
  ding: 'dingtalk',
  discord: 'discord',
  web: 'web',
};

function fakeGetChannelType(jid: string): string | null {
  const prefix = jid.split(':')[0];
  return PREFIX_TO_TYPE[prefix] ?? null;
}

describe('broadcastToOwnerIMChannels — folder-precise routing (fix F regression guard)', () => {
  test('routes only to groups whose folder matches sourceFolder', () => {
    // Owner has two IM bindings: feishu bound to ws-x, telegram bound to home-u.
    // Task runs in workspace ws-x → feishu fires, telegram does NOT.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'home-u' },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('feishu:F1');
    expect(sendFn).not.toHaveBeenCalledWith('tg:T1');
  });

  test('sourceFolder=home-u routes only to telegram binding', () => {
    // Symmetric case: same bindings, different sourceFolder → telegram only.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'home-u' },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'home-u',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('tg:T1');
  });

  test('no group matches sourceFolder → no sendFn calls', () => {
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'home-u' },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'some-other-folder',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).not.toHaveBeenCalled();
  });

  test('channel type already sent (in alreadySentJids) is skipped', () => {
    // alreadySentJids says feishu was already covered; broadcast should skip
    // the feishu binding even though it matches the folder.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'ws-x' }, // also bound to ws-x for this case
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set(['feishu:F1']),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('tg:T1');
  });

  test('source IM jid in alreadySent prevents same-channel fallback duplicate', () => {
    // Reproduces the bug fixed in storeResultAndNotify: a script task
    // bound to feishu:source has already sent its IM message via the upstream
    // sendMessage call. The subsequent broadcast must NOT pick a different
    // feishu group (fallback) just because both share the same folder, or
    // the task result lands in a wrong feishu group as well.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu'],
      getGroupsByOwner: () => [
        // Note ordering: the fallback group is listed first, mimicking the
        // production case where the wrongly-picked group happens to be the
        // earliest-registered feishu group for the owner.
        { jid: 'feishu:fallback', folder: 'ws-main' },
        { jid: 'feishu:source', folder: 'ws-main' },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-main',
      new Set(['feishu:source']),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).not.toHaveBeenCalled();
  });

  test('notifyChannels filter restricts output to allowed channel types', () => {
    // Both feishu and telegram bind to ws-x, but notifyChannels=['telegram']
    // means only telegram should receive.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'ws-x' },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      ['telegram'],
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('tg:T1');
  });

  test('notifyChannels=null means no filter (fan out to all matching)', () => {
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x' },
        { jid: 'tg:T1', folder: 'ws-x' },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      null,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenCalledWith('feishu:F1');
    expect(sendFn).toHaveBeenCalledWith('tg:T1');
  });

  test('one channel type, multiple candidate bindings: only the folder-matching one wins', () => {
    // Owner has feishu bound to two different workspaces. Only the one whose
    // folder === sourceFolder should fire. This is the core "folder precision"
    // property that fix F is defending.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F-home', folder: 'home-u' },
        { jid: 'feishu:F-wsx', folder: 'ws-x' },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('feishu:F-wsx');
    expect(sendFn).not.toHaveBeenCalledWith('feishu:F-home');
  });

  test('connected channel type with no binding at sourceFolder is silently skipped', () => {
    // Owner has feishu connected, but no feishu binding exists for this folder.
    // Should not throw, should not send.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu'],
      getGroupsByOwner: () => [{ jid: 'tg:T1', folder: 'ws-x' }],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).not.toHaveBeenCalled();
  });
});

/**
 * Regression suite for a bug discovered after fix F shipped: the
 * ImBindingDialog UI binds an IM group to a non-home workspace via
 * `target_main_jid` WITHOUT changing the group's own `folder`. The
 * initial fix F only matched on folder equality, so scheduled tasks in
 * non-home workspaces silently failed to reach their bound IM groups
 * when the binding was of the target_main_jid kind.
 *
 * These tests lock in that `resolveImGroupEffectiveFolder` (via
 * resolveJidFolder) is consulted during matching, so both binding
 * mechanisms work:
 *   - shared folder (handled by the suite above)
 *   - target_main_jid redirection (this suite)
 */
describe('broadcastToOwnerIMChannels — target_main_jid binding (ImBindingDialog)', () => {
  test('IM group with target_main_jid matches via resolved target folder, not own folder', () => {
    // Feishu group's own folder is 'home-u' (registered there on first contact),
    // but the user bound it to workspace 'ws-x' via ImBindingDialog. The binding
    // is stored as target_main_jid='web:ws-x-jid'. A scheduled task running in
    // ws-x (sourceFolder='ws-x') must still fan out to this Feishu group.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu'],
      getGroupsByOwner: () => [
        {
          jid: 'feishu:F-bound',
          folder: 'home-u',
          target_main_jid: 'web:ws-x-jid',
        },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: (jid) => (jid === 'web:ws-x-jid' ? 'ws-x' : null),
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('feishu:F-bound');
  });

  test('target_main_jid takes precedence over own folder when both could match different sourceFolders', () => {
    // IM group's own folder is 'home-u', target_main_jid points to 'ws-x'.
    // When sourceFolder='home-u', it MUST NOT match — the binding redirects
    // this group to ws-x only. (Prevents double-delivery when home and ws-x
    // both host scheduled tasks.)
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu'],
      getGroupsByOwner: () => [
        {
          jid: 'feishu:F-bound',
          folder: 'home-u',
          target_main_jid: 'web:ws-x-jid',
        },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: (jid) => (jid === 'web:ws-x-jid' ? 'ws-x' : null),
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'home-u',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).not.toHaveBeenCalled();
  });

  test('target_main_jid that cannot be resolved falls back to own folder', () => {
    // target_main_jid points to a workspace that was deleted (resolveJidFolder
    // returns null). The group should gracefully fall back to matching on its
    // own folder so at least the pre-fix F behavior is preserved.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu'],
      getGroupsByOwner: () => [
        {
          jid: 'feishu:F-orphan',
          folder: 'home-u',
          target_main_jid: 'web:deleted-ws',
        },
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null, // deleted target
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'home-u',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('feishu:F-orphan');
  });

  test('legacy target_main_jid format `web:{folder}` still resolves (DB-migration compat)', () => {
    // Historical data shape: some old DBs stored target_main_jid as
    // `web:{folder}` (using the folder name as a pseudo-jid) instead of the
    // canonical `web:{uuid}` the current writer uses. The production
    // resolveJidFolder delegates to resolveWorkspaceJid which folds this shape
    // back to the real registered jid. This test exercises the shape
    // contract: a resolveJidFolder impl that interprets the legacy shape
    // correctly (returns a folder) must still hit the broadcast path.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu'],
      getGroupsByOwner: () => [
        {
          jid: 'feishu:F-legacy',
          folder: 'home-u',
          // Legacy shape: `web:{folder-name}`, not `web:{uuid}`.
          target_main_jid: 'web:flow-legacy-42',
        },
      ],
      getChannelType: fakeGetChannelType,
      // Simulate resolveWorkspaceJid's legacy fallback: legacy shape inputs
      // are translated to the canonical folder rather than returning null.
      resolveJidFolder: (jid) =>
        jid === 'web:flow-legacy-42' ? 'flow-legacy-42' : null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'flow-legacy-42',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith('feishu:F-legacy');
  });

  test('group with target_main_jid=null / undefined behaves like legacy folder-only match', () => {
    // Regression guard: ensure adding the target_main_jid code path didn't
    // break the existing folder-equality behavior for groups without binding.
    const sendFn = vi.fn<(jid: string) => void>();
    const deps: BroadcastToOwnerIMChannelsDeps = {
      getConnectedChannelTypes: () => ['feishu', 'telegram'],
      getGroupsByOwner: () => [
        { jid: 'feishu:F1', folder: 'ws-x', target_main_jid: null },
        { jid: 'tg:T1', folder: 'ws-x' }, // no target_main_jid field at all
      ],
      getChannelType: fakeGetChannelType,
      resolveJidFolder: () => null,
    };

    broadcastToOwnerIMChannels(
      'user-1',
      'ws-x',
      new Set<string>(),
      sendFn,
      undefined,
      deps,
    );

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenCalledWith('feishu:F1');
    expect(sendFn).toHaveBeenCalledWith('tg:T1');
  });
});
