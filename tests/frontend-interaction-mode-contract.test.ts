import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_INTERACTION_MODE,
  normalizeInteractionMode,
  shouldShowStreamingPartialText,
} from '../web/src/lib/interaction-mode';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('frontend workspace interaction mode contract', () => {
  test('normalizes current, missing, and legacy values', () => {
    expect(DEFAULT_INTERACTION_MODE).toBe('assistant');
    expect(normalizeInteractionMode(undefined)).toBe('assistant');
    expect(normalizeInteractionMode(null)).toBe('assistant');
    expect(normalizeInteractionMode('legacy')).toBe('assistant');
    expect(normalizeInteractionMode('assistant')).toBe('assistant');
    expect(normalizeInteractionMode('proactive')).toBe('proactive');
    expect(normalizeInteractionMode('persona')).toBe('proactive');
  });

  test('sends the selected mode on create and PATCHes workspace changes', () => {
    const store = read('web/src/stores/chat.ts');
    const createDialog = read(
      'web/src/components/chat/CreateContainerDialog.tsx',
    );

    expect(store).toContain('body.interaction_mode = normalizeInteractionMode');
    expect(store).toContain('updateInteractionMode: async');
    expect(store).toContain('{ interaction_mode: interactionMode }');
    expect(createDialog).toContain("useState<InteractionMode>('assistant')");
    expect(createDialog).toContain(
      'options.interaction_mode = interactionMode',
    );
    expect(createDialog).toContain('Assistant 模式');
    expect(createDialog).toContain('主动模式');
  });

  test('exposes mode and safe runtime restart semantics in workspace settings', () => {
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const settingsDialog = read(
      'web/src/components/chat/WorkspaceInteractionModeDialog.tsx',
    );
    const selector = read(
      'web/src/components/chat/InteractionModeSelector.tsx',
    );

    expect(chatView).toContain('<WorkspaceInteractionModeDialog');
    expect(chatView).toContain('工作区设置');
    expect(chatView).toContain("'主动' : 'Assistant'");
    expect(settingsDialog).toContain(
      '同一模式会应用到该工作区的 Web、飞书和所有已绑定渠道',
    );
    expect(settingsDialog).toContain('切换会安全重启该工作区的 Agent');
    expect(settingsDialog).toContain('身份、Skills、记忆与渠道绑定保持不变');
    expect(settingsDialog).toContain('后续消息按新模式处理');
    expect(settingsDialog).toContain("saving ? '正在保存…' : '保存更改'");
    expect(settingsDialog).toContain('aria-busy={saving}');
    expect(selector).toContain('Assistant 模式（推荐）');
    expect(selector).toContain('主动模式');
    expect(selector).toContain('一轮可以发送多条');
    expect(selector).toContain('身份与语气仍由 Agent Profile 决定');
    expect(selector).toContain('CircleCheck');
  });

  test('never presents uncommitted partial text in proactive mode', () => {
    expect(shouldShowStreamingPartialText('assistant')).toBe(true);
    expect(shouldShowStreamingPartialText('proactive')).toBe(false);

    const streamingDisplay = read(
      'web/src/components/chat/StreamingDisplay.tsx',
    );
    const messageList = read('web/src/components/chat/MessageList.tsx');

    expect(streamingDisplay).toContain(
      'showPartialText && streaming.partialText',
    );
    expect(streamingDisplay).toContain(
      "effectiveInteractionMode === 'proactive'",
    );
    expect(streamingDisplay).toContain('<span>正在处理…</span>');
    expect(streamingDisplay).toContain('role="status"');
    expect(streamingDisplay).toContain('aria-live="polite"');
    expect(streamingDisplay).toContain('hasActiveRun');
    expect(streamingDisplay).toContain(
      "runtimeAgentKind === 'spawn' ? 'assistant' : interactionMode",
    );
    expect(messageList).toContain('interactionMode={interactionMode}');
  });

  test('re-evaluates workspace read state when the active conversation changes', () => {
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const store = read('web/src/stores/chat.ts');

    expect(chatView).toContain('}, [activeAgentTab, groupJid, markChatRead]);');
    expect(store).toContain('s.currentGroup === jid && s.unreadReplies[jid]');
    expect(store).toContain('delete nextUnreadReplies[jid]');
    expect(store).toContain('unreadReplies: nextUnreadReplies');
  });
});
