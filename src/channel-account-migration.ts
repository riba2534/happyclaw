import crypto from 'node:crypto';
import type { ChannelAccount, ChannelProvider } from './types.js';
import {
  createChannelAccount,
  getDefaultChannelAccount,
  getAllRegisteredGroups,
  getLegacyChannelAccount,
  setRegisteredGroup,
  updateChannelAccount,
  updateChannelAccountAuthStatus,
} from './db.js';
import { getChannelFromJid } from './channel-prefixes.js';
import { parseChannelAddress } from './channel-address.js';
import {
  channelAccountSecretRef,
  deleteChannelAccountSecret,
  loadChannelAccountSecret,
  saveChannelAccountSecret,
  type ChannelAccountSecret,
} from './channel-account-secrets.js';

export function ensureLegacyDefaultChannelAccount(input: {
  ownerUserId: string;
  provider: ChannelProvider;
  name: string;
  secret: ChannelAccountSecret;
  enabled: boolean;
}): ChannelAccount {
  const backfillLegacyBindings = (account: ChannelAccount): ChannelAccount => {
    for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
      if (
        group.created_by !== input.ownerUserId ||
        group.channel_account_id ||
        getChannelFromJid(jid) !== input.provider ||
        parseChannelAddress(jid)?.legacy !== true
      ) {
        continue;
      }
      setRegisteredGroup(jid, {
        ...group,
        channel_account_id: account.id,
      });
    }
    return account;
  };

  const existing = getLegacyChannelAccount(input.ownerUserId, input.provider);
  if (existing) return backfillLegacyBindings(existing);
  const currentDefault = getDefaultChannelAccount(
    input.ownerUserId,
    input.provider,
  );
  const id = crypto.randomUUID();
  const secretRef = channelAccountSecretRef(id);
  saveChannelAccountSecret(secretRef, input.secret);
  try {
    return backfillLegacyBindings(
      createChannelAccount({
        id,
        owner_user_id: input.ownerUserId,
        provider: input.provider,
        name: input.name,
        secret_ref: secretRef,
        enabled: input.enabled,
        is_default: currentDefault == null,
        is_legacy_default: true,
        auth_mode:
          input.provider === 'wechat' || input.provider === 'whatsapp'
            ? 'qr_session'
            : input.provider === 'telegram' || input.provider === 'discord'
              ? 'bot_token'
              : 'credentials',
        auth_status: 'authorized',
      }),
    );
  } catch (error) {
    deleteChannelAccountSecret(secretRef);
    throw error;
  }
}

/**
 * Account options edited in the channel-account settings. A legacy config
 * holds at most a copy from when it seeded the account, and the legacy routes
 * resave that copy on every write, so a legacy save cannot tell a change from
 * a stale value: an account that has the option keeps its own.
 */
const ACCOUNT_OPTION_KEYS: Partial<Record<ChannelProvider, readonly string[]>> =
  {
    feishu: ['domain'],
    telegram: ['streamingMode'],
    dingtalk: ['streamingMode'],
    discord: ['streamingMode'],
  };

/**
 * Compatibility write path for old /api/config/user-im/:provider routes. The
 * legacy config replaces the credentials it manages; the account's own
 * options survive.
 */
export function syncDefaultChannelAccountCredentials(input: {
  ownerUserId: string;
  provider: ChannelProvider;
  name: string;
  secret: ChannelAccountSecret;
  enabled: boolean;
}): ChannelAccount {
  const account = ensureLegacyDefaultChannelAccount(input);
  const current = loadChannelAccountSecret(account.secret_ref);
  const secret: ChannelAccountSecret = { ...input.secret };
  for (const key of ACCOUNT_OPTION_KEYS[input.provider] ?? []) {
    if (current?.[key] !== undefined) secret[key] = current[key];
  }
  saveChannelAccountSecret(account.secret_ref, secret);
  updateChannelAccountAuthStatus(account.id, 'authorized');
  return (
    updateChannelAccount(account.id, input.ownerUserId, {
      enabled: input.enabled,
    }) ?? account
  );
}

/**
 * The legacy global Feishu config carries credentials only, and
 * syncDefaultChannelAccountCredentials replaces the whole secret. Carry the
 * auto-learned bot owner forward so a re-save does not let the next DM
 * re-claim the bot. Feishu open_ids are per app, so a new appId drops it.
 */
export function mergeLegacyFeishuOwner(
  ownerUserId: string,
  secret: ChannelAccountSecret,
): ChannelAccountSecret {
  const existing = getLegacyChannelAccount(ownerUserId, 'feishu');
  if (!existing || secret.ownerOpenId) return secret;
  let previous: ChannelAccountSecret | null;
  try {
    previous = loadChannelAccountSecret(existing.secret_ref);
  } catch {
    // An unreadable secret is about to be replaced; don't block the re-save.
    return secret;
  }
  if (!previous?.ownerOpenId || previous.appId !== secret.appId) return secret;
  return { ...secret, ownerOpenId: previous.ownerOpenId };
}
