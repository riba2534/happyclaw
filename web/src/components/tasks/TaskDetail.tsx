import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  Eye,
  Pencil,
  RefreshCw,
  X,
  FileText,
  Download,
  Copy,
  PlusCircle,
  ArrowRight,
  ShieldCheck,
  Package,
} from 'lucide-react';
import { api } from '../../api/client';
import { CreateTaskForm } from './CreateTaskForm';
import type {
  TaskRunArtifact,
  TaskDraft,
  TemplateParameterDefinition,
} from '../../types/task-templates';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { ScheduledTask, TaskRunLog, useTasksStore } from '../../stores/tasks';
import type { ApiError } from '../../api/client';
import { showToast } from '../../utils/toast';
import {
  INTERVAL_UNITS,
  formatContextMode,
  formatInterval,
  decomposeInterval,
  toggleNotifyChannel,
} from '../../utils/task-utils';
import { useConnectedChannels } from '../../hooks/useConnectedChannels';
import { useGroupsStore } from '../../stores/groups';
import { useAuthStore } from '../../stores/auth';
import { getWorkspaceExecutionMode } from '../../utils/agent-product';
import {
  buildTaskWorkspacePatch,
  canSelectTaskExecutionMode,
  type TaskExecutionMode,
} from '../../utils/task-edit';
import {
  ChannelBadge,
  CHANNEL_LABEL,
  formatGroupLabel,
} from '../settings/channel-meta';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import type { TaskBudgetConfig, TaskBudgetStatus } from '../../types';

interface TaskDetailProps {
  task: ScheduledTask;
}

const LOG_STATUS_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  budget_exceeded: {
    bg: 'bg-amber-100 dark:bg-amber-900/40',
    text: 'text-amber-700 dark:text-amber-300',
    label: '预算超限（可恢复）',
  },
  queued: {
    bg: 'bg-slate-100 dark:bg-slate-800/60',
    text: 'text-slate-700 dark:text-slate-300',
    label: '已排队',
  },
  running: {
    bg: 'bg-blue-100 dark:bg-blue-900/40',
    text: 'text-blue-700 dark:text-blue-300',
    label: '运行中',
  },
  recovering: {
    bg: 'bg-blue-100 dark:bg-blue-900/40',
    text: 'text-blue-700 dark:text-blue-300',
    label: '正在恢复',
  },
  retry_wait: {
    bg: 'bg-amber-100 dark:bg-amber-900/40',
    text: 'text-amber-700 dark:text-amber-300',
    label: '等待重试',
  },
  success: {
    bg: 'bg-green-100 dark:bg-green-900/40',
    text: 'text-green-700 dark:text-green-300',
    label: '成功',
  },
  error: {
    bg: 'bg-red-100 dark:bg-red-900/40',
    text: 'text-red-700 dark:text-red-300',
    label: '失败',
  },
  failed: {
    bg: 'bg-red-100 dark:bg-red-900/40',
    text: 'text-red-700 dark:text-red-300',
    label: '失败',
  },
  cancelled: {
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    label: '已取消',
  },
  missed: {
    bg: 'bg-amber-100 dark:bg-amber-900/40',
    text: 'text-amber-700 dark:text-amber-300',
    label: '已错过',
  },
  delivered: {
    bg: 'bg-cyan-100 dark:bg-cyan-900/40',
    text: 'text-cyan-700 dark:text-cyan-300',
    label: '已投递到主会话',
  },
};

const TRIGGER_LABEL: Record<string, string> = {
  scheduled: '计划触发',
  manual: '立即运行',
  backfill: '恢复补跑',
  retry: '自动重试',
};

const NOTIFICATION_LABEL: Record<string, string> = {
  pending: '待发送',
  success: '发送成功',
  partial_failed: '部分失败',
  failed: '发送失败',
  uncertain: '送达待确认',
  skipped: '无需通知',
};

function RunLogStatusBadge({ status }: { status: string }) {
  const style = LOG_STATUS_STYLES[status] || {
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    label: status,
  };
  return (
    <span
      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${style.bg} ${style.text}`}
    >
      {style.label}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export function TaskDetail({ task }: TaskDetailProps) {
  const { updateTask, loadLogs, logs } = useTasksStore();

  const connectedChannels = useConnectedChannels();
  const groupNames = useTasksStore((s) => s.groupNames);
  const executionRole = useAuthStore((state) =>
    state.user?.role === 'admin' ? 'admin' : 'member',
  );
  const isAdmin = executionRole === 'admin';
  const groups = useGroupsStore((state) => state.groups);
  const adminHostOnlyMode = useGroupsStore((state) => state.adminHostOnlyMode);
  const groupsLoading = useGroupsStore((state) => state.loading);
  const groupsError = useGroupsStore((state) => state.error);
  const loadGroups = useGroupsStore((state) => state.loadGroups);
  const taskLogs = logs[task.id] || [];
  const [logsLoading, setLogsLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<TaskRunLog | null>(null);

  // R18 & R19 states
  const [artifacts, setArtifacts] = useState<TaskRunArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  const [activeDraft, setActiveDraft] = useState<TaskDraft | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showSaveTemplateDialog, setShowSaveTemplateDialog] = useState(false);
  const [templateCandidate, setTemplateCandidate] = useState<{
    name: string;
    description: string;
    prompt_template: string;
    parameter_definitions: TemplateParameterDefinition[];
  }>({
    name: '',
    description: '',
    prompt_template: '',
    parameter_definitions: [],
  });
  const [savingTemplate, setSavingTemplate] = useState(false);

  useEffect(() => {
    if (selectedLog && selectedLog.id) {
      setArtifactsLoading(true);
      setSelectedArtifactIds([]);
      api
        .get<{ artifacts: TaskRunArtifact[] }>(
          `/api/tasks/runs/${selectedLog.id}/artifacts`,
        )
        .then((res) => {
          setArtifacts(res.artifacts || []);
          if (res.artifacts && res.artifacts.length > 0) {
            setSelectedArtifactIds(res.artifacts.map((a) => a.id));
          }
        })
        .catch(() => setArtifacts([]))
        .finally(() => setArtifactsLoading(false));
    }
  }, [selectedLog]);

  const handleDownloadArtifact = async (
    runId: string | number,
    artifact: TaskRunArtifact,
  ) => {
    try {
      const downloadUrl = `/api/tasks/runs/${runId}/artifacts/${artifact.id}/download`;
      const res = await fetch(downloadUrl, { credentials: 'include' });
      if (!res.ok) {
        let errMsg = '下载失败';
        try {
          const json = await res.json();
          errMsg = json.error || errMsg;
        } catch {
          /* ignore */
        }
        showToast('下载失败', errMsg);
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = artifact.name;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      showToast('开始下载', `已保存交付文件: ${artifact.name}`);
    } catch (err) {
      showToast('下载出错', err instanceof Error ? err.message : '网络异常');
    }
  };

  const handleCreateDraftFromRun = async (runId: string | number) => {
    try {
      const res = await api.post<{
        success: boolean;
        draft: TaskDraft;
        template_candidate: unknown;
      }>(`/api/task-templates/from-run/${runId}`);
      if (res.success && res.draft) {
        setActiveDraft(res.draft);
        setShowCreateForm(true);
      }
    } catch (err) {
      showToast(
        '生成草稿失败',
        err instanceof Error ? err.message : '请求异常',
      );
    }
  };

  const handleOpenSaveTemplate = async (runId: string | number) => {
    try {
      const res = await api.post<{
        success: boolean;
        draft: TaskDraft;
        template_candidate: {
          prompt_template: string;
          parameter_definitions: TemplateParameterDefinition[];
        };
      }>(`/api/task-templates/from-run/${runId}`);
      if (res.success && res.template_candidate) {
        const firstLine = (task.prompt || '')
          .split('\n')[0]
          .trim()
          .slice(0, 20);
        setTemplateCandidate({
          name: `${firstLine || '任务'} 模板`,
          description: `基于任务运行 (${runId}) 创建的私有模板`,
          prompt_template: res.template_candidate.prompt_template,
          parameter_definitions:
            res.template_candidate.parameter_definitions || [],
        });
        setShowSaveTemplateDialog(true);
      }
    } catch (err) {
      showToast(
        '提取模板失败',
        err instanceof Error ? err.message : '请求异常',
      );
    }
  };

  const handleSaveTemplateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !templateCandidate.name.trim() ||
      !templateCandidate.prompt_template.trim()
    ) {
      showToast('请填写必填项', '模板名称和提示词模板不能为空');
      return;
    }
    setSavingTemplate(true);
    try {
      const res = await api.post<{ success: boolean; template?: unknown }>(
        '/api/task-templates',
        {
          name: templateCandidate.name.trim(),
          description: templateCandidate.description.trim(),
          prompt_template: templateCandidate.prompt_template,
          parameter_definitions: templateCandidate.parameter_definitions,
          default_schedule_type: task.schedule_type,
          default_schedule_value: task.schedule_value,
          default_context_mode: task.context_mode,
          default_execution_type: task.execution_type,
          default_execution_mode: task.execution_mode,
        },
      );
      if (res.success) {
        showToast('保存成功', '已创建当前用户私有任务模板');
        setShowSaveTemplateDialog(false);
      }
    } catch (err) {
      showToast(
        '保存模板失败',
        err instanceof Error ? err.message : '网络请求失败',
      );
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleCreateContinuationDraft = async (runId: string | number) => {
    if (selectedArtifactIds.length === 0) {
      showToast('未选择产物', '请勾选至少一个交付产物文件');
      return;
    }
    try {
      const res = await api.post<{
        success: boolean;
        draft: TaskDraft;
        referenced_artifacts: unknown[];
      }>(`/api/tasks/runs/${runId}/draft-continuation`, {
        artifact_ids: selectedArtifactIds,
      });
      if (res.success && res.draft) {
        setActiveDraft(res.draft);
        setShowCreateForm(true);
        showToast(
          '已生成接续任务草稿',
          `已准确引用 ${res.referenced_artifacts?.length || 0} 个交付产物版本`,
        );
      }
    } catch (err) {
      showToast(
        '生成接续任务草稿失败',
        err instanceof Error ? err.message : '请求异常',
      );
    }
  };

  useEffect(() => {
    loadLogs(task.id);
  }, [
    task.id,
    task.current_run?.updated_at,
    task.last_run_summary?.updated_at,
    loadLogs,
  ]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const handleRefreshLogs = async () => {
    setLogsLoading(true);
    try {
      await loadLogs(task.id);
    } finally {
      setLogsLoading(false);
    }
  };

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [budgetStatus, setBudgetStatus] = useState<TaskBudgetStatus | null>(
    null,
  );
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [resumeExtraDuration, setResumeExtraDuration] = useState('10');
  const [resumeExtraToolCalls, setResumeExtraToolCalls] = useState('20');
  const [resumeExtraCost, setResumeExtraCost] = useState('0.5');
  const [resumingBudget, setResumingBudget] = useState(false);
  const [editBudget, setEditBudget] = useState<TaskBudgetConfig | null>(
    task.budget ?? null,
  );

  useEffect(() => {
    void useTasksStore
      .getState()
      .getTaskBudget(task.id)
      .then((res) => {
        if (res?.budgetStatus) {
          setBudgetStatus(res.budgetStatus);
        }
      });
  }, [
    task.id,
    task.current_run?.updated_at,
    task.last_run_summary?.updated_at,
  ]);

  const handleResumeBudget = async () => {
    setResumingBudget(true);
    try {
      await useTasksStore.getState().resumeTaskBudget(task.id, {
        additionalDurationMs: resumeExtraDuration
          ? Number(resumeExtraDuration) * 60 * 1000
          : undefined,
        additionalToolCalls: resumeExtraToolCalls
          ? Number(resumeExtraToolCalls)
          : undefined,
        additionalCostUsd: resumeExtraCost
          ? Number(resumeExtraCost)
          : undefined,
      });
      showToast('恢复成功', '已追加预算并恢复任务执行');
      setResumeDialogOpen(false);
      loadLogs(task.id);
      const updated = await useTasksStore.getState().getTaskBudget(task.id);
      if (updated?.budgetStatus) setBudgetStatus(updated.budgetStatus);
    } catch (err) {
      showToast('恢复失败', String(err));
    } finally {
      setResumingBudget(false);
    }
  };
  const [editForm, setEditForm] = useState({
    prompt: task.prompt,
    script_command: task.script_command || '',
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    notify_channels: task.notify_channels ?? null,
    chat_jid: task.chat_jid,
    execution_mode: (task.execution_type === 'script'
      ? 'host'
      : (task.execution_mode ?? 'container')) as TaskExecutionMode,
    context_mode: task.context_mode,
  });

  // Interval editing: decompose ms into number + unit
  const initialInterval = useMemo(
    () => decomposeInterval(task.schedule_value),
    [task.schedule_value],
  );
  const [intervalNum, setIntervalNum] = useState(initialInterval.num);
  const [intervalUnit, setIntervalUnit] = useState(initialInterval.unitMs);

  // Sync form when task prop changes (e.g. after save)
  useEffect(() => {
    if (!editing) {
      setEditForm({
        prompt: task.prompt,
        script_command: task.script_command || '',
        schedule_type: task.schedule_type,
        schedule_value: task.schedule_value,
        notify_channels: task.notify_channels ?? null,
        chat_jid: task.chat_jid,
        execution_mode: (task.execution_type === 'script'
          ? 'host'
          : (task.execution_mode ?? 'container')) as TaskExecutionMode,
        context_mode: task.context_mode,
      });
      const decomposed = decomposeInterval(task.schedule_value);
      setIntervalNum(decomposed.num);
      setIntervalUnit(decomposed.unitMs);
    }
  }, [task, editing]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const fields: Record<string, unknown> = {};
      if (editForm.prompt !== task.prompt) fields.prompt = editForm.prompt;
      if (editForm.script_command !== (task.script_command || ''))
        fields.script_command = editForm.script_command || null;
      if (editForm.schedule_type !== task.schedule_type)
        fields.schedule_type = editForm.schedule_type;
      // For interval type, compute ms from number + unit
      const effectiveValue =
        editForm.schedule_type === 'interval' && intervalNum
          ? String(parseInt(intervalNum, 10) * parseInt(intervalUnit, 10))
          : editForm.schedule_value;
      if (effectiveValue !== task.schedule_value)
        fields.schedule_value = effectiveValue;
      // notify_channels: compare serialized
      const oldChannels = JSON.stringify(task.notify_channels ?? null);
      const newChannels = JSON.stringify(editForm.notify_channels);
      if (oldChannels !== newChannels)
        fields.notify_channels = editForm.notify_channels;
      Object.assign(
        fields,
        buildTaskWorkspacePatch({
          currentChatJid: task.chat_jid,
          currentExecutionMode: task.execution_mode,
          targetChatJid: editForm.chat_jid,
          targetExecutionMode: editForm.execution_mode,
        }),
      );
      if (editForm.context_mode !== task.context_mode)
        fields.context_mode = editForm.context_mode;
      if (JSON.stringify(editBudget) !== JSON.stringify(task.budget ?? null))
        fields.budget = editBudget;

      if (Object.keys(fields).length > 0) {
        await updateTask(task.id, fields);
        showToast('保存成功', '任务已更新');
      }
      setEditing(false);
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.status === 409) {
        showToast(
          '任务已被其他操作修改',
          '为避免覆盖最新配置，已退出编辑并重新加载。',
        );
        setEditing(false);
        await useTasksStore.getState().loadTasks();
      } else {
        showToast('保存失败', apiError.message || '请稍后重试');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditForm({
      prompt: task.prompt,
      script_command: task.script_command || '',
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      notify_channels: task.notify_channels ?? null,
      chat_jid: task.chat_jid,
      execution_mode: (task.execution_type === 'script'
        ? 'host'
        : (task.execution_mode ?? 'container')) as TaskExecutionMode,
      context_mode: task.context_mode,
    });
    const decomposed = decomposeInterval(task.schedule_value);
    setIntervalNum(decomposed.num);
    setIntervalUnit(decomposed.unitMs);
    setEditing(false);
  };

  const connectedKeys = Object.keys(connectedChannels).filter(
    (k) => connectedChannels[k],
  );

  const toggleChannel = (ch: string) => {
    setEditForm((prev) => ({
      ...prev,
      notify_channels: toggleNotifyChannel(
        prev.notify_channels,
        ch,
        connectedKeys,
      ),
    }));
  };

  const formatDate = (timestamp: string | null | undefined) => {
    if (!timestamp) return '-';
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return timestamp;
    return parsed.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const scheduleLabel = () => {
    const type = editing ? editForm.schedule_type : task.schedule_type;
    if (type === 'cron') return 'Cron 表达式';
    if (type === 'interval') return '执行间隔';
    if (type === 'once') return '执行时间';
    return '调度值';
  };

  const formatScheduleValue = (type: string, value: string) => {
    if (type === 'interval') return formatInterval(value);
    if (type === 'once') return formatDate(value);
    return value; // cron — show raw expression
  };

  const isChannelSelected = (ch: string) => {
    if (editForm.notify_channels === null) return true;
    return editForm.notify_channels.includes(ch);
  };

  const renderNotifyChannelsBadges = () => {
    const channels = task.notify_channels;
    // null means all connected channels
    if (channels === null || channels === undefined) {
      const connectedKeys = Object.entries(connectedChannels)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return (
        <div className="flex flex-wrap gap-1">
          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
            Web
          </span>
          {connectedKeys.map((key) => (
            <span
              key={key}
              className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-primary"
            >
              {CHANNEL_LABEL[key] || key}
            </span>
          ))}
        </div>
      );
    }
    if (channels.length === 0) {
      return (
        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
          仅 Web
        </span>
      );
    }
    return (
      <div className="flex flex-wrap gap-1">
        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
          Web
        </span>
        {channels.map((ch) => (
          <span
            key={ch}
            className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-primary"
          >
            {CHANNEL_LABEL[ch] || ch}
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="p-4 bg-background space-y-4">
      {/* Edit Toggle */}
      <div className="flex items-center justify-end gap-2">
        {editing ? (
          <>
            <button
              onClick={handleCancel}
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" /> 取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-primary hover:bg-primary/90 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" /> {saving ? '保存中...' : '保存'}
            </button>
          </>
        ) : task.deleted_at || task.permissions?.can_edit === false ? null : (
          <button
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-primary hover:bg-brand-50 rounded-lg transition-colors cursor-pointer"
          >
            <Pencil className="w-3.5 h-3.5" /> 编辑
          </button>
        )}
      </div>

      {task.permissions && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 text-sm font-medium text-foreground">
            权限与执行范围
          </div>
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">文件范围：</span>
              当前工作区目录
            </div>
            <div>
              <span className="text-muted-foreground">执行环境：</span>
              {task.permissions.execution_scope === 'workspace_host'
                ? '宿主机'
                : 'Docker 容器'}
            </div>
            <div>
              <span className="text-muted-foreground">上下文：</span>
              {formatContextMode(task.context_mode)}
            </div>
            <div>
              <span className="text-muted-foreground">可执行操作：</span>
              {task.permissions.can_run ? '可运行' : '仅查看'}
            </div>
          </div>
          {task.permissions.risk_level === 'high' && (
            <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              高权限任务：可在宿主机执行 Shell 命令，仅管理员可以修改或运行。
            </p>
          )}
        </div>
      )}

      {/* Script Command (script mode) */}
      {task.execution_type === 'script' && (
        <div>
          <div className="text-xs text-muted-foreground mb-2">脚本命令</div>
          {editing ? (
            <textarea
              value={editForm.script_command}
              onChange={(e) =>
                setEditForm({ ...editForm, script_command: e.target.value })
              }
              rows={3}
              maxLength={4096}
              className="w-full text-sm text-foreground bg-card px-3 py-2 rounded border border-border font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            task.script_command && (
              <pre className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border whitespace-pre-wrap font-mono">
                {task.script_command}
              </pre>
            )
          )}
        </div>
      )}

      {/* Full Prompt / Description */}
      <div>
        <div className="text-xs text-muted-foreground mb-2">
          {task.execution_type === 'script' ? '任务描述' : '完整 Prompt'}
        </div>
        {editing ? (
          <textarea
            value={editForm.prompt}
            onChange={(e) =>
              setEditForm({ ...editForm, prompt: e.target.value })
            }
            rows={6}
            className="w-full text-sm text-foreground bg-card px-3 py-2 rounded border border-border resize-y min-h-[160px] max-h-[400px] overflow-y-auto focus:outline-none focus:ring-1 focus:ring-primary"
          />
        ) : (
          task.prompt && (
            <div className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border whitespace-pre-wrap max-h-[300px] overflow-y-auto">
              {task.prompt}
            </div>
          )
        )}
      </div>

      {/* Schedule Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-muted-foreground mb-1">执行方式</div>
          <div className="text-sm text-foreground">
            {task.execution_type === 'script' ? '脚本' : '智能体'}
          </div>
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">调度类型</div>
          {editing ? (
            <select
              value={editForm.schedule_type}
              onChange={(e) =>
                setEditForm({
                  ...editForm,
                  schedule_type: e.target.value as 'cron' | 'interval' | 'once',
                })
              }
              className="w-full text-sm text-foreground bg-card px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="cron">Cron 表达式</option>
              <option value="interval">间隔执行</option>
              <option value="once">单次执行</option>
            </select>
          ) : (
            <div className="text-sm text-foreground">
              {task.schedule_type === 'cron' && 'Cron 表达式'}
              {task.schedule_type === 'interval' && '间隔执行'}
              {task.schedule_type === 'once' && '单次执行'}
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">
            {scheduleLabel()}
          </div>
          {editing && isAdmin ? (
            <>
              {editForm.schedule_type === 'interval' ? (
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="1"
                    value={intervalNum}
                    onChange={(e) => setIntervalNum(e.target.value)}
                    className="flex-1 text-sm text-foreground bg-card px-2 py-1 rounded border border-border font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="数值"
                  />
                  <select
                    value={intervalUnit}
                    onChange={(e) => setIntervalUnit(e.target.value)}
                    className="w-20 text-sm text-foreground bg-card px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {INTERVAL_UNITS.map((u) => (
                      <option key={u.ms} value={String(u.ms)}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <input
                  type="text"
                  value={editForm.schedule_value}
                  onChange={(e) =>
                    setEditForm({ ...editForm, schedule_value: e.target.value })
                  }
                  className="w-full text-sm text-foreground bg-card px-2 py-1 rounded border border-border font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
              )}
              {editForm.schedule_type === 'cron' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  格式: 分 时 日 月 星期（北京时间）
                </p>
              )}
            </>
          ) : (
            <div className="text-sm text-foreground">
              {task.schedule_type === 'cron' ? (
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                  {task.schedule_value}
                </code>
              ) : (
                formatScheduleValue(task.schedule_type, task.schedule_value)
              )}
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">下次运行</div>
          <div className="text-sm text-foreground">
            {formatDate(task.next_run)}
          </div>
        </div>

        {task.last_run && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">上次运行</div>
            <div className="text-sm text-foreground">
              {formatDate(task.last_run)}
            </div>
          </div>
        )}

        <div>
          <div className="text-xs text-muted-foreground mb-1">执行模式</div>
          {editing && isAdmin ? (
            <>
              <select
                value={editForm.execution_mode}
                disabled={task.execution_type === 'script' || adminHostOnlyMode}
                onChange={(event) =>
                  setEditForm({
                    ...editForm,
                    execution_mode: event.target.value as TaskExecutionMode,
                  })
                }
                className="w-full text-sm text-foreground bg-card px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="host">宿主机</option>
                {task.execution_type !== 'script' && !adminHostOnlyMode && (
                  <option value="container">Docker 容器</option>
                )}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {adminHostOnlyMode
                  ? '管理员纯宿主机模式已开启，任务固定在宿主机执行。'
                  : task.execution_type === 'script'
                    ? '脚本固定为宿主机模式；必须同时选择管理员宿主机工作区。'
                    : '切换工作区时会自动继承目标工作区模式，也可在保存前手动调整。'}
              </p>
            </>
          ) : (
            <>
              <div className="text-sm text-foreground">
                {(editing ? editForm.execution_mode : task.execution_mode) ===
                'host'
                  ? '宿主机'
                  : 'Docker 容器'}
              </div>
              {editing && !isAdmin && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {editForm.execution_mode === 'host'
                    ? '这是旧版宿主机任务；成员只能查看，执行模式仅管理员可修改。'
                    : '成员任务固定使用 Docker 容器；宿主机模式仅管理员可用。'}
                </p>
              )}
            </>
          )}
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">会话模式</div>
          {editing ? (
            <select
              value={editForm.context_mode}
              onChange={(e) =>
                setEditForm({
                  ...editForm,
                  context_mode: e.target.value as 'group' | 'isolated',
                })
              }
              className="w-full text-sm text-foreground bg-card px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="isolated">独立任务会话</option>
              <option value="group">主会话执行</option>
            </select>
          ) : (
            <div className="text-sm text-foreground">
              {formatContextMode(task.context_mode)}
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">所属工作区</div>
          {editing ? (
            <>
              <select
                value={editForm.chat_jid}
                onChange={(event) => {
                  const chatJid = event.target.value;
                  const targetExecutionMode = getWorkspaceExecutionMode(
                    groups,
                    chatJid,
                  );
                  if (!targetExecutionMode) {
                    showToast('无法切换工作区', '尚未取得目标工作区的执行模式');
                    return;
                  }
                  if (
                    !canSelectTaskExecutionMode(
                      executionRole,
                      targetExecutionMode,
                    )
                  ) {
                    showToast(
                      '无法切换工作区',
                      '成员任务不能迁移到宿主机执行工作区',
                    );
                    return;
                  }
                  setEditForm({
                    ...editForm,
                    chat_jid: chatJid,
                    execution_mode: targetExecutionMode,
                  });
                }}
                disabled={groupsLoading || !!groupsError}
                className="w-full text-sm text-foreground bg-card px-2 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {Object.entries(groupNames)
                  .filter(
                    ([jid]) =>
                      task.execution_type !== 'script' ||
                      groups[jid]?.execution_mode === 'host',
                  )
                  .map(([jid, name]) => (
                    <option key={jid} value={jid}>
                      {formatGroupLabel(jid, name)}
                    </option>
                  ))}
              </select>
              {task.permissions?.execution_blocked_reason && (
                <p className="mt-1 text-xs text-error">
                  {task.permissions.execution_blocked_reason}
                </p>
              )}
              {groupsLoading && (
                <p className="mt-1 text-xs text-muted-foreground">
                  正在加载工作区执行模式…
                </p>
              )}
              {groupsError && (
                <p className="mt-1 text-xs text-error">
                  工作区信息加载失败，请关闭编辑后重试。
                </p>
              )}
            </>
          ) : (
            <div className="text-sm text-foreground inline-flex items-center gap-1.5">
              <ChannelBadge channelType={task.chat_jid.split(':')[0]} />
              <span>{groupNames[task.chat_jid] || task.chat_jid}</span>
              <span className="text-xs text-muted-foreground">
                ({task.chat_jid.split(':').slice(1).join(':')})
              </span>
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-muted-foreground mb-1">工作区目录</div>
          <Link
            to={`/chat/${task.group_folder}`}
            className="text-sm text-primary hover:underline"
          >
            {task.group_folder}
          </Link>
        </div>

        {task.workspace_folder?.startsWith('task-') && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">
              旧版任务工作区
            </div>
            <Link
              to={`/chat/${task.workspace_folder}`}
              className="text-sm text-primary hover:underline"
            >
              {task.workspace_folder}
            </Link>
          </div>
        )}

        <div>
          <div className="text-xs text-muted-foreground mb-1">创建时间</div>
          <div className="text-sm text-foreground">
            {formatDate(task.created_at)}
          </div>
        </div>

        {/* Notify Channels */}
        <div>
          <div className="text-xs text-muted-foreground mb-1">通知渠道</div>
          {editing ? (
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                <input type="checkbox" checked disabled className="rounded" />
                Web
              </label>
              {Object.entries(CHANNEL_LABEL)
                .filter(([key]) => connectedChannels[key])
                .map(([key, label]) => (
                  <label
                    key={key}
                    className="inline-flex items-center gap-1 text-sm text-foreground cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={isChannelSelected(key)}
                      onChange={() => toggleChannel(key)}
                      className="rounded"
                    />
                    {label}
                  </label>
                ))}
            </div>
          ) : (
            renderNotifyChannelsBadges()
          )}
        </div>

        {/* Budget Control & Status */}
        <div className="md:col-span-2 border border-border/60 rounded-lg p-3 bg-muted/20 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-foreground">
              单次运行预算控制
            </div>
            {budgetStatus?.status === 'exceeded' && (
              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                已达预算上限（
                {budgetStatus.exceededReason === 'tool_calls'
                  ? '工具调用数超限'
                  : budgetStatus.exceededReason === 'duration'
                    ? '执行时长超限'
                    : budgetStatus.exceededReason === 'cost'
                      ? '估算费用超限'
                      : '已暂停'}
                ）
              </span>
            )}
          </div>
          {editing ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  时长上限（分钟）
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="无限制"
                  value={
                    editBudget?.maxDurationMs
                      ? Math.round(editBudget.maxDurationMs / 60000)
                      : ''
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    setEditBudget((prev) => ({
                      ...prev,
                      maxDurationMs: val ? Number(val) * 60000 : undefined,
                    }));
                  }}
                  className="w-full text-xs bg-card px-2 py-1 rounded border border-border"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  工具调用上限（次）
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="无限制"
                  value={editBudget?.maxToolCalls ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setEditBudget((prev) => ({
                      ...prev,
                      maxToolCalls: val ? Number(val) : undefined,
                    }));
                  }}
                  className="w-full text-xs bg-card px-2 py-1 rounded border border-border"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  估算成本上限（USD）
                </label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="无限制"
                  value={editBudget?.maxCostUsd ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setEditBudget((prev) => ({
                      ...prev,
                      maxCostUsd: val ? Number(val) : undefined,
                    }));
                  }}
                  className="w-full text-xs bg-card px-2 py-1 rounded border border-border"
                />
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground space-y-1">
              <div className="flex flex-wrap gap-4">
                <span>
                  时长上限：
                  {task.budget?.maxDurationMs
                    ? `${Math.round(task.budget.maxDurationMs / 60000)} 分钟`
                    : '无限制'}
                </span>
                <span>
                  工具调用上限：
                  {task.budget?.maxToolCalls
                    ? `${task.budget.maxToolCalls} 次`
                    : '无限制'}
                </span>
                <span>
                  成本上限：
                  {task.budget?.maxCostUsd
                    ? `$${task.budget.maxCostUsd}`
                    : '无限制'}
                </span>
              </div>
              {budgetStatus && (
                <div className="pt-2 border-t border-border/40 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">
                    当前消耗：耗时{' '}
                    {formatDuration(budgetStatus.currentDurationMs)} · 工具{' '}
                    {budgetStatus.currentToolCalls} 次 · 估算成本 $
                    {budgetStatus.currentCostUsd.toFixed(4)}
                  </div>
                  {budgetStatus.status === 'exceeded' && (
                    <button
                      type="button"
                      className="px-2.5 py-1 text-xs rounded bg-amber-100 hover:bg-amber-200 dark:bg-amber-900/50 dark:hover:bg-amber-900/70 text-amber-900 dark:text-amber-200 border border-amber-300 dark:border-amber-700 cursor-pointer font-medium"
                      onClick={() => setResumeDialogOpen(true)}
                    >
                      追加预算并恢复执行
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Execution Logs */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-muted-foreground">执行日志</div>
          <button
            onClick={handleRefreshLogs}
            disabled={logsLoading}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
            title="刷新日志"
          >
            <RefreshCw
              className={`w-4 h-4 ${logsLoading ? 'animate-spin' : ''}`}
            />
          </button>
        </div>

        {taskLogs.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无执行记录</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="bg-brand-50 text-primary text-xs">
                  <th className="text-left px-4 py-2 font-medium">计划时间</th>
                  <th className="text-left px-4 py-2 font-medium">实际开始</th>
                  <th className="text-left px-4 py-2 font-medium">触发来源</th>
                  <th className="text-left px-4 py-2 font-medium">耗时</th>
                  <th className="text-left px-4 py-2 font-medium">状态</th>
                  <th className="text-left px-4 py-2 font-medium">尝试</th>
                  <th className="text-left px-4 py-2 font-medium">通知</th>
                  <th className="text-left px-4 py-2 font-medium">结果</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {taskLogs.map((log: TaskRunLog) => (
                  <tr key={log.id}>
                    <td className="px-4 py-2.5 text-foreground whitespace-nowrap">
                      {formatDate(log.scheduled_for ?? log.run_at)}
                    </td>
                    <td className="px-4 py-2.5 text-foreground whitespace-nowrap">
                      {formatDate(log.started_at ?? log.run_at)}
                    </td>
                    <td className="px-4 py-2.5 text-foreground whitespace-nowrap">
                      {TRIGGER_LABEL[log.trigger_type || 'scheduled'] ||
                        log.trigger_type ||
                        '-'}
                    </td>
                    <td className="px-4 py-2.5 text-foreground whitespace-nowrap">
                      {[
                        'queued',
                        'running',
                        'recovering',
                        'retry_wait',
                      ].includes(log.status)
                        ? '-'
                        : formatDuration(log.duration_ms)}
                    </td>
                    <td className="px-4 py-2.5">
                      <RunLogStatusBadge status={log.status} />
                    </td>
                    <td className="px-4 py-2.5 text-foreground whitespace-nowrap">
                      {log.attempt ?? 1}
                    </td>
                    <td
                      className={`px-4 py-2.5 whitespace-nowrap ${log.notification_status === 'uncertain' ? 'text-warning' : log.notification_status === 'failed' || log.notification_status === 'partial_failed' ? 'text-error' : 'text-foreground'}`}
                      title={log.notification_error || ''}
                    >
                      {NOTIFICATION_LABEL[
                        log.notification_status || 'skipped'
                      ] || log.notification_status}
                    </td>
                    <td className="max-w-xs px-4 py-2.5 text-foreground">
                      {log.error || log.result ? (
                        <button
                          type="button"
                          onClick={() => setSelectedLog(log)}
                          className="group/result flex w-full cursor-pointer items-center gap-2 text-left hover:text-primary"
                          title="查看完整结果"
                        >
                          <span
                            className={`min-w-0 flex-1 truncate ${
                              log.error ? 'text-red-600 dark:text-red-400' : ''
                            }`}
                          >
                            {(log.error || log.result || '').slice(0, 100)}
                          </span>
                          <Eye className="h-4 w-4 shrink-0 opacity-50 group-hover/result:opacity-100" />
                        </button>
                      ) : ['queued', 'running', 'recovering'].includes(
                          log.status,
                        ) ? (
                        <span className="text-muted-foreground">
                          {log.status === 'queued' ? '排队中...' : '执行中...'}
                        </span>
                      ) : (
                        ''
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog
        open={selectedLog !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedLog(null);
        }}
      >
        <DialogContent className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>定时任务完整结果</DialogTitle>
            <DialogDescription>
              {selectedLog
                ? `${formatDate(selectedLog.started_at ?? selectedLog.run_at)} · ${TRIGGER_LABEL[selectedLog.trigger_type || 'scheduled'] || selectedLog.trigger_type || '计划触发'}`
                : '查看本次定时任务的完整业务结果'}
            </DialogDescription>
            {selectedLog &&
              (() => {
                const snapshotJid = selectedLog.definition_snapshot?.chat_jid;
                const hasSnapshot = !!snapshotJid;
                const currentWorkspaceName =
                  groupNames[task.chat_jid] ||
                  task.group_folder ||
                  task.chat_jid;
                const snapshotWorkspaceName = snapshotJid
                  ? groupNames[snapshotJid] ||
                    selectedLog.definition_snapshot?.group_folder ||
                    snapshotJid
                  : null;
                const isMigratedWorkspace =
                  hasSnapshot && snapshotJid !== task.chat_jid;

                return (
                  <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                    <RunLogStatusBadge status={selectedLog.status} />
                    <span>耗时 {formatDuration(selectedLog.duration_ms)}</span>
                    <span className="inline-flex items-center gap-1">
                      <span>运行工作区：</span>
                      <span className="font-medium text-foreground">
                        {hasSnapshot
                          ? snapshotWorkspaceName
                          : currentWorkspaceName}
                      </span>
                      {isMigratedWorkspace && (
                        <span className="text-[11px] text-amber-600 dark:text-amber-400">
                          （当前任务已位于：{currentWorkspaceName}）
                        </span>
                      )}
                      {!hasSnapshot && (
                        <span className="text-[11px] text-muted-foreground">
                          （未记录快照，回退当前工作区）
                        </span>
                      )}
                    </span>
                    <span>
                      通知：
                      {NOTIFICATION_LABEL[
                        selectedLog.notification_status || 'skipped'
                      ] ||
                        selectedLog.notification_status ||
                        '无需通知'}
                    </span>
                    <span className="font-mono">Run {selectedLog.id}</span>
                  </div>
                );
              })()}
          </DialogHeader>

          {/* Action toolbar (R18 & R19) */}
          {selectedLog && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleCreateDraftFromRun(selectedLog.id)}
                  className="flex items-center gap-1.5 text-xs cursor-pointer"
                >
                  <PlusCircle className="w-3.5 h-3.5 text-primary" />
                  以本次运行创建任务草稿 (R18)
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleOpenSaveTemplate(selectedLog.id)}
                  className="flex items-center gap-1.5 text-xs cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5 text-brand-600 dark:text-brand-400" />
                  另存为任务模板 (R18)
                </Button>
              </div>

              {artifacts.length > 0 && (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={selectedArtifactIds.length === 0}
                  onClick={() => handleCreateContinuationDraft(selectedLog.id)}
                  className="flex items-center gap-1.5 text-xs cursor-pointer"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                  用所选产物创建接续任务草稿 (R19)
                </Button>
              )}
            </div>
          )}

          {/* Delivery Artifacts section (R19) */}
          {selectedLog && (
            <div className="rounded-lg border border-border bg-card p-3 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-foreground">
                <div className="flex items-center gap-1.5">
                  <Package className="w-4 h-4 text-primary" />
                  <span>交付产物版本清单 ({artifacts.length})</span>
                </div>
                {artifactsLoading && (
                  <span className="text-muted-foreground flex items-center gap-1">
                    <RefreshCw className="w-3 h-3 animate-spin" /> 加载中...
                  </span>
                )}
              </div>

              {artifacts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  本次运行暂未登记声明交付产物文件。智能体可在任务执行中调用
                  declare_artifact 工具或输出交付声明标签。
                </p>
              ) : (
                <div className="divide-y divide-border border border-border rounded-md overflow-hidden bg-background">
                  {artifacts.map((art) => {
                    const isSelected = selectedArtifactIds.includes(art.id);
                    return (
                      <div
                        key={art.id}
                        className="flex items-center justify-between p-2.5 hover:bg-muted/30 text-xs transition-colors gap-2"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedArtifactIds((prev) => [
                                  ...prev,
                                  art.id,
                                ]);
                              } else {
                                setSelectedArtifactIds((prev) =>
                                  prev.filter((id) => id !== art.id),
                                );
                              }
                            }}
                            className="rounded cursor-pointer"
                            title="选择产物用于接续任务"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-foreground truncate">
                                {art.name}
                              </span>
                              <span className="text-muted-foreground text-[10px] font-mono">
                                {(art.file_size / 1024).toFixed(1)} KB
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                              <span className="truncate">
                                路径: {art.original_path}
                              </span>
                              <span>·</span>
                              <span
                                className="font-mono flex items-center gap-0.5 cursor-pointer hover:text-foreground"
                                title={`完整 SHA-256: ${art.file_hash} (点击复制)`}
                                onClick={() => {
                                  navigator.clipboard.writeText(art.file_hash);
                                  showToast(
                                    '已复制',
                                    '产物 SHA-256 哈希已复制到剪贴板',
                                  );
                                }}
                              >
                                <ShieldCheck className="w-3 h-3 text-green-600 dark:text-green-400" />
                                {art.file_hash.slice(0, 10)}...
                                <Copy className="w-2.5 h-2.5 opacity-60" />
                              </span>
                            </div>
                          </div>
                        </div>

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            handleDownloadArtifact(selectedLog.id, art)
                          }
                          className="h-7 px-2 text-xs flex items-center gap-1 cursor-pointer shrink-0"
                          title="安全下载该独立版本产物文件（校验 SHA-256）"
                        >
                          <Download className="w-3 h-3 text-primary" />
                          下载版本
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-muted/20 p-4">
            {selectedLog && !selectedLog.definition_snapshot?.chat_jid && (
              <div
                role="note"
                className="mb-3 rounded-md border border-amber-500/20 bg-amber-50/50 p-2.5 text-xs text-amber-700 dark:border-amber-400/20 dark:bg-amber-950/20 dark:text-amber-300"
              >
                历史运行记录未包含工作区快照，相对图片与文件已明确回退为按当前工作区（
                {groupNames[task.chat_jid] ||
                  task.group_folder ||
                  task.chat_jid}
                ）解析。
              </div>
            )}
            {selectedLog?.status === 'budget_exceeded' && (
              <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium">任务已达到单次运行预算上限</div>
                  <div className="text-xs text-amber-700 dark:text-amber-300">
                    已安全中断并保存当前阶段性成果。您可以追加预算并恢复任务继续执行。
                  </div>
                </div>
                <button
                  type="button"
                  className="px-3 py-1.5 text-xs rounded bg-amber-600 hover:bg-amber-700 text-white font-medium cursor-pointer"
                  onClick={() => {
                    setSelectedLog(null);
                    setResumeDialogOpen(true);
                  }}
                >
                  追加预算并恢复
                </button>
              </div>
            )}
            {selectedLog?.error && (
              <div className="mb-4 rounded-lg border border-error/20 bg-error-bg p-3 text-sm text-error">
                <div className="mb-1 font-medium">执行错误</div>
                <div className="whitespace-pre-wrap break-words">
                  {selectedLog.error}
                </div>
              </div>
            )}
            {selectedLog?.result ? (
              <div>
                {selectedLog.definition_snapshot?.chat_jid &&
                  selectedLog.definition_snapshot.chat_jid !==
                    task.chat_jid && (
                    <div className="mb-3 p-2 rounded border border-brand-200 bg-brand-50/50 dark:border-brand-800 dark:bg-brand-950/30 text-xs text-muted-foreground flex items-center gap-1">
                      <span className="font-medium text-foreground">
                        历史运行工作区:
                      </span>
                      <span className="font-mono">
                        {selectedLog.definition_snapshot.chat_jid}
                      </span>
                      <span>
                        (已自动使用运行时工作区解析文件与相对资源 - UX R09)
                      </span>
                    </div>
                  )}
                <MarkdownRenderer
                  content={selectedLog.result}
                  groupJid={
                    selectedLog.definition_snapshot?.chat_jid || task.chat_jid
                  }
                  variant="docs"
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                本次运行没有留下可展示的业务结果。
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Save as Template Dialog (R18) */}
      <Dialog
        open={showSaveTemplateDialog}
        onOpenChange={setShowSaveTemplateDialog}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>另存为私有任务模板 (R18)</DialogTitle>
            <DialogDescription>
              将本次运行的提示词与执行配置保存为私有模板，支持声明命名参数以便复用。
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSaveTemplateSubmit} className="space-y-4 pt-2">
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                模板名称 <span className="text-red-500">*</span>
              </label>
              <Input
                value={templateCandidate.name}
                onChange={(e) =>
                  setTemplateCandidate({
                    ...templateCandidate,
                    name: e.target.value,
                  })
                }
                placeholder="例如: 日报总结模板"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                模板描述
              </label>
              <Input
                value={templateCandidate.description}
                onChange={(e) =>
                  setTemplateCandidate({
                    ...templateCandidate,
                    description: e.target.value,
                  })
                }
                placeholder="简述模板用途"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                提示词模板 (可包含 &#123;&#123;参数名&#125;&#125;){' '}
                <span className="text-red-500">*</span>
              </label>
              <Textarea
                value={templateCandidate.prompt_template}
                onChange={(e) =>
                  setTemplateCandidate({
                    ...templateCandidate,
                    prompt_template: e.target.value,
                  })
                }
                rows={4}
                className="font-mono text-xs"
                required
              />
            </div>

            {templateCandidate.parameter_definitions.length > 0 && (
              <div className="rounded border border-border p-2 bg-muted/20 text-xs">
                <div className="font-semibold mb-1">已声明的命名参数:</div>
                <div className="space-y-1">
                  {templateCandidate.parameter_definitions.map((p, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 font-mono text-[11px]"
                    >
                      <span className="text-primary font-bold">
                        &#123;&#123;{p.name}&#125;&#125;
                      </span>
                      <span className="text-muted-foreground">({p.type})</span>
                      <span>- {p.label || p.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowSaveTemplateDialog(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={savingTemplate}>
                {savingTemplate ? '保存中...' : '保存为模板'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Create Task Form Modal (when draft is generated) */}
      {showCreateForm && (
        <CreateTaskForm
          initialDraft={activeDraft}
          onSubmit={async (data) => {
            const { createTask } = useTasksStore.getState();
            await createTask(
              data.prompt,
              data.scheduleType,
              data.scheduleValue,
              data.executionType,
              data.executionMode,
              data.scriptCommand,
              data.notifyChannels,
              data.chatJid,
              data.contextMode,
            );
            if (!useTasksStore.getState().error) {
              setShowCreateForm(false);
              setActiveDraft(null);
              showToast('任务已创建', '已成功基于草稿创建任务');
            }
          }}
          onClose={() => {
            setShowCreateForm(false);
            setActiveDraft(null);
          }}
          isAdmin={isAdmin}
        />
      )}
      <Dialog open={resumeDialogOpen} onOpenChange={setResumeDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>恢复任务并追加预算</DialogTitle>
            <DialogDescription>
              该任务因达到单次运行预算上限已暂停，已保留阶段性成果。您可以指定追加预算额度并继续执行：
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-xs">
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                追加时长（分钟）
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={resumeExtraDuration}
                onChange={(e) => setResumeExtraDuration(e.target.value)}
                className="w-full text-xs bg-card px-3 py-1.5 rounded border border-border"
                placeholder="如 10"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                追加工具调用上限（次）
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={resumeExtraToolCalls}
                onChange={(e) => setResumeExtraToolCalls(e.target.value)}
                className="w-full text-xs bg-card px-3 py-1.5 rounded border border-border"
                placeholder="如 20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                追加估算费用（USD）
              </label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={resumeExtraCost}
                onChange={(e) => setResumeExtraCost(e.target.value)}
                className="w-full text-xs bg-card px-3 py-1.5 rounded border border-border"
                placeholder="如 0.50"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              className="px-3 py-1.5 text-xs rounded border border-border hover:bg-muted cursor-pointer"
              onClick={() => setResumeDialogOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              disabled={resumingBudget}
              onClick={handleResumeBudget}
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer font-medium disabled:opacity-50"
            >
              {resumingBudget ? '恢复中...' : '确认追加并恢复'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
