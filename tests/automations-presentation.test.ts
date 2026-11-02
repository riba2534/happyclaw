import { describe, expect, test } from 'vitest';
import {
  validateAutomationDraft,
  type Automation,
  type AutomationRun,
} from '../web/src/lib/automation';
import {
  automationCellBadge,
  automationFormFrom,
  automationSubtitle,
  automationUnreadTone,
  automationsBySession,
  defaultScheduleForm,
  draftFromForm,
  emptyAutomationForm,
  fieldOfError,
  groupAutomationRuns,
  scheduleFormFrom,
  scheduleFromForm,
  type ScheduleForm,
} from '../web/src/lib/automation-presentation';
import { sessionListItems } from '../web/src/lib/session-presentation';
import type { AgentInfo } from '../web/src/types';

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    workspaceJid: 'web:home',
    workspaceFolder: 'home',
    workspaceName: '主工作区',
    createdBy: 'u1',
    name: '日报',
    prompt: '写日报',
    stopWhen: null,
    schedule: { kind: 'cron', cronExpr: '0 9 * * *', timezone: 'UTC' },
    endAt: null,
    sessionMode: 'fresh',
    targetSessionJid: null,
    deliveryRouteJid: null,
    silentWhenIdle: false,
    preRunCheck: null,
    execution: 'agent',
    scriptCommand: null,
    status: 'active',
    statusReason: null,
    nextFireAt: '2026-10-31T09:00:00.000Z',
    lastFiredAt: null,
    lastFinishedAt: null,
    revision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    unreadRuns: 0,
    lastRunStatus: null,
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'r1',
    automationId: 'a1',
    trigger: 'schedule',
    status: 'success',
    sessionJid: null,
    inputMessageId: null,
    scheduledFor: '2026-10-30T09:00:00.000Z',
    firedAt: '2026-10-30T09:00:00.000Z',
    finishedAt: '2026-10-30T09:01:05.000Z',
    resultText: null,
    error: null,
    preCheck: null,
    silenced: false,
    readAt: null,
    createdAt: '2026-10-30T09:00:00.000Z',
    ...overrides,
  };
}

const form = (overrides: Partial<ScheduleForm>): ScheduleForm => ({
  ...defaultScheduleForm(),
  timezone: 'Asia/Shanghai',
  ...overrides,
});

describe('schedule presets → schedule', () => {
  test.each([
    [{ preset: 'minutes', everyMinutes: 15 }, '*/15 * * * *'],
    [{ preset: 'hourly', everyHours: 1, minute: 5 }, '5 * * * *'],
    [{ preset: 'hourly', everyHours: 2, minute: 0 }, '0 */2 * * *'],
    [{ preset: 'daily', hour: 21, minute: 30 }, '30 21 * * *'],
    [{ preset: 'weekdays', hour: 9, minute: 0 }, '0 9 * * 1-5'],
    [{ preset: 'weekly', weekday: 3, hour: 8, minute: 15 }, '15 8 * * 3'],
    [{ preset: 'monthly', monthDay: 28, hour: 7, minute: 0 }, '0 7 28 * *'],
    [{ preset: 'cron', cronExpr: ' 0 0 1 1 * ' }, '0 0 1 1 *'],
  ] as const)('%o → %s', (overrides, expr) => {
    expect(scheduleFromForm(form(overrides))).toEqual({
      kind: 'cron',
      cronExpr: expr,
      timezone: 'Asia/Shanghai',
    });
  });

  test('完成后计时 makes an interval, manual has no timing', () => {
    expect(
      scheduleFromForm(
        form({ preset: 'minutes', timing: 'interval', everyMinutes: 30 }),
      ),
    ).toEqual({ kind: 'interval', intervalMs: 1_800_000 });
    expect(
      scheduleFromForm(
        form({ preset: 'hourly', timing: 'interval', everyHours: 4 }),
      ),
    ).toEqual({ kind: 'interval', intervalMs: 4 * 3_600_000 });
    expect(scheduleFromForm(form({ plan: 'manual' }))).toEqual({
      kind: 'manual',
    });
  });

  test('一次 sends a UTC instant the shared validator accepts', () => {
    const schedule = scheduleFromForm(
      form({ preset: 'once', runAtLocal: '2099-01-02T03:04' }),
    );
    expect(schedule.kind).toBe('once');
    expect(schedule.runAt).toBe(new Date('2099-01-02T03:04').toISOString());
    expect(
      validateAutomationDraft(
        { name: 'x', prompt: 'y', schedule, sessionMode: 'fresh' },
        { now: new Date('2026-10-30T00:00:00Z') },
      ),
    ).toEqual([]);
    // Empty: the validator asks for a time.
    expect(
      validateAutomationDraft({
        name: 'x',
        prompt: 'y',
        schedule: scheduleFromForm(form({ preset: 'once', runAtLocal: '' })),
        sessionMode: 'fresh',
      }),
    ).toContain('请填写带时区的运行时间');
  });

  test('a saved schedule reopens on the preset that made it', () => {
    for (const overrides of [
      { preset: 'minutes', everyMinutes: 10 },
      { preset: 'hourly', everyHours: 3, minute: 20 },
      { preset: 'daily', hour: 6, minute: 45 },
      { preset: 'weekdays', hour: 9, minute: 0 },
      { preset: 'weekly', weekday: 0, hour: 9, minute: 0 },
      { preset: 'monthly', monthDay: 15, hour: 9, minute: 0 },
      { preset: 'minutes', timing: 'interval', everyMinutes: 45 },
      { preset: 'hourly', timing: 'interval', everyHours: 2 },
    ] as const) {
      const schedule = scheduleFromForm(form(overrides));
      expect(scheduleFromForm(scheduleFormFrom(schedule))).toEqual(schedule);
      expect(scheduleFormFrom(schedule).preset).toBe(overrides.preset);
    }
    expect(
      scheduleFormFrom({ kind: 'cron', cronExpr: '0 9 1-7 * 1' }).preset,
    ).toBe('cron');
    expect(scheduleFormFrom({ kind: 'manual' }).plan).toBe('manual');
  });
});

describe('form draft', () => {
  test('a script drops the prompt and the pre-run check', () => {
    const draft = draftFromForm({
      ...emptyAutomationForm({ workspaceJid: 'web:home' }),
      name: '  备份 ',
      execution: 'script',
      sessionMode: 'persistent',
      scriptCommand: ' ./backup.sh ',
      preRunCheckEnabled: true,
      preRunCheckCommand: 'true',
    });
    expect(draft).toMatchObject({
      name: '备份',
      prompt: '',
      execution: 'script',
      scriptCommand: './backup.sh',
      preRunCheck: null,
    });
  });

  test('the pre-run check timeout is typed in seconds', () => {
    const draft = draftFromForm({
      ...emptyAutomationForm(),
      preRunCheckEnabled: true,
      preRunCheckCommand: ' test -f x ',
      preRunCheckTimeout: '30',
    });
    expect(draft.preRunCheck).toEqual({
      command: 'test -f x',
      timeoutMs: 30_000,
    });
  });

  test('a session prefill binds the new automation to it', () => {
    const values = emptyAutomationForm({
      workspaceJid: 'web:home',
      targetSessionJid: 'web:home#agent:s1',
    });
    expect(values.sessionMode).toBe('bound');
    expect(emptyAutomationForm().sessionMode).toBe('fresh');
  });

  test('editing starts from the saved automation', () => {
    const values = automationFormFrom(
      automation({
        sessionMode: 'bound',
        targetSessionJid: 'web:home',
        endAt: '2099-01-01T00:00:00.000Z',
        preRunCheck: { command: 'check', timeoutMs: 5000 },
      }),
    );
    expect(values).toMatchObject({
      sessionMode: 'bound',
      targetSessionJid: 'web:home',
      preRunCheckEnabled: true,
      preRunCheckTimeout: '5',
    });
    expect(draftFromForm(values).endAt).toBe('2099-01-01T00:00:00.000Z');
  });

  test.each([
    ['请填写名称', 'name'],
    ['请填写提示词', 'prompt'],
    ['请填写脚本命令', 'script'],
    [
      '脚本只能写入一个固定会话，请选择「持续会话」或「绑定已有会话」',
      'session',
    ],
    ['脚本不需要前置检查', 'preRunCheck'],
    ['脚本和前置检查只能在管理员的宿主机工作区使用', 'form'],
    ['请填写前置检查命令', 'preRunCheck'],
    ['前置检查超时需在 1 秒到 10 分钟之间', 'preRunCheck'],
    ['间隔不能短于 1 分钟', 'schedule'],
    ['请填写 Cron 表达式', 'schedule'],
    ['运行时间已经过去', 'schedule'],
    ['结束时间已经过去', 'endAt'],
    ['结束时间需要带时区', 'endAt'],
    ['停止条件不能超过 500 个字符', 'stopWhen'],
  ])('%s shows under %s', (message, field) => {
    expect(fieldOfError(message)).toBe(field);
  });
});

describe('list cell', () => {
  test('subtitle priority: 排队中 > 已暂停 > 已完成 > cadence', () => {
    const paused = automation({ status: 'paused', lastRunStatus: 'queued' });
    expect(automationSubtitle(paused)).toBe('排队中');
    expect(automationSubtitle({ ...paused, lastRunStatus: 'success' })).toBe(
      '已暂停',
    );
    expect(
      automationSubtitle(
        automation({ status: 'completed', statusReason: '已到结束时间' }),
      ),
    ).toBe('已完成 · 已到结束时间');
    expect(automationSubtitle(automation({ status: 'completed' }))).toBe(
      '已完成',
    );
  });

  test('manual and once read 上次 X once they ran', () => {
    const fired = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(
      automationSubtitle(automation({ schedule: { kind: 'manual' } })),
    ).toBe('手动');
    expect(
      automationSubtitle(
        automation({ schedule: { kind: 'manual' }, lastFiredAt: fired }),
      ),
    ).toBe('上次 5 分钟前');
    expect(
      automationSubtitle(
        automation({ schedule: { kind: 'once', runAt: fired } }),
      ),
    ).toBe('一次');
    expect(
      automationSubtitle(
        automation({
          schedule: { kind: 'once', runAt: fired },
          lastFiredAt: fired,
        }),
      ),
    ).toBe('上次 5 分钟前');
  });

  test('recurring shows the last and the next run', () => {
    const fired = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(automationSubtitle(automation({ lastFiredAt: fired }))).toBe(
      '上次 2 小时前 · 下次 10月31日 09:00',
    );
    expect(automationSubtitle(automation())).toBe('下次 10月31日 09:00');
  });

  test('badges: 运行中 over 单次 / 手动', () => {
    expect(automationCellBadge(automation())).toBeNull();
    expect(
      automationCellBadge(automation({ schedule: { kind: 'once' } }))?.label,
    ).toBe('单次');
    expect(
      automationCellBadge(automation({ schedule: { kind: 'manual' } }))?.label,
    ).toBe('手动');
    expect(
      automationCellBadge(
        automation({ schedule: { kind: 'manual' }, lastRunStatus: 'running' }),
      )?.label,
    ).toBe('运行中');
  });

  test('unread dot: error after a failure, success otherwise, none when read', () => {
    expect(automationUnreadTone(automation())).toBeNull();
    expect(
      automationUnreadTone(
        automation({ unreadRuns: 2, lastRunStatus: 'failed' }),
      ),
    ).toBe('error');
    expect(
      automationUnreadTone(
        automation({ unreadRuns: 1, lastRunStatus: 'interrupted' }),
      ),
    ).toBe('error');
    expect(
      automationUnreadTone(
        automation({ unreadRuns: 1, lastRunStatus: 'success' }),
      ),
    ).toBe('success');
  });
});

describe('runs and sessions', () => {
  test('a persistent automation folds runs that share a session', () => {
    const runs = [
      run({ id: 'r4', sessionJid: 'web:home#agent:p2' }),
      run({ id: 'r3', sessionJid: 'web:home#agent:p1' }),
      run({ id: 'r2', sessionJid: null, status: 'skipped' }),
      run({ id: 'r1', sessionJid: 'web:home#agent:p1' }),
    ];
    expect(groupAutomationRuns(runs, 'persistent')).toEqual([
      { kind: 'single', run: runs[0] },
      {
        kind: 'session',
        sessionJid: 'web:home#agent:p1',
        runs: [runs[1], runs[3]],
      },
      { kind: 'single', run: runs[2] },
    ]);
    expect(groupAutomationRuns(runs, 'fresh')).toHaveLength(4);
  });

  test('sessions an automation opened fold into one row where its newest one is', () => {
    const session = (
      id: string,
      automationId?: string,
      pinned = false,
    ): AgentInfo =>
      ({
        id,
        name: id,
        prompt: '',
        status: 'idle',
        kind: 'conversation',
        created_at: '2026-10-30T00:00:00Z',
        automation_id: automationId ?? null,
        automation_name: automationId ? `自动化 ${automationId}` : null,
        pinned_at: pinned ? '2026-10-30T00:00:00Z' : null,
      }) as AgentInfo;
    // Already in list order: pinned first, then by recent activity.
    const items = sessionListItems([
      session('p1', 'a1', true),
      session('s1', 'a2'),
      session('s2'),
      session('s3', 'a1'),
      session('s4', 'a2'),
    ]);
    expect(
      items.map((item) =>
        item.kind === 'session'
          ? item.session.id
          : [
              item.group.automationId,
              item.group.name,
              item.group.sessions.map((s) => s.id),
            ],
      ),
    ).toEqual([
      // A pinned session stays a row of its own.
      'p1',
      ['a2', '自动化 a2', ['s1', 's4']],
      's2',
      ['a1', '自动化 a1', ['s3']],
    ]);
  });

  test('bound and persistent automations mark their session', () => {
    const map = automationsBySession([
      automation({
        id: 'b',
        sessionMode: 'bound',
        targetSessionJid: 'web:home',
      }),
      automation({
        id: 'f',
        sessionMode: 'fresh',
        targetSessionJid: 'web:home',
      }),
      automation({
        id: 'p',
        sessionMode: 'persistent',
        targetSessionJid: 'web:home#agent:s1',
      }),
    ]);
    expect(map.get('web:home')?.map((a) => a.id)).toEqual(['b']);
    expect(map.get('web:home#agent:s1')?.map((a) => a.id)).toEqual(['p']);
  });
});

describe('validator messages', () => {
  test('every message the shared validator gives lands on a field', () => {
    const long = 'x'.repeat(20_000);
    const drafts = [
      {
        name: '',
        prompt: '',
        schedule: { kind: 'cron' as const },
        sessionMode: 'fresh' as const,
      },
      {
        name: long,
        prompt: long,
        stopWhen: long,
        schedule: { kind: 'interval' as const, intervalMs: 1 },
        endAt: 'tomorrow',
        sessionMode: 'fresh' as const,
        preRunCheck: { command: '', timeoutMs: 1 },
      },
      {
        name: 'x',
        execution: 'script' as const,
        scriptCommand: '',
        schedule: { kind: 'once' as const, runAt: '2001-01-01T00:00:00Z' },
        endAt: '2001-01-01T00:00:00Z',
        sessionMode: 'fresh' as const,
        preRunCheck: { command: 'x' },
      },
      {
        name: 'x',
        execution: 'script' as const,
        scriptCommand: long,
        schedule: { kind: 'once' as const },
        sessionMode: 'bound' as const,
      },
      {
        name: 'x',
        prompt: 'y',
        schedule: {} as never,
        sessionMode: 'fresh' as const,
      },
    ];
    const messages = new Set(
      drafts.flatMap((draft) =>
        validateAutomationDraft(draft, {
          now: new Date('2026-10-30T00:00:00Z'),
        }),
      ),
    );
    expect(messages.size).toBeGreaterThan(15);
    for (const message of messages)
      if (!message.includes('宿主机'))
        expect([message, fieldOfError(message)]).not.toEqual([message, 'form']);
  });
});
