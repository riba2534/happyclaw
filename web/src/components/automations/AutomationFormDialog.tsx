import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import {
  SettingsField,
  SettingsRow,
} from '@/components/settings/SettingsLayout';
import { cn } from '@/lib/utils';
import type { ApiError } from '../../api/client';
import {
  AUTOMATION_LIMITS,
  AUTOMATION_SESSION_MODE_LABELS,
  describeAutomationSchedule,
  validateAutomationDraft,
  type Automation,
  type AutomationSessionMode,
} from '../../lib/automation';
import {
  AUTOMATION_EXECUTION_LABELS,
  HOUR_STEPS,
  MINUTE_STEPS,
  SCHEDULE_PRESET_LABELS,
  WEEKDAY_LABELS,
  automationFormFrom,
  draftFromForm,
  emptyAutomationForm,
  fieldOfError,
  type AutomationFormField,
  type AutomationFormValues,
  type ScheduleForm,
  type SchedulePreset,
} from '../../lib/automation-presentation';
import {
  useAutomationsStore,
  type AutomationFormPrefill,
  type AutomationPatchBody,
} from '../../stores/automations';
import { useAuthStore } from '../../stores/auth';
import { useChatStore } from '../../stores/chat';
import { extractErrorMessage } from '../../utils/error';
import { sessionJidOf } from '../../lib/session-jid';
import {
  listedSessions,
  sessionDisplayName,
} from '../../lib/session-presentation';

const PRESETS: SchedulePreset[] = [
  'minutes',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'cron',
  'once',
];
const SESSION_MODES: AutomationSessionMode[] = ['fresh', 'persistent', 'bound'];
const STALE_MESSAGE =
  '这个自动化已在别处修改。刷新后会载入最新内容，你的改动会丢失。';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

interface AutomationFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Edit this automation; create when absent. */
  automation?: Automation | null;
  prefill?: AutomationFormPrefill;
  /** Called with the saved automation. */
  onSaved?: (automation: Automation) => void;
}

/** Create or edit an automation; one form for both. */
export function AutomationFormDialog({
  open,
  onClose,
  automation = null,
  prefill,
  onSaved,
}: AutomationFormDialogProps) {
  const editing = !!automation;
  const title = editing ? '编辑自动化' : '新建自动化';
  const description = '按计划在会话里运行提示词，每次运行都是一轮真实的对话。';
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      {/* A bottom sheet on a phone: the fields scroll between the header and
          the footer, which carries the home indicator's inset itself. */}
      <DialogContent className="flex max-h-[min(52rem,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-2xl phone:not-has-[>[data-slot=dialog-footer]]:pb-0">
        <DialogHeader className="border-b border-surface-border px-5 pt-5 pb-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <AutomationForm
          automation={automation}
          prefill={prefill}
          onCancel={onClose}
          onSaved={(saved) => {
            onSaved?.(saved);
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function AutomationForm({
  automation,
  prefill,
  onCancel,
  onSaved,
}: {
  automation: Automation | null;
  prefill?: AutomationFormPrefill;
  onCancel: () => void;
  onSaved: (automation: Automation) => void;
}) {
  const editing = !!automation;
  const user = useAuthStore((s) => s.user);
  const groups = useChatStore((s) => s.groups);
  const agents = useChatStore((s) => s.agents);
  const loadAgents = useChatStore((s) => s.loadAgents);
  const create = useAutomationsStore((s) => s.create);
  const update = useAutomationsStore((s) => s.update);
  const loadDetail = useAutomationsStore((s) => s.loadDetail);

  const workspaces = useMemo(
    () =>
      Object.entries(groups)
        .filter(
          ([jid, group]) =>
            jid.startsWith('web:') && group.can_modify !== false,
        )
        .map(([jid, group]) => ({ jid, group })),
    [groups],
  );

  const [values, setValues] = useState<AutomationFormValues>(() =>
    automation
      ? automationFormFrom(automation)
      : emptyAutomationForm({
          workspaceJid:
            prefill?.workspaceJid ??
            workspaces.find((item) => item.group.is_my_home)?.jid ??
            workspaces[0]?.jid,
          targetSessionJid: prefill?.targetSessionJid,
        }),
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  // `stale`: a 409, the form must reload before it can save.
  const [serverError, setServerError] = useState<{
    message: string;
    stale?: boolean;
  } | null>(null);
  const stale = !!serverError?.stale;
  // The revision the form's contents came from; a refresh moves it on.
  const [revision, setRevision] = useState(automation?.revision ?? 0);

  const set = <K extends keyof AutomationFormValues>(
    key: K,
    value: AutomationFormValues[K],
  ) => setValues((current) => ({ ...current, [key]: value }));
  const setSchedule = (patch: Partial<ScheduleForm>) =>
    setValues((current) => ({
      ...current,
      schedule: { ...current.schedule, ...patch },
    }));

  const workspace = groups[values.workspaceJid];
  // The server checks again; this only keeps unusable options out of reach.
  const allowHostCommands =
    user?.role === 'admin' && workspace?.execution_mode === 'host';
  const script = values.execution === 'script';

  useEffect(() => {
    if (values.workspaceJid) void loadAgents(values.workspaceJid);
  }, [values.workspaceJid, loadAgents]);

  // The workspace's sessions, in the session lists' order.
  const sessionOptions = useMemo(() => {
    if (!values.workspaceJid) return [];
    return listedSessions(agents[values.workspaceJid] ?? []).map((agent) => ({
      jid: sessionJidOf(values.workspaceJid, agent.id),
      label: sessionDisplayName(agent),
    }));
  }, [agents, values.workspaceJid]);

  const draft = useMemo(() => draftFromForm(values), [values]);
  const fieldErrors = useMemo(() => {
    const byField: Partial<Record<AutomationFormField, string[]>> = {};
    const add = (field: AutomationFormField, message: string) =>
      (byField[field] ??= []).push(message);
    for (const message of validateAutomationDraft(draft, {
      // A past time only blocks creation; an edit may keep it.
      now: editing ? undefined : new Date(),
      allowHostCommands,
    }))
      add(fieldOfError(message), message);
    if (!values.workspaceJid) add('workspace', '请选择工作区');
    if (values.sessionMode === 'bound' && !values.targetSessionJid)
      add('session', '请选择要绑定的会话');
    return byField;
  }, [
    draft,
    values.workspaceJid,
    values.sessionMode,
    values.targetSessionJid,
    editing,
    allowHostCommands,
  ]);
  const hasErrors = Object.keys(fieldErrors).length > 0;
  const errorOf = (field: AutomationFormField) =>
    submitted ? fieldErrors[field] : undefined;

  const reloadStale = async () => {
    if (!automation) return;
    try {
      await loadDetail(automation.id);
      const latest = useAutomationsStore
        .getState()
        .automations.find((item) => item.id === automation.id);
      if (latest) {
        setValues(automationFormFrom(latest));
        setRevision(latest.revision);
      }
      setServerError(null);
    } catch (err) {
      setServerError({
        message: `刷新失败：${extractErrorMessage(err)}`,
        stale: true,
      });
    }
  };

  const submit = async () => {
    setSubmitted(true);
    setServerError(null);
    if (hasErrors || saving) return;
    setSaving(true);
    try {
      const targetSessionJid =
        values.sessionMode === 'bound' ? values.targetSessionJid : null;
      let saved: Automation;
      if (automation) {
        // The execution kind is fixed at creation; fresh and persistent
        // sessions are the server's to pick.
        const patch: AutomationPatchBody = { ...draft };
        delete (patch as Partial<typeof draft>).execution;
        if (values.sessionMode === 'bound')
          patch.targetSessionJid = targetSessionJid;
        saved = await update(automation.id, revision, patch);
        toast.success('已保存');
      } else {
        saved = await create({
          ...draft,
          workspaceJid: values.workspaceJid,
          targetSessionJid,
        });
        toast.success('自动化已创建');
      }
      onSaved(saved);
    } catch (err) {
      setServerError(
        (err as ApiError).status === 409
          ? { message: STALE_MESSAGE, stale: true }
          : { message: extractErrorMessage(err) },
      );
    } finally {
      setSaving(false);
    }
  };

  const schedule = values.schedule;
  const built = draft.schedule;
  const preview = describeAutomationSchedule(built);
  const time = `${pad2(schedule.hour)}:${pad2(schedule.minute)}`;
  const setTime = (value: string) => {
    const [hour, minute] = value.split(':').map(Number);
    if (Number.isFinite(hour) && Number.isFinite(minute))
      setSchedule({ hour, minute });
  };
  const timeInput = (
    <Input
      type="time"
      aria-label="时间"
      value={time}
      onChange={(event) => setTime(event.target.value)}
      className="w-32"
    />
  );
  const timedPreset =
    schedule.preset === 'minutes' || schedule.preset === 'hourly';

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <Field label="标题" errors={errorOf('name')}>
          {(id) => (
            <Input
              id={id}
              value={values.name}
              maxLength={AUTOMATION_LIMITS.nameMax}
              placeholder="为这个自动化命名"
              onChange={(event) => set('name', event.target.value)}
            />
          )}
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="执行方式"
            hint={
              allowHostCommands
                ? undefined
                : '仅运行脚本和前置检查只在管理员的宿主机工作区可用。'
            }
          >
            {() => (
              <SegmentedControl
                label="执行方式"
                value={values.execution}
                onChange={(value) => {
                  if (editing) return;
                  if (value === 'script' && !allowHostCommands) return;
                  setValues((current) => ({
                    ...current,
                    execution: value,
                    // A script writes into one fixed session.
                    sessionMode:
                      value === 'script' && current.sessionMode === 'fresh'
                        ? 'persistent'
                        : current.sessionMode,
                  }));
                }}
                options={(['agent', 'script'] as const).map((value) => ({
                  value,
                  label: AUTOMATION_EXECUTION_LABELS[value],
                }))}
                className={cn(editing && 'pointer-events-none opacity-60')}
              />
            )}
          </Field>
          <Field label="工作区" errors={errorOf('workspace')}>
            {(id) => (
              <NativeSelect
                id={id}
                value={values.workspaceJid}
                disabled={editing}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    workspaceJid: event.target.value,
                    targetSessionJid: null,
                  }))
                }
                className="w-full"
              >
                {!values.workspaceJid && (
                  <NativeSelectOption value="">选择工作区</NativeSelectOption>
                )}
                {workspaces.map(({ jid, group }) => (
                  <NativeSelectOption key={jid} value={jid}>
                    {group.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>

        <Field label="计划" errors={errorOf('schedule')}>
          {(id) => (
            <div className="space-y-3">
              <SegmentedControl
                label="计划"
                value={schedule.plan}
                onChange={(plan) => setSchedule({ plan })}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'manual', label: '手动' },
                ]}
              />
              {schedule.plan === 'auto' && (
                <div className="flex flex-wrap items-center gap-2">
                  <NativeSelect
                    id={id}
                    aria-label="频率"
                    value={schedule.preset}
                    onChange={(event) =>
                      setSchedule({
                        preset: event.target.value as SchedulePreset,
                      })
                    }
                  >
                    {PRESETS.map((preset) => (
                      <NativeSelectOption key={preset} value={preset}>
                        {SCHEDULE_PRESET_LABELS[preset]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {schedule.preset === 'minutes' && (
                    <NativeSelect
                      aria-label="间隔分钟"
                      value={String(schedule.everyMinutes)}
                      onChange={(event) =>
                        setSchedule({
                          everyMinutes: Number(event.target.value),
                        })
                      }
                    >
                      {MINUTE_STEPS.map((step) => (
                        <NativeSelectOption key={step} value={step}>
                          每 {step} 分钟
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                  {schedule.preset === 'hourly' && (
                    <>
                      <NativeSelect
                        aria-label="间隔小时"
                        value={String(schedule.everyHours)}
                        onChange={(event) =>
                          setSchedule({
                            everyHours: Number(event.target.value),
                          })
                        }
                      >
                        {HOUR_STEPS.map((step) => (
                          <NativeSelectOption key={step} value={step}>
                            每 {step} 小时
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      {schedule.timing === 'cron' && (
                        <label className="flex items-center gap-1.5 text-body text-muted-foreground">
                          第
                          <Input
                            type="number"
                            aria-label="第几分"
                            min={0}
                            max={59}
                            value={schedule.minute}
                            onChange={(event) =>
                              setSchedule({
                                minute: Math.min(
                                  59,
                                  Math.max(0, Number(event.target.value) || 0),
                                ),
                              })
                            }
                            className="w-16"
                          />
                          分
                        </label>
                      )}
                    </>
                  )}
                  {(schedule.preset === 'daily' ||
                    schedule.preset === 'weekdays') &&
                    timeInput}
                  {schedule.preset === 'weekly' && (
                    <>
                      <NativeSelect
                        aria-label="星期"
                        value={String(schedule.weekday)}
                        onChange={(event) =>
                          setSchedule({ weekday: Number(event.target.value) })
                        }
                      >
                        {WEEKDAY_LABELS.map((label, day) => (
                          <NativeSelectOption key={day} value={day}>
                            周{label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      {timeInput}
                    </>
                  )}
                  {schedule.preset === 'monthly' && (
                    <>
                      <NativeSelect
                        aria-label="日期"
                        value={String(schedule.monthDay)}
                        onChange={(event) =>
                          setSchedule({ monthDay: Number(event.target.value) })
                        }
                      >
                        {Array.from({ length: 31 }, (_, index) => (
                          <NativeSelectOption key={index} value={index + 1}>
                            {index + 1} 日
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      {timeInput}
                    </>
                  )}
                  {schedule.preset === 'cron' && (
                    <Input
                      aria-label="Cron 表达式"
                      value={schedule.cronExpr}
                      placeholder="0 9 * * 1-5"
                      onChange={(event) =>
                        setSchedule({ cronExpr: event.target.value })
                      }
                      className="w-48 font-mono"
                    />
                  )}
                  {schedule.preset === 'once' && (
                    <Input
                      type="datetime-local"
                      aria-label="运行时间"
                      value={schedule.runAtLocal}
                      onChange={(event) =>
                        setSchedule({ runAtLocal: event.target.value })
                      }
                      className="w-56"
                    />
                  )}
                </div>
              )}
              {schedule.plan === 'auto' && timedPreset && (
                <div className="space-y-1">
                  <SegmentedControl
                    label="计时方式"
                    size="sm"
                    value={schedule.timing}
                    onChange={(timing) => setSchedule({ timing })}
                    options={[
                      { value: 'cron', label: 'Cron 定时' },
                      { value: 'interval', label: '完成后计时' },
                    ]}
                  />
                  <p className="text-caption text-muted-foreground">
                    {schedule.timing === 'cron'
                      ? '按日历时钟的固定时间点运行。'
                      : '上一次运行完成后，再等待指定时长。'}
                  </p>
                </div>
              )}
              <p
                data-testid="automation-schedule-preview"
                className="text-caption text-muted-foreground"
              >
                {schedule.plan === 'manual'
                  ? '只在你点「立即运行」或让智能体运行时执行。'
                  : `${preview}${
                      built.kind === 'cron'
                        ? ` · Cron ${built.cronExpr || '—'}`
                        : ''
                    } · 时区 ${schedule.timezone}`}
              </p>
            </div>
          )}
        </Field>

        <Field label="运行会话" errors={errorOf('session')}>
          {(id) => (
            <div className="space-y-2">
              <SegmentedControl
                label="运行会话"
                value={values.sessionMode}
                onChange={(sessionMode) => set('sessionMode', sessionMode)}
                options={SESSION_MODES.map((value) => ({
                  value,
                  label: AUTOMATION_SESSION_MODE_LABELS[value],
                }))}
              />
              <p className="text-caption text-muted-foreground">
                {values.sessionMode === 'fresh'
                  ? `每次运行新建一个会话，保留最近 ${AUTOMATION_LIMITS.freshSessionsKept} 个。`
                  : values.sessionMode === 'persistent'
                    ? '第一次运行新建会话，之后的运行都接着这个会话。'
                    : '运行发到选中的会话里，排在它正在做的事之后。'}
              </p>
              {values.sessionMode === 'bound' && (
                <NativeSelect
                  id={id}
                  aria-label="目标会话"
                  value={values.targetSessionJid ?? ''}
                  onChange={(event) =>
                    set('targetSessionJid', event.target.value || null)
                  }
                  className="w-full sm:w-80"
                >
                  <NativeSelectOption value="">选择一个会话</NativeSelectOption>
                  {sessionOptions.map((option) => (
                    <NativeSelectOption key={option.jid} value={option.jid}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </div>
          )}
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="停止条件（可选）"
            errors={errorOf('stopWhen')}
            hint="每次运行先核实，满足时智能体会结束这个自动化。"
          >
            {(id) => (
              <Input
                id={id}
                value={values.stopWhen}
                maxLength={AUTOMATION_LIMITS.stopWhenMax}
                placeholder="例如：第 1–29 集全部下载完"
                onChange={(event) => set('stopWhen', event.target.value)}
              />
            )}
          </Field>
          <Field
            label="结束时间（可选）"
            errors={errorOf('endAt')}
            hint="到这个时间后不再触发。"
          >
            {(id) => (
              <Input
                id={id}
                type="datetime-local"
                value={values.endAtLocal}
                onChange={(event) => set('endAtLocal', event.target.value)}
              />
            )}
          </Field>
        </div>

        <SwitchRow
          label="检查没事不说话"
          description="仅报告变化或问题。提醒和定时发送可关闭此项。"
          checked={values.silentWhenIdle}
          onCheckedChange={(value) => set('silentWhenIdle', value)}
        />

        {!script && (
          <div className="space-y-3">
            <SwitchRow
              label="前置检查"
              description={
                allowHostCommands
                  ? '触发时先在工作目录运行命令：退出码 0 照常运行，2 跳过本次（不消耗用量），其他视为失败。'
                  : '只在管理员的宿主机工作区可用。'
              }
              checked={values.preRunCheckEnabled}
              disabled={!allowHostCommands && !values.preRunCheckEnabled}
              onCheckedChange={(value) => set('preRunCheckEnabled', value)}
            />
            {values.preRunCheckEnabled && (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                <Field label="检查命令" errors={errorOf('preRunCheck')}>
                  {(id) => (
                    <Input
                      id={id}
                      value={values.preRunCheckCommand}
                      placeholder="node scripts/check.mjs"
                      onChange={(event) =>
                        set('preRunCheckCommand', event.target.value)
                      }
                      className="font-mono"
                    />
                  )}
                </Field>
                <Field label="超时（秒）">
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={1}
                      max={AUTOMATION_LIMITS.preRunCheckMaxTimeoutMs / 1000}
                      value={values.preRunCheckTimeout}
                      onChange={(event) =>
                        set('preRunCheckTimeout', event.target.value)
                      }
                    />
                  )}
                </Field>
              </div>
            )}
          </div>
        )}

        {script ? (
          <Field label="脚本命令" errors={errorOf('script')}>
            {(id) => (
              <Input
                id={id}
                value={values.scriptCommand}
                maxLength={AUTOMATION_LIMITS.scriptCommandMax}
                placeholder="python scripts/report.py"
                onChange={(event) => set('scriptCommand', event.target.value)}
                className="font-mono"
              />
            )}
          </Field>
        ) : (
          <Field label="提示词" errors={errorOf('prompt')}>
            {(id) => (
              <Textarea
                id={id}
                value={values.prompt}
                rows={6}
                maxLength={AUTOMATION_LIMITS.promptMax}
                placeholder="例如：检查仓库里新的 issue，总结需要我处理的部分。"
                onChange={(event) => set('prompt', event.target.value)}
                className="min-h-32"
              />
            )}
          </Field>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-surface-border px-5 py-3 sm:flex-row sm:items-center phone:pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="min-w-0 flex-1 space-y-1" aria-live="polite">
          {serverError && (
            <p role="alert" className="text-caption text-error">
              {serverError.message}
            </p>
          )}
          {stale && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={reloadStale}
            >
              刷新
            </Button>
          )}
          {errorOf('form')?.map((message) => (
            <p key={message} role="alert" className="text-caption text-error">
              {message}
            </p>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" disabled={saving || stale}>
            {saving && <Loader2 className="animate-spin" />}
            {editing ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** A labelled control (built with the label's id) and its inline errors. */
function Field({
  label,
  hint,
  errors,
  children,
}: {
  label: string;
  hint?: string;
  errors?: string[];
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <SettingsField label={label} description={hint} htmlFor={id}>
      {children(id)}
      {errors?.map((message) => (
        <p key={message} role="alert" className="text-caption text-error">
          {message}
        </p>
      ))}
    </SettingsField>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <SettingsRow
      inline
      className="p-0"
      label={label}
      description={description}
      htmlFor={id}
      control={
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      }
    />
  );
}
