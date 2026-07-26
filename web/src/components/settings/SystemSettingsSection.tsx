import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { HostIntegrationSettings, SystemSettings } from './types';
import { getErrorMessage } from './types';

type NumericSettingKey =
  | 'containerTimeout'
  | 'idleTimeout'
  | 'containerMaxOutputSize'
  | 'maxConcurrentContainers'
  | 'maxLoginAttempts'
  | 'loginLockoutMinutes'
  | 'maxConcurrentScripts'
  | 'scriptTimeout'
  | 'taskBackfillGraceMs'
  | 'maxRepliesPerTurn'
  | 'maxTasksPerUser';

interface FieldConfig {
  key: NumericSettingKey;
  label: string;
  description: string;
  unit: string;
  toDisplay: (value: number) => number;
  toStored: (value: number) => number;
  min: number;
  max: number;
  step: number;
  validate?: (value: number) => string | null;
}

interface FieldGroup {
  scope: 'runtime' | 'security' | 'automation';
  title: string;
  description: string;
  fields: FieldConfig[];
}

const fieldGroups: FieldGroup[] = [
  {
    scope: 'runtime',
    title: '运行资源',
    description:
      'Docker 容器使用显式容量上限；宿主机模式仅对同一会话串行，不限制不同会话并发。正在运行的任务不会被中断。',
    fields: [
      {
        key: 'containerTimeout',
        label: '默认任务最大运行时间',
        description:
          '容器或宿主机进程单次运行的默认最长时间；工作区可单独覆盖。',
        unit: '分钟',
        toDisplay: (value) => Math.round(value / 60_000),
        toStored: (value) => value * 60_000,
        min: 1,
        max: 1440,
        step: 1,
      },
      {
        key: 'idleTimeout',
        label: '工作区运行器空闲保留时间',
        description:
          '最后一次输出后持续无活动，达到该时长时关闭容器或宿主机运行进程。',
        unit: '分钟',
        toDisplay: (value) => Math.round(value / 60_000),
        toStored: (value) => value * 60_000,
        min: 1,
        max: 1440,
        step: 1,
      },
      {
        key: 'containerMaxOutputSize',
        label: '运行日志保留上限',
        description:
          '限制单次运行保留的 stdout/stderr 日志，不限制 Agent 回复长度。',
        unit: 'MB',
        toDisplay: (value) => Math.round(value / 1_048_576),
        toStored: (value) => value * 1_048_576,
        min: 1,
        max: 100,
        step: 1,
      },
      {
        key: 'maxConcurrentContainers',
        label: 'Docker 容器并发上限',
        description: '系统同时运行的 Docker 容器数量上限。',
        unit: '个',
        toDisplay: (value) => value,
        toStored: (value) => value,
        min: 1,
        max: 100,
        step: 1,
      },
    ],
  },
  {
    scope: 'security',
    title: '登录与注册限流',
    description:
      '保存后立即用于新的登录和注册尝试。按用户名和来源 IP 计数，服务重启后计数会清空。',
    fields: [
      {
        key: 'maxLoginAttempts',
        label: '认证尝试次数上限',
        description:
          '同一用户名或来源 IP 达到该次数后，暂时拒绝新的登录或注册请求。',
        unit: '次',
        toDisplay: (value) => value,
        toStored: (value) => value,
        min: 1,
        max: 100,
        step: 1,
      },
      {
        key: 'loginLockoutMinutes',
        label: '登录与注册限流时间',
        description: '触发认证限流后，需要等待的时间。',
        unit: '分钟',
        toDisplay: (value) => value,
        toStored: (value) => value,
        min: 1,
        max: 1440,
        step: 1,
      },
    ],
  },
  {
    scope: 'automation',
    title: '任务调度',
    description: '保存后用于新启动和新调度的任务；正在执行的脚本不会被中断。',
    fields: [
      {
        key: 'maxConcurrentScripts',
        label: '脚本任务并发上限',
        description: '系统同时运行的脚本任务数量上限。',
        unit: '个',
        toDisplay: (value) => value,
        toStored: (value) => value,
        min: 1,
        max: 50,
        step: 1,
      },
      {
        key: 'scriptTimeout',
        label: '脚本执行超时',
        description: '单个脚本任务允许持续运行的最长时间。',
        unit: '秒',
        toDisplay: (value) => Math.round(value / 1000),
        toStored: (value) => value * 1000,
        min: 5,
        max: 600,
        step: 5,
      },
      {
        key: 'taskBackfillGraceMs',
        label: '定时任务逾期容忍窗口',
        description:
          '服务恢复后，仅补偿该时间窗口内错过的任务；0 表示补偿所有逾期任务。',
        unit: '分钟',
        toDisplay: (value) => Math.round(value / 60_000),
        toStored: (value) => value * 60_000,
        min: 0,
        max: 1440,
        step: 1,
      },
      {
        key: 'maxTasksPerUser',
        label: '每用户定时任务上限',
        description:
          '单个用户可持有的定时任务总数，防止大量任务持续占满执行容量。0 表示不限制。',
        unit: '个',
        toDisplay: (value) => value,
        toStored: (value) => value,
        min: 0,
        max: 10000,
        step: 10,
      },
      {
        key: 'maxRepliesPerTurn',
        label: '单轮消息条数上限',
        description:
          '一次回合内 Agent 最多送达多少条用户可见消息，用于兜住异常的重复发送循环；正常对话远达不到。0 表示不限制。',
        unit: '条',
        toDisplay: (value) => value,
        toStored: (value) => value,
        min: 0,
        max: 500,
        step: 1,
      },
    ],
  },
];

const fields = fieldGroups.flatMap((group) => group.fields);

function toDisplayValues(
  settings: SystemSettings,
): Record<NumericSettingKey, string> {
  return Object.fromEntries(
    fields.map((field) => [
      field.key,
      String(field.toDisplay(settings[field.key])),
    ]),
  ) as Record<NumericSettingKey, string>;
}

function getFieldError(field: FieldConfig, rawValue: string): string | null {
  if (!rawValue.trim()) return '请输入一个数值。';
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return '请输入有效数字。';
  if (!Number.isInteger(value / field.step)) {
    return `请输入 ${field.step} 的整数倍。`;
  }
  if (value < field.min || value > field.max) {
    return `请输入 ${field.min}–${field.max} ${field.unit}。`;
  }
  return field.validate?.(value) ?? null;
}

function RetryState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 text-center">
      <AlertCircle className="size-6 text-destructive" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-foreground">加载失败</p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        className="min-h-11"
      >
        <RotateCcw className="size-4" aria-hidden="true" />
        重新加载
      </Button>
    </div>
  );
}

function NumberSettingField({
  field,
  value,
  error,
  onChange,
  onBlur,
}: {
  field: FieldConfig;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const inputId = `system-setting-${field.key}`;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;

  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_11rem] sm:gap-8">
      <div className="min-w-0">
        <Label htmlFor={inputId} className="text-sm font-medium">
          {field.label}
        </Label>
        <p
          id={descriptionId}
          className="mt-1 text-xs leading-5 text-muted-foreground"
        >
          {field.description}
        </p>
      </div>
      <div className="self-start">
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            value={value}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            aria-invalid={!!error}
            aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ''}`}
            className="h-11 min-w-0"
          />
          <span className="w-16 shrink-0 text-xs text-muted-foreground">
            {field.unit}
          </span>
        </div>
        {error && (
          <p
            id={errorId}
            role="alert"
            className="mt-1.5 text-xs text-destructive"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function SystemSettingsSection({
  scope = 'runtime',
}: {
  scope?: FieldGroup['scope'];
}) {
  const canManage = useAuthStore((state) =>
    state.hasPermission('manage_system_config'),
  );
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [values, setValues] = useState<Record<
    NumericSettingKey,
    string
  > | null>(null);
  const [initialValues, setInitialValues] = useState<Record<
    NumericSettingKey,
    string
  > | null>(null);
  const [touched, setTouched] = useState<
    Partial<Record<NumericSettingKey, boolean>>
  >({});
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // fallbackModel 是自由字符串，独立于数值 field 抽象；仅在 runtime scope 展示。
  const [fallbackModel, setFallbackModel] = useState('');
  const [initialFallbackModel, setInitialFallbackModel] = useState('');

  const loadSettings = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<SystemSettings>('/api/config/system');
      const nextValues = toDisplayValues(data);
      setSettings(data);
      setValues(nextValues);
      setInitialValues(nextValues);
      setFallbackModel(data.fallbackModel ?? '');
      setInitialFallbackModel(data.fallbackModel ?? '');
      setTouched({});
      setSubmitted(false);
    } catch (error) {
      setLoadError(
        getErrorMessage(error, '无法读取系统参数，请检查网络后重试。'),
      );
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const activeGroups = useMemo(
    () => fieldGroups.filter((group) => group.scope === scope),
    [scope],
  );
  const activeFields = useMemo(
    () => activeGroups.flatMap((group) => group.fields),
    [activeGroups],
  );

  const errors = useMemo(() => {
    if (!values) return {} as Partial<Record<NumericSettingKey, string>>;
    return Object.fromEntries(
      activeFields
        .map((field) => [field.key, getFieldError(field, values[field.key])])
        .filter((entry) => entry[1]),
    ) as Partial<Record<NumericSettingKey, string>>;
  }, [activeFields, values]);

  const fallbackModelDirty =
    scope === 'runtime' && fallbackModel.trim() !== initialFallbackModel.trim();

  const dirty = useMemo(
    () =>
      (!!values &&
        !!initialValues &&
        activeFields.some(
          (field) => values[field.key] !== initialValues[field.key],
        )) ||
      fallbackModelDirty,
    [activeFields, initialValues, values, fallbackModelDirty],
  );

  const handleSave = async () => {
    if (!settings || !values) return;
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;

    const payload: Partial<SystemSettings> = {};
    for (const field of activeFields) {
      payload[field.key] = field.toStored(Number(values[field.key]));
    }
    if (scope === 'runtime') {
      payload.fallbackModel = fallbackModel.trim();
    }

    setSaving(true);
    try {
      const data = await api.put<SystemSettings>('/api/config/system', payload);
      const nextValues = toDisplayValues(data);
      setSettings(data);
      setValues(nextValues);
      setInitialValues(nextValues);
      setFallbackModel(data.fallbackModel ?? '');
      setInitialFallbackModel(data.fallbackModel ?? '');
      setTouched({});
      setSubmitted(false);
      toast.success('系统参数已保存，将应用于后续启动的任务');
    } catch (error) {
      toast.error(getErrorMessage(error, '系统参数保存失败，请稍后重试。'));
    } finally {
      setSaving(false);
    }
  };

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        需要系统配置权限才能查看和修改系统参数。
      </p>
    );
  }

  if (loading) {
    return (
      <div
        className="flex min-h-40 items-center justify-center"
        aria-label="正在加载系统参数"
      >
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError || !values) {
    return (
      <RetryState
        message={loadError ?? '系统参数不可用。'}
        onRetry={() => void loadSettings()}
      />
    );
  }

  return (
    <div>
      <p className="text-sm leading-6 text-muted-foreground">
        {scope === 'runtime' && '管理工作区运行边界、日志和执行容量。'}
        {scope === 'security' && '管理登录与注册请求的认证限流策略。'}
        {scope === 'automation' && '管理脚本执行限制和定时任务恢复策略。'}
      </p>

      <div className="mt-6 divide-y divide-border">
        {activeGroups.map((group) => (
          <section key={group.title} className="py-6 first:pt-0">
            <header className="mb-5 max-w-2xl">
              <h2 className="text-base font-semibold text-foreground">
                {group.title}
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {group.description}
              </p>
            </header>
            <div className="divide-y divide-border/70">
              {group.fields.map((field) => (
                <NumberSettingField
                  key={field.key}
                  field={field}
                  value={values[field.key]}
                  error={
                    submitted || touched[field.key]
                      ? (errors[field.key] ?? null)
                      : null
                  }
                  onChange={(value) =>
                    setValues((current) =>
                      current ? { ...current, [field.key]: value } : current,
                    )
                  }
                  onBlur={() =>
                    setTouched((current) => ({ ...current, [field.key]: true }))
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {scope === 'runtime' && (
        <section className="border-t border-border py-6">
          <header className="mb-5 max-w-2xl">
            <h2 className="text-base font-semibold text-foreground">
              额度墙回退模型
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              主模型在一轮里撞到账号用量上限（如「You've reached your Fable 5
              limit」）时，用该模型在同一轮无缝重跑一次，上限通知不外发给用户。填模型别名或完整
              ID（如 <code>opus</code>、<code>claude-opus-4-8</code>
              ）。留空关闭，保留原行为。同一 OAuth
              账号下不同模型有独立额度桶，因此 fable→opus
              这类回退无需额外配置第二个 provider。
            </p>
          </header>
          <Input
            type="text"
            value={fallbackModel}
            onChange={(e) => setFallbackModel(e.target.value)}
            placeholder="留空 = 关闭（如 opus / claude-opus-4-8）"
            className="max-w-xs"
            aria-label="额度墙回退模型"
          />
        </section>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 mt-2 flex min-h-16 items-center justify-between gap-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {dirty ? '有尚未保存的系统参数' : '系统参数已保存'}
        </p>
        <Button
          onClick={() => void handleSave()}
          disabled={saving || !dirty || Object.keys(errors).length > 0}
          className="min-h-11"
        >
          {saving && (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          )}
          保存系统参数
        </Button>
      </div>
    </div>
  );
}

export function HostIntegrationSettingsSection({
  scope = 'host',
}: {
  scope?: 'main-agent' | 'host';
}) {
  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
  const [settings, setSettings] = useState<HostIntegrationSettings | null>(
    null,
  );
  const [draft, setDraft] = useState<HostIntegrationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mainAutoCompactPercentage, setMainAutoCompactPercentage] =
    useState('80');

  const loadSettings = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<HostIntegrationSettings>(
        '/api/config/host-integration',
      );
      setSettings(data);
      setDraft(data);
      setMainAutoCompactPercentage(
        data.mainAgentAutoCompactPercentage > 0
          ? String(data.mainAgentAutoCompactPercentage)
          : '80',
      );
    } catch (error) {
      setLoadError(
        getErrorMessage(error, '无法读取宿主机集成设置，请稍后重试。'),
      );
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  if (!isAdmin) return null;

  if (loading) {
    return (
      <div
        className="flex min-h-32 items-center justify-center"
        aria-label="正在加载宿主机集成设置"
      >
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError || !draft || !settings) {
    return (
      <RetryState
        message={loadError ?? '宿主机集成设置不可用。'}
        onRetry={() => void loadSettings()}
      />
    );
  }

  const dirty =
    scope === 'main-agent'
      ? draft.mainAgentContextSource !== settings.mainAgentContextSource ||
        draft.mainAgentAutoCompactWindow !==
          settings.mainAgentAutoCompactWindow ||
        draft.mainAgentAutoCompactPercentage !==
          settings.mainAgentAutoCompactPercentage
      : draft.externalClaudeDir !== settings.externalClaudeDir ||
        draft.pluginAutoScan !== settings.pluginAutoScan;

  const mainAutoCompactError = (() => {
    if (
      draft.mainAgentAutoCompactWindow === 0 &&
      draft.mainAgentAutoCompactPercentage === 0
    ) {
      return null;
    }
    if (
      draft.mainAgentAutoCompactWindow > 0 &&
      draft.mainAgentAutoCompactPercentage === 0
    ) {
      return null;
    }
    const value = Number(mainAutoCompactPercentage);
    if (!Number.isInteger(value) || value < 50 || value > 90) {
      return '请输入 50–90 之间的整数。';
    }
    return null;
  })();

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await api.put<HostIntegrationSettings>(
        '/api/config/host-integration',
        draft,
      );
      setSettings(data);
      setDraft(data);
      setMainAutoCompactPercentage(
        data.mainAgentAutoCompactPercentage > 0
          ? String(data.mainAgentAutoCompactPercentage)
          : '80',
      );
      toast.success(
        scope === 'main-agent'
          ? '主 HappyClaw 默认策略已保存'
          : draft.pluginAutoScan !== settings.pluginAutoScan
            ? '宿主机集成设置已保存；Plugin 自动扫描将在服务重启后生效'
            : '宿主机集成设置已保存',
      );
    } catch (error) {
      toast.error(
        getErrorMessage(error, '宿主机集成设置保存失败，请稍后重试。'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {scope === 'host' && (
        <div className="rounded-lg border border-warning/30 bg-warning-bg px-4 py-3 text-xs leading-5 text-warning">
          这些设置会读取宿主机文件，只对系统管理员开放。自定义 Agent
          是否继承宿主机 Claude Code 配置，请在对应 Agent 的设置中管理。
        </div>
      )}

      <section className="mt-6 space-y-6">
        {scope === 'main-agent' && (
          <>
            <div className="flex min-h-16 items-start justify-between gap-6">
              <div className="min-w-0">
                <Label htmlFor="host-integration-main-agent-context">
                  主 HappyClaw 继承宿主机 Claude Code 配置
                </Label>
                <p
                  id="host-integration-main-agent-context-description"
                  className="mt-1 text-xs leading-5 text-muted-foreground"
                >
                  开启后自动继承宿主机提示词、Rules、全部 Skills 与 MCP，
                  无需再逐项选择；HappyClaw 管理的能力继续附加。普通用户的 默认
                  HappyClaw 始终使用托管配置。
                </p>
              </div>
              <Switch
                id="host-integration-main-agent-context"
                checked={draft.mainAgentContextSource === 'host_claude'}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          mainAgentContextSource: checked
                            ? 'host_claude'
                            : 'managed',
                        }
                      : current,
                  )
                }
                aria-describedby="host-integration-main-agent-context-description"
              />
            </div>

            <div className="border-t border-border pt-6">
              <div className="flex min-h-14 items-start justify-between gap-6">
                <div className="min-w-0">
                  <Label htmlFor="main-agent-auto-compact-default">
                    SDK 自动压缩（推荐）
                  </Label>
                  <p
                    id="main-agent-auto-compact-default-description"
                    className="mt-1 text-xs leading-5 text-muted-foreground"
                  >
                    全局作用于所有用户的默认 HappyClaw。SDK
                    根据当前模型决定压缩时机：普通模型通常为 200K
                    上下文；模型名带 [1m] 时按 1M 处理。
                  </p>
                </div>
                <Switch
                  id="main-agent-auto-compact-default"
                  checked={
                    draft.mainAgentAutoCompactWindow === 0 &&
                    draft.mainAgentAutoCompactPercentage === 0
                  }
                  onCheckedChange={(checked) => {
                    const compactPercentage = Number(mainAutoCompactPercentage);
                    const validCompactPercentage =
                      Number.isInteger(compactPercentage) &&
                      compactPercentage >= 50 &&
                      compactPercentage <= 90
                        ? compactPercentage
                        : 80;
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            mainAgentAutoCompactWindow: checked
                              ? 0
                              : current.mainAgentAutoCompactWindow,
                            mainAgentAutoCompactPercentage: checked
                              ? 0
                              : current.mainAgentAutoCompactWindow > 0
                                ? 0
                                : validCompactPercentage,
                          }
                        : current,
                    );
                  }}
                  aria-describedby="main-agent-auto-compact-default-description"
                />
              </div>

              {(draft.mainAgentAutoCompactWindow !== 0 ||
                draft.mainAgentAutoCompactPercentage !== 0) && (
                <div className="mt-4 max-w-xs">
                  {draft.mainAgentAutoCompactWindow > 0 &&
                  draft.mainAgentAutoCompactPercentage === 0 ? (
                    <div className="rounded-md border border-warning/30 bg-warning-bg p-3">
                      <p className="text-xs leading-5 text-warning">
                        当前保留旧版固定阈值{' '}
                        {Math.round(draft.mainAgentAutoCompactWindow / 1000)}K。
                        固定值无法同时适配 200K 与 1M 模型。
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  mainAgentAutoCompactWindow: 0,
                                  mainAgentAutoCompactPercentage: 80,
                                }
                              : current,
                          )
                        }
                      >
                        改用 80% 模型比例
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Label htmlFor="main-agent-auto-compact-percentage">
                        上下文使用比例
                      </Label>
                      <div className="mt-2 flex items-center gap-2">
                        <Input
                          id="main-agent-auto-compact-percentage"
                          type="number"
                          inputMode="numeric"
                          min={50}
                          max={90}
                          step={5}
                          value={mainAutoCompactPercentage}
                          onChange={(event) => {
                            const rawValue = event.target.value;
                            const value = Number(rawValue);
                            setMainAutoCompactPercentage(rawValue);
                            if (rawValue.trim() && Number.isInteger(value)) {
                              setDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      mainAgentAutoCompactWindow: 0,
                                      mainAgentAutoCompactPercentage: value,
                                    }
                                  : current,
                              );
                            }
                          }}
                          aria-invalid={!!mainAutoCompactError}
                          aria-describedby={`main-agent-auto-compact-percentage-description${mainAutoCompactError ? ' main-agent-auto-compact-percentage-error' : ''}`}
                          className="h-11"
                        />
                        <span className="shrink-0 text-xs text-muted-foreground">
                          %
                        </span>
                      </div>
                      <p
                        id="main-agent-auto-compact-percentage-description"
                        className="mt-1.5 text-xs leading-5 text-muted-foreground"
                      >
                        可设置 50–90%。例如 80% 在普通模型下为 160K，在 [1m]
                        模型下为 800K。
                      </p>
                    </>
                  )}
                  {mainAutoCompactError && (
                    <p
                      id="main-agent-auto-compact-percentage-error"
                      role="alert"
                      className="mt-1 text-xs text-destructive"
                    >
                      {mainAutoCompactError}
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {scope === 'host' && (
          <>
            <div className="border-t border-border pt-6">
              <Label htmlFor="host-integration-claude-dir">
                宿主机 Claude 目录
              </Label>
              <Input
                id="host-integration-claude-dir"
                value={draft.externalClaudeDir}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, externalClaudeDir: event.target.value }
                      : current,
                  )
                }
                placeholder="留空使用 ~/.claude"
                aria-describedby="host-integration-claude-dir-description"
                className="mt-2 h-11"
              />
              <p
                id="host-integration-claude-dir-description"
                className="mt-1.5 text-xs leading-5 text-muted-foreground"
              >
                留空时使用当前服务用户的
                ~/.claude；自定义目录必须是宿主机上的绝对路径。
                当前目录同时作为提示词、Rules、Skills、MCP 与 Plugin Marketplace
                的来源。
              </p>
            </div>

            <div className="flex min-h-16 items-start justify-between gap-6 border-t border-border pt-6">
              <div className="min-w-0">
                <Label htmlFor="host-integration-plugin-scan">
                  自动扫描 Plugin Catalog
                </Label>
                <p
                  id="host-integration-plugin-scan-description"
                  className="mt-1 text-xs leading-5 text-muted-foreground"
                >
                  服务启动后扫描宿主机 marketplace，并每小时刷新共享
                  Catalog。Catalog
                  全局共享，但每个用户独立选择启用项；修改后需重启服务。
                </p>
              </div>
              <Switch
                id="host-integration-plugin-scan"
                checked={draft.pluginAutoScan}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current ? { ...current, pluginAutoScan: checked } : current,
                  )
                }
                aria-describedby="host-integration-plugin-scan-description"
              />
            </div>
            <div className="grid gap-2 border-t border-border pt-6 sm:grid-cols-2">
              <Link
                to="/capabilities/mcp"
                className="flex min-h-11 items-center justify-between rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
              >
                导入宿主机 MCP 副本
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
              <Link
                to="/capabilities/plugins"
                className="flex min-h-11 items-center justify-between rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
              >
                查看共享 Plugin Catalog
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
            </div>
          </>
        )}
      </section>

      <div className="mt-6 flex justify-end border-t border-border pt-4">
        <Button
          onClick={() => void handleSave()}
          disabled={
            saving ||
            !dirty ||
            (scope === 'main-agent' && !!mainAutoCompactError)
          }
          className="min-h-11"
        >
          {saving && (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          )}
          {scope === 'main-agent' ? '保存主 Agent 设置' : '保存宿主机设置'}
        </Button>
      </div>
    </div>
  );
}
