import {
  AUTOMATION_LIMITS,
  formatAutomationTime,
  type Automation,
  type AutomationDraft,
  type AutomationModelChoice,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationSchedule,
  type AutomationSessionMode,
} from './automation';
import { formatSpanZh } from './process-steps';
import { formatSessionTime } from './session-presentation';

// Web-only presentation of automations: list subtitles, unread marks, the
// form's schedule presets and the cron they produce. Validation and labels
// come from the shared `./automation` module.

export type AutomationFilter = 'all' | 'active' | 'paused' | 'completed';

export const AUTOMATION_FILTER_LABELS: Record<AutomationFilter, string> = {
  all: '全部',
  active: '启用',
  paused: '已暂停',
  completed: '已完成',
};

export function matchesAutomationFilter(
  automation: Automation,
  filter: AutomationFilter,
): boolean {
  return filter === 'all' || automation.status === filter;
}

export function isAutomationRunning(
  automation: Pick<Automation, 'lastRunStatus'>,
): boolean {
  return automation.lastRunStatus === 'running';
}

/** `error` when the run that left the mark failed, otherwise `success`. */
export function automationUnreadTone(
  automation: Automation,
): 'error' | 'success' | null {
  if (!automation.unreadRuns) return null;
  return automation.lastRunStatus === 'failed' ||
    automation.lastRunStatus === 'interrupted'
    ? 'error'
    : 'success';
}

/** The kind badge of a list cell: 单次 / 手动, or 运行中 while a run goes. */
export function automationCellBadge(
  automation: Automation,
): { label: string; variant: 'info' | 'outline' } | null {
  if (isAutomationRunning(automation))
    return { label: '运行中', variant: 'info' };
  if (automation.schedule.kind === 'once')
    return { label: '单次', variant: 'outline' };
  if (automation.schedule.kind === 'manual')
    return { label: '手动', variant: 'outline' };
  return null;
}

/**
 * The second line of a list cell, most pressing first: 排队中, 已暂停,
 * 已完成 with its reason, then the last and next run for the cadence.
 */
export function automationSubtitle(automation: Automation): string {
  if (automation.lastRunStatus === 'queued') return '排队中';
  if (automation.status === 'paused') return '已暂停';
  if (automation.status === 'completed')
    return automation.statusReason
      ? `已完成 · ${automation.statusReason}`
      : '已完成';
  const last = automation.lastFiredAt
    ? `上次 ${formatSessionTime(automation.lastFiredAt)}`
    : null;
  if (automation.schedule.kind === 'manual') return last ?? '手动';
  if (automation.schedule.kind === 'once') return last ?? '一次';
  return (
    [last, nextRunText(automation)].filter(Boolean).join(' · ') || '等待计划'
  );
}

/** `下次 10月31日 09:00`, or null when nothing is planned. */
export function nextRunText(automation: Automation): string | null {
  return automation.nextFireAt
    ? `下次 ${formatAutomationTime(automation.nextFireAt, automation.schedule.timezone)}`
    : null;
}

export const AUTOMATION_RUN_STATUS_VARIANTS: Record<
  AutomationRunStatus,
  'neutral' | 'info' | 'success' | 'error' | 'warning' | 'outline'
> = {
  queued: 'neutral',
  running: 'info',
  success: 'success',
  failed: 'error',
  skipped: 'outline',
  cancelled: 'neutral',
  interrupted: 'warning',
  missed: 'warning',
};

export const AUTOMATION_EXECUTION_LABELS = {
  agent: 'AI 任务',
  script: '仅运行脚本',
} as const;

export const PRE_CHECK_DECISION_LABELS = {
  run: '前置检查通过',
  skip: '条件不满足，已跳过',
  block: '前置检查失败',
} as const;

/** `1 分 5 秒`, or null when the run has not both started and finished. */
export function formatRunDuration(run: AutomationRun): string | null {
  if (!run.firedAt || !run.finishedAt) return null;
  return (
    formatSpanZh(Date.parse(run.finishedAt) - Date.parse(run.firedAt)) || null
  );
}

export type RunGroup =
  | { kind: 'single'; run: AutomationRun }
  | { kind: 'session'; sessionJid: string; runs: AutomationRun[] };

/**
 * Runs newest first. A persistent automation's runs that share a session are
 * folded into one group, placed where its newest run is.
 */
export function groupAutomationRuns(
  runs: AutomationRun[],
  sessionMode: AutomationSessionMode,
): RunGroup[] {
  if (sessionMode !== 'persistent')
    return runs.map((run) => ({ kind: 'single', run }));
  const groups: RunGroup[] = [];
  const bySession = new Map<string, AutomationRun[]>();
  for (const run of runs) {
    if (!run.sessionJid) {
      groups.push({ kind: 'single', run });
      continue;
    }
    const existing = bySession.get(run.sessionJid);
    if (existing) {
      existing.push(run);
      continue;
    }
    const grouped = [run];
    bySession.set(run.sessionJid, grouped);
    groups.push({ kind: 'session', sessionJid: run.sessionJid, runs: grouped });
  }
  return groups.map((group) =>
    group.kind === 'session' && group.runs.length === 1
      ? { kind: 'single', run: group.runs[0] }
      : group,
  );
}

// ─── Form: schedule presets ↔ AutomationSchedule ─────────────────────────

export type SchedulePreset =
  | 'minutes'
  | 'hourly'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'cron'
  | 'once';

export const SCHEDULE_PRESET_LABELS: Record<SchedulePreset, string> = {
  minutes: '每隔几分钟',
  hourly: '每隔几小时',
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
  monthly: '每月',
  cron: '自定义 Cron',
  once: '一次',
};

const NO_AUTOMATIONS: Automation[] = [];
const boundCache = new WeakMap<Automation[], Map<string, Automation[]>>();

/**
 * Automations by the session their runs go to (bound or persistent). Built
 * once per list, however many session lists ask.
 */
export function automationsBySession(
  automations: Automation[],
): Map<string, Automation[]> {
  const cached = boundCache.get(automations);
  if (cached) return cached;
  const bySession = new Map<string, Automation[]>();
  for (const automation of automations) {
    if (automation.sessionMode === 'fresh' || !automation.targetSessionJid)
      continue;
    const list = bySession.get(automation.targetSessionJid) ?? [];
    list.push(automation);
    bySession.set(automation.targetSessionJid, list);
  }
  boundCache.set(automations, bySession);
  return bySession;
}

/**
 * The automations whose runs come to a session: bound to it, reusing it, or
 * (with `generatedBy`) the one that opened it.
 */
export function automationsForSession(
  automations: Automation[],
  sessionJid: string,
  generatedBy?: string | null,
): Automation[] {
  const bound = automationsBySession(automations).get(sessionJid);
  const own = generatedBy
    ? automations.find((item) => item.id === generatedBy)
    : undefined;
  if (!own) return bound ?? NO_AUTOMATIONS;
  return bound?.includes(own) ? bound : [own, ...(bound ?? [])];
}

/**
 * The timer mark of a session row: automations bound to it, without the one
 * that opened it (the group it sits in already says so).
 */
export function boundAutomationsOf(
  automations: Automation[],
  sessionJid: string,
  generatedBy?: string | null,
): Automation[] {
  const bound = automationsBySession(automations).get(sessionJid);
  if (!bound) return NO_AUTOMATIONS;
  if (!generatedBy || !bound.some((item) => item.id === generatedBy))
    return bound;
  const others = bound.filter((item) => item.id !== generatedBy);
  return others.length ? others : NO_AUTOMATIONS;
}

/** Divisors of 60, so `*\/N` fires at evenly spaced minutes. */
export const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const;
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** `cron` fires on calendar slots; `interval` waits after a run finishes. */
type TimingMode = 'cron' | 'interval';

export interface ScheduleForm {
  plan: 'auto' | 'manual';
  preset: SchedulePreset;
  /** minutes / hourly presets only. */
  timing: TimingMode;
  everyMinutes: number;
  everyHours: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
  monthDay: number;
  cronExpr: string;
  /** `datetime-local` value, in the viewer's zone. */
  runAtLocal: string;
  timezone: string;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** A `datetime-local` value for an instant, in the viewer's zone. */
export function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** The instant of a `datetime-local` value, as UTC ISO; '' stays empty. */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function defaultScheduleForm(): ScheduleForm {
  return {
    plan: 'auto',
    preset: 'daily',
    timing: 'cron',
    everyMinutes: 30,
    everyHours: 1,
    hour: 9,
    minute: 0,
    weekday: 1,
    monthDay: 1,
    cronExpr: '',
    runAtLocal: '',
    timezone: browserTimeZone(),
  };
}

/** The schedule a filled-in form stands for. */
export function scheduleFromForm(form: ScheduleForm): AutomationSchedule {
  if (form.plan === 'manual') return { kind: 'manual' };
  const { minute, hour } = form;
  const cron = (cronExpr: string): AutomationSchedule => ({
    kind: 'cron',
    cronExpr,
    timezone: form.timezone,
  });
  switch (form.preset) {
    case 'minutes':
      return form.timing === 'interval'
        ? { kind: 'interval', intervalMs: form.everyMinutes * 60_000 }
        : cron(`*/${form.everyMinutes} * * * *`);
    case 'hourly':
      if (form.timing === 'interval')
        return { kind: 'interval', intervalMs: form.everyHours * 3_600_000 };
      return cron(
        form.everyHours === 1
          ? `${minute} * * * *`
          : `${minute} */${form.everyHours} * * *`,
      );
    case 'daily':
      return cron(`${minute} ${hour} * * *`);
    case 'weekdays':
      return cron(`${minute} ${hour} * * 1-5`);
    case 'weekly':
      return cron(`${minute} ${hour} * * ${form.weekday}`);
    case 'monthly':
      return cron(`${minute} ${hour} ${form.monthDay} * *`);
    case 'cron':
      return cron(form.cronExpr.trim());
    case 'once':
      return {
        kind: 'once',
        runAt: fromLocalInputValue(form.runAtLocal),
        timezone: form.timezone,
      };
  }
}

const NUMBER = /^\d+$/;

/** The form that reproduces `schedule`; unknown cron falls back to 自定义. */
export function scheduleFormFrom(schedule: AutomationSchedule): ScheduleForm {
  const form = defaultScheduleForm();
  if (schedule.timezone) form.timezone = schedule.timezone;
  switch (schedule.kind) {
    case 'manual':
      return { ...form, plan: 'manual' };
    case 'once':
      return {
        ...form,
        preset: 'once',
        runAtLocal: toLocalInputValue(schedule.runAt),
      };
    case 'interval': {
      const ms = schedule.intervalMs ?? 0;
      if (ms % 3_600_000 === 0 && ms > 0)
        return {
          ...form,
          preset: 'hourly',
          timing: 'interval',
          everyHours: ms / 3_600_000,
        };
      return {
        ...form,
        preset: 'minutes',
        timing: 'interval',
        everyMinutes: Math.max(1, Math.round(ms / 60_000)),
      };
    }
    case 'cron':
      return { ...form, ...cronPreset(schedule.cronExpr ?? '') };
  }
}

function cronPreset(expr: string): Partial<ScheduleForm> {
  const custom = { preset: 'cron' as const, cronExpr: expr };
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return custom;
  const [min, hr, dom, month, dow] = fields;
  if (month !== '*') return custom;
  const step = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
  const minuteStep = step(min);
  if (minuteStep && hr === '*' && dom === '*' && dow === '*') {
    const value = Number(minuteStep);
    return (MINUTE_STEPS as readonly number[]).includes(value)
      ? { preset: 'minutes', everyMinutes: value, cronExpr: expr }
      : custom;
  }
  if (!NUMBER.test(min)) return custom;
  const minute = Number(min);
  const hourStep = hr === '*' ? '1' : step(hr);
  if (hourStep && dom === '*' && dow === '*')
    return {
      preset: 'hourly',
      everyHours: Number(hourStep),
      minute,
      cronExpr: expr,
    };
  if (!NUMBER.test(hr)) return custom;
  const timed = { minute, hour: Number(hr), cronExpr: expr };
  if (dom === '*' && dow === '*') return { preset: 'daily', ...timed };
  if (dom === '*' && dow === '1-5') return { preset: 'weekdays', ...timed };
  if (dom === '*' && /^[0-7]$/.test(dow))
    return { preset: 'weekly', weekday: Number(dow) % 7, ...timed };
  if (NUMBER.test(dom) && dow === '*')
    return { preset: 'monthly', monthDay: Number(dom), ...timed };
  return custom;
}

// ─── Form: the whole draft ───────────────────────────────────────────────

export interface AutomationFormValues {
  name: string;
  execution: 'agent' | 'script';
  workspaceJid: string;
  schedule: ScheduleForm;
  sessionMode: AutomationSessionMode;
  targetSessionJid: string | null;
  stopWhen: string;
  endAtLocal: string;
  silentWhenIdle: boolean;
  preRunCheckEnabled: boolean;
  preRunCheckCommand: string;
  /** Seconds, as typed. */
  preRunCheckTimeout: string;
  prompt: string;
  scriptCommand: string;
  /** Null follows the default; sent only where it applies (automationTakesModel). */
  model: AutomationModelChoice | null;
}

export function emptyAutomationForm(
  prefill: Partial<Pick<AutomationFormValues, 'workspaceJid'>> & {
    targetSessionJid?: string | null;
  } = {},
): AutomationFormValues {
  return {
    name: '',
    execution: 'agent',
    workspaceJid: prefill.workspaceJid ?? '',
    schedule: defaultScheduleForm(),
    sessionMode: prefill.targetSessionJid ? 'bound' : 'fresh',
    targetSessionJid: prefill.targetSessionJid ?? null,
    stopWhen: '',
    endAtLocal: '',
    silentWhenIdle: true,
    preRunCheckEnabled: false,
    preRunCheckCommand: '',
    preRunCheckTimeout: String(
      AUTOMATION_LIMITS.preRunCheckDefaultTimeoutMs / 1000,
    ),
    prompt: '',
    scriptCommand: '',
    model: null,
  };
}

export function automationFormFrom(
  automation: Automation,
): AutomationFormValues {
  return {
    name: automation.name,
    execution: automation.execution,
    workspaceJid: automation.workspaceJid,
    schedule: scheduleFormFrom(automation.schedule),
    sessionMode: automation.sessionMode,
    targetSessionJid:
      automation.sessionMode === 'bound' ? automation.targetSessionJid : null,
    stopWhen: automation.stopWhen ?? '',
    endAtLocal: toLocalInputValue(automation.endAt),
    silentWhenIdle: automation.silentWhenIdle,
    preRunCheckEnabled: !!automation.preRunCheck,
    preRunCheckCommand: automation.preRunCheck?.command ?? '',
    preRunCheckTimeout: String(
      (automation.preRunCheck?.timeoutMs ??
        AUTOMATION_LIMITS.preRunCheckDefaultTimeoutMs) / 1000,
    ),
    prompt: automation.prompt,
    scriptCommand: automation.scriptCommand ?? '',
    model: automation.model ?? null,
  };
}

/**
 * Whether the runs take a model of their own: the sessions they create
 * (每次新建, 持续会话) do; a bound session keeps its own choice, and a
 * script runs no model.
 */
export function automationTakesModel(
  values: Pick<AutomationFormValues, 'execution' | 'sessionMode'>,
): boolean {
  return values.execution === 'agent' && values.sessionMode !== 'bound';
}

function sameModelChoice(
  a: AutomationModelChoice | null,
  b: AutomationModelChoice | null,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.modelConfigId === b.modelConfigId &&
    (a.model ?? null) === (b.model ?? null) &&
    (a.effort ?? null) === (b.effort ?? null)
  );
}

/**
 * The model an edit sends: only a change, as an omitted model stays as it
 * is. One that no longer applies (the runs moved to a bound session) is
 * cleared, which the server requires before it takes the move.
 */
export function modelPatchFromForm(
  values: AutomationFormValues,
  automation: Pick<Automation, 'model'>,
): { model?: AutomationModelChoice | null } {
  const next = automationTakesModel(values) ? values.model : null;
  return sameModelChoice(next, automation.model ?? null) ? {} : { model: next };
}

/** The draft the form submits; the shared validator checks it. */
export function draftFromForm(values: AutomationFormValues): AutomationDraft {
  const script = values.execution === 'script';
  const timeoutSeconds = Number(values.preRunCheckTimeout);
  return {
    name: values.name.trim(),
    prompt: script ? '' : values.prompt,
    stopWhen: values.stopWhen.trim() || null,
    schedule: scheduleFromForm(values.schedule),
    endAt: fromLocalInputValue(values.endAtLocal),
    sessionMode: values.sessionMode,
    silentWhenIdle: values.silentWhenIdle,
    preRunCheck:
      !script && values.preRunCheckEnabled
        ? {
            command: values.preRunCheckCommand.trim(),
            timeoutMs:
              values.preRunCheckTimeout.trim() === ''
                ? null
                : Math.round(timeoutSeconds * 1000),
          }
        : null,
    execution: values.execution,
    scriptCommand: script ? values.scriptCommand.trim() : null,
    // A creation names a model only when one is picked and the runs take it.
    ...(automationTakesModel(values) && values.model
      ? { model: values.model }
      : {}),
  };
}

export type AutomationFormField =
  | 'name'
  | 'workspace'
  | 'schedule'
  | 'session'
  | 'stopWhen'
  | 'endAt'
  | 'preRunCheck'
  | 'prompt'
  | 'script'
  | 'form';

// The shared validator's messages by how they start; checked in order.
const ERROR_FIELDS: [prefix: string, field: AutomationFormField][] = [
  ['请填写名称', 'name'],
  ['名称不能超过', 'name'],
  ['请填写提示词', 'prompt'],
  ['提示词不能超过', 'prompt'],
  ['请填写脚本命令', 'script'],
  ['脚本命令不能超过', 'script'],
  ['脚本只能写入一个固定会话', 'session'],
  ['脚本不需要前置检查', 'preRunCheck'],
  ['脚本和前置检查只能在', 'form'],
  ['停止条件不能超过', 'stopWhen'],
  ['请填写前置检查命令', 'preRunCheck'],
  ['前置检查超时', 'preRunCheck'],
  ['请填写 Cron 表达式', 'schedule'],
  ['间隔不能短于', 'schedule'],
  ['请填写带时区的运行时间', 'schedule'],
  ['运行时间已经过去', 'schedule'],
  ['请选择计划', 'schedule'],
  ['结束时间', 'endAt'],
];

/** Which field a shared validator message belongs under. */
export function fieldOfError(message: string): AutomationFormField {
  return (
    ERROR_FIELDS.find(([prefix]) => message.startsWith(prefix))?.[1] ?? 'form'
  );
}
