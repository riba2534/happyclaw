import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { useChatStore } from '../../stores/chat';
import { useGroupsStore } from '../../stores/groups';
import { useTasksStore } from '../../stores/tasks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';
import {
  SettingsFormFooter,
  SettingsStickySaveBar,
  SettingsSwitchRow,
} from './SettingsFormControls';
import type { HostIntegrationSettings, SystemSettings } from './types';
import { getErrorMessage } from './types';

type NumericSettingKey =
  | 'containerTimeout'
  | 'idleTimeout'
  | 'containerMaxOutputSize'
  | 'maxConcurrentContainers'
  | 'maxLoginAttempts'
  | 'loginLockoutMinutes';

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
  scope: 'runtime' | 'security';
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
          '限制单次运行保留的 stdout/stderr 日志，不限制智能体回复长度。',
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
    <SettingsGroup>
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
        <AlertCircle className="size-5 text-error" aria-hidden="true" />
        <div>
          <p className="text-body font-medium text-foreground">加载失败</p>
          <p className="mt-1 text-caption text-muted-foreground">{message}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          重新加载
        </Button>
      </div>
    </SettingsGroup>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <SettingsGroup>
      <div
        className="flex min-h-32 items-center justify-center"
        aria-label={label}
      >
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    </SettingsGroup>
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
    <SettingsRow
      label={field.label}
      htmlFor={inputId}
      description={<span id={descriptionId}>{field.description}</span>}
      control={
        <div className="flex w-full flex-col gap-1 sm:w-auto sm:items-end">
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
              className="min-w-0 tabular-nums sm:w-28 pointer-coarse:min-h-11"
            />
            <span className="w-8 shrink-0 text-caption text-muted-foreground">
              {field.unit}
            </span>
          </div>
          {error && (
            <p id={errorId} role="alert" className="text-caption text-error">
              {error}
            </p>
          )}
        </div>
      }
    />
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

  const saveButton = (
    <Button
      onClick={() => void handleSave()}
      disabled={saving || !dirty || Object.keys(errors).length > 0}
    >
      {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      保存系统参数
    </Button>
  );

  if (!canManage) {
    return (
      <p className="text-body text-muted-foreground">
        需要系统配置权限才能查看和修改系统参数。
      </p>
    );
  }

  if (loading) {
    return <LoadingState label="正在加载系统参数" />;
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
      <div className="space-y-8">
        {activeGroups.map((group) => (
          <SettingsSection
            key={group.title}
            title={group.title}
            description={group.description}
          >
            <SettingsGroup>
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
            </SettingsGroup>
          </SettingsSection>
        ))}

        {scope === 'runtime' && (
          <SettingsSection
            title="额度墙回退模型"
            description={
              <>
                主模型在一轮里撞到账号用量上限（如「You've reached your Fable 5
                limit」）时，用该模型在同一轮无缝重跑一次，上限通知不外发给用户。填模型别名或完整
                ID（如 <code className="font-mono">opus</code>、
                <code className="font-mono">claude-opus-4-8</code>
                ）。留空关闭，保留原行为。同一 OAuth
                账号下不同模型有独立额度桶，因此 fable→opus
                这类回退无需额外配置第二个 provider。
              </>
            }
          >
            <SettingsGroup>
              <SettingsRow
                label="回退模型"
                htmlFor="system-setting-fallbackModel"
                control={
                  <Input
                    id="system-setting-fallbackModel"
                    type="text"
                    value={fallbackModel}
                    onChange={(e) => setFallbackModel(e.target.value)}
                    placeholder="留空 = 关闭（如 opus / claude-opus-4-8）"
                    className="sm:w-80"
                    aria-label="额度墙回退模型"
                  />
                }
              />
            </SettingsGroup>
          </SettingsSection>
        )}
      </div>

      {scope === 'runtime' ? (
        <SettingsStickySaveBar
          status={
            <p
              className="truncate text-caption text-muted-foreground"
              aria-live="polite"
            >
              {dirty ? '有尚未保存的系统参数' : '系统参数已保存'}
            </p>
          }
        >
          {saveButton}
        </SettingsStickySaveBar>
      ) : (
        <SettingsFormFooter className="mt-3">{saveButton}</SettingsFormFooter>
      )}
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
    return <LoadingState label="正在加载宿主机集成设置" />;
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
        draft.pluginAutoScan !== settings.pluginAutoScan ||
        draft.adminHostOnlyMode !== settings.adminHostOnlyMode;

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
      const adminHostOnlyModeChanged =
        draft.adminHostOnlyMode !== settings.adminHostOnlyMode;
      const data = await api.put<HostIntegrationSettings>(
        '/api/config/host-integration',
        draft,
      );
      if (adminHostOnlyModeChanged) {
        await Promise.allSettled([
          useChatStore.getState().loadGroups(),
          useGroupsStore.getState().loadGroups(),
          useTasksStore.getState().loadTasks(),
        ]);
      }
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

  const autoCompactEnabled =
    draft.mainAgentAutoCompactWindow === 0 &&
    draft.mainAgentAutoCompactPercentage === 0;

  const saveButton = (
    <Button
      onClick={() => void handleSave()}
      disabled={
        saving || !dirty || (scope === 'main-agent' && !!mainAutoCompactError)
      }
    >
      {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {scope === 'main-agent' ? '保存主智能体设置' : '保存宿主机设置'}
    </Button>
  );

  if (scope === 'main-agent') {
    return (
      <SettingsSection
        title="配置继承与上下文压缩"
        description="控制主 HappyClaw 是否继承宿主机 Claude Code 配置，以及何时自动压缩上下文。"
      >
        <SettingsGroup>
          <SettingsSwitchRow
            label="主 HappyClaw 继承宿主机 Claude Code 配置"
            htmlFor="host-integration-main-agent-context"
            description={
              <span id="host-integration-main-agent-context-description">
                开启后自动继承宿主机提示词、Rules、全部 Skills 与 MCP，
                无需再逐项选择；HappyClaw 管理的能力继续附加。普通用户的 默认
                HappyClaw 始终使用托管配置。
              </span>
            }
            control={
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
            }
          />

          <SettingsSwitchRow
            label="SDK 自动压缩（推荐）"
            htmlFor="main-agent-auto-compact-default"
            description={
              <span id="main-agent-auto-compact-default-description">
                全局作用于所有用户的默认 HappyClaw。SDK
                根据当前模型决定压缩时机：普通模型通常为 200K 上下文；模型名带
                [1m] 时按 1M 处理。
              </span>
            }
            control={
              <Switch
                id="main-agent-auto-compact-default"
                checked={autoCompactEnabled}
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
            }
          />

          {!autoCompactEnabled &&
            (draft.mainAgentAutoCompactWindow > 0 &&
            draft.mainAgentAutoCompactPercentage === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 bg-warning/10 px-4 py-3">
                <p className="text-caption leading-5 text-warning">
                  当前保留旧版固定阈值{' '}
                  {Math.round(draft.mainAgentAutoCompactWindow / 1000)}K。
                  固定值无法同时适配 200K 与 1M 模型。
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
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
              <SettingsRow
                label="上下文使用比例"
                htmlFor="main-agent-auto-compact-percentage"
                description={
                  <span id="main-agent-auto-compact-percentage-description">
                    可设置 50–90%。例如 80% 在普通模型下为 160K，在 [1m]
                    模型下为 800K。
                  </span>
                }
                control={
                  <div className="flex w-full flex-col gap-1 sm:w-auto sm:items-end">
                    <div className="flex items-center gap-2">
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
                        className="min-w-0 tabular-nums sm:w-28 pointer-coarse:min-h-11"
                      />
                      <span className="w-8 shrink-0 text-caption text-muted-foreground">
                        %
                      </span>
                    </div>
                    {mainAutoCompactError && (
                      <p
                        id="main-agent-auto-compact-percentage-error"
                        role="alert"
                        className="text-caption text-error"
                      >
                        {mainAutoCompactError}
                      </p>
                    )}
                  </div>
                }
              />
            ))}
        </SettingsGroup>
        <SettingsFormFooter>{saveButton}</SettingsFormFooter>
      </SettingsSection>
    );
  }

  return (
    <div className="space-y-8">
      <div className="rounded-lg bg-warning/10 px-3 py-2.5 text-caption leading-5 text-warning">
        这些设置会读取宿主机文件，只对系统管理员开放。自定义智能体
        是否继承宿主机 Claude Code 配置，请在对应智能体的设置中管理。
      </div>

      <div className="space-y-3">
        <SettingsGroup>
          <SettingsSwitchRow
            label="管理员纯宿主机模式"
            htmlFor="admin-host-only-mode"
            description={
              <span id="admin-host-only-mode-description">
                开启后，管理员拥有的工作区和定时任务会统一迁移到宿主机，并禁止再选择
                Docker；普通成员仍固定使用
                Docker。关闭后不会自动把已有工作区迁回
                Docker。宿主机工作区暂不支持网页终端。
              </span>
            }
            control={
              <Switch
                id="admin-host-only-mode"
                checked={draft.adminHostOnlyMode}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current
                      ? { ...current, adminHostOnlyMode: checked }
                      : current,
                  )
                }
                aria-describedby="admin-host-only-mode-description"
              />
            }
          />

          <SettingsRow
            label="宿主机 Claude 目录"
            htmlFor="host-integration-claude-dir"
            description={
              <span id="host-integration-claude-dir-description">
                留空时使用当前服务用户的
                ~/.claude；自定义目录必须是宿主机上的绝对路径。
                当前目录同时作为提示词、Rules、Skills、MCP 与 Plugin Marketplace
                的来源。
              </span>
            }
            control={
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
                className="font-mono sm:w-72 pointer-coarse:min-h-11"
              />
            }
          />

          <SettingsSwitchRow
            label="自动扫描 Plugin Catalog"
            htmlFor="host-integration-plugin-scan"
            description={
              <span id="host-integration-plugin-scan-description">
                服务启动后扫描宿主机 marketplace，并每小时刷新共享
                Catalog。Catalog
                全局共享，但每个用户独立选择启用项；修改后需重启服务。
              </span>
            }
            control={
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
            }
          />
        </SettingsGroup>
        <SettingsFormFooter>{saveButton}</SettingsFormFooter>
      </div>

      <SettingsSection title="相关入口">
        <SettingsGroup>
          {[
            { to: '/capabilities/mcp', label: '导入宿主机 MCP 副本' },
            { to: '/capabilities/plugins', label: '查看共享 Plugin Catalog' },
          ].map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="flex h-11 items-center justify-between px-4 text-body font-medium text-foreground transition-colors duration-100 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
            >
              {link.label}
              <ArrowRight className="size-4 text-muted-foreground" />
            </Link>
          ))}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
