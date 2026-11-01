import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  conversationBindingPolicyError,
  resolveChannelConversationKind,
} from '../src/channel-conversation-kind.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('channel binding REST contract', () => {
  test('workspace and settings routes share mount builders and explicit unbind', () => {
    const agents = read('src/routes/agents.ts');
    const config = read('src/routes/config.ts');

    for (const source of [agents, config]) {
      expect(source).toContain('unbindChannelMount(');
      // A workspace binding is a topic thread map, never a single session.
      expect(source).not.toContain(
        "threadCapable ? 'thread_map' : 'single_session'",
      );
      expect(source).toMatch(
        /conversationBindingPolicyError\(\s*getConversationKind\([^)]*\),\s*'workspace',/,
      );
      expect(source).toContain(
        'Native thread containers can only bind to a workspace',
      );
      expect(source).toContain('conversationBindingPolicyError(');
    }
  });

  test('unbinding does not restore an account default or home workspace', () => {
    for (const file of ['src/routes/agents.ts', 'src/routes/config.ts']) {
      const source = read(file);
      expect(source).toContain('unbindChannelMount(');
      expect(source).not.toContain('restoreDefaultChannelMount(');
    }
  });

  test('settings UI uses the shared ordinary-vs-topic binding policy', () => {
    const section = read('web/src/components/settings/BindingsSection.tsx');
    const dialog = read('web/src/components/settings/BindingTargetDialog.tsx');

    expect(section).toContain(
      '!(item.bound_session_id ?? item.bound_agent_id)',
    );
    expect(section).toContain(
      'Boolean(item.bound_session_id ?? item.bound_agent_id)',
    );
    expect(section).toContain('resolveBindingTargetType(rebindGroup)');
    expect(section).toContain("resolveBindingTargetType(item) === 'session'");
    expect(section).toContain("resolveBindingTargetType(item) === 'workspace'");
    expect(dialog).toContain('解除渠道绑定');
    expect(dialog).toContain("target.type === 'session'");
    expect(dialog).toContain("'绑定到此工作区'");
  });

  test('frontend capability table mirrors workspace and native-thread policy', () => {
    const capabilities = read('web/src/constants/im-capabilities.ts');
    expect((capabilities.match(/can_bind_workspace: true/g) ?? []).length).toBe(
      2,
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
    const policy = read('web/src/utils/im-binding-policy.ts');
    const dialog = read('web/src/components/chat/ImBindingDialog.tsx');

    expect(policy).toContain('`${workspacePath}/im-binding`');
    expect(policy).toContain(
      '`${workspacePath}/sessions/${encodeURIComponent(destination.sessionId!)}/im-binding`',
    );
    expect(dialog).toContain('buildImBindingRequest(group, destination,');
    expect(dialog).toContain('机器人身份');
    expect(dialog).toContain('<ChannelAccountBadge');
  });

  test('a detected Telegram Forum is workspace-only before its first topic', () => {
    const kind = resolveChannelConversationKind(
      'telegram:-100123#account:bot',
      {
        native_context_type: 'thread',
      },
    );
    expect(kind).toBe('topic');
    expect(conversationBindingPolicyError(kind, 'workspace')).toBeNull();
    expect(conversationBindingPolicyError(kind, 'session')).not.toBeNull();
  });
});
