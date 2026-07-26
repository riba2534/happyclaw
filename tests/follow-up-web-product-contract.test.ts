import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  alternateFollowUpMode,
  normalizeFollowUpMode,
} from '../web/src/lib/follow-up-preferences.js';
import { getPresentedMessageContent } from '../web/src/lib/message-presentation.js';
import {
  buildSteeredReply,
  buildStoppedReply,
  stripRedundantCompletionPreamble,
} from '../src/reply-finalization.js';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Codex-style Web follow-up product contract', () => {
  test('defaults to queue and provides a one-shot alternate behavior', () => {
    expect(normalizeFollowUpMode(null)).toBe('queue');
    expect(normalizeFollowUpMode('unknown')).toBe('queue');
    expect(normalizeFollowUpMode('steer')).toBe('steer');
    expect(alternateFollowUpMode('queue')).toBe('steer');
    expect(alternateFollowUpMode('steer')).toBe('queue');
  });

  test('keeps the default in settings instead of a permanent composer toggle', () => {
    const input = read('web/src/components/chat/MessageInput.tsx');
    const preferences = read(
      'web/src/components/settings/PreferencesSection.tsx',
    );

    expect(preferences).toMatch(/运行中的后续消息/);
    expect(preferences).toMatch(/Ctrl\+Shift\+Enter/);
    expect(input).not.toMatch(/aria-label="运行中消息处理方式"/);
    expect(input).not.toMatch(/selectFollowUpMode/);
  });

  test('uses an exact query attempt instead of a warm or backoff process for stop state', () => {
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const store = read('web/src/stores/chat.ts');

    expect(chatView).not.toMatch(/activeAgent\?\.status === 'running'/);
    expect(chatView).toMatch(/isRunning=\{currentContextWaiting\}/);
    expect(chatView).toMatch(/status: 'idle' as const/);
    expect(store).toMatch(/queryInFlight\?: boolean/);
    expect(store).toMatch(/queryId\?: string \| null/);
    expect(store).toMatch(/hasExactQueryAttempt\(g\)/);
    expect(store).not.toMatch(/g\.queryInFlight \|\| g\.pendingMessages/);
  });

  test('exposes every queued message with edit, reorder, send, and delete', () => {
    const input = read('web/src/components/chat/MessageInput.tsx');

    expect(input).toMatch(/handleFollowUpAction\(item, 'move_up'\)/);
    expect(input).toMatch(/handleFollowUpAction\(item, 'move_down'\)/);
    expect(input).toMatch(/beginEditingFollowUp/);
    expect(input).toMatch(/立即发送/);
    expect(input).toMatch(/删除排队消息/);
    expect(input).not.toMatch(/queuedFollowUps\.slice\(0, 3\)/);
    expect(input).not.toMatch(/index > 0/);
  });

  test('recovers an unsaved queue edit if the dispatcher claims the item', () => {
    const input = read('web/src/components/chat/MessageInput.tsx');

    expect(input).toMatch(/未保存的修改已移到输入框/);
    expect(input).toMatch(/editingFollowUpInitialContentRef/);
    expect(input).toMatch(/editingFollowUpContentRef/);
    expect(input).toMatch(/debouncedSaveDraft\(nextContent\)/);
  });

  test('presents steering as a normal direction change instead of a failure', () => {
    expect(buildSteeredReply('已生成的有效内容\n')).toBe('已生成的有效内容');
    expect(buildSteeredReply('')).toBe('');
    expect(buildStoppedReply('已生成的有效内容')).toBe('已生成的有效内容');
    expect(buildStoppedReply('')).toBe('');
    expect(buildStoppedReply('已生成的有效内容')).not.toContain('⚠️');

    const streamingDisplay = read(
      'web/src/components/chat/StreamingDisplay.tsx',
    );
    expect(streamingDisplay).not.toMatch(/<span>已中断<\/span>/);
    expect(streamingDisplay).not.toMatch(/OctagonX/);
  });

  test('replaces a stopped stream with one terminal presentation', () => {
    const store = read('web/src/stores/chat.ts');

    expect(store).not.toMatch(/interruptPartialWhileFrozen/);
    expect(store).toMatch(
      /const hasData = state\.partialText \|\| state\.thinkingText/,
    );
  });

  test('cleans the legacy warning footer in existing intentional transitions', () => {
    expect(
      getPresentedMessageContent({
        content: '一段已经生成的回复\n\n---\n*⚠️ 已中断*',
        source_kind: 'interrupt_partial',
        finalization_reason: 'interrupted',
      }),
    ).toBe('一段已经生成的回复');
    expect(
      getPresentedMessageContent({
        content: '一段已经生成的回复\n\n---\n*⚠️ 已中断*',
        source_kind: 'interrupt_partial',
        finalization_reason: 'error',
      }),
    ).toContain('⚠️ 已中断');
    expect(
      getPresentedMessageContent({
        content: '---\n*已停止*',
        source_kind: 'interrupt_partial',
        finalization_reason: 'interrupted',
      }),
    ).toBe('');
  });

  test('keeps held progress out of the final Workflow conclusion', () => {
    const legacy =
      '已启动分析工作流。\n\n> ⏳ 1 个后台任务运行中，完成后将继续汇总\n\n---\n\n分析完成。以下是完整报告。\n\n---\n\n# 最终报告';
    expect(
      getPresentedMessageContent({
        content: legacy,
        source_kind: 'sdk_final',
        finalization_reason: 'completed',
      }),
    ).toBe('# 最终报告');
    expect(
      stripRedundantCompletionPreamble(
        '分析完成。以下是完整报告。\n\n---\n\n# 最终报告',
      ),
    ).toBe('# 最终报告');
  });
});
