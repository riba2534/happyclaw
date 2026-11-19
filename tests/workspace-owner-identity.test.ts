import { describe, expect, test } from 'vitest';

import {
  isWorkspaceOwnerInput,
  type OwnerIdentityRegistration,
} from '../src/workspace-owner-identity.js';

const OWNER = 'owner-1';
const OTHER_USER = 'user-2';
const HOME = 'home-owner';

/**
 * Registrations as the host writes them: discovery and pairing record every
 * chat under the account's default workspace (here Home), and binding a chat
 * to a session only sets target_agent_id. The folder never follows the bind.
 */
const rows: Array<
  OwnerIdentityRegistration & { folder: string; channel_account_id?: string }
> = [
  {
    jid: 'web:ws-b',
    folder: 'ws-b',
    created_by: OWNER,
  },
  // The owner's own Telegram direct chat, paired, bound to a session of ws-b.
  {
    jid: 'telegram:111#account:tg-a',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'tg-a',
    owner_im_id: '111',
    owner_claim_source: 'trusted_direct',
  },
  // A Telegram group of the same bot, bound to a session of ws-b.
  {
    jid: 'telegram:-1001#account:tg-a',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'tg-a',
  },
  // The owner's second Telegram bot: nobody recorded as owner there.
  {
    jid: 'telegram:-1002#account:tg-b',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'tg-b',
  },
  // A Feishu group whose owner the host read from the bot configuration.
  {
    jid: 'feishu:oc_group#account:fs-a',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'fs-a',
    owner_im_id: 'ou_owner',
    owner_claim_source: 'auto_feishu',
  },
  // A legacy topic group that never captured its owner.
  {
    jid: 'feishu:oc_topic#account:fs-a',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'fs-a',
  },
  // Another Feishu app of the owner, nobody recorded as owner there.
  {
    jid: 'feishu:oc_other_app#account:fs-b',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'fs-b',
  },
  // Chats of other providers, under ids equal to the owner's on Telegram and
  // Feishu.
  {
    jid: 'dingtalk:cid_group#account:fs-a',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'fs-a',
  },
  {
    jid: 'discord:2001#account:dc-a',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'dc-a',
  },
  // Claims the host did not record never vouch.
  {
    jid: 'feishu:oc_claimed#account:fs-a',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'fs-a',
    owner_im_id: 'ou_claimer',
    owner_claim_source: 'explicit',
  },
  {
    jid: 'telegram:333#account:tg-a',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'tg-a',
    owner_im_id: '333',
    owner_claim_source: 'transfer_reset',
  },
  // Another user's direct chat with their own bot.
  {
    jid: 'telegram:222#account:tg-other',
    folder: 'home-user-2',
    created_by: OTHER_USER,
    channel_account_id: 'tg-other',
    owner_im_id: '222',
    owner_claim_source: 'trusted_direct',
  },
  // A row another user left on the owner's bot (e.g. before a credential
  // transfer).
  {
    jid: 'telegram:223#account:tg-a',
    folder: 'home-user-2',
    created_by: OTHER_USER,
    channel_account_id: 'tg-a',
    owner_im_id: '223',
    owner_claim_source: 'trusted_direct',
  },
  // WhatsApp: the stored owner may carry a device suffix.
  {
    jid: 'whatsapp:8613800000000@s.whatsapp.net#account:wa-a',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'wa-a',
    owner_im_id: '8613800000000:12@s.whatsapp.net',
    owner_claim_source: 'configured',
  },
  // Legacy unscoped chats keep their JID; the account is on the row.
  {
    jid: 'telegram:444',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'tg-legacy',
    owner_im_id: '444',
    owner_claim_source: 'trusted_direct',
  },
  {
    jid: 'telegram:-1003',
    folder: HOME,
    created_by: OWNER,
    channel_account_id: 'tg-legacy',
  },
];

const byJid = new Map(rows.map((row) => [row.jid, row]));

function lookup(
  overrides: Partial<Parameters<typeof isWorkspaceOwnerInput>[1]> = {},
) {
  return {
    ownerUserId: OWNER,
    registration: (jid: string) => byJid.get(jid),
    ownerRegistrations: () => rows.filter((row) => row.created_by === OWNER),
    ...overrides,
  };
}

const isOwner = (
  sender: string | null,
  source_jid: string | null,
  overrides: Partial<Parameters<typeof isWorkspaceOwnerInput>[1]> = {},
) => isWorkspaceOwnerInput({ sender, source_jid }, lookup(overrides));

describe('whether the workspace owner sent an input', () => {
  test('on the Web, by user id', () => {
    expect(isOwner(OWNER, 'web:ws-b#agent:s1')).toBe(true);
    expect(isOwner(OWNER, null)).toBe(true);
    expect(isOwner(OTHER_USER, 'web:ws-b#agent:s1')).toBe(false);
    expect(isOwner(null, 'web:ws-b')).toBe(false);
    expect(isOwner('', 'web:ws-b', { ownerUserId: '' })).toBe(false);
  });

  test("the owner's own paired direct chat, whichever workspace it is bound to", () => {
    expect(isOwner('tg:111', 'telegram:111#account:tg-a')).toBe(true);
  });

  test('the owner speaking in a group is judged by sender; members never count', () => {
    expect(isOwner('tg:111', 'telegram:-1001#account:tg-a')).toBe(true);
    expect(isOwner('tg:999', 'telegram:-1001#account:tg-a')).toBe(false);
    expect(isOwner('ou_owner', 'feishu:oc_group#account:fs-a')).toBe(true);
    expect(isOwner('ou_member', 'feishu:oc_group#account:fs-a')).toBe(false);
    // A topic group that never captured its owner: the owner's identity on
    // the same bot still vouches, in a topic route too.
    expect(
      isOwner('ou_owner', 'feishu:oc_topic#account:fs-a#thread:t1#root:r1'),
    ).toBe(true);
  });

  test('identities are compared per provider, across the owner’s bots', () => {
    // The same IM id under the owner's other bot of the provider: the owner,
    // as the folder-based rule had it (one human, one Telegram id).
    expect(isOwner('tg:111', 'telegram:-1002#account:tg-b')).toBe(true);
    expect(isOwner('ou_owner', 'feishu:oc_other_app#account:fs-b')).toBe(true);
    // The same value on another provider is not.
    expect(isOwner('discord:111', 'discord:2001#account:dc-a')).toBe(false);
    expect(
      isOwner('dingtalk:ou_owner', 'dingtalk:cid_group#account:fs-a'),
    ).toBe(false);
  });

  test('only identities the host recorded vouch', () => {
    expect(isOwner('ou_claimer', 'feishu:oc_claimed#account:fs-a')).toBe(false);
    expect(isOwner('tg:333', 'telegram:333#account:tg-a')).toBe(false);
  });

  test("another user's chats and identities never count", () => {
    // Their own direct chat: not a registration of this owner.
    expect(isOwner('tg:222', 'telegram:222#account:tg-other')).toBe(false);
    // Even handed the other user's rows on the same bot, only the owner's
    // rows vouch.
    expect(
      isOwner('tg:223', 'telegram:-1001#account:tg-a', {
        ownerRegistrations: () => rows,
      }),
    ).toBe(false);
    // The owner's identity in a chat another user registered.
    expect(isOwner('tg:111', 'telegram:222#account:tg-other')).toBe(false);
    // An unknown chat fails closed.
    expect(isOwner('tg:111', 'telegram:-9999#account:tg-a')).toBe(false);
  });

  test('legacy unscoped chats count like any other chat of the provider', () => {
    expect(isOwner('tg:444', 'telegram:-1003')).toBe(true);
    expect(isOwner('tg:444', 'telegram:-1001#account:tg-a')).toBe(true);
    expect(isOwner('tg:111', 'telegram:-1003')).toBe(true);
    expect(isOwner('tg:999', 'telegram:-1003')).toBe(false);
  });

  test('WhatsApp ids are compared canonically', () => {
    expect(
      isOwner(
        'whatsapp:8613800000000:7@s.whatsapp.net',
        'whatsapp:8613800000000@s.whatsapp.net#account:wa-a',
      ),
    ).toBe(true);
    expect(
      isOwner(
        'whatsapp:8613900000000@s.whatsapp.net',
        'whatsapp:8613800000000@s.whatsapp.net#account:wa-a',
      ),
    ).toBe(false);
  });

  test('a malformed sender fails closed', () => {
    expect(isOwner('111', 'telegram:111#account:tg-a')).toBe(false);
    expect(isOwner(null, 'telegram:111#account:tg-a')).toBe(false);
  });
});
