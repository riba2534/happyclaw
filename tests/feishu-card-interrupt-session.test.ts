import { describe, expect, test, vi } from 'vitest';

import { channelConversationJid } from '../src/channel-address.js';
import { getChannelType } from '../src/im-channel.js';
import { agentIdOfJid, stripVirtualJidSuffix } from '../src/utils.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

/**
 * Runs index.ts's real `handleCardInterrupt`, Session resolution and queue
 * serialization key. A card is keyed by its reply route plus the Session it
 * answers for (`…#agent:<id>`) — a reply inside a topic carries
 * `#thread:`/`#root:` — and an IM chat keeps its owner's home folder after it
 * is bound to another workspace, so the stop button must reach that Session's
 * running query and nothing else.
 */
const registeredGroups: Record<string, Record<string, unknown>> = {
  'web:home': { folder: 'home', name: 'Home' },
  'web:proj': { folder: 'proj', name: 'Proj' },
  // Ordinary group bound to Session s1 of `proj`.
  'feishu:oc_group': { folder: 'home', target_agent_id: 's1' },
  // Topic group bound to `proj`; each topic has its own Session.
  'feishu:oc_topics': {
    folder: 'home',
    binding_mode: 'thread_map',
    target_main_jid: 'web:proj',
  },
};
const agents: Record<string, { chat_jid: string; name: string }> = {
  a1: { chat_jid: 'web:proj', name: 'topic one' },
  a2: { chat_jid: 'web:proj', name: 'topic two' },
  s1: { chat_jid: 'web:proj', name: 'group session' },
};

function harness(activeRunnerJid: string) {
  const abort = vi.fn(async () => undefined);
  const interruptQuery = vi.fn();
  const globals: Record<string, unknown> = {
    registeredGroups,
    getRegisteredGroup: (jid: string) => registeredGroups[jid],
    getAgent: (id: string) => agents[id],
    agentIdOfJid,
    channelConversationJid,
    stripVirtualJidSuffix,
    getChannelType,
    isSenderAllowedInGroup: () => true,
    getStreamingSession: (jid: string) =>
      jid.startsWith('feishu:') ? { isActive: () => true, abort } : undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
  const runtime = createRuntimeSourceHarness(globals);
  runtime.install('queueSerializationKey');
  const key = globals.queueSerializationKey as (jid: string) => string;
  // Like GroupQueue: a JID reaches the active runner sharing its key.
  interruptQuery.mockImplementation(
    (jid: string) => key(jid) === key(activeRunnerJid),
  );
  globals.queue = { interruptQuery };
  runtime.install('runtimeJidOfSession');
  runtime.install('cardSessionJid');
  runtime.install('handleCardInterrupt');
  const handle = globals.handleCardInterrupt as (
    cardJid: string,
    operator: string,
  ) => { ok: boolean; message: string };
  return { handle, abort, interruptQuery };
}

const ENDED = { ok: false, message: '当前回复已经结束，无需中断。' };

describe('Feishu stop button', () => {
  test('stops a topic Session of the workspace the group is bound to', () => {
    const { handle, abort, interruptQuery } = harness('web:proj#agent:a1');
    expect(
      handle('feishu:oc_topics#thread:omt_1#root:om_1#agent:a1', 'ou_owner'),
    ).toMatchObject({ ok: true });
    expect(abort).toHaveBeenCalledWith('已停止');
    // The stop button is an explicit stop, not a steer.
    expect(interruptQuery).toHaveBeenCalledWith(
      'web:proj#agent:a1',
      undefined,
      'stop',
    );
  });

  test('stops the bound Session answering in a group, inside a thread too', () => {
    const { handle } = harness('web:proj#agent:s1');
    expect(
      handle('feishu:oc_group#thread:omt_1#root:om_1#agent:s1', 'ou_owner'),
    ).toMatchObject({ ok: true });
    expect(handle('feishu:oc_group#agent:s1', 'ou_owner')).toMatchObject({
      ok: true,
    });
  });

  test('a card without a Session names nothing to stop', () => {
    const { handle, abort } = harness('web:proj#agent:s1');
    expect(
      handle('feishu:oc_group#thread:omt_1#root:om_1', 'ou_owner'),
    ).toEqual(ENDED);
    expect(handle('feishu:oc_group', 'ou_owner')).toEqual(ENDED);
    expect(abort).not.toHaveBeenCalled();
  });

  test('never stops another Session of the same workspace', () => {
    const { handle, abort } = harness('web:proj#agent:a2');
    expect(
      handle('feishu:oc_topics#thread:omt_1#root:om_1#agent:a1', 'ou_owner'),
    ).toEqual(ENDED);
    expect(abort).not.toHaveBeenCalled();
  });

  test('a card whose Session is gone stops nothing', () => {
    const { handle } = harness('web:proj#agent:a1');
    expect(
      handle('feishu:oc_topics#thread:omt_1#root:om_1#agent:gone', 'ou_owner'),
    ).toEqual(ENDED);
  });
});
