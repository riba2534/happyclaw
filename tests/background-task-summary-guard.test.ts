import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildBackgroundTaskSummaryPrompt,
  isStaleBackgroundWaitReply,
  shouldForceBackgroundTaskSummary,
} from '../container/agent-runner/src/utils.js';

describe('background task summary guard', () => {
  test('prompt forbids premature final or numbered completion language', () => {
    const prompt = fs.readFileSync(
      path.join(
        process.cwd(),
        'container/agent-runner/prompts/background-tasks.md',
      ),
      'utf8',
    );

    expect(prompt).toContain('只能称为“进展”或“阶段结果”');
    expect(prompt).toContain('不得使用“最终”“完整”“全部完成”“到此结束”');
    expect(prompt).toContain('不得使用 `1/N`、`N/N`');
    expect(prompt).toContain('等整批任务状态稳定后一次汇总最终结果');
    expect(prompt).toContain('不要再单独发送“已送达”“任务完成”');
  });

  test('detects the stale wait reply from the Matt Pocock incident', () => {
    expect(
      isStaleBackgroundWaitReply(
        '1/6 完成（执行层），已落盘。等待其余 5 个 Agent。',
      ),
    ).toBe(true);
  });

  test('detects generic stale background-task progress replies', () => {
    expect(
      isStaleBackgroundWaitReply(
        '6 个 Agent 调研中，结果到齐后我会汇总并撰写文档。\n\n> ⏳ 2 个后台任务运行中，完成后将继续汇总',
      ),
    ).toBe(true);
    expect(
      isStaleBackgroundWaitReply(
        "I'll wait for the remaining 3 agents before summarizing.",
      ),
    ).toBe(true);
  });

  test('does not flag substantive final summaries', () => {
    expect(
      isStaleBackgroundWaitReply(
        '调研完成。Matt Pocock v1.1 的当前工作流是 grill-with-docs -> to-spec -> to-tickets -> implement -> code-review。',
      ),
    ).toBe(false);
  });

  test('forces a summary only after a held background-task result has fully settled', () => {
    const stale = '1/6 完成（执行层），已落盘。等待其余 5 个 Agent。';

    expect(
      shouldForceBackgroundTaskSummary({
        emitOutput: true,
        sawPendingBackgroundTasks: false,
        pendingBgTasks: 0,
        finalText: stale,
        attempts: 0,
        maxAttempts: 2,
      }),
    ).toBe(false);

    expect(
      shouldForceBackgroundTaskSummary({
        emitOutput: true,
        sawPendingBackgroundTasks: true,
        pendingBgTasks: 1,
        finalText: stale,
        attempts: 0,
        maxAttempts: 2,
      }),
    ).toBe(false);

    expect(
      shouldForceBackgroundTaskSummary({
        emitOutput: true,
        sawPendingBackgroundTasks: true,
        pendingBgTasks: 0,
        finalText: stale,
        attempts: 0,
        maxAttempts: 2,
      }),
    ).toBe(true);
  });

  test('stops forcing after the retry budget is exhausted', () => {
    expect(
      shouldForceBackgroundTaskSummary({
        emitOutput: true,
        sawPendingBackgroundTasks: true,
        pendingBgTasks: 0,
        finalText: '等待其余 5 个 Agent。',
        attempts: 2,
        maxAttempts: 2,
      }),
    ).toBe(false);
  });

  test('forced prompt is a final-summary instruction, not another progress update', () => {
    const prompt = buildBackgroundTaskSummaryPrompt();

    expect(prompt).toContain('All background Task agents');
    expect(prompt).toContain('Do not send another progress update');
    expect(prompt).toContain('final user-facing synthesis');
  });
});
