import { describe, expect, test, vi } from 'vitest';

import { resolveIpcDeliveryTargetGroup } from '../src/ipc-delivery-routing.js';
import type { RegisteredGroup } from '../src/types.js';

function makeGroup(): RegisteredGroup {
  return {
    name: 'target',
    folder: 'flow-x',
    added_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('IPC delivery target authorization lookup', () => {
  test('uses the stable Feishu conversation JID for a native topic route', () => {
    const baseJid = 'feishu:oc_topic_group';
    const target = makeGroup();
    const lookup = vi.fn((jid: string) =>
      jid === baseJid ? target : undefined,
    );

    expect(
      resolveIpcDeliveryTargetGroup(
        `${baseJid}#thread:omt_topic#root:om_root`,
        lookup,
      ),
    ).toBe(target);
    expect(lookup).toHaveBeenCalledWith(baseJid);
  });

  test('preserves the channel account scope while removing route fragments', () => {
    const baseJid = 'feishu:oc_topic_group#account:bot-a';
    const target = makeGroup();
    const lookup = vi.fn((jid: string) =>
      jid === baseJid ? target : undefined,
    );

    expect(
      resolveIpcDeliveryTargetGroup(
        'feishu:oc_topic_group#account:bot-a#thread:omt_topic#root:om_root',
        lookup,
      ),
    ).toBe(target);
    expect(lookup).toHaveBeenCalledWith(baseJid);
  });

  test('removes a virtual Agent suffix from a Web conversation lookup', () => {
    const target = makeGroup();
    const lookup = vi.fn((jid: string) =>
      jid === 'web:workspace' ? target : undefined,
    );

    expect(
      resolveIpcDeliveryTargetGroup('web:workspace#agent:agent-a', lookup),
    ).toBe(target);
    expect(lookup).toHaveBeenCalledWith('web:workspace');
  });
});
