import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('channel binding REST contract', () => {
  test('workspace and settings routes share mount builders and restore-default', () => {
    const agents = read('src/routes/agents.ts');
    const config = read('src/routes/config.ts');

    for (const source of [agents, config]) {
      expect(source).toContain('restoreDefaultChannelMount(');
      expect(source).toContain(
        "threadCapable ? 'thread_map' : 'single_session'",
      );
      expect(source).toContain(
        'Native thread containers can only bind to a workspace',
      );
      expect(source).toContain('conversationBindingPolicyError(');
    }
  });

  test('restore-default fails atomically when neither account default nor home exists', () => {
    const service = read('src/channel-mount-service.ts');
    const agents = read('src/routes/agents.ts');
    const config = read('src/routes/config.ts');

    expect(service).toMatch(
      /if \(!workspaceJid\)[\s\S]*getHome\(effectiveOwner\)[\s\S]*missing_default_workspace/,
    );
    expect(agents).toContain(
      'Channel account has no default or owner home workspace',
    );
    expect(config).toContain(
      'Channel account has no default or owner home workspace',
    );
    expect(service).toMatch(
      /if \(resolved\.status !== 'resolved'\) return resolved;[\s\S]*commitChannelMountUpdate/,
    );
  });

  test('settings UI classifies binding targets by direct-vs-group identity', () => {
    const section = read('web/src/components/settings/BindingsSection.tsx');
    const dialog = read('web/src/components/settings/BindingTargetDialog.tsx');

    expect(section).toContain(
      '!(item.bound_session_id ?? item.bound_agent_id)',
    );
    expect(section).toContain(
      'Boolean(item.bound_session_id ?? item.bound_agent_id)',
    );
    expect(section).toContain(
      "rebindGroup?.conversation_kind === 'group' ? 'workspace' : 'both'",
    );
    expect(section).toContain("item.conversation_kind === 'direct'");
    expect(section).toContain("item.conversation_kind === 'group'");
    expect(dialog).toContain('恢复账号默认工作区');
    expect(dialog).toContain("target.type === 'session'");
    expect(dialog).toContain("'绑定到此工作区'");
  });

  test('frontend capability table mirrors workspace and native-thread policy', () => {
    const capabilities = read('web/src/constants/im-capabilities.ts');
    expect((capabilities.match(/can_bind_workspace: true/g) ?? []).length).toBe(
      8,
    );
    expect(capabilities).toMatch(
      /telegram:[\s\S]*supports_thread_map: true[\s\S]*supports_activation_modes: false/,
    );
    expect(capabilities).toMatch(
      /qq:[\s\S]*supports_thread_map: false[\s\S]*supports_activation_modes: false/,
    );
    expect(capabilities).toMatch(
      /wechat:[\s\S]*supports_thread_map: false[\s\S]*supports_activation_modes: false/,
    );
    expect(capabilities).toMatch(
      /wecom:[\s\S]*supports_thread_map: false[\s\S]*supports_activation_modes: true/,
    );
  });

  test('chat UI uses distinct workspace and session mutation endpoints', () => {
    const store = read('web/src/stores/chat.ts');
    const dialog = read('web/src/components/chat/ImBindingDialog.tsx');

    expect(store).toContain('bindWorkspaceImGroup: async');
    expect(store).toContain(
      '`/api/groups/${encodeURIComponent(jid)}/im-binding`',
    );
    expect(store).toContain(
      '`/api/groups/${encodeURIComponent(jid)}/sessions/main/im-binding`',
    );
    expect(dialog).toMatch(
      /isWorkspaceMode\s*\? bindWorkspaceImGroup\s*: bindMainImGroup/,
    );
    expect(dialog).toContain('机器人身份');
    expect(dialog).toContain('<ChannelAccountBadge');
  });

  test('a detected Telegram Forum is workspace-only before its first topic', () => {
    const telegram = read('src/telegram.ts');
    const index = read('src/index.ts');
    const agents = read('src/routes/agents.ts');
    const config = read('src/routes/config.ts');

    expect(telegram).toContain('prepareTelegramForumPairing(');
    expect(telegram).toMatch(
      /onPairAttempt\(jid, chatName, code\)[\s\S]*prepareTelegramForumPairing\([\s\S]*ctx\.reply/,
    );
    expect(index).toContain(
      'return ensureNativeContextChannelMount(chatJid, group) !== null',
    );
    for (const source of [agents, config]) {
      expect(source).toContain(
        'Native thread containers can only bind to a workspace',
      );
      expect(source).toContain(
        "threadCapable ? 'thread_map' : 'single_session'",
      );
    }
  });
});
