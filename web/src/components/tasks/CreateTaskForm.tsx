import { useEffect, useState } from 'react';
import {
  Loader2,
  Sparkles,
  X,
  SlidersHorizontal,
  FileText,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { api } from '../../api/client';
import { showToast } from '../../utils/toast';
import {
  INTERVAL_UNITS,
  CHANNEL_OPTIONS,
  toggleNotifyChannel,
} from '../../utils/task-utils';
import { useConnectedChannels } from '../../hooks/useConnectedChannels';
import { useTasksStore } from '../../stores/tasks';
import { useGroupsStore } from '../../stores/groups';
import { formatGroupLabel } from '../settings/channel-meta';
import type {
  TaskTemplate,
  TemplateParameterDefinition,
  TaskDraft,
} from '../../types/task-templates';

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
  initialDraft?: TaskDraft | null;
}

type CreateMode = 'ai' | 'manual' | 'template';
const MODAL_SELECT_CONTENT_CLASS = 'z-[11020]';

export function CreateTaskForm({
  onSubmit,
  onClose,
  isAdmin,
  initialDraft,
}: CreateTaskFormProps) {
  const [mode, setMode] = useState<CreateMode>(
    initialDraft
      ? initialDraft.source_type === 'template'
        ? 'template'
        : 'manual'
      : 'ai',
  );

  // --- AI mode state ---
  const [aiDescription, setAiDescription] = useState('');
  const [aiSubmitting, setAiSubmitting] = useState(false);

  // --- Manual mode state ---
  const [formData, setFormData] = useState({
    prompt: initialDraft?.prompt || '',
    scheduleType: (initialDraft?.schedule_type || 'cron') as
      | 'cron'
      | 'interval'
      | 'once',
    scheduleValue: initialDraft?.schedule_value || '',
    executionType: (initialDraft?.execution_type || 'agent') as
      | 'agent'
      | 'script',
    executionMode: (initialDraft?.execution_mode ||
      (isAdmin ? 'host' : 'container')) as 'host' | 'container',
    scriptCommand: initialDraft?.script_command || '',
  });
  const [intervalNumber, setIntervalNumber] = useState('');
  const [intervalUnit, setIntervalUnit] = useState('60000');
  const [onceDateTime, setOnceDateTime] = useState(
    initialDraft?.schedule_type === 'once' && initialDraft.schedule_value
      ? initialDraft.schedule_value.slice(0, 16)
      : '',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // --- Template mode state (R18) ---
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [templateParams, setTemplateParams] = useState<Record<string, string>>(
    {},
  );
  const [previewPrompt, setPreviewPrompt] = useState<string>('');
  const [templateErrors, setTemplateErrors] = useState<string[]>([]);
  const [missingParams, setMissingParams] = useState<string[]>([]);

  // --- Shared state ---
  const [notifyChannels, setNotifyChannels] = useState<string[] | null>(null);
  const [chatJid, setChatJid] = useState<string>(
    initialDraft?.chat_jid || initialDraft?.suggested_workspace_jid || '',
  );
  const [contextMode, setContextMode] = useState<'group' | 'isolated'>(
    initialDraft?.context_mode || 'isolated',
  );
  const [executionModeExplicit, setExecutionModeExplicit] = useState<boolean>(
    !!initialDraft?.execution_mode,
  );
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
  }, [groupNames, groups, loadTasks, loadGroups]);

  // Load templates when switching to template mode
  useEffect(() => {
    if (mode === 'template') {
      setTemplatesLoading(true);
      api
        .get<{ templates: TaskTemplate[] }>('/api/task-templates')
        .then((res) => {
          setTemplates(res.templates || []);
          if (
            res.templates &&
            res.templates.length > 0 &&
            !selectedTemplateId
          ) {
            handleSelectTemplate(res.templates[0]);
          }
        })
        .catch((err) => {
          console.error('Failed to load templates:', err);
        })
        .finally(() => {
          setTemplatesLoading(false);
        });
    }
  }, [mode]);

  const handleSelectTemplate = (tpl: TaskTemplate) => {
    setSelectedTemplateId(tpl.id);
    const initialParams: Record<string, string> = {};
    for (const def of tpl.parameter_definitions) {
      initialParams[def.name] = def.default_value ?? '';
    }
    setTemplateParams(initialParams);
    setFormData((prev) => ({
      ...prev,
      scheduleType: tpl.default_schedule_type,
      scheduleValue: tpl.default_schedule_value,
      executionType: tpl.default_execution_type,
      executionMode:
        tpl.default_execution_mode || (isAdmin ? 'host' : 'container'),
      scriptCommand: '',
    }));
    setContextMode(tpl.default_context_mode);
    updatePreview(tpl, initialParams);
  };

  const updatePreview = (tpl: TaskTemplate, params: Record<string, string>) => {
    let rendered = tpl.prompt_template;
    const missing: string[] = [];
    for (const def of tpl.parameter_definitions) {
      const val = params[def.name];
      if ((val === undefined || val === '') && def.required) {
        missing.push(def.name);
      }
      const pattern = new RegExp(`\\{\\{\\s*${def.name}\\s*\\}\\}`, 'g');
      rendered = rendered.replace(
        pattern,
        val || `[待填写: ${def.label || def.name}]`,
      );
    }
    setPreviewPrompt(rendered);
    setMissingParams(missing);
  };

  const handleParamChange = (name: string, value: string) => {
    const updated = { ...templateParams, [name]: value };
    setTemplateParams(updated);
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (tpl) {
      updatePreview(tpl, updated);
    }
  };

  // Sync executionMode from selected workspace
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
    <div>
      <label className="block text-sm font-medium text-foreground mb-2">
        所属工作区 <span className="text-red-500">*</span>
      </label>
      <Select
        value={chatJid || '__default__'}
        onValueChange={(value) =>
          setChatJid(value === '__default__' ? '' : value)
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={MODAL_SELECT_CONTENT_CLASS}>
          {(!isScript || defaultWorkspaceMode === 'host') && (
            <SelectItem value="__default__">默认工作区 (我的主空间)</SelectItem>
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
      <p className="mt-1 text-xs text-muted-foreground">
        {isScript
          ? '脚本仅可选择管理员宿主机工作区，并直接在该宿主机目录中执行。'
          : '任务会在这个工作区的目录和环境中执行，显式选择目标工作区（不继承旧渠道绑定）。'}
      </p>
    </div>
  );

  const renderContextMode = () => (
    <div>
      <label className="block text-sm font-medium text-foreground mb-2">
        上下文模式
      </label>
      <Select
        value={contextMode}
        onValueChange={(value) => setContextMode(value as 'group' | 'isolated')}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={MODAL_SELECT_CONTENT_CLASS}>
          <SelectItem value="isolated">
            独立任务会话（推荐，不污染主会话）
          </SelectItem>
          <SelectItem value="group">主会话上下文（群聊公共会话）</SelectItem>
        </SelectContent>
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">
        {contextMode === 'isolated'
          ? '每次执行使用全新的独立会话，并在完成后归档结果。'
          : '任务将直接运行在工作区的主会话上下文中。'}
      </p>
    </div>
  );

  const isChannelSelected = (channelKey: string) => {
    return notifyChannels === null || notifyChannels.includes(channelKey);
  };

  const toggleChannel = (channelKey: string) => {
    setNotifyChannels((prev) =>
      toggleNotifyChannel(
        prev,
        channelKey,
        connectedOptions.map((ch) => ch.key),
      ),
    );
  };

  // --- AI mode submit ---
  const handleAiSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiDescription.trim()) return;
    setAiSubmitting(true);
    try {
      const res = await api.post<{
        success: boolean;
        taskId?: string;
        error?: string;
      }>('/api/tasks/ai', {
        description: aiDescription.trim(),
        chat_jid: chatJid || undefined,
        context_mode: contextMode,
        notify_channels: notifyChannels,
      });
      if (res.success) {
        showToast('任务已创建', '后台正在解析调度规则...');
        onClose();
        loadTasks();
      } else {
        showToast('创建失败', res.error || '未知错误');
      }
    } catch (err) {
      showToast(
        '创建失败',
        err instanceof Error ? err.message : '网络请求失败',
      );
    } finally {
      setAiSubmitting(false);
    }
  };

  // --- Manual mode validation ---
  const validateForm = () => {
    const newErrors: Record<string, string> = {};
    if (isScript) {
      if (!formData.scriptCommand.trim())
        newErrors.scriptCommand = '请输入脚本命令';
      if (formData.executionMode !== 'host') {
        newErrors.executionMode = '脚本任务只能使用宿主机模式';
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

  // --- Template mode submit (R18) ---
  const handleTemplateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (!tpl) {
      showToast('请选择模板', '当前未选择任何任务模板');
      return;
    }

    setSubmitting(true);
    setTemplateErrors([]);
    try {
      const res = await api.post<{
        success: boolean;
        rendered_prompt: string;
        error?: string;
        missing_parameters?: string[];
        validation_errors?: string[];
      }>(`/api/task-templates/${tpl.id}/instantiate`, {
        parameters: templateParams,
      });

      if (!res.success) {
        setTemplateErrors(
          res.validation_errors || [res.error || '模板实例化失败'],
        );
        showToast('参数校验未通过', res.error || '请检查必填参数');
        setSubmitting(false);
        return;
      }

      await onSubmit({
        prompt: res.rendered_prompt,
        scheduleType: tpl.default_schedule_type,
        scheduleValue: tpl.default_schedule_value,
        executionType: tpl.default_execution_type,
        executionMode:
          tpl.default_execution_mode || (isAdmin ? 'host' : 'container'),
        scriptCommand: '',
        notifyChannels,
        chatJid: chatJid || undefined,
        contextMode: !isScript ? contextMode : undefined,
      });

      const storeError = useTasksStore.getState().error;
      if (storeError) {
        showToast('创建失败', storeError);
      }
    } catch (err: unknown) {
      const apiErr = err as {
        body?: { validation_errors?: string[]; error?: string };
        message?: string;
      };
      const errMsgs = apiErr.body?.validation_errors || [
        apiErr.body?.error || apiErr.message || '实例化出错',
      ];
      setTemplateErrors(errMsgs);
      showToast('模板实例化错误', errMsgs.join(', '));
    } finally {
      setSubmitting(false);
    }
  };

  const connectedOptions = CHANNEL_OPTIONS.filter(
    (ch) => connectedChannels[ch.key],
  );

  const renderNotifyChannels = () => (
    <div>
      <label className="block text-sm font-medium text-foreground mb-2">
        通知渠道
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked disabled className="rounded" />
          Web（始终）
        </label>
        {connectedOptions.map((ch) => (
          <label
            key={ch.key}
            className="inline-flex items-center gap-1.5 text-sm cursor-pointer"
          >
            <input
              type="checkbox"
              checked={isChannelSelected(ch.key)}
              onChange={() => toggleChannel(ch.key)}
              className="rounded"
            />
            {ch.label}
          </label>
        ))}
      </div>
      {connectedOptions.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          未绑定任何 IM 渠道，任务结果仅在 Web 工作区展示
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          选择任务结果推送的 IM 渠道，默认推送到所有已连接渠道
        </p>
      )}
    </div>
  );

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  return (
    <div className="fixed inset-0 z-[11000] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[94vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-xl bg-card shadow-xl sm:max-h-[90vh] sm:rounded-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div>
            <h2 className="text-xl font-bold text-foreground">创建定时任务</h2>
            {initialDraft && (
              <p className="text-xs text-brand-600 dark:text-brand-400 mt-1">
                已从历史运行预填任务草稿（原渠道绑定已清除，请确认目标工作区与参数）
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Tabs */}
        <div className="flex border-b border-border">
          <button
            onClick={() => setMode('ai')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors cursor-pointer',
              mode === 'ai'
                ? 'text-primary border-b-2 border-primary bg-brand-50/50'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
          >
            <Sparkles className="w-4 h-4" />
            AI 智能创建
          </button>
          <button
            onClick={() => setMode('template')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors cursor-pointer',
              mode === 'template'
                ? 'text-primary border-b-2 border-primary bg-brand-50/50'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
          >
            <FileText className="w-4 h-4" />
            模板复用 (R18)
          </button>
          <button
            onClick={() => setMode('manual')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors cursor-pointer',
              mode === 'manual'
                ? 'text-primary border-b-2 border-primary bg-brand-50/50'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
          >
            <SlidersHorizontal className="w-4 h-4" />
            手动配置
          </button>
        </div>

        {/* Template Mode */}
        {mode === 'template' && (
          <form
            onSubmit={handleTemplateSubmit}
            className="space-y-4 overflow-y-auto p-4 sm:p-6"
          >
            {templatesLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                正在加载任务模板...
              </div>
            ) : templates.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <FileText className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p>暂无私有任务模板</p>
                <p className="text-xs mt-1">
                  可在任务运行结果详情页中将成功运行另存为模板。
                </p>
              </div>
            ) : (
              <>
                {/* Template Selection */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">
                    选择任务模板 <span className="text-red-500">*</span>
                  </label>
                  <Select
                    value={selectedTemplateId}
                    onValueChange={(val) => {
                      const found = templates.find((t) => t.id === val);
                      if (found) handleSelectTemplate(found);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="请选择模板" />
                    </SelectTrigger>
                    <SelectContent className={MODAL_SELECT_CONTENT_CLASS}>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name} {t.description ? `(${t.description})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedTemplate?.description && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {selectedTemplate.description}
                    </p>
                  )}
                </div>

                {/* Parameters Form */}
                {selectedTemplate &&
                  selectedTemplate.parameter_definitions.length > 0 && (
                    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
                      <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                        <SlidersHorizontal className="w-4 h-4 text-primary" />
                        参数输入与校验
                      </div>
                      {selectedTemplate.parameter_definitions.map(
                        (def: TemplateParameterDefinition) => (
                          <div key={def.name}>
                            <div className="flex items-center justify-between mb-1">
                              <label className="text-xs font-medium text-foreground">
                                {def.label || def.name}{' '}
                                {def.required && (
                                  <span className="text-red-500">*</span>
                                )}
                                <span className="text-muted-foreground font-mono ml-1">
                                  ({def.type})
                                </span>
                              </label>
                              {def.description && (
                                <span className="text-xs text-muted-foreground">
                                  {def.description}
                                </span>
                              )}
                            </div>
                            {def.type === 'date' ? (
                              <Input
                                type="date"
                                value={templateParams[def.name] || ''}
                                onChange={(e) =>
                                  handleParamChange(def.name, e.target.value)
                                }
                                className={cn(
                                  missingParams.includes(def.name) &&
                                    'border-red-500',
                                )}
                              />
                            ) : (
                              <Input
                                type={def.type === 'number' ? 'number' : 'text'}
                                value={templateParams[def.name] || ''}
                                onChange={(e) =>
                                  handleParamChange(def.name, e.target.value)
                                }
                                placeholder={
                                  def.default_value ||
                                  `请输入 ${def.label || def.name}`
                                }
                                className={cn(
                                  missingParams.includes(def.name) &&
                                    'border-red-500',
                                )}
                              />
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  )}

                {/* Template Validation Errors */}
                {templateErrors.length > 0 && (
                  <div className="rounded-lg border border-error/20 bg-error-bg p-3 text-sm text-error">
                    <div className="flex items-center gap-1.5 font-medium mb-1">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      参数校验未通过:
                    </div>
                    <ul className="list-disc list-inside text-xs space-y-0.5">
                      {templateErrors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Rendered Prompt Preview */}
                {previewPrompt && (
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
                      实时替换预览 Prompt
                    </label>
                    <div className="rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap text-foreground max-h-40 overflow-y-auto">
                      {previewPrompt}
                    </div>
                  </div>
                )}

                {renderTargetWorkspace()}
                {!isScript && renderContextMode()}
                {renderNotifyChannels()}

                {/* Actions */}
                <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-card px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 sm:pb-0">
                  <Button type="button" variant="outline" onClick={onClose}>
                    取消
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting && (
                      <Loader2 className="size-4 animate-spin mr-1.5" />
                    )}
                    {submitting ? '实例化并创建中...' : '使用模板创建任务'}
                  </Button>
                </div>
              </>
            )}
          </form>
        )}

        {/* AI Mode */}
        {mode === 'ai' && (
          <div className="space-y-4 overflow-y-auto p-4 sm:p-6">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                用自然语言描述你的任务
              </label>
              <Textarea
                value={aiDescription}
                onChange={(e) => setAiDescription(e.target.value)}
                rows={4}
                className="resize-none"
                placeholder="例如: 每天早上 9 点抓取 GitHub 趋势榜并总结成中文发送给我"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                AI 会自动解析你的意图，提取执行内容、调度周期等参数
              </p>
            </div>

            {renderTargetWorkspace()}
            {renderContextMode()}
            {renderNotifyChannels()}

            <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-card px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 sm:pb-0">
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button
                onClick={handleAiSubmit}
                disabled={!aiDescription.trim() || aiSubmitting}
              >
                {aiSubmitting && (
                  <Loader2 className="size-4 animate-spin mr-1.5" />
                )}
                {aiSubmitting ? '解析中...' : 'AI 解析并创建'}
              </Button>
            </div>
          </div>
        )}

        {/* Manual Mode */}
        {mode === 'manual' && (
          <form
            onSubmit={handleManualSubmit}
            className="space-y-4 overflow-y-auto p-4 sm:p-6"
          >
            {/* Prompt */}
            {!isScript && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  任务 Prompt <span className="text-red-500">*</span>
                </label>
                <Textarea
                  value={formData.prompt}
                  onChange={(e) =>
                    setFormData({ ...formData, prompt: e.target.value })
                  }
                  rows={4}
                  className={cn(
                    'resize-none',
                    errors.prompt && 'border-red-500',
                  )}
                  placeholder="任务触发时发送给智能体的指令"
                />
                {errors.prompt && (
                  <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                    {errors.prompt}
                  </p>
                )}
              </div>
            )}

            {/* Execution Type (admin only) */}
            {isAdmin && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  执行类型
                </label>
                <Select
                  value={formData.executionType}
                  onValueChange={(value) =>
                    setFormData({
                      ...formData,
                      executionType: value as 'agent' | 'script',
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={MODAL_SELECT_CONTENT_CLASS}>
                    <SelectItem value="agent">智能体（AI 执行）</SelectItem>
                    <SelectItem value="script">脚本（Shell 命令）</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {isScript
                    ? '直接执行 Shell 命令，零 API 消耗，适合确定性任务'
                    : '启动完整 Claude Agent，消耗 API tokens'}
                </p>
              </div>
            )}

            {/* Execution Mode */}
            {isAdmin && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  执行模式
                </label>
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
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={MODAL_SELECT_CONTENT_CLASS}>
                    <SelectItem value="host">宿主机</SelectItem>
                    {!isScript && !adminHostOnlyMode && (
                      <SelectItem value="container">Docker 容器</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {adminHostOnlyMode
                    ? '管理员纯宿主机模式已开启，任务固定在宿主机执行。'
                    : isScript
                      ? '脚本固定使用宿主机模式；Docker 容器脚本不会被执行。'
                      : executionModeExplicit
                        ? '已手动指定执行模式，不再跟随源工作区'
                        : '默认继承源工作区的执行模式，选择后将锁定不再自动同步'}
                </p>
                {errors.executionMode && (
                  <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                    {errors.executionMode}
                  </p>
                )}
              </div>
            )}

            {renderTargetWorkspace()}
            {!isScript && renderContextMode()}

            {/* Script Command */}
            {isScript && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  脚本命令 <span className="text-red-500">*</span>
                </label>
                <Textarea
                  value={formData.scriptCommand}
                  onChange={(e) =>
                    setFormData({ ...formData, scriptCommand: e.target.value })
                  }
                  rows={3}
                  maxLength={4096}
                  className={cn(
                    'resize-none font-mono text-sm',
                    errors.scriptCommand && 'border-red-500',
                  )}
                  placeholder="例如: curl -s https://api.example.com/health | jq .status"
                />
                {errors.scriptCommand && (
                  <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                    {errors.scriptCommand}
                  </p>
                )}
              </div>
            )}

            {/* Schedule Type */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                调度类型 <span className="text-red-500">*</span>
              </label>
              <Select
                value={formData.scheduleType}
                onValueChange={(value) =>
                  setFormData({
                    ...formData,
                    scheduleType: value as 'cron' | 'interval' | 'once',
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={MODAL_SELECT_CONTENT_CLASS}>
                  <SelectItem value="cron">Cron 表达式</SelectItem>
                  <SelectItem value="interval">固定间隔</SelectItem>
                  <SelectItem value="once">单次执行</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Schedule Value */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                调度时间 <span className="text-red-500">*</span>
              </label>
              {formData.scheduleType === 'cron' && (
                <>
                  <Input
                    type="text"
                    value={formData.scheduleValue}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        scheduleValue: e.target.value,
                      })
                    }
                    className={cn(errors.scheduleValue && 'border-red-500')}
                    placeholder="例如: 0 9 * * * (每天 9 点)"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    格式: 分 时 日 月 星期（北京时间 UTC+8）。
                  </p>
                </>
              )}
              {formData.scheduleType === 'interval' && (
                <>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min="1"
                      value={intervalNumber}
                      onChange={(e) => setIntervalNumber(e.target.value)}
                      className={cn(
                        'flex-1',
                        errors.scheduleValue && 'border-red-500',
                      )}
                      placeholder="数值"
                    />
                    <Select
                      value={intervalUnit}
                      onValueChange={setIntervalUnit}
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={MODAL_SELECT_CONTENT_CLASS}>
                        {INTERVAL_UNITS.map((u) => (
                          <SelectItem key={u.ms} value={String(u.ms)}>
                            {u.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    设置任务执行间隔
                  </p>
                </>
              )}
              {formData.scheduleType === 'once' && (
                <>
                  <Input
                    type="datetime-local"
                    value={onceDateTime}
                    onChange={(e) => setOnceDateTime(e.target.value)}
                    className={cn(errors.scheduleValue && 'border-red-500')}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    选择任务的执行时间
                  </p>
                </>
              )}
              {errors.scheduleValue && (
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                  {errors.scheduleValue}
                </p>
              )}
            </div>

            {renderNotifyChannels()}

            {/* Actions */}
            <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-card px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:px-6 sm:pb-0">
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && (
                  <Loader2 className="size-4 animate-spin mr-1.5" />
                )}
                {submitting ? '创建中...' : '创建任务'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
