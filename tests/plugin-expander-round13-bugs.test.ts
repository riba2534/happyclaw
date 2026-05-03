/**
 * plugin-expander-round13-bugs.test.ts
 *
 * Regression tests for codex review round-13 PR2.b bugs (#21):
 *
 *   P1-1: GroupQueue.hasActiveMainRunnerForMessage() must be a strict
 *         pre-image of `sendMessage()`'s 'sent' acceptance set. When the
 *         active runner is a scheduled task and the caller is NOT a
 *         `#agent:` virtual JID, sendMessage returns 'no_active' so the
 *         caller cold-starts a fresh runner. If the predicate returns true
 *         in that case, web.ts eagerly expands the plugin command (running
 *         inline `!` as a side effect), sendMessage rejects, cold-start
 *         re-reads the original DB row and re-expands → inline double-fire
 *         under the wrong runner context.
 *
 *   P2-2: resolveAdminSharedRuntimeOwner / resolveLatestAdminSenderOverride
 *         centralise the latest-active-admin-sender resolution shared by
 *         the three plugin-expansion call sites (active-IPC, agent-conv
 *         cold-start, main-conv cold-start). Without a shared helper the
 *         three inline copies drifted twice already (round 9 / 11 / 13).
 *
 *   P2-3: handleWebUserMessage / handleAgentConversationMessage must
 *         resolve the effective (sibling-aware) group before calling
 *         buildWebExpandContext. Sibling JIDs (e.g. an IM group bound to
 *         a home workspace) carry incomplete executionMode / customCwd /
 *         created_by on their own row; without resolution the expander
 *         either returns null (no plugins) or pipes the literal `/foo`
 *         to the active runner instead of the rendered prompt.
 *
 * Tests exercise the production exports directly where possible
 * (resolveLatestAdminSenderOverride, resolveAdminSharedRuntimeOwner,
 * GroupQueue.hasActiveMainRunnerForMessage). Pure shadow harnesses are kept
 * only where reaching the production code requires a full DB / runner
 * environment (resolveEffectiveGroup is wired through index.ts module-level
 * state — the shadow mirrors its contract).
 */

import { describe, expect, test } from 'vitest';
import { GroupQueue } from '../src/group-queue.js';
import {
  resolveAdminSharedRuntimeOwner,
  resolveLatestAdminSenderOverride,
  type RuntimeOwnerCandidateUser,
} from '../src/runtime-owner.js';

// ─── P1-1: hasActiveMainRunnerForMessage must mirror sendMessage acceptance ──

interface SeedState {
  jid: string;
  active: boolean;
  groupFolder: string | null;
  activeRunnerIsTask: boolean;
  agentId?: string | null;
}

/**
 * Seed `GroupQueue.groups` directly. `hasActiveMainRunnerForMessage` and
 * `resolveActiveState` only read `active`, `groupFolder`, and
 * `activeRunnerIsTask`; the rest of GroupState is irrelevant for this
 * predicate so we cast through unknown to keep the test hermetic.
 */
function seedQueueState(q: GroupQueue, states: SeedState[]): void {
  const anyQ = q as unknown as {
    groups: Map<
      string,
      {
        active: boolean;
        groupFolder: string | null;
        activeRunnerIsTask: boolean;
        agentId: string | null;
        // unused by this predicate but present in the shape
        pendingTasks: unknown[];
      }
    >;
  };
  for (const s of states) {
    anyQ.groups.set(s.jid, {
      active: s.active,
      groupFolder: s.groupFolder,
      activeRunnerIsTask: s.activeRunnerIsTask,
      agentId: s.agentId ?? null,
      pendingTasks: [],
    });
  }
}

describe('GroupQueue.hasActiveMainRunnerForMessage — #21 round-13 P1-1', () => {
  test('no state at all → false', () => {
    const q = new GroupQueue();
    expect(q.hasActiveMainRunnerForMessage('web:main')).toBe(false);
  });

  test('inactive state → false', () => {
    const q = new GroupQueue();
    seedQueueState(q, [
      {
        jid: 'web:main',
        active: false,
        groupFolder: 'main',
        activeRunnerIsTask: false,
      },
    ]);
    expect(q.hasActiveMainRunnerForMessage('web:main')).toBe(false);
  });

  test('active message runner → true', () => {
    const q = new GroupQueue();
    seedQueueState(q, [
      {
        jid: 'web:main',
        active: true,
        groupFolder: 'main',
        activeRunnerIsTask: false,
      },
    ]);
    expect(q.hasActiveMainRunnerForMessage('web:main')).toBe(true);
  });

  test('active task runner on non-#agent JID → false (sendMessage would reject)', () => {
    // Critical scenario: scheduled task runs on web:main. sendMessage()
    // returns 'no_active' for non-#agent callers. Eager expand here would
    // run inline `!` and then cold-start re-runs it after sendMessage
    // rejects → double-fire under wrong runner context (#21 round-13 P1-1).
    const q = new GroupQueue();
    seedQueueState(q, [
      {
        jid: 'web:main',
        active: true,
        groupFolder: 'main',
        activeRunnerIsTask: true,
      },
    ]);
    expect(q.hasActiveMainRunnerForMessage('web:main')).toBe(false);
  });

  test('active task runner + #agent: caller → true (conversation agents accept IPC)', () => {
    // #agent: virtual JIDs are user-message handlers started via
    // enqueueTask. sendMessage explicitly exempts them from the task-runner
    // exclusion — eager expand must follow.
    const q = new GroupQueue();
    seedQueueState(q, [
      {
        jid: 'web:main#agent:abc123',
        active: true,
        groupFolder: 'main',
        activeRunnerIsTask: true,
        agentId: 'abc123',
      },
    ]);
    expect(q.hasActiveMainRunnerForMessage('web:main#agent:abc123')).toBe(
      true,
    );
  });

  test('active state but groupFolder=null → false (state not yet bound to runner)', () => {
    // resolveActiveState requires both active=true AND groupFolder set.
    const q = new GroupQueue();
    seedQueueState(q, [
      {
        jid: 'web:main',
        active: true,
        groupFolder: null,
        activeRunnerIsTask: false,
      },
    ]);
    expect(q.hasActiveMainRunnerForMessage('web:main')).toBe(false);
  });

  test('IM sibling JID resolves through serializationKeyResolver to active home', () => {
    // Feishu/TG/QQ JIDs share serialization with their bound web JID.
    // sendMessage uses resolveActiveState → findActiveRunnerFor, which
    // walks all states with the same key. Predicate must match.
    const q = new GroupQueue();
    seedQueueState(q, [
      {
        jid: 'web:main',
        active: true,
        groupFolder: 'main',
        activeRunnerIsTask: false,
      },
    ]);
    q.setSerializationKeyResolver((jid) => {
      // both feishu:foo and web:main map to 'main'
      if (jid === 'web:main' || jid === 'feishu:oc_xyz') return 'main';
      return jid;
    });
    expect(q.hasActiveMainRunnerForMessage('feishu:oc_xyz')).toBe(true);
  });

  test('IM sibling JID + active task runner on home → false (consistent with sendMessage)', () => {
    const q = new GroupQueue();
    seedQueueState(q, [
      {
        jid: 'web:main',
        active: true,
        groupFolder: 'main',
        activeRunnerIsTask: true,
      },
    ]);
    q.setSerializationKeyResolver((jid) => {
      if (jid === 'web:main' || jid === 'feishu:oc_xyz') return 'main';
      return jid;
    });
    // sibling JID has no `#agent:` so the task-runner exclusion applies
    expect(q.hasActiveMainRunnerForMessage('feishu:oc_xyz')).toBe(false);
  });

  test('multiple groups, only one active → predicate finds it via sibling lookup', () => {
    const q = new GroupQueue();
    seedQueueState(q, [
      {
        jid: 'web:home-alice',
        active: false,
        groupFolder: 'home-alice',
        activeRunnerIsTask: false,
      },
      {
        jid: 'web:main',
        active: true,
        groupFolder: 'main',
        activeRunnerIsTask: false,
      },
    ]);
    expect(q.hasActiveMainRunnerForMessage('web:main')).toBe(true);
    expect(q.hasActiveMainRunnerForMessage('web:home-alice')).toBe(false);
  });
});

// ─── P2-2: shared helper resolveLatestAdminSenderOverride direct unit tests ──

describe('resolveLatestAdminSenderOverride — direct helper unit', () => {
  const userTable: Record<string, RuntimeOwnerCandidateUser> = {
    'admin-1': { id: 'admin-1', status: 'active', role: 'admin' },
    'admin-2': { id: 'admin-2', status: 'active', role: 'admin' },
    'admin-disabled': {
      id: 'admin-disabled',
      status: 'disabled',
      role: 'admin',
    },
    'admin-deleted': {
      id: 'admin-deleted',
      status: 'deleted',
      role: 'admin',
    },
    member: { id: 'member', status: 'active', role: 'member' },
  };
  const lookup = (id: string) => userTable[id] ?? null;

  test('empty messages → null', () => {
    expect(resolveLatestAdminSenderOverride([], lookup)).toBe(null);
  });

  test('only system / agent senders → null', () => {
    expect(
      resolveLatestAdminSenderOverride(
        [{ sender: '__system__' }, { sender: 'happyclaw-agent' }],
        lookup,
      ),
    ).toBe(null);
  });

  test('single active admin sender → returned', () => {
    expect(
      resolveLatestAdminSenderOverride([{ sender: 'admin-1' }], lookup),
    ).toBe('admin-1');
  });

  test('walks from end, picks the LATEST admin', () => {
    expect(
      resolveLatestAdminSenderOverride(
        [
          { sender: 'admin-1' },
          { sender: '__system__' },
          { sender: 'admin-2' }, // most recent
        ],
        lookup,
      ),
    ).toBe('admin-2');
  });

  test('disabled admin sender skipped, walks earlier', () => {
    expect(
      resolveLatestAdminSenderOverride(
        [{ sender: 'admin-1' }, { sender: 'admin-disabled' }],
        lookup,
      ),
    ).toBe('admin-1');
  });

  test('deleted admin sender skipped', () => {
    expect(
      resolveLatestAdminSenderOverride(
        [{ sender: 'admin-1' }, { sender: 'admin-deleted' }],
        lookup,
      ),
    ).toBe('admin-1');
  });

  test('member sender skipped (admin-only override)', () => {
    expect(
      resolveLatestAdminSenderOverride(
        [{ sender: 'member' }, { sender: '__system__' }],
        lookup,
      ),
    ).toBe(null);
  });

  test('unknown sender (returns null from lookup) skipped', () => {
    expect(
      resolveLatestAdminSenderOverride([{ sender: 'ghost' }], lookup),
    ).toBe(null);
  });

  test('empty-string sender skipped (defensive)', () => {
    expect(
      resolveLatestAdminSenderOverride(
        [{ sender: '' }, { sender: 'admin-1' }],
        lookup,
      ),
    ).toBe('admin-1');
  });
});

describe('resolveAdminSharedRuntimeOwner — gate + override composition', () => {
  const userTable: Record<string, RuntimeOwnerCandidateUser> = {
    'admin-1': { id: 'admin-1', status: 'active', role: 'admin' },
    'admin-2': { id: 'admin-2', status: 'active', role: 'admin' },
    member: { id: 'member', status: 'active', role: 'member' },
  };
  const lookup = (id: string) => userTable[id] ?? null;

  test('non-web:main chatJid → returns fallbackOwner unchanged', () => {
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:home-alice',
      isHome: true,
      fallbackOwner: 'alice',
      messages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('alice');
  });

  test('web:main + isHome=false → no override', () => {
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:main',
      isHome: false,
      fallbackOwner: 'admin-1',
      messages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-1');
  });

  test('web:main + isHome=true + admin sender → override wins', () => {
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-1',
      messages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-2');
  });

  test('web:main + isHome=true + no qualifying sender → fallback', () => {
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-1',
      messages: [{ sender: 'member' }, { sender: '__system__' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-1');
  });

  test('virtual #agent: JID strips suffix → web:main gate still matches', () => {
    // Agent conversation tab: virtual JID is `web:main#agent:<id>`. The gate
    // must look at the base JID before `#`, otherwise admin-2 starting an
    // agent conv on the shared workspace expands against admin-1's plugins
    // (round 11 #19 P2-5 + round 13 P2-2 symmetry).
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:main#agent:abc123',
      isHome: true,
      fallbackOwner: 'admin-1',
      messages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-2');
  });

  test('virtual #task: JID strips suffix → web:main gate matches', () => {
    // Symmetric to #agent: — task virtual JIDs would also be expected to
    // strip before the gate. (Tasks don't currently call this path but the
    // contract is the same; defensive against future call sites.)
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:main#task:xyz',
      isHome: true,
      fallbackOwner: 'admin-1',
      messages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-2');
  });

  test('fallback null when no override and no fallback', () => {
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: null,
      messages: [{ sender: '__system__' }],
      getUserById: lookup,
    });
    expect(owner).toBe(null);
  });

  test('fallback undefined preserved when no override', () => {
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:home-alice',
      isHome: true,
      fallbackOwner: undefined,
      messages: [],
      getUserById: lookup,
    });
    expect(owner).toBeUndefined();
  });
});

// ─── P2-2 integration: each of the three call sites uses the helper ─────────

/**
 * The three production call sites (main-conv cold-start, agent-conv
 * cold-start, active-IPC injection) all invoke `resolveAdminSharedRuntimeOwner`
 * with the same shape of args. If any of the three drifted again — e.g.
 * forgot to switch from `chatJid` to `virtualChatJid` — the gate would fail
 * silently. These integration tests exercise a "would the helper return X"
 * shape for each call site, mirroring the exact arg shape used in production.
 */
describe('runtime-owner helper — three integration touch-points', () => {
  const userTable: Record<string, RuntimeOwnerCandidateUser> = {
    'admin-1': { id: 'admin-1', status: 'active', role: 'admin' },
    'admin-2': { id: 'admin-2', status: 'active', role: 'admin' },
  };
  const lookup = (id: string) => userTable[id] ?? null;

  test('main-conv cold-start (src/index.ts ~2683): chatJid="web:main", group home', () => {
    // Mirrors the call inside processGroupMessages(chatJid='web:main')
    // immediately before buildExpandContext.
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-1',
      messages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-2');
  });

  test('agent-conv cold-start (src/index.ts ~5665): virtualChatJid="web:main#agent:<id>"', () => {
    // Mirrors the call inside processAgentConversation. The helper must
    // strip the agent suffix before applying the web:main gate.
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:main#agent:abc',
      isHome: true,
      fallbackOwner: 'admin-1',
      messages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-2');
  });

  test('active-IPC path (src/index.ts ~6641): chatJid="web:main", activeEffectiveGroup home', () => {
    // Mirrors the call inside processGroupMessages active-IPC branch.
    const owner = resolveAdminSharedRuntimeOwner({
      chatJid: 'web:main',
      isHome: true,
      fallbackOwner: 'admin-1',
      messages: [{ sender: 'admin-2' }],
      getUserById: lookup,
    });
    expect(owner).toBe('admin-2');
  });

  test('member home (web:home-bob) on any of the three paths → no override', () => {
    // Member workspaces are single-owner; the override gate must short-circuit.
    for (const chatJid of [
      'web:home-bob',
      'web:home-bob#agent:zz',
      'web:home-bob',
    ]) {
      const owner = resolveAdminSharedRuntimeOwner({
        chatJid,
        isHome: true,
        fallbackOwner: 'bob',
        messages: [{ sender: 'admin-2' }],
        getUserById: lookup,
      });
      expect(owner).toBe('bob');
    }
  });
});

// ─── P2-3: web handlers must use sibling-resolved effective group ───────────

/**
 * Shadow of the production resolveEffectiveGroup contract — the bits
 * web.ts depends on for plugin expansion. Mirrors src/index.ts:662.
 * (Reaching the production fn requires module-level `registeredGroups`
 * cache + DB; the contract test asserts the shape web.ts depends on.)
 */
interface RegisteredGroupShape {
  folder: string;
  is_home?: boolean;
  executionMode?: 'host' | 'container' | string | null;
  customCwd?: string | null;
  created_by?: string | null;
  target_main_jid?: string | null;
}

function resolveEffectiveGroup(
  group: RegisteredGroupShape,
  homeSibling: RegisteredGroupShape | null,
): { effectiveGroup: RegisteredGroupShape; isHome: boolean } {
  if (group.is_home) return { effectiveGroup: group, isHome: true };
  if (homeSibling) {
    return {
      effectiveGroup: {
        ...group,
        executionMode: homeSibling.executionMode,
        customCwd: homeSibling.customCwd || group.customCwd,
        created_by: group.created_by || homeSibling.created_by,
        is_home: true,
      },
      isHome: true,
    };
  }
  return { effectiveGroup: group, isHome: !!group.is_home };
}

interface ExpandCtxShape {
  ownerId: string;
  executionMode: 'host' | 'container';
  cwd: string;
}
function buildWebExpandContext(
  group: RegisteredGroupShape,
): ExpandCtxShape | null {
  if (!group.created_by) return null;
  const executionMode: 'host' | 'container' =
    (group.executionMode || 'container') === 'host' ? 'host' : 'container';
  const cwd =
    executionMode === 'host'
      ? group.customCwd || `/data/groups/${group.folder}`
      : '/workspace/group';
  return { ownerId: group.created_by, executionMode, cwd };
}

describe('handleWebUserMessage — #21 round-13 P2-3 must resolve effective group', () => {
  test('IM sibling without home semantics → raw group has no created_by → null', () => {
    const imSibling: RegisteredGroupShape = {
      folder: 'main',
      is_home: false,
      executionMode: null,
      customCwd: null,
      created_by: null,
    };
    const homeRow: RegisteredGroupShape = {
      folder: 'main',
      is_home: true,
      executionMode: 'host',
      customCwd: '/Users/admin/myrepo',
      created_by: 'admin-1',
    };

    expect(buildWebExpandContext(imSibling)).toBeNull();

    const { effectiveGroup } = resolveEffectiveGroup(imSibling, homeRow);
    const ctx = buildWebExpandContext(effectiveGroup);
    expect(ctx).not.toBeNull();
    expect(ctx!.ownerId).toBe('admin-1');
    expect(ctx!.executionMode).toBe('host');
    expect(ctx!.cwd).toBe('/Users/admin/myrepo');
  });

  test('home group itself → resolveEffectiveGroup is identity', () => {
    const homeRow: RegisteredGroupShape = {
      folder: 'main',
      is_home: true,
      executionMode: 'host',
      customCwd: '/Users/admin/myrepo',
      created_by: 'admin-1',
    };
    const { effectiveGroup, isHome } = resolveEffectiveGroup(homeRow, null);
    expect(isHome).toBe(true);
    expect(effectiveGroup).toBe(homeRow);
  });

  test('sibling with own customCwd preserved when home has none', () => {
    const sibling: RegisteredGroupShape = {
      folder: 'main',
      is_home: false,
      executionMode: null,
      customCwd: '/Users/admin/sibling-cwd',
      created_by: null,
    };
    const homeRow: RegisteredGroupShape = {
      folder: 'main',
      is_home: true,
      executionMode: 'host',
      customCwd: null,
      created_by: 'admin-1',
    };
    const { effectiveGroup } = resolveEffectiveGroup(sibling, homeRow);
    expect(effectiveGroup.customCwd).toBe('/Users/admin/sibling-cwd');
    expect(effectiveGroup.executionMode).toBe('host');
    expect(effectiveGroup.created_by).toBe('admin-1');
  });

  test('regression demo: raw sibling builds null ctx → /foo piped literal', () => {
    const sibling: RegisteredGroupShape = {
      folder: 'home-alice',
      is_home: false,
      executionMode: null,
      customCwd: null,
      created_by: null,
    };
    const homeRow: RegisteredGroupShape = {
      folder: 'home-alice',
      is_home: true,
      executionMode: 'container',
      customCwd: null,
      created_by: 'alice',
    };
    expect(buildWebExpandContext(sibling)).toBeNull();
    const { effectiveGroup } = resolveEffectiveGroup(sibling, homeRow);
    const ctx = buildWebExpandContext(effectiveGroup);
    expect(ctx).not.toBeNull();
    expect(ctx!.ownerId).toBe('alice');
    expect(ctx!.executionMode).toBe('container');
  });
});

describe('handleAgentConversationMessage — #21 round-13 P2-3 same fix on agent virtual JID', () => {
  test('agent virtual JID expands via parent group resolved against home sibling', () => {
    const parentImSibling: RegisteredGroupShape = {
      folder: 'main',
      is_home: false,
      executionMode: null,
      customCwd: null,
      created_by: null,
    };
    const homeRow: RegisteredGroupShape = {
      folder: 'main',
      is_home: true,
      executionMode: 'host',
      customCwd: '/Users/admin/myrepo',
      created_by: 'admin-1',
    };

    expect(buildWebExpandContext(parentImSibling)).toBeNull();

    const { effectiveGroup } = resolveEffectiveGroup(parentImSibling, homeRow);
    const ctx = buildWebExpandContext(effectiveGroup);
    expect(ctx).not.toBeNull();
    expect(ctx!.ownerId).toBe('admin-1');
    expect(ctx!.executionMode).toBe('host');
    expect(ctx!.cwd).toBe('/Users/admin/myrepo');
  });
});
