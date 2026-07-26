import { getChannelType } from './im-channel.js';
import { channelConversationJid } from './channel-address.js';

/**
 * A Web surface may inject input into an IM-owned session, but it never
 * changes transport ownership. Likewise, a later message observed through a
 * second IM connector cannot silently move an existing session to that Bot.
 *
 * Ownership is held at conversation granularity — provider, external chat and
 * channel account — not at thread granularity. Within one conversation the
 * reply anchor still follows the current message: freezing the whole route on
 * the first message meant a session whose first inbound happened to carry a
 * `root_id` kept answering into that one thread forever, including for later
 * top-level messages. Crossing to a different conversation, account or provider
 * still keeps the original owner.
 */
export function resolveStickyChannelOwner(
  currentOwnerJid: string | null,
  incomingSourceJid: string | null,
): string | null {
  const incomingIsChannel = Boolean(
    incomingSourceJid && getChannelType(incomingSourceJid),
  );
  if (currentOwnerJid && getChannelType(currentOwnerJid)) {
    if (
      incomingIsChannel &&
      channelConversationJid(currentOwnerJid) ===
        channelConversationJid(incomingSourceJid!)
    ) {
      return incomingSourceJid;
    }
    return currentOwnerJid;
  }
  return incomingIsChannel ? incomingSourceJid : null;
}
