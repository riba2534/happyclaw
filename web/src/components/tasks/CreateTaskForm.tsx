import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Loader2, Sparkles, SlidersHorizontal } from 'lucide-react';
import { SettingsField } from '@/components/settings/SettingsLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '../../api/client';
import { showToast } from '../../utils/toast';
import {
  INTERVAL_UNITS,
  CHANNEL_OPTIONS,
  toggleNotifyChannel,
} from '../../utils/task-utils';
import { useConnectedChannels } from '../../hooks/useConnectedChannels';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useTasksStore } from '../../stores/tasks';
import { useGroupsStore } from '../../stores/groups';
import { formatGroupLabel } from '../settings/channel-meta';

interface CreateTaskFormProps {
  onSubmit: (data: {
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    executionType: 'agent' | 'script';
    executionMode?: 'host' | 'container';
    scriptCommand: string;
    notifyChannels: string[] | null;
    chatJid?: string;
    contextMode?: 'group' | 'isolated';
  }) => Promise<void>;
  onClose: () => void;
  isAdmin?: boolean;
}

type CreateMode = 'ai' | 'manual';

function RequiredMark() {
  return <span className="text-error">*</span>;
}

export function CreateTaskForm({
  onSubmit,
  onClose,
  isAdmin,
}: CreateTaskFormProps) {
  const [mode, setMode] = useState<CreateMode>('ai');
  const isDesktop = useMediaQuery('(min-width: 640px)');

  // --- AI mode state ---
  const [aiDescription, setAiDescription] = useState('');
  const [aiSubmitting, setAiSubmitting] = useState(false);

  // --- Manual mode state ---
  const [formData, setFormData] = useState({
    prompt: '',
    scheduleType: 'cron' as 'cron' | 'interval' | 'once',
    scheduleValue: '',
    executionType: 'agent' as 'agent' | 'script',
    executionMode: (isAdmin ? 'host' : 'container') as 'host' | 'container',
    scriptCommand: '',
  });
  const [intervalNumber, setIntervalNumber] = useState('');
  const [intervalUnit, setIntervalUnit] = useState('60000');
  const [onceDateTime, setOnceDateTime] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // --- Shared state ---
  const [notifyChannels, setNotifyChannels] = useState<string[] | null>(null);
  const [chatJid, setChatJid] = useState<string>('');
  const [contextMode, setContextMode] = useState<'group' | 'isolated'>(
    'isolated',
  );
  const [executionModeExplicit, setExecutionModeExplicit] =
    useState<boolean>(false);
  const connectedChannels = useConnectedChannels();

  const groupNames = useTasksStore((s) => s.groupNames);
  const loadTasks = useTasksStore((s) => s.loadTasks);
  const groups = useGroupsStore((s) => s.groups);
  const adminHostOnlyMode = useGroupsStore((s) => s.adminHostOnlyMode);
  const loadGroups = useGroupsStore((s) => s.loadGroups);

  useEffect(() => {
    if (Object.keys(groupNames).length === 0) {
      loadTasks();
    }
    if (Object.keys(groups).length === 0) {
      loadGroups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync executionMode from selected workspace when user hasn't manually overridden.
  // For the "default" option (empty chatJid), fall back to a role-based placeholder
  // that matches what the backend infers for the user's own home workspace.
  useEffect(() => {
    if (!isAdmin || !adminHostOnlyMode) return;
    setExecutionModeExplicit(true);
    setFormData((previous) =>
      previous.executionMode === 'host'
        ? previous
        : { ...previous, executionMode: 'host' },
    );
  }, [isAdmin, adminHostOnlyMode]);

  useEffect(() => {
    if (executionModeExplicit) return;
    const sourceMode = chatJid ? groups[chatJid]?.execution_mode : undefined;
    const next = sourceMode ?? (isAdmin ? 'host' : 'container');
    setFormData((prev) =>
      prev.executionMode === next ? prev : { ...prev, executionMode: next },
    );
  }, [chatJid, groups, executionModeExplicit, isAdmin]);

  const isScript = formData.executionType === 'script';

  const sortedGroupEntries = Object.entries(groupNames).sort(([a], [b]) => {
    const aWeb = a.startsWith('web:') ? 0 : 1;
    const bWeb = b.startsWith('web:') ? 0 : 1;
    if (aWeb !== bWeb) return aWeb - bWeb;
    return a.localeCompare(b);
  });
  const scriptGroupEntries = sortedGroupEntries.filter(
    ([jid]) => groups[jid]?.execution_mode === 'host',
  );
  const defaultWorkspaceMode = Object.values(groups).find(
    (group) => group.is_my_home,
  )?.execution_mode;

  useEffect(() => {
    if (!isScript) return;
    setExecutionModeExplicit(true);
    setFormData((previous) =>
      previous.executionMode === 'host'
        ? previous
        : { ...previous, executionMode: 'host' },
    );
    const selectedMode = chatJid
      ? groups[chatJid]?.execution_mode
      : defaultWorkspaceMode;
    if (selectedMode === 'host') return;
    const firstHostJid = Object.keys(groupNames).find(
      (jid) => groups[jid]?.execution_mode === 'host',
    );
    if (firstHostJid && firstHostJid !== chatJid) setChatJid(firstHostJid);
  }, [isScript, chatJid, groups, groupNames, defaultWorkspaceMode]);

  const renderTargetWorkspace = () => (
    <SettingsField
      label="所属工作区"
      description={
        isScript
          ? '脚本仅可选择管理员宿主机工作区，并直接在该宿主机目录中执行。'
          : '任务会在这个工作区的目录和环境中执行，并继承该工作区的智能体。'
      }
    >
      <Select
        value={chatJid || '__default__'}
        onValueChange={(value) =>
          setChatJid(value === '__default__' ? '' : value)
        }
      >
        <SelectTrigger className="w-full" aria-label="所属工作区">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(!isScript || defaultWorkspaceMode === 'host') && (
            <SelectItem value="__default__">默认工作区</SelectItem>
          )}
          {(isScript ? scriptGroupEntries : sortedGroupEntries).map(
            ([jid, name]) => (
              <SelectItem key={jid} value={jid}>
                {formatGroupLabel(jid, name)}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </SettingsField>
  );

  const renderContextMode = () => (
    <SettingsField
      label="上下文模式"
      description={
        contextMode === 'isolated'
          ? '在所属工作区内使用任务专属会话执行，不影响主会话上下文。'
          : '把任务作为消息注入主会话，适合需要主会话连续上下文的任务。'
      }
    >
      <Select
        value={contextMode}
        onValueChange={(value) => setContextMode(value as 'group' | 'isolated')}
      >
        <SelectTrigger className="w-full" aria-label="上下文模式">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="isolated">独立任务会话（默认）</SelectItem>
          <SelectItem value="group">主会话执行</SelectItem>
        </SelectContent>
      </Select>
    </SettingsField>
  );

  const connectedKeys = CHANNEL_OPTIONS.filter(
    (c) => connectedChannels[c.key],
  ).map((c) => c.key);

  const isChannelSelected = (key: string) => {
    if (notifyChannels === null) return true;
    return notifyChannels.includes(key);
  };

  const toggleChannel = (key: string) => {
    setNotifyChannels((prev) => toggleNotifyChannel(prev, key, connectedKeys));
  };

  // --- AI mode handler ---
  const handleAiCreate = async () => {
    if (!aiDescription.trim()) return;
    setAiSubmitting(true);
    try {
      // AI mode always sends context_mode — the execution_type (agent/script)
      // is decided by the backend parser, not the client. If the parser
      // resolves to script, the backend ignores context_mode server-side.
      const body: Record<string, unknown> = {
        description: aiDescription.trim(),
        notify_channels: notifyChannels,
        context_mode: contextMode,
      };
      if (chatJid) {
        body.chat_jid = chatJid;
      }
      await api.post('/api/tasks/ai', body);
      showToast('任务已创建', 'AI 正在后台解析调度参数，稍后自动激活');
      onClose();
    } catch (error) {
      showToast(
        '创建失败',
        error instanceof Error ? error.message : '请稍后重试',
      );
    } finally {
      setAiSubmitting(false);
    }
  };

  // --- Manual mode handlers ---
  const validateForm = () => {
    const newErrors: Record<string, string> = {};
    if (isScript) {
      if (!formData.scriptCommand.trim())
        newErrors.scriptCommand = '请输入脚本命令';
      if (formData.executionMode !== 'host') {
        newErrors.executionMode = '脚本任务只能使用宿主机模式';
      }
      const selectedMode = chatJid
        ? groups[chatJid]?.execution_mode
        : defaultWorkspaceMode;
      if (selectedMode && selectedMode !== 'host') {
        newErrors.executionMode = '请选择管理员宿主机工作区';
      }
    } else {
      if (!formData.prompt.trim()) newErrors.prompt = '请输入 Prompt';
    }
    if (formData.scheduleType === 'cron') {
      if (!formData.scheduleValue.trim()) {
        newErrors.scheduleValue = '请输入 Cron 表达式';
      } else if (formData.scheduleValue.trim().split(' ').length < 5) {
        newErrors.scheduleValue = 'Cron 表达式格式错误（至少需要 5 个字段）';
      }
    } else if (formData.scheduleType === 'interval') {
      if (!intervalNumber.trim()) {
        newErrors.scheduleValue = '请输入间隔数值';
      } else {
        const num = parseInt(intervalNumber);
        if (isNaN(num) || num <= 0)
          newErrors.scheduleValue = '间隔必须是正整数';
      }
    } else if (formData.scheduleType === 'once') {
      if (!onceDateTime) {
        newErrors.scheduleValue = '请选择执行时间';
      } else {
        const date = new Date(onceDateTime);
        if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
          newErrors.scheduleValue = '请选择未来时间';
        }
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;
    let finalScheduleValue = formData.scheduleValue;
    if (formData.scheduleType === 'interval') {
      finalScheduleValue = String(
        parseInt(intervalNumber, 10) * parseInt(intervalUnit, 10),
      );
    } else if (formData.scheduleType === 'once') {
      finalScheduleValue = new Date(onceDateTime).toISOString();
    }
    setSubmitting(true);
    // Clear any lingering store error so we can detect whether this submit failed.
    useTasksStore.setState({ error: null });
    try {
      await onSubmit({
        prompt: formData.prompt,
        scheduleType: formData.scheduleType,
        scheduleValue: finalScheduleValue,
        executionType: formData.executionType,
        executionMode: executionModeExplicit
          ? formData.executionMode
          : undefined,
        scriptCommand: formData.scriptCommand,
        notifyChannels,
        chatJid: chatJid || undefined,
        contextMode: !isScript ? contextMode : undefined,
      });
      // The store swallows API errors into state.error; surface it as a toast
      // so the user sees why the submit failed. TasksPage keeps the form open
      // whenever state.error is set.
      const storeError = useTasksStore.getState().error;
      if (storeError) {
        showToast('创建失败', storeError);
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    } finally {
      setSubmitting(false);
    }
  };

  // --- Notify channels UI (shared) ---
  const connectedOptions = CHANNEL_OPTIONS.filter(
    (ch) => connectedChannels[ch.key],
  );

  const renderNotifyChannels = () => (
    <SettingsField
      label="通知渠道"
      description={
        connectedOptions.length === 0
          ? '未绑定任何 IM 渠道，任务结果仅在 Web 工作区展示'
          : '选择任务结果推送的 IM 渠道，默认推送到所有已连接渠道'
      }
    >
      <div className="flex flex-wrap gap-x-4 gap-y-2 py-1">
        <label className="inline-flex items-center gap-1.5 text-body text-muted-foreground">
          <Checkbox checked disabled />
          Web（始终）
        </label>
        {connectedOptions.map((ch) => (
          <label
            key={ch.key}
            className="inline-flex cursor-pointer items-center gap-1.5 text-body text-foreground"
          >
            <Checkbox
              checked={isChannelSelected(ch.key)}
              onCheckedChange={() => toggleChannel(ch.key)}
            />
            {ch.label}
          </label>
        ))}
      </div>
    </SettingsField>
  );

  const footer = (primary: ReactNode) => (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-surface-border bg-muted/40 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
      <Button type="button" variant="outline" onClick={onClose}>
        取消
      </Button>
      {primary}
    </div>
  );

  const fieldError = (message?: string) =>
    message ? <p className="text-caption text-error">{message}</p> : null;

  const content = (
    <Tabs
      value={mode}
      onValueChange={(value) => setMode(value as CreateMode)}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="shrink-0 border-b border-surface-border px-4 sm:px-5">
        <TabsList
          variant="line"
          aria-label="创建方式"
          className="h-10 gap-5 p-0 group-data-horizontal/tabs:h-10"
        >
          <TabsTrigger
            value="ai"
            className="flex-none px-0.5 group-data-horizontal/tabs:after:-bottom-px"
          >
            <Sparkles />
            AI 智能创建
          </TabsTrigger>
          <TabsTrigger
            value="manual"
            className="flex-none px-0.5 group-data-horizontal/tabs:after:-bottom-px"
          >
            <SlidersHorizontal />
            手动配置
          </TabsTrigger>
        </TabsList>
      </div>

      {/* AI Mode */}
      <TabsContent value="ai" className="flex min-h-0 flex-col">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5">
          <SettingsField
            label="用自然语言描述你的任务"
            description="AI 会自动解析调度时间和任务内容，创建后在后台完成解析"
            htmlFor="task-ai-description"
          >
            <Textarea
              id="task-ai-description"
              value={aiDescription}
              onChange={(e) => setAiDescription(e.target.value)}
              rows={4}
              className="field-sizing-fixed resize-none"
              placeholder="例如：每天早上 9 点帮我总结最新的科技新闻&#10;每周一下午 2 点检查项目依赖是否有安全更新&#10;每隔 2 小时检查一次服务器状态"
            />
          </SettingsField>

          {renderTargetWorkspace()}
          {renderContextMode()}
          {renderNotifyChannels()}
        </div>
        {footer(
          <Button
            onClick={handleAiCreate}
            disabled={aiSubmitting || !aiDescription.trim()}
          >
            {aiSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                创建中...
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                创建任务
              </>
            )}
          </Button>,
        )}
      </TabsContent>

      {/* Manual Mode */}
      <TabsContent value="manual" className="flex min-h-0 flex-col">
        <form
          onSubmit={handleManualSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5">
            {/* Execution Type */}
            {isAdmin && (
              <SettingsField
                label="执行方式"
                description={
                  isScript
                    ? '直接执行 Shell 命令，零 API 消耗，适合确定性任务'
                    : '启动完整 Claude Agent，消耗 API tokens'
                }
              >
                <Select
                  value={formData.executionType}
                  onValueChange={(value) =>
                    setFormData({
                      ...formData,
                      executionType: value as 'agent' | 'script',
                    })
                  }
                >
                  <SelectTrigger className="w-full" aria-label="执行方式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">智能体（AI 执行）</SelectItem>
                    <SelectItem value="script">脚本（Shell 命令）</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsField>
            )}

            {/* Execution Mode */}
            {isAdmin && (
              <SettingsField
                label="执行模式"
                description={
                  adminHostOnlyMode
                    ? '管理员纯宿主机模式已开启，任务固定在宿主机执行。'
                    : isScript
                      ? '脚本固定使用宿主机模式；Docker 容器脚本不会被执行。'
                      : executionModeExplicit
                        ? '已手动指定执行模式，不再跟随源工作区'
                        : '默认继承源工作区的执行模式，选择后将锁定不再自动同步'
                }
              >
                <Select
                  value={formData.executionMode}
                  disabled={isScript || adminHostOnlyMode}
                  onValueChange={(value) => {
                    setExecutionModeExplicit(true);
                    setFormData({
                      ...formData,
                      executionMode: value as 'host' | 'container',
                    });
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label="执行模式"
                    aria-invalid={!!errors.executionMode || undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="host">宿主机</SelectItem>
                    {!isScript && !adminHostOnlyMode && (
                      <SelectItem value="container">Docker 容器</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {fieldError(errors.executionMode)}
              </SettingsField>
            )}

            {renderTargetWorkspace()}
            {!isScript && renderContextMode()}

            {/* Script Command */}
            {isScript && (
              <SettingsField
                label={
                  <>
                    脚本命令 <RequiredMark />
                  </>
                }
                description="命令在所属工作区目录下执行，最大 4096 字符"
                htmlFor="task-script-command"
              >
                <Textarea
                  id="task-script-command"
                  value={formData.scriptCommand}
                  onChange={(e) =>
                    setFormData({ ...formData, scriptCommand: e.target.value })
                  }
                  rows={3}
                  maxLength={4096}
                  aria-invalid={!!errors.scriptCommand || undefined}
                  className="field-sizing-fixed resize-none font-mono text-sm"
                  placeholder="例如: curl -s https://api.example.com/health | jq .status"
                />
                {fieldError(errors.scriptCommand)}
              </SettingsField>
            )}

            {/* Prompt */}
            <SettingsField
              label={
                <>
                  {isScript ? '任务描述' : '任务 Prompt'}{' '}
                  {!isScript && <RequiredMark />}
                </>
              }
              htmlFor="task-prompt"
            >
              <Textarea
                id="task-prompt"
                value={formData.prompt}
                onChange={(e) =>
                  setFormData({ ...formData, prompt: e.target.value })
                }
                rows={isScript ? 2 : 4}
                aria-invalid={!!errors.prompt || undefined}
                className="field-sizing-fixed resize-none"
                placeholder={
                  isScript ? '可选的任务描述...' : '输入任务的提示词...'
                }
              />
              {fieldError(errors.prompt)}
            </SettingsField>

            <div className="grid gap-5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-3">
              {/* Schedule Type */}
              <SettingsField
                label={
                  <>
                    调度类型 <RequiredMark />
                  </>
                }
              >
                <Select
                  value={formData.scheduleType}
                  onValueChange={(value) => {
                    setIntervalNumber('');
                    setOnceDateTime('');
                    setFormData({
                      ...formData,
                      scheduleType: value as 'cron' | 'interval' | 'once',
                      scheduleValue: '',
                    });
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="调度类型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cron">Cron 表达式</SelectItem>
                    <SelectItem value="interval">间隔执行</SelectItem>
                    <SelectItem value="once">单次执行</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsField>

              {/* Schedule Value */}
              <SettingsField
                label={
                  <>
                    调度值 <RequiredMark />
                  </>
                }
                htmlFor="task-schedule-value"
              >
                {formData.scheduleType === 'cron' && (
                  <Input
                    id="task-schedule-value"
                    type="text"
                    value={formData.scheduleValue}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        scheduleValue: e.target.value,
                      })
                    }
                    aria-invalid={!!errors.scheduleValue || undefined}
                    className="font-mono"
                    placeholder="例如: 0 9 * * * (每天 9 点)"
                  />
                )}
                {formData.scheduleType === 'interval' && (
                  <div className="flex gap-2">
                    <Input
                      id="task-schedule-value"
                      type="number"
                      min="1"
                      value={intervalNumber}
                      onChange={(e) => setIntervalNumber(e.target.value)}
                      aria-invalid={!!errors.scheduleValue || undefined}
                      className="flex-1"
                      placeholder="数值"
                    />
                    <Select
                      value={intervalUnit}
                      onValueChange={setIntervalUnit}
                    >
                      <SelectTrigger className="w-24" aria-label="间隔单位">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INTERVAL_UNITS.map((u) => (
                          <SelectItem key={u.ms} value={String(u.ms)}>
                            {u.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {formData.scheduleType === 'once' && (
                  <Input
                    id="task-schedule-value"
                    type="datetime-local"
                    value={onceDateTime}
                    onChange={(e) => setOnceDateTime(e.target.value)}
                    aria-invalid={!!errors.scheduleValue || undefined}
                  />
                )}
                {fieldError(errors.scheduleValue)}
              </SettingsField>
            </div>
            <p className="-mt-3 text-caption text-muted-foreground">
              {formData.scheduleType === 'cron' && (
                <>
                  格式: 分 时 日 月 星期（北京时间 UTC+8）。常用:{' '}
                  <code className="rounded bg-muted px-1 font-mono">
                    */5 * * * *
                  </code>{' '}
                  每5分钟,{' '}
                  <code className="rounded bg-muted px-1 font-mono">
                    0 9 * * 1-5
                  </code>{' '}
                  工作日9点,{' '}
                  <code className="rounded bg-muted px-1 font-mono">
                    @daily
                  </code>{' '}
                  每天
                </>
              )}
              {formData.scheduleType === 'interval' && '设置任务执行间隔'}
              {formData.scheduleType === 'once' && '选择任务的执行时间'}
            </p>

            {renderNotifyChannels()}
          </div>
          {footer(
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting ? '创建中...' : '创建任务'}
            </Button>,
          )}
        </form>
      </TabsContent>
    </Tabs>
  );

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  if (!isDesktop) {
    return (
      <Sheet open onOpenChange={handleOpenChange}>
        <SheetContent
          side="bottom"
          className="flex max-h-[94dvh] flex-col gap-0 rounded-t-xl"
        >
          <div className="shrink-0 px-4 pt-4 pb-3 pr-12">
            <SheetTitle className="text-title">创建定时任务</SheetTitle>
            <SheetDescription className="sr-only">
              用自然语言或手动配置创建定时任务
            </SheetDescription>
          </div>
          {content}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="shrink-0 px-5 pt-5 pb-3 pr-12">
          <DialogTitle>创建定时任务</DialogTitle>
          <DialogDescription className="sr-only">
            用自然语言或手动配置创建定时任务
          </DialogDescription>
        </div>
        {content}
      </DialogContent>
    </Dialog>
  );
}
