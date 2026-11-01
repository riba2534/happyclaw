import { vi } from 'vitest';

import { agentBuilderTurnScope } from '../../src/agent-builder-turn-auth.js';
import { channelConversationJid } from '../../src/channel-address.js';
import * as channelInteraction from '../../src/channel-interaction-mode.js';
import { selectChannelReplyBatch } from '../../src/channel-reply-source.js';
import { resolveScheduledGroupDeliveryContract } from '../../src/reply-delivery.js';
import type { NewMessage } from '../../src/types.js';
import * as interactionRuntime from '../../src/workspace-interaction-runtime.js';
import { createRuntimeSourceHarness } from './runtime-source.js';

/** Thrown at IPC admission: everything after it is the agent turn. */
const STOP = Symbol('stop-before-agent-turn');

/**
 * The production processAgentConversation from the group lookup through
 * input selection. The caller supplies the database
 * functions (and anything else its runs read) in `globals`. A run stops when
 * its batch is published for IPC admission.
 */
export function createConversationLoop(input: {
  chatJid: string;
  agentId: string;
  folder: string;
  globals: Record<string, unknown>;
}) {
  const { chatJid, agentId } = input;
  const owner = 'processAgentConversation';
  const queue = { enqueueTask: vi.fn() };
  const globals: Record<string, any> = {
    ...interactionRuntime,
    ...channelInteraction,
    channelConversationJid,
    selectChannelReplyBatch,
    resolveScheduledGroupDeliveryContract,
    agentBuilderTurnScope,
    registeredGroups: {
      [chatJid]: { folder: input.folder, name: input.folder },
    },
    lastAgentTimestamp: {},
    lastCommittedCursor: {},
    EMPTY_CURSOR: { timestamp: '', id: '', sequence: 0 },
    resolveEffectiveGroup: (group: unknown) => ({ effectiveGroup: group }),
    getAgent: (id: string) =>
      id === agentId
        ? { id, kind: 'conversation', status: 'idle', name: id }
        : undefined,
    getRegisteredGroup: () => undefined,
    getWorkspaceInteractionMode: () => 'assistant',
    getChannelMount: () => undefined,
    queue,
    createIpcDeliveryTarget: (_jid: string, messages: NewMessage[]) => {
      globals.admittedBatch = messages;
      throw STOP;
    },
    ...input.globals,
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'isCursorAfter',
    'resolveTrustedInteractionMode',
    'selectRuntimeInteractionBatch',
    owner,
  ]) {
    harness.install(name);
  }
  return {
    globals,
    harness,
    queue,
    owner,
    /** One scheduler round: the batch the turn would take, or null. */
    async round(): Promise<NewMessage[] | null> {
      globals.admittedBatch = null;
      try {
        await globals.processAgentConversation(chatJid, agentId);
      } catch (err) {
        if (err !== STOP) throw err;
      }
      return globals.admittedBatch as NewMessage[] | null;
    },
  };
}
