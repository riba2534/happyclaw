import { describe, expect, test, vi } from 'vitest';

import { createChannelInboundRouter } from '../src/channel-inbound-routing.js';
import { buildNativeThreadRouteJid } from '../src/channel-native-context.js';
import type {
  ChannelMessageMeta,
  RegisteredGroup,
  SubAgent,
} from '../src/types.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const FORUM = 'telegram:-100777';
const WORKSPACE = 'web:workspace';

const topic = (id: string): ChannelMessageMeta => ({
  provider: 'telegram',
  nativeContextType: 'thread',
  contextId: id,
  threadId: id,
  rootId: id,
  messageId: `m-${id}`,
});

/**
 * Runs index.ts's real `buildLookupEffectiveChatJid` (the router runtime
 * controls resolve their target with) over the real inbound router. The
 * creating dependencies throw: a lookup must never reach them.
 */
function lookupHarness(forum: Partial<RegisteredGroup>) {
  const groups = new Map<string, RegisteredGroup>([
    [
      WORKSPACE,
      {
        name: 'Workspace',
        folder: 'workspace',
        created_by: 'owner',
        added_at: '2026-10-27',
      },
    ],
    [
      FORUM,
      {
        name: 'Forum',
        folder: 'workspace',
        created_by: 'owner',
        added_at: '2026-10-27',
        target_main_jid: WORKSPACE,
        native_context_type: 'thread',
        ...forum,
      } as RegisteredGroup,
    ],
  ]);
  const agents = new Map<string, SubAgent>();
  const bindings = new Map<string, { agent_id: string }>();
  const globals: Record<string, unknown> = {
    createChannelInboundRouter,
    buildNativeThreadRouteJid,
    registeredGroups: {},
    getRegisteredGroup: (jid: string) => groups.get(jid),
    getAgent: (id: string) => agents.get(id),
    getChannelMount: () => undefined,
    resolveWorkspaceJid: (jid: string) => (groups.has(jid) ? jid : null),
    getImContextBinding: (jid: string, type: string, id: string) =>
      bindings.get(`${jid}|${type}|${id}`),
    ensureNativeContextChannelMount: vi.fn(() => {
      throw new Error('a lookup upgraded a mount');
    }),
    resolveOrCreateNativeThreadAgent: vi.fn(() => {
      throw new Error('a lookup created a topic Session');
    }),
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'channelInboundRoutingDeps',
    'findNativeThreadAgent',
    'buildLookupEffectiveChatJid',
  ]) {
    harness.install(name);
  }
  const lookup = (
    globals.buildLookupEffectiveChatJid as () => (
      jid: string,
      meta?: ChannelMessageMeta,
    ) => unknown
  )();
  return {
    lookup,
    globals,
    addTopicSession(threadId: string, agentId: string, chatJid = WORKSPACE) {
      agents.set(agentId, {
        id: agentId,
        chat_jid: chatJid,
        kind: 'conversation',
      } as SubAgent);
      bindings.set(`${FORUM}|thread|${threadId}`, { agent_id: agentId });
    },
  };
}

describe('the runtime-control route lookup', () => {
  test('a topic without a Session has no target, and none is created', () => {
    const h = lookupHarness({ binding_mode: 'thread_map' });
    expect(h.lookup(FORUM, topic('77'))).toBeNull();
    expect(h.globals.resolveOrCreateNativeThreadAgent).not.toHaveBeenCalled();
  });

  test("a topic's existing Session is its target", () => {
    const h = lookupHarness({ binding_mode: 'thread_map' });
    h.addTopicSession('77', 't77');
    expect(h.lookup(FORUM, topic('77'))).toEqual({
      effectiveJid: `${WORKSPACE}#agent:t77`,
      agentId: 't77',
      sourceJid: buildNativeThreadRouteJid(FORUM, '77', '77'),
    });
  });

  test('a Session moved to another workspace is not the topic target', () => {
    const h = lookupHarness({ binding_mode: 'thread_map' });
    h.addTopicSession('77', 't77', 'web:elsewhere');
    expect(h.lookup(FORUM, topic('77'))).toBeNull();
  });

  test('a forum not yet mapped to topics has no topic target', () => {
    const h = lookupHarness({});
    h.addTopicSession('77', 't77');
    expect(h.lookup(FORUM, topic('77'))).toBeNull();
    expect(h.globals.ensureNativeContextChannelMount).not.toHaveBeenCalled();
  });

  test('an ordinary group resolves to its bound Session; a workspace binding has none', () => {
    const h = lookupHarness({ native_context_type: undefined });
    expect(h.lookup(FORUM)).toBeNull();
    const bound = lookupHarness({
      native_context_type: undefined,
      target_main_jid: undefined,
      target_agent_id: 'bound',
    });
    bound.addTopicSession('unused', 'bound');
    expect(bound.lookup(FORUM)).toEqual({
      effectiveJid: `${WORKSPACE}#agent:bound`,
      agentId: 'bound',
    });
  });
});
