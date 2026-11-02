import { channelConversationJid } from './channel-address.js';
import type { RegisteredGroup } from './types.js';

/**
 * Resolve an IPC delivery target to its durable registered conversation.
 *
 * Provider-native routing fragments (for example Feishu thread/root) select
 * where a reply is delivered, but registered_groups stores the stable
 * conversation JID. Authorization must therefore use the stable JID while the
 * original route remains untouched for the connector call.
 */
export function resolveIpcDeliveryTargetGroup(
  chatJid: string,
  lookupGroup: (jid: string) => RegisteredGroup | undefined,
): RegisteredGroup | undefined {
  return lookupGroup(channelConversationJid(chatJid));
}
