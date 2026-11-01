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
    expect(settingsDialog).toContain('切换会安全重启该工作区的智能体');
    expect(settingsDialog).toContain('身份、Skills、记忆与渠道绑定保持不变');
    expect(settingsDialog).toContain('后续消息按新模式处理');
    expect(settingsDialog).toContain("saving ? '正在保存…' : '保存更改'");
    expect(settingsDialog).toContain('aria-busy={saving}');
    expect(selector).toContain('Assistant 模式（推荐）');
    expect(selector).toContain('主动模式');
    expect(selector).toContain('一轮可以发送多条');
    expect(selector).toContain('身份与语气仍由智能体配置决定');
    expect(selector).toContain('CircleCheck');
  });

  test('never presents uncommitted partial text in proactive mode', () => {
    expect(shouldShowStreamingPartialText('assistant')).toBe(true);
    expect(shouldShowStreamingPartialText('proactive')).toBe(false);

    const streamingDisplay = read(
      'web/src/components/chat/StreamingDisplay.tsx',
    );
    const messageList = read('web/src/components/chat/MessageList.tsx');
    const statusBar = read('web/src/components/chat/RunStatusBar.tsx');

    expect(streamingDisplay).toContain(
      'showPartialText && streaming.partialText',
    );
    expect(streamingDisplay).toContain(
      "effectiveInteractionMode === 'proactive'",
    );
    // That the run is busy is the run status bar's to say, not the transcript's.
    expect(streamingDisplay).not.toContain('正在处理…');
    expect(statusBar).toContain("const BUSY_TEXT = '处理中';");
    expect(statusBar).toContain('role="status"');
    expect(statusBar).toContain('aria-live="polite"');
    expect(streamingDisplay).toContain('hasActiveRun');
    expect(streamingDisplay).toContain(
      "runtimeAgentKind === 'spawn' ? 'assistant' : interactionMode",
    );
    expect(messageList).toContain('interactionMode={interactionMode}');
  });

  test('shows a proactive workspace process read-only and never its model text', () => {
    const panel = read('web/src/components/chat/ProcessPanel.tsx');
    const display = read('web/src/components/chat/StreamingDisplay.tsx');
    const statusBar = read('web/src/components/chat/RunStatusBar.tsx');
    const store = read('web/src/stores/chat.ts');

    // The panel reads the steps, the tools and the plan; model text is never
    // one of its inputs, and reasoning and the narration before a tool call
    // (a step the host handed over whole) only reach it at the `full` level.
    expect(panel).not.toMatch(/partialText|textTail|thinkingText:/);
    expect(panel).toContain("commentary={visibility === 'full'}");
    expect(panel).toContain("thinkingText={visibility === 'full'}");

    // At `hidden` the panel shows only for the progress the Agent sent; the
    // run status bar says the run is busy and offers its owner the process.
    const proactive = display.slice(
      display.indexOf("if (effectiveInteractionMode === 'proactive')"),
      display.indexOf('// 计算是否有流式数据'),
    );
    expect(proactive).toContain('<ProcessPanel');
    expect(proactive).toContain("(processVisibility === 'hidden' &&");
    expect(proactive).not.toMatch(/partialText|StreamingMarkdown/);
    expect(statusBar).toContain('显示过程');
    expect(statusBar).toContain('requestWorkspaceSettings(groupJid)');

    // The reducer checks again what the host sends, and spawn Agents keep the
    // Assistant contract there too.
    expect(store).toContain('filterProactiveStreamEvent(');
    expect(store).toContain('isProactiveRuntime(get(), runtimeJid)');
    expect(store).toContain("?.kind !== 'spawn'");
  });

  test('offers the process visibility in the workspace settings without a restart', () => {
    const dialog = read(
      'web/src/components/chat/WorkspaceInteractionModeDialog.tsx',
    );
    const selector = read(
      'web/src/components/chat/ProcessVisibilitySelector.tsx',
    );
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const store = read('web/src/stores/chat.ts');

    expect(selector).toContain('过程可见性');
    expect(selector).toContain('不重启运行时');
    expect(selector).toContain('不影响飞书等渠道');
    expect(dialog).toContain('<ProcessVisibilitySelector');
    // Only a proactive workspace has a process to show or hide.
    expect(dialog).toContain(
      "const visibilityApplies = draftMode === 'proactive'",
    );
    expect(chatView).toContain('updateProcessVisibility(groupJid, visibility)');
    expect(chatView).toContain('workspaceSettingsRequest');
    expect(store).toContain('process_visibility: requested,');
    expect(store).not.toMatch(/process_visibility[\s\S]{0,200}restart/i);
  });

  test('re-evaluates workspace read state when the active conversation changes', () => {
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const store = read('web/src/stores/chat.ts');

    expect(chatView).toContain('}, [sessionId, groupJid, markChatRead]);');
    expect(store).toContain('s.currentGroup === jid && s.unreadReplies[jid]');
    expect(store).toContain('delete nextUnreadReplies[jid]');
    expect(store).toContain('unreadReplies: nextUnreadReplies');
  });
});
