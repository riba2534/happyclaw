import { jidNormalizedUser } from 'baileys';

import {
  ownerImIdFromPersistedSender,
  type AgentBuilderPersistedInput,
} from './agent-builder-turn-auth.js';
import {
  channelConversationJid,
  parseChannelAddress,
} from './channel-address.js';

/**
 * Claim sources the host records itself, so the IM id they hold is the
 * owner's own: set in the channel configuration, learned from a paired or
 * bound direct chat, or the Feishu bot account's configured owner. Never
 * `explicit` (any member may first-claim an unowned group with
 * /owner_mention) or `transfer_reset` (credential-transfer quarantine).
 */
export const OWNER_IDENTITY_CLAIM_SOURCES: readonly string[] = [
  'configured',
  'trusted_direct',
  'auto_feishu',
];

export interface OwnerIdentityRegistration {
  jid: string;
  created_by?: string;
  channel_account_id?: string | null;
  owner_im_id?: string;
  owner_claim_source?: string;
}

export interface WorkspaceOwnerIdentityLookup {
  /** The workspace owner (`created_by` of the workspace). */
  ownerUserId: string;
  /** The registration of a conversation JID, whoever created it. */
  registration: (
    jid: string,
  ) => Omit<OwnerIdentityRegistration, 'jid'> | undefined;
  /** Every chat registration the owner created, in any of their workspaces. */
  ownerRegistrations: () => readonly OwnerIdentityRegistration[];
}

/**
 * The provider and channel account (bot) a registered chat belongs to. IM ids
 * are compared only within one account: a Feishu open_id is per app, so the
 * same value under another bot is not the same person. A legacy unscoped chat
 * with no stored account keeps the provider's legacy slot.
 */
function channelAccountKey(
  jid: string,
  row: Pick<OwnerIdentityRegistration, 'channel_account_id'>,
): string | null {
  const address = parseChannelAddress(jid);
  if (!address) return null;
  const accountId = address.channelAccountId ?? row.channel_account_id ?? '';
  return `${address.provider}\u0000${accountId}`;
}

/**
 * Whether the workspace owner themself sent this input. A Web input is the
 * owner's when its sender is the owner's user id. An IM input is when its
 * chat is the owner's own registration and its sender is an IM identity the
 * host recorded for the owner (OWNER_IDENTITY_CLAIM_SOURCES) on a chat the
 * owner registered under the same channel account. Which workspace those
 * chats are registered or bound to plays no part: a paired direct chat bound
 * to a session of another workspace is the owner there too. Group members are
 * judged by their own sender id, never by the chat they write in.
 */
export function isWorkspaceOwnerInput(
  input: Pick<AgentBuilderPersistedInput, 'sender' | 'source_jid'>,
  lookup: WorkspaceOwnerIdentityLookup,
): boolean {
  const { ownerUserId } = lookup;
  if (!ownerUserId || !input.sender) return false;
  const sourceJid = input.source_jid;
  if (!sourceJid || sourceJid.startsWith('web:')) {
    return input.sender === ownerUserId;
  }
  const conversationJid = channelConversationJid(sourceJid);
  const source = lookup.registration(conversationJid);
  if (source?.created_by !== ownerUserId) return false;
  const account = channelAccountKey(conversationJid, source);
  const senderImId = ownerImIdFromPersistedSender(sourceJid, input.sender);
  if (!account || !senderImId) return false;
  const canonical =
    parseChannelAddress(sourceJid)?.provider === 'whatsapp'
      ? jidNormalizedUser
      : (id: string) => id;
  return lookup
    .ownerRegistrations()
    .some(
      (row) =>
        row.created_by === ownerUserId &&
        !!row.owner_im_id &&
        !!row.owner_claim_source &&
        OWNER_IDENTITY_CLAIM_SOURCES.includes(row.owner_claim_source) &&
        channelAccountKey(row.jid, row) === account &&
        canonical(row.owner_im_id) === senderImId,
    );
}
