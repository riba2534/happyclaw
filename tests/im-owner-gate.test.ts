import { describe, expect, test } from 'vitest';

import {
  OWNER_REQUIRED_IM_COMMANDS,
  checkImOwnerCommand,
  isDirectMessageJid,
} from '../src/im-command-utils';

const OWNER = 'ou_owner_123';
const STRANGER = 'ou_stranger_456';
const OWNED_GROUP = { owner_im_id: OWNER };
const UNOWNED_GROUP = { owner_im_id: null };

describe('OWNER_REQUIRED_IM_COMMANDS set', () => {
  test('locks destructive commands only', () => {
    expect([...OWNER_REQUIRED_IM_COMMANDS].sort()).toEqual([
      'bind',
      'clear',
      'new',
      'release_owner',
      'spawn',
      'sw',
      'unbind',
    ]);
  });

  test('excludes /owner_mention so unowned groups can bootstrap', () => {
    expect(OWNER_REQUIRED_IM_COMMANDS.has('owner_mention')).toBe(false);
  });

  test('excludes /require_mention (settings toggle, has its own guard)', () => {
    expect(OWNER_REQUIRED_IM_COMMANDS.has('require_mention')).toBe(false);
  });

  test('excludes read-only utilities', () => {
    for (const cmd of ['list', 'ls', 'status', 'recall', 'rc', 'where', 'allowlist']) {
      expect(OWNER_REQUIRED_IM_COMMANDS.has(cmd)).toBe(false);
    }
  });
});

describe('checkImOwnerCommand', () => {
  test('non-owner-required command always allowed', () => {
    expect(checkImOwnerCommand('list', null, undefined)).toEqual({ ok: true });
    expect(checkImOwnerCommand('status', UNOWNED_GROUP, undefined)).toEqual({
      ok: true,
    });
    expect(checkImOwnerCommand('owner_mention', UNOWNED_GROUP, STRANGER)).toEqual({
      ok: true,
    });
  });

  test('owner-required command: missing senderImId denied with channel-unsupported reason', () => {
    const r = checkImOwnerCommand('clear', OWNED_GROUP, undefined);
    expect(r).toEqual({
      ok: false,
      reason: '该通道暂不支持此命令（缺少发送者身份）',
    });
  });

  test('owner-required command: group has no owner → ask to use /owner_mention', () => {
    const r = checkImOwnerCommand('clear', UNOWNED_GROUP, STRANGER);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('/owner_mention');
    }
  });

  test('owner-required command: senderImId mismatches owner denied with owner-only reason', () => {
    const r = checkImOwnerCommand('clear', OWNED_GROUP, STRANGER);
    expect(r).toEqual({ ok: false, reason: '只有工作区 owner 才能执行此命令' });
  });

  test('owner-required command: senderImId equals owner allowed', () => {
    expect(checkImOwnerCommand('clear', OWNED_GROUP, OWNER)).toEqual({ ok: true });
    expect(checkImOwnerCommand('bind', OWNED_GROUP, OWNER)).toEqual({ ok: true });
    expect(checkImOwnerCommand('spawn', OWNED_GROUP, OWNER)).toEqual({ ok: true });
  });

  test('null/undefined group treated as unowned (bootstrap message)', () => {
    const r1 = checkImOwnerCommand('clear', null, OWNER);
    const r2 = checkImOwnerCommand('clear', undefined, OWNER);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain('/owner_mention');
    if (!r2.ok) expect(r2.reason).toContain('/owner_mention');
  });
});

describe('isDirectMessageJid', () => {
  test('DM jids → true', () => {
    expect(isDirectMessageJid('qq:c2c:user_openid_abc')).toBe(true);
    expect(isDirectMessageJid('dingtalk:c2c:staff123')).toBe(true);
    expect(isDirectMessageJid('discord:dm:8675309')).toBe(true);
    expect(isDirectMessageJid('whatsapp:15551234567@s.whatsapp.net')).toBe(true);
    expect(isDirectMessageJid('wechat:wxid_abc123')).toBe(true);
    // Telegram private chats have positive ids
    expect(isDirectMessageJid('telegram:123456789')).toBe(true);
  });

  test('group jids → false (no auto-claim in groups)', () => {
    expect(isDirectMessageJid('qq:group:group_openid_xyz')).toBe(false);
    expect(isDirectMessageJid('dingtalk:cidAbc123==')).toBe(false);
    expect(isDirectMessageJid('discord:998877665544')).toBe(false);
    expect(isDirectMessageJid('whatsapp:120363012345678901@g.us')).toBe(false);
    // Telegram groups/supergroups have negative ids
    expect(isDirectMessageJid('telegram:-1001234567890')).toBe(false);
    expect(isDirectMessageJid('telegram:-100')).toBe(false);
  });

  test('feishu never auto-claims (own owner-learn path) → false', () => {
    expect(isDirectMessageJid('feishu:oc_p2p_chat')).toBe(false);
    expect(isDirectMessageJid('feishu:oc_group_chat')).toBe(false);
  });

  test('web + unknown + malformed telegram → false (safe default)', () => {
    expect(isDirectMessageJid('web:home-42')).toBe(false);
    expect(isDirectMessageJid('something-weird')).toBe(false);
    expect(isDirectMessageJid('telegram:notanumber')).toBe(false);
    expect(isDirectMessageJid('telegram:')).toBe(false);
  });
});
