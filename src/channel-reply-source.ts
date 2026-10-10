import { getChannelType } from './im-channel.js';
import {
  resolveCompatibleChannelBatchAnchor,
  resolveForwardBundleBatchAnchor,
} from './forward-bundle-batch.js';
import type { NewMessage } from './types.js';

/** Reply transport belongs to an input, never to a workspace or old session. */
export function resolveInputChannelReplySource(
  sourceJid: string | null | undefined,
): string | null {
  return sourceJid && getChannelType(sourceJid) ? sourceJid : null;
}

function messageRouteKey(message: NewMessage): string {
  const context = message.channel_context;
  return [
    message.source_jid || message.chat_jid,
    context?.provider || '',
    context?.channelAccountId || '',
    context?.chat.id || '',
    context?.message.threadId || '',
    context?.message.rootId || '',
  ].join('\u0000');
}

/**
 * A turn has one reply destination. Keep later channels/topics behind the
 * durable cursor rather than merging their prompts and replying to just one.
 * Structurally linked forwarded content and its author's note stay together.
 */
export function selectChannelReplyBatch<T extends NewMessage>(
  messages: T[],
): T[] {
  if (messages.length < 2) return messages;
  const firstRoute = messageRouteKey(messages[0]);
  // Same-route prefixes are tracked incrementally: re-deriving every key of
  // every candidate prefix was O(n²) and froze the event loop for minutes on
  // a recovered backlog (4k messages: 1.5s; 50k: >3min). The anchor resolvers
  // only run once the prefix mixes routes, exactly as before.
  let sameRoute = true;
  let end = 1;
  while (end < messages.length) {
    sameRoute = sameRoute && messageRouteKey(messages[end]) === firstRoute;
    if (sameRoute) {
      end += 1;
      continue;
    }
    const candidate = messages.slice(0, end + 1);
    if (
      resolveForwardBundleBatchAnchor(candidate) ||
      resolveCompatibleChannelBatchAnchor(candidate)
    ) {
      end += 1;
    } else {
      break;
    }
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

export function resolveBatchChannelReplySource(
  messages: NewMessage[],
): string | null {
  if (messages.length === 0) return null;
  if (selectChannelReplyBatch(messages).length !== messages.length) return null;
  const anchor =
    resolveForwardBundleBatchAnchor(messages) ??
    resolveCompatibleChannelBatchAnchor(messages);
  return resolveInputChannelReplySource(
    anchor?.context.sourceJid ||
      messages[messages.length - 1].source_jid ||
      messages[messages.length - 1].chat_jid,
  );
}

/** A Web admission explicitly owns null; a later input cannot borrow the initial route. */
export function resolveOutputChannelReplySource(input: {
  inputTurnId: string;
  initialInputTurnId: string;
  initialSourceJid: string | null;
  scopeSourceJid?: string;
  admittedInput?: { imJid: string | null };
}): string | null {
  if (input.scopeSourceJid !== undefined) return input.scopeSourceJid;
  if (input.admittedInput) return input.admittedInput.imJid;
  return input.inputTurnId === input.initialInputTurnId
    ? input.initialSourceJid
    : null;
}
