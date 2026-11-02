import type { TeamRole } from './work-items.js';

/**
 * Whether the next input may take over background work from the input that
 * started it, in the same SDK stream. Handing over moves the work's summary
 * and every later request of its sub-agents to the next input, so that must
 * not change where the summary goes or what the sub-agents may do. Anything
 * refused here keeps waiting in the durable queue.
 */
export interface BackgroundHandoffInput {
  /** The IM route the reply goes to; null for a Web-only input. */
  route: string | null;
  /** Automation, work item or other input with no person waiting on it. */
  unattended: boolean;
  /** Every input of the batch is the workspace owner's own. */
  ownerAlone: boolean;
}

export function backgroundHandoffRefusal(input: {
  teamRole: TeamRole | null | undefined;
  runtimeKind: string;
  held: BackgroundHandoffInput;
  next: BackgroundHandoffInput;
  /** The held input's reply can be settled now without new text. */
  heldReplySettleable: boolean;
}): string | null {
  if (input.teamRole) return 'team_session';
  if (input.runtimeKind !== 'conversation') return 'not_a_conversation';
  if (input.held.unattended) return 'held_unattended';
  if (!input.heldReplySettleable) return 'held_reply_not_delivered';
  if (input.next.unattended) return 'next_unattended';
  if (input.next.route !== input.held.route) return 'different_route';
  if (input.next.ownerAlone !== input.held.ownerAlone) {
    return 'different_authority';
  }
  return null;
}
