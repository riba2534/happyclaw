import { describe, expect, test, vi } from 'vitest';

import { resolveFeishuCliBoundAccountId } from '../src/feishu-cli-runtime.js';
import type { ChannelTurnContext } from '../src/types.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

/**
 * Runs index.ts's real `injectPreparedFollowUp` and records the requirements
 * it hands the warm runner. A queued batch must require the Feishu CLI
 * identity a cold start would bind (the turn's Feishu account, else the
 * workspace's), never inherit whichever Bot started the container.
 */
function harness(options: {
  executionMode: 'container' | 'host';
  workspaceAccountId: string | null;
  channelContext: Partial<ChannelTurnContext> | undefined;
}) {
  const sendMessage = vi.fn(() => 'no_active');
  const item = {
    id: 'om_queued',
    chat_jid: 'web:workspace#agent:session-1',
    source_jid: 'tg:-100123',
  };
  const globals: Record<string, unknown> = {
    getQueuedFollowUp: () => item,
    resolveForwardBundleBatchAnchor: () => null,
    createIpcDeliveryTarget: () => null,
    resolveFollowUpRuntime: () => ({
      agentId: 'session-1',
      baseChatJid: 'web:workspace',
      effectiveGroup: {
        folder: 'flow-workspace',
        executionMode: options.executionMode,
        channel_account_id: options.workspaceAccountId,
      },
    }),
    resolveBatchChannelContext: () => options.channelContext,
    collectPersistedReferencedMessageIds: () => new Set<string>(),
    collectMessageImages: () => [],
    selectRuntimeInteractionBatch: () => ({
      messages: [{ id: item.id }],
      interactionMode: 'assistant',
      hasDeferredMessages: false,
    }),
    resolveTeamRole: () => null,
    getAgent: () => undefined,
    resolveFeishuCliBoundAccountId,
    formatMessages: () => '<messages/>',
    queue: { sendMessage },
    releaseQueuedFollowUpBatch: () => true,
    broadcastFollowUpBatchUpdate: () => undefined,
    enqueueReleasedFollowUp: () => undefined,
    Date,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const runtime = createRuntimeSourceHarness(globals);
  runtime.install('releaseFollowUpToColdReader');
  runtime.install('injectPreparedFollowUp');
  const inject = globals.injectPreparedFollowUp as (
    items: unknown[],
    prepared: { messages: unknown[]; replies: unknown[] },
    runId: string,
  ) => string;
  inject([item], { messages: [{ id: item.id }], replies: [] }, 'run-1');
  expect(sendMessage).toHaveBeenCalledTimes(1);
  const calls = sendMessage.mock.calls as unknown as unknown[][];
  return calls[0][calls[0].length - 1] as
    | { feishuCliAccountId?: string | null }
    | undefined;
}

describe('queued batch Feishu CLI identity', () => {
  test('a Telegram batch in a container requires the workspace Feishu account', () => {
    const requirements = harness({
      executionMode: 'container',
      workspaceAccountId: 'feishu-account-w',
      channelContext: { provider: 'telegram', channelAccountId: 'tg-account' },
    });
    expect(requirements).toMatchObject({
      feishuCliAccountId: 'feishu-account-w',
    });
  });

  test('a Feishu batch requires its own Bot account over the workspace one', () => {
    const requirements = harness({
      executionMode: 'container',
      workspaceAccountId: 'feishu-account-w',
      channelContext: {
        provider: 'feishu',
        channelAccountId: 'feishu-account-a',
      },
    });
    expect(requirements).toMatchObject({
      feishuCliAccountId: 'feishu-account-a',
    });
  });

  test('a host-mode batch requires no Feishu CLI identity', () => {
    const requirements = harness({
      executionMode: 'host',
      workspaceAccountId: 'feishu-account-w',
      channelContext: { provider: 'telegram', channelAccountId: 'tg-account' },
    });
    expect(requirements).toMatchObject({ feishuCliAccountId: null });
  });
});
