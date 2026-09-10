import type { FollowUpMode } from './types.js';

/**
 * No channel exposes a persistent composer mode switch. Ordinary messages
 * always follow the safe default queue. Only an explicit, host-parsed command
 * may request steer; replying to an Agent card is still an ordinary reply.
 */
export function resolveFollowUpMode(
  requestedMode: FollowUpMode | undefined,
): FollowUpMode {
  return requestedMode ?? 'queue';
}

export type RuntimeControl =
  | { kind: 'steer'; text: string }
  | { kind: 'clear' }
  | { kind: 'break' }
  | { kind: 'fresh'; notes: string };

/**
 * Parse the small runtime control surface after the connector has structurally
 * proved the message may drive it -- a real Bot mention in groups, or a direct
 * conversation. Commands are deliberately case-sensitive, matching the
 * reference runtime: lookalikes and commands with extra `/break` arguments
 * remain ordinary input.
 */
export function parseRuntimeControl(input: {
  commandText: string;
  eligible: boolean;
  hasAttachments: boolean;
}): RuntimeControl | undefined {
  if (!input.eligible) return undefined;
  const commandText = input.commandText.trim();
  if (!input.hasAttachments && commandText === '/clear') {
    return { kind: 'clear' };
  }
  if (!input.hasAttachments && commandText === '/break') {
    return { kind: 'break' };
  }
  if (!input.hasAttachments) {
    const fresh = commandText.match(/^\/fresh(?:\s+([\s\S]*))?$/);
    if (fresh) {
      return { kind: 'fresh', notes: (fresh[1] ?? '').trim() };
    }
  }
  const followUp = commandText.match(/^\/steer\s+([\s\S]*\S)$/);
  if (!followUp) return undefined;
  return {
    kind: 'steer',
    text: followUp[1].trim(),
  };
}

/** Keep invalid/case-variant control lookalikes out of the generic IM command handler. */
export function isRuntimeControlLike(commandText: string): boolean {
  // `/queue` remains a lookalike only so legacy text bypasses the generic
  // slash-command interceptor and reaches the Agent as ordinary default-queued
  // input. It is intentionally not parsed as a runtime control above.
  return /^\/(?:queue|steer|break|clear|fresh)(?:\s|$)/i.test(
    commandText.trim(),
  );
}
