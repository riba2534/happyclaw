/**
 * Host channel-turn settlement. Where the logic is a standalone production
 * function (or a closure inside `main`) it runs through the runtime-source
 * harness against explicit dependencies. A few assertions remain on source
 * text: they pin wiring that lives deep inside the 1000-line main/agent run
 * loops, whose own helpers are covered behaviourally elsewhere
 * (channel-reliability-host-guards, channel-delivery-failure,
 * feishu-scoped-text-delivery, terminal-system-notice, host-im-command-scope).
 */
import fs from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import {
  channelConversationJid,
  parseChannelAddress,
} from '../src/channel-address.js';
import { getChannelType } from '../src/im-channel.js';
import { classifyImSendFailure } from '../src/im-send-retry-policy.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const main = fs.readFileSync('src/index.ts', 'utf8');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function between(start: string, end: string, from = 0): string {
  const startIndex = main.indexOf(start, from);
  const endIndex = main.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return main.slice(startIndex, endIndex);
}

describe('retry_wait is never left for a consumed input (prod P1-2)', () => {
  test('the periodic sweep cancels retry_wait Turns older than the bound', () => {
    const cancelStaleRetryWaitChannelTurns = vi.fn(() => 2);
    // Which inputs a usage-limit wait keeps: usage-limit-wait-park.
    const globals: Record<string, unknown> = {
      logger,
      cancelStaleRetryWaitChannelTurns,
      listPendingUsageLimitWaits: () => [],
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('CHANNEL_RETRY_WAIT_TURN_MAX_AGE_MS');
    harness.install('runStaleRetryWaitTurnSweep', 'main');
    const before = Date.now();
    (globals.runStaleRetryWaitTurnSweep as () => void)();
    expect(cancelStaleRetryWaitChannelTurns).toHaveBeenCalledTimes(1);
    const [{ updatedBefore }] = cancelStaleRetryWaitChannelTurns.mock
      .calls[0] as unknown as [{ updatedBefore: string }];
    const age = before - Date.parse(updatedBefore);
    expect(age).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000 - 1000);
    expect(age).toBeLessThanOrEqual(6 * 60 * 60 * 1000 + 1000);
    // A failing store never throws out of the timer.
    cancelStaleRetryWaitChannelTurns.mockImplementation(() => {
      throw new Error('db busy');
    });
    expect(() =>
      (globals.runStaleRetryWaitTurnSweep as () => void)(),
    ).not.toThrow();
  });

  test('cancelling a queued input closes only its own channel-scoped Turn', () => {
    const cancelRetryWaitChannelTurnsForInputs = vi.fn(() => 1);
    const globals: Record<string, unknown> = {
      logger,
      cancelQueuedFollowUp: vi.fn(() => ({
        id: 'om_q',
        source_jid: 'feishu:oc_chat#account:bot-1',
        delivery_run_id: 'run-1',
      })),
      broadcastFollowUpUpdate: vi.fn(),
      clearStandaloneProcessingIndicator: vi.fn(async () => {}),
      getChannelType,
      parseChannelAddress,
      channelConversationJid,
      registeredGroups: {},
      getRegisteredGroup: () => undefined,
      cancelRetryWaitChannelTurnsForInputs,
      listQueuedFollowUps: () => [],
      endUsageLimitWait: vi.fn(),
    };
    const harness = createRuntimeSourceHarness(globals);
    for (const name of [
      'channelTurnScopeForInput',
      'closeRetryWaitTurnsForWithdrawnInputs',
      'settleCancelledFollowUp',
      'cancelFollowUp',
    ]) {
      harness.install(name);
    }
    const result = (globals.cancelFollowUp as (...a: unknown[]) => any)(
      'web:ws#agent:session-1',
      'om_q',
    );
    expect(result.ok).toBe(true);
    expect(cancelRetryWaitChannelTurnsForInputs).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'feishu',
        accountId: 'bot-1',
        agentId: 'session-1',
        correlationIds: ['om_q'],
      }),
    );
    // The last queued input gone: a usage-limit wait has nothing to resume.
    expect(globals.endUsageLimitWait).toHaveBeenCalledWith(
      'web:ws#agent:session-1',
      'cancelled',
    );
  });

  test('a legacy route without an account fragment uses the chat account; unknown routes close nothing', () => {
    const globals: Record<string, unknown> = {
      parseChannelAddress,
      channelConversationJid,
      registeredGroups: {
        'feishu:oc_legacy': { channel_account_id: 'legacy-bot' },
      },
      getRegisteredGroup: () => undefined,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('channelTurnScopeForInput');
    const scopeFor = globals.channelTurnScopeForInput as (
      logical: string,
      source: string | null,
    ) => unknown;
    const session = 'web:ws#agent:session-1';
    expect(scopeFor(session, 'feishu:oc_legacy#thread:omt')).toEqual({
      provider: 'feishu',
      accountId: 'legacy-bot',
      agentId: 'session-1',
    });
    expect(scopeFor(session, 'feishu:oc_unbound')).toBeNull();
    expect(scopeFor(session, 'web:ws')).toBeNull();
    expect(scopeFor(session, null)).toBeNull();
    // A workspace JID names no session, so it has no Turn scope.
    expect(scopeFor('web:ws', 'feishu:oc_legacy#thread:omt')).toBeNull();
  });

  test('the session loop cancels a Turn whose cursor already committed (loop wiring)', () => {
    const agentStart = main.indexOf('async function processAgentConversation(');
    const agentBranch = main.slice(
      main.indexOf('} else if (isCursorCommitted(inputTurnId)) {', agentStart),
    );
    expect(agentBranch.indexOf('runtime.cancel(')).toBeGreaterThan(0);
    expect(agentBranch.indexOf('runtime.cancel(')).toBeLessThan(
      agentBranch.indexOf('runtime.retry('),
    );
  });
});

describe('retry_wait Outbox rows are rejections, not uncertainty (outbound P1-5)', () => {
  test('ScopedChannelDeliveryError maps failed and retry_wait to rejected', () => {
    const globals: Record<string, unknown> = {};
    const harness = createRuntimeSourceHarness(globals);
    harness.install('ScopedChannelDeliveryError');
    const Scoped = globals.ScopedChannelDeliveryError as new (
      status: string,
      message: string,
    ) => Error & { deliveryPhase: string };
    for (const status of ['failed', 'retry_wait']) {
      const error = new Scoped(status, 'refused');
      expect(error.deliveryPhase).toBe('rejected');
      expect(classifyImSendFailure(error)).toBe('rejected');
    }
    for (const status of ['uncertain', 'busy', 'lease_lost']) {
      expect(classifyImSendFailure(new Scoped(status, 'x'))).toBe('uncertain');
    }
  });
});

describe('streaming card lifecycle (prod P2-9, outbound P2-8; loop wiring)', () => {
  test('a reservation without a created session is rolled back', () => {
    expect(main).toMatch(
      /if \(!agentStreamingSession && activeAgentDurableCardLifecycle\) \{[\s\S]{0,400}agentChannelTurnRuntime\?\.rollbackUnpublishedStreamingCardReservation\(\)/,
    );
  });

  test('a new input finalizes an active card before disposing it', () => {
    const rotation = between(
      'const previousAgentSession = agentStreamingSession;',
      'previousAgentSession?.dispose();',
    );
    expect(rotation).toContain(
      'unregisterStreamingSession(streamingSessionJid, previousAgentSession)',
    );
    expect(rotation).toContain(".abort('新消息已开始')");
  });

  test('every streaming session release is compare-and-delete', () => {
    const calls = main.match(/unregisterStreamingSession\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      expect(call).toMatch(
        /unregisterStreamingSession\(\s*[^,]+,\s*[^,)]+,?\s*\)/,
      );
    }
  });
});

describe('inbound wiring', () => {
  test('Feishu connections receive the recall callback', () => {
    expect(
      main.match(/onMessageRecalled: handleChannelMessageRecalled/g),
    ).toHaveLength(1);
  });

  test('IM downloads resolve from the Agent working directory', async () => {
    const path = await import('node:path');
    const { GROUPS_DIR } = await import('../src/config.js');
    const { resolveWorkspaceProjectRoot } =
      await import('../src/session-worktree.js');
    const { agentIdOfJid } = await import('../src/utils.js');
    const groups: Record<string, any> = {
      'web:host-cwd': {
        folder: 'host-cwd',
        executionMode: 'host',
        customCwd: '/srv/project',
      },
      'web:host-default': { folder: 'host-default', executionMode: 'host' },
      'web:container': {
        folder: 'container',
        executionMode: 'container',
        customCwd: '/ignored',
      },
    };
    const globals: Record<string, unknown> = {
      registeredGroups: groups,
      getRegisteredGroup: (jid: string) => groups[jid],
      findWebJidForFolder: (folder: string) => `web:${folder}`,
      resolveEffectiveGroup: (group: unknown) => ({ effectiveGroup: group }),
      resolveWorkspaceProjectRoot,
      agentIdOfJid,
      path,
      GROUPS_DIR,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('agentWorkingRoot');
    harness.install('imDownloadRoot');
    harness.installCallArgument(
      'downloadRootResolver',
      'main',
      'setImDownloadRootResolver',
      0,
    );
    const resolve = globals.downloadRootResolver as (
      folder: string,
      routeJid: string,
    ) => string | undefined;
    expect(resolve('host-cwd', 'web:host-cwd')).toBe('/srv/project');
    expect(resolve('host-default', 'web:host-default')).toBe(
      path.join(GROUPS_DIR, 'host-default'),
    );
    expect(resolve('container', 'web:container')).toBe(
      path.join(GROUPS_DIR, 'container'),
    );
    expect(resolve('missing', 'web:missing')).toBe(
      path.join(GROUPS_DIR, 'missing'),
    );
  });
});

describe('card follow-ups (outbound review)', () => {
  test('tool output in the card timeline is escaped and cut on code points', async () => {
    const { escapeFeishuPanelInline } =
      await import('../src/feishu-cards/sections.js');
    const events: string[] = [];
    const globals: Record<string, unknown> = { escapeFeishuPanelInline };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('feedStreamEventToCard');
    const session = {
      getToolInfo: () => ({ name: 'Bash' }),
      pushRecentEvent: (line: string) => events.push(line),
    };
    (globals.feedStreamEventToCard as (...args: unknown[]) => void)(
      session,
      {
        eventType: 'tool_result',
        toolUseId: 't1',
        toolResult: '<at id=all></at> line1\nline2 | </font>',
      },
      '',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).not.toContain('<at');
    expect(events[0]).not.toContain('</font> line');
    expect(events[0]).not.toContain('\n');
    expect(events[0]).toContain('&#124;');
  });
});

describe('refused card body fallback (outbound P1-4, cross-review M3; loop wiring)', () => {
  test('only a terminalized refused card gets a static copy, marked before the send', () => {
    // The decision itself (cardTerminalized gate, uncertain otherwise) is
    // feishuCardStaticFallbackText/classifyImSendFailure, tested in
    // channel-delivery-failure.test.ts against the real card error.
    const agentBranch = between(
      'const refusedAgentCardText = cardCompleted',
      'Agent conversation: static IM message sent',
    );
    expect(
      agentBranch.indexOf('markStreamingCardStaticFallbackDelivered()'),
    ).toBeLessThan(
      agentBranch.indexOf('const agentStaticTextDelivered = await'),
    );
    expect(agentBranch).toMatch(
      /agentStaticTextDelivered = await sendImWithRetry\(\s+outputAgentReplySourceJid,\s+agentStaticFallbackText,/,
    );
  });
});
