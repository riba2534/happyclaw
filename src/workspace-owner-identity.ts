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
const OWNER_IDENTITY_CLAIM_SOURCES: readonly string[] = [
  'configured',
  'trusted_direct',
  'auto_feishu',
];

/**
 * Providers whose sender ids are unique only inside one organization: a WeCom
 * userid (often the member's pinyin) and a DingTalk staffId or senderId belong
 * to the enterprise or app the bot was created in, so two bots in two
 * enterprises may see the same value for two people.
 */
const ACCOUNT_SCOPED_PROVIDERS: ReadonlySet<string> = new Set([
  'wecom',
  'dingtalk',
]);

export interface OwnerIdentityRegistration {
  jid: string;
  folder?: string;
  created_by?: string;
  channel_account_id?: string | null;
  owner_im_id?: string;
  owner_claim_source?: string;
}

export interface WorkspaceOwnerIdentityLookup {
  /** The workspace owner (`created_by` of the workspace). */
  ownerUserId: string;
  /** Folder of the workspace the turn runs in. */
  workspaceFolder: string;
  /** Folder of the owner's Home workspace, when they have one. */
  homeFolder: string | null | undefined;
  /** The registration of a conversation JID, whoever created it. */
  registration: (
    jid: string,
  ) => Omit<OwnerIdentityRegistration, 'jid'> | undefined;
  /** Every chat registration the owner created, in any of their workspaces. */
  ownerRegistrations: () => readonly OwnerIdentityRegistration[];
}

/**
 * Where an IM id names one person. Most providers compare within the provider,
 * across the owner's channel accounts, as the folder-based rule did: the
 * sender comes from the platform and cannot be forged, ids issued per app
 * (Feishu open_id, QQ openid) never collide across apps, and one human's
 * global id (Telegram, Discord, WhatsApp) stays the owner on every bot of the
 * owner's. ACCOUNT_SCOPED_PROVIDERS compare within one channel account; a
 * legacy unscoped chat with no stored account keeps the provider's legacy slot.
 */
function identityScope(
  jid: string,
  row: Pick<OwnerIdentityRegistration, 'channel_account_id'>,
): string | null {
  const address = parseChannelAddress(jid);
  if (!address) return null;
  if (!ACCOUNT_SCOPED_PROVIDERS.has(address.provider)) return address.provider;
  const accountId = address.channelAccountId ?? row.channel_account_id ?? '';
  return `${address.provider}\u0000${accountId}`;
}

/**
 * Whether the workspace owner themself sent this input. A Web input is the
 * owner's when its sender is the owner's user id. An IM input is when its
 * chat is the owner's own registration and its sender is an IM identity the
 * host recorded for the owner (OWNER_IDENTITY_CLAIM_SOURCES) on a chat the
 * owner registered to their Home workspace or to this workspace, in the same
 * identity scope.
 *
 * Discovery and pairing register a chat under its account's default workspace
 * (Home unless the account names another) and binding it to a session never
 * moves it, so the owner's paired direct chat stays on Home wherever it is
 * bound: Home's identities count in every workspace. Identities registered to
 * another workspace W (an account defaulting to W) count only in W, as before.
 * Group members are judged by their own sender id, never by the chat they
 * write in.
 */
export function isWorkspaceOwnerInput(
  input: Pick<AgentBuilderPersistedInput, 'sender' | 'source_jid'>,
  lookup: WorkspaceOwnerIdentityLookup,
): boolean {
  const { ownerUserId, workspaceFolder, homeFolder } = lookup;
  if (!ownerUserId || !input.sender) return false;
  const sourceJid = input.source_jid;
  if (!sourceJid || sourceJid.startsWith('web:')) {
    return input.sender === ownerUserId;
  }
  const conversationJid = channelConversationJid(sourceJid);
  const source = lookup.registration(conversationJid);
  if (source?.created_by !== ownerUserId) return false;
  const scope = identityScope(conversationJid, source);
  const senderImId = ownerImIdFromPersistedSender(sourceJid, input.sender);
  if (!scope || !senderImId) return false;
  const canonical =
    parseChannelAddress(conversationJid)?.provider === 'whatsapp'
      ? jidNormalizedUser
      : (id: string) => id;
  return lookup
    .ownerRegistrations()
    .some(
      (row) =>
        row.created_by === ownerUserId &&
        !!row.folder &&
        (row.folder === workspaceFolder || row.folder === homeFolder) &&
        !!row.owner_im_id &&
        !!row.owner_claim_source &&
        OWNER_IDENTITY_CLAIM_SOURCES.includes(row.owner_claim_source) &&
        identityScope(row.jid, row) === scope &&
        canonical(row.owner_im_id) === senderImId,
    );
}
