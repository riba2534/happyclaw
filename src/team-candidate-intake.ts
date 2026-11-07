import { readTeamInput } from './team-gate.js';
import type { NewMessage } from './types.js';
import type { TeamCandidateIntakeSettings } from './work-items.js';

export type TeamCandidateIntakePlan =
  | { kind: 'bypass'; messages: NewMessage[] }
  | { kind: 'wait'; messages: NewMessage[]; waitMs: number }
  | { kind: 'admit' | 'discard'; messages: NewMessage[]; reason: string };

const ACK =
  /^(?:收到|好[的哒]?|嗯+|哦+|谢谢(?:你)?|感谢|了解|明白|可以|没问题|ok(?:ay)?|thanks?|thank you|1|\+1)[\s!！。.,，~～]*$/iu;
const MAX_BATCH_CHARS = 32000;

function usefulText(text: string): string {
  const trimmed = text.trim();
  return ACK.test(trimmed) || !/[\p{L}\p{N}]/u.test(trimmed) ? '' : trimmed;
}

function inferred(message: NewMessage): boolean {
  const header = readTeamInput(message.attachments);
  return (
    header?.tag === 'team_candidate' && header.facts?.strength === 'inferred'
  );
}

function routeKey(message: NewMessage): string {
  const context = message.channel_context;
  return JSON.stringify([
    message.chat_jid,
    message.source_jid,
    context?.channelAccountId,
    context?.chat.id,
    context?.message.threadId,
    context?.message.rootId,
  ]);
}

function hasMaterial(message: NewMessage): boolean {
  // Never reject a picture, file, or structured quote because its placeholder
  // lacks a keyword. It still goes through the model's existing team rules.
  if (message.channel_context?.message.referencedMessages?.length) return true;
  try {
    const items: unknown = JSON.parse(message.attachments ?? '[]');
    return (
      Array.isArray(items) &&
      items.some(
        (item) =>
          item && typeof item === 'object' && item.type !== 'team_input',
      )
    );
  } catch {
    return true;
  }
}

/**
 * Plan the oldest compatible prefix of durable inputs. No timer owns the
 * messages: after a restart the same rows produce the same bounded plan.
 * Each message keeps its identity/mandate; only invocation timing is batched.
 */
export function planTeamCandidateIntake(
  messages: NewMessage[],
  settings: TeamCandidateIntakeSettings | undefined,
  now = Date.now(),
): TeamCandidateIntakePlan {
  const first = messages[0];
  if (!settings?.enabled || !first || !inferred(first))
    return { kind: 'bypass', messages };
  const key = routeKey(first);
  const frozenIds = readTeamInput(first.attachments)?.facts?.candidateBatchIds;
  if (
    frozenIds?.length &&
    frozenIds.length <= 50 &&
    frozenIds[0] === first.id
  ) {
    const frozen = messages.slice(0, frozenIds.length);
    if (
      frozen.every(
        (message, index) =>
          message.id === frozenIds[index] &&
          inferred(message) &&
          routeKey(message) === key,
      )
    ) {
      return { kind: 'admit', messages: frozen, reason: 'replay' };
    }
  }
  const batch: NewMessage[] = [];
  let chars = 0;
  for (const message of messages) {
    if (!inferred(message) || routeKey(message) !== key) break;
    if (
      batch.length >= settings.maxMessages ||
      (batch.length > 0 && chars + message.content.length > MAX_BATCH_CHARS)
    )
      break;
    batch.push(message);
    chars += message.content.length;
  }
  const received = batch.map((message) => {
    const recorded = readTeamInput(message.attachments)?.facts?.receivedAt;
    const time =
      typeof recorded === 'number' ? recorded : Date.parse(message.timestamp);
    return Number.isFinite(time) && time <= now
      ? time
      : now - settings.maxWaitMs;
  });
  const waitMs =
    Math.min(
      Math.max(...received) + settings.quietMs,
      Math.min(...received) + settings.maxWaitMs,
    ) - now;
  // A different route or an explicit request is a barrier: flush the earlier
  // prefix now, without making the explicit request wait for unrelated chatter.
  if (
    waitMs > 0 &&
    batch.length === messages.length &&
    batch.length < settings.maxMessages &&
    chars < MAX_BATCH_CHARS
  )
    return { kind: 'wait', messages: batch, waitMs };
  if (batch.some(hasMaterial))
    return { kind: 'admit', messages: batch, reason: 'material' };
  const meaningful = batch.filter((message) => usefulText(message.content));
  if (meaningful.length === 0)
    return { kind: 'discard', messages: batch, reason: 'noise' };
  if (
    meaningful.some((message) => {
      const sender = readTeamInput(message.attachments)?.facts?.senderImId;
      return !!sender && settings.prioritySenderIds.includes(sender);
    })
  )
    return { kind: 'admit', messages: batch, reason: 'priority_sender' };
  const text = meaningful
    .map((message) => message.content)
    .join('\n')
    .toLocaleLowerCase();
  const matched = settings.keywords.some((keyword) =>
    text.includes(keyword.toLocaleLowerCase()),
  );
  return {
    kind: matched ? 'admit' : 'discard',
    messages: batch,
    reason: matched ? 'keyword' : 'no_signal',
  };
}
