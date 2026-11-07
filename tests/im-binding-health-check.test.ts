import { describe, expect, test, vi } from 'vitest';

import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

type Reachability = 'reachable' | 'gone' | 'unknown' | undefined;

/**
 * The real checkImBindingsHealth from src/index.ts, over one bound Feishu
 * group whose probe answers come from `answers`, one per check.
 */
function healthCheck(answers: Reachability[]) {
  const jid = 'feishu:oc_bound';
  const removeImGroupRecord = vi.fn();
  const globals: Record<string, unknown> = {
    registeredGroups: {
      [jid]: { folder: 'ws', target_agent_id: 'agent-1' },
    },
    getRegisteredGroup: () => undefined,
    getAgent: () => ({ id: 'agent-1' }),
    unbindImGroup: vi.fn(),
    imManager: { probeChat: vi.fn(async () => answers.shift()) },
    imHealthCheckFailCounts: new Map<string, number>(),
    IM_HEALTH_CHECK_FAIL_THRESHOLD: 3,
    removeImGroupRecord,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('checkImBindingsHealth');
  const check = globals.checkImBindingsHealth as () => Promise<void>;
  return {
    async run(times: number) {
      for (let i = 0; i < times; i += 1) await check();
    },
    removeImGroupRecord,
  };
}

describe('IM binding health check', () => {
  test('an unreachable Feishu (inconclusive probes) never removes a binding', async () => {
    const h = healthCheck(Array(10).fill('unknown'));
    await h.run(10);
    expect(h.removeImGroupRecord).not.toHaveBeenCalled();
  });

  test('three answers that the chat is gone remove it', async () => {
    const h = healthCheck(['gone', 'gone', 'gone']);
    await h.run(2);
    expect(h.removeImGroupRecord).not.toHaveBeenCalled();
    await h.run(1);
    expect(h.removeImGroupRecord).toHaveBeenCalledTimes(1);
    expect(h.removeImGroupRecord.mock.calls[0]?.[0]).toBe('feishu:oc_bound');
  });

  test('inconclusive probes neither count nor reset; a reachable one resets', async () => {
    const spaced = healthCheck(['gone', 'unknown', 'gone', 'unknown', 'gone']);
    await spaced.run(5);
    expect(spaced.removeImGroupRecord).toHaveBeenCalledTimes(1);

    const reset = healthCheck(['gone', 'gone', 'reachable', 'gone', 'gone']);
    await reset.run(5);
    expect(reset.removeImGroupRecord).not.toHaveBeenCalled();
  });

  test('a channel that cannot probe is skipped', async () => {
    const h = healthCheck(Array(5).fill(undefined));
    await h.run(5);
    expect(h.removeImGroupRecord).not.toHaveBeenCalled();
  });
});
