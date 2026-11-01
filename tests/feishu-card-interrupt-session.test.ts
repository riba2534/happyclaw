import { describe, expect, test, vi } from 'vitest';

import { channelConversationJid } from '../src/channel-address.js';
import { resolveBoundChatTarget } from '../src/im-command-utils.js';
import { getChannelType } from '../src/im-channel.js';
import { stripVirtualJidSuffix } from '../src/utils.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

/**
 * Runs index.ts's real `handleCardInterrupt`, Session resolution and queue
 * serialization key. A card is keyed by its reply route — a reply inside a
 * topic carries `#thread:`/`#root:` — and an IM chat keeps its owner's home
 * folder after it is bound to another workspace, so the stop button must
 * reach the bound Session's running query and nothing else.
 */
const registeredGroups: Record<string, Record<string, unknown>> = {
  'web:home': { folder: 'home', name: 'Home' },
  'web:proj': { folder: 'proj', name: 'Proj' },
  // Ordinary group bound to session `g1` of `proj`.
  'feishu:oc_group': { folder: 'home', target_agent_id: 'g1' },
  // Topic group bound to `proj`; each topic has its own Session.
  'feishu:oc_topics': { folder: 'home', target_main_jid: 'web:proj' },
};
const agents: Record<string, { chat_jid: string; name: string }> = {
  a1: { chat_jid: 'web:proj', name: 'topic one' },
  a2: { chat_jid: 'web:proj', name: 'topic two' },
  g1: { chat_jid: 'web:proj', name: 'group session' },
};

function harness(activeRunnerJid: string) {
  const abort = vi.fn(async () => undefined);
  const interruptQuery = vi.fn();
  const globals: Record<string, unknown> = {
    registeredGroups,
    getRegisteredGroup: (jid: string) => registeredGroups[jid],
    getAgent: (id: string) => agents[id],
    findGroupNameByFolder: (folder: string) => folder,
    resolveWorkspaceJid: (jid: string) => jid,
    resolveBoundChatTarget,
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

  test('stops the bound session answering inside a thread', () => {
    const { handle } = harness('web:proj#agent:g1');
    expect(
      handle('feishu:oc_group#thread:omt_1#root:om_1#agent:g1', 'ou_owner'),
    ).toMatchObject({ ok: true });
  });

  test('a card without a session address stops nothing, not the workspace', () => {
    const { handle, abort } = harness('web:proj');
    expect(
      handle('feishu:oc_group#thread:omt_1#root:om_1', 'ou_owner'),
    ).toEqual(ENDED);
    expect(handle('feishu:oc_group', 'ou_owner')).toEqual(ENDED);
    expect(abort).not.toHaveBeenCalled();
  });

  test("never stops the chat's home workspace instead", () => {
    const { handle, abort } = harness('web:home');
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
    const { handle } = harness('web:proj');
    expect(
      handle('feishu:oc_topics#thread:omt_1#root:om_1#agent:gone', 'ou_owner'),
    ).toEqual(ENDED);
  });
});
