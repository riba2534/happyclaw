import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');

describe('task run status contract', () => {
  test('shows queued runs before execution starts', () => {
    const store = read('web/src/stores/tasks.ts');
    const detail = read('web/src/components/tasks/TaskDetail.tsx');
    const card = read('web/src/components/tasks/TaskCard.tsx');
    const page = read('web/src/pages/TasksPage.tsx');

    for (const status of [
      'queued',
      'running',
      'recovering',
      'retry_wait',
      'success',
      'failed',
      'cancelled',
      'missed',
      'delivered',
    ]) {
      expect(store).toContain(`| '${status}'`);
    }
    expect(detail).toMatch(/queued:\s*\{[\s\S]*label: '已排队'/);
    expect(detail).toContain("label: '等待重试'");
    expect(detail).toContain("label: '已投递到主会话'");
    expect(card).toContain('queued|running|recovering|retry_wait|delivered');
    expect(card).toMatch(
      /\[\s*'queued',\s*'running',\s*'recovering',\s*'retry_wait',\s*'delivered',?\s*\]/,
    );
    expect(detail).toContain('定时任务完整结果');
    expect(detail).toContain('setSelectedLog(log)');
    expect(detail).toContain('<MarkdownRenderer');
    expect(detail).toContain('content={selectedLog.result}');
    expect(detail).toContain('task.permissions?.can_edit === false');
    for (const permission of [
      'can_run',
      'can_pause',
      'can_stop',
      'can_delete',
      'can_restore',
      'can_purge',
    ]) {
      expect(card).toContain(`task.permissions?.${permission} !== false`);
    }
    expect(page).toContain('hasNotificationWork');
    expect(page).toContain("notification_status === 'pending'");
    expect(page).toContain('notification_available_at');
    expect(page).toContain('如果该时间已过，请先修改为未来时间');
    expect(page).toContain('需要先修改为未来时间再启用');
    expect(store).toContain('execution_blocked_reason');
    expect(card).toContain('配置已阻止执行');
    expect(card).toContain('已移到回收站');
    expect(card).toContain('onPurge');
    expect(page).toContain('当前任务');
    expect(page).toContain('回收站');
    expect(page).toContain('清空回收站');
    expect(page).toContain('永久删除');
    expect(store).toContain("'/api/tasks/purge'");
    const createForm = read('web/src/components/tasks/CreateTaskForm.tsx');
    expect(createForm).toContain('Docker 容器脚本不会被执行');
    expect(createForm).toContain("groups[jid]?.execution_mode === 'host'");
    expect(createForm).toContain('disabled={isScript}');
  });
});
