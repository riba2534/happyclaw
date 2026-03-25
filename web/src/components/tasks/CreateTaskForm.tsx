import { useEffect, useState } from 'react';
import { Loader2, Sparkles, X, SlidersHorizontal } from 'lucide-react';
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

interface Group {
  jid: string;
  name: string;
  folder: string;
}

interface CreateTaskFormProps {
  groups: Group[];
  onSubmit: (data: {
    groupFolder: string;
    chatJid: string;
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    contextMode: 'group' | 'isolated';
    executionType: 'agent' | 'script';
    scriptCommand: string;
    notifyChannels: string[] | null;
  }) => Promise<void>;
  onClose: () => void;
  isAdmin?: boolean;
  homeFolder?: string;
}

const CHANNEL_OPTIONS = [
  { key: 'feishu', label: '飞书' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'qq', label: 'QQ' },
  { key: 'wechat', label: '微信' },
] as const;

const INTERVAL_UNITS = [
  { label: '秒', ms: 1000 },
  { label: '分钟', ms: 60 * 1000 },
  { label: '小时', ms: 60 * 60 * 1000 },
  { label: '天', ms: 24 * 60 * 60 * 1000 },
] as const;

type CreateMode = 'ai' | 'manual';

interface ParsedTask {
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  summary: string;
}

export function CreateTaskForm({ groups, onSubmit, onClose, isAdmin, homeFolder }: CreateTaskFormProps) {
  const [mode, setMode] = useState<CreateMode>('ai');

  // Resolve initial group from homeFolder
  const initialGroup = homeFolder ? groups.find((g) => g.folder === homeFolder) : undefined;

  // --- AI mode state ---
  const [aiDescription, setAiDescription] = useState('');
  const [aiGroupFolder, setAiGroupFolder] = useState(initialGroup?.folder || '');
  const [aiGroupJid, setAiGroupJid] = useState(initialGroup?.jid || '');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [parsedTask, setParsedTask] = useState<ParsedTask | null>(null);
  const [aiSubmitting, setAiSubmitting] = useState(false);

  // --- Manual mode state ---
  const [formData, setFormData] = useState({
    groupFolder: initialGroup?.folder || '',
    chatJid: initialGroup?.jid || '',
    prompt: '',
    scheduleType: 'cron' as 'cron' | 'interval' | 'once',
    scheduleValue: '',
    contextMode: 'isolated' as 'group' | 'isolated',
    executionType: 'agent' as 'agent' | 'script',
    scriptCommand: '',
  });
  const [intervalNumber, setIntervalNumber] = useState('');
  const [intervalUnit, setIntervalUnit] = useState('60000');
  const [onceDateTime, setOnceDateTime] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // --- Shared state ---
  const [notifyChannels, setNotifyChannels] = useState<string[] | null>(null);
  const [connectedChannels, setConnectedChannels] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.get<Record<string, unknown>>('/api/config/user-im/status')
      .then((data) => {
        const connected: Record<string, boolean> = {};
        for (const ch of CHANNEL_OPTIONS) {
          const status = data[ch.key];
          connected[ch.key] = !!(status && typeof status === 'object' && (status as any).connected);
        }
        setConnectedChannels(connected);
      })
      .catch(() => {/* ignore */});
  }, []);

  const isScript = formData.executionType === 'script';

  const isChannelSelected = (key: string) => {
    if (notifyChannels === null) return true;
    return notifyChannels.includes(key);
  };

  const toggleChannel = (key: string) => {
    setNotifyChannels((prev) => {
      if (prev === null) {
        const all = CHANNEL_OPTIONS.map((c) => c.key);
        return all.filter((c) => c !== key);
      }
      if (prev.includes(key)) {
        return prev.filter((c) => c !== key);
      }
      const next = [...prev, key];
      if (next.length === CHANNEL_OPTIONS.length) return null;
      return next;
    });
  };

  // --- AI mode handlers ---
  const handleAiGroupChange = (value: string) => {
    const g = groups.find((g) => g.folder === value);
    setAiGroupFolder(value);
    setAiGroupJid(g?.jid || '');
  };

  const handleParse = async () => {
    if (!aiDescription.trim()) {
      setParseError('请输入任务描述');
      return;
    }
    if (!aiGroupFolder) {
      setParseError('请先选择执行工作区');
      return;
    }
    setParsing(true);
    setParseError('');
    setParsedTask(null);
    try {
      const result = await api.post<{ success: boolean; parsed: ParsedTask }>('/api/tasks/parse', {
        description: aiDescription.trim(),
      });
      setParsedTask(result.parsed);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'AI 解析失败，请重试');
    } finally {
      setParsing(false);
    }
  };

  const handleAiSubmit = async () => {
    if (!parsedTask || !aiGroupFolder) return;
    setAiSubmitting(true);
    try {
      await onSubmit({
        groupFolder: aiGroupFolder,
        chatJid: aiGroupJid,
        prompt: parsedTask.prompt,
        scheduleType: parsedTask.schedule_type,
        scheduleValue: parsedTask.schedule_value,
        contextMode: parsedTask.context_mode,
        executionType: 'agent',
        scriptCommand: '',
        notifyChannels,
      });
    } catch (error) {
      showToast('创建失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setAiSubmitting(false);
    }
  };

  // --- Manual mode handlers ---
  const validateForm = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.groupFolder) newErrors.groupFolder = '请选择执行工作区';
    if (isScript) {
      if (!formData.scriptCommand.trim()) newErrors.scriptCommand = '请输入脚本命令';
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
        if (isNaN(num) || num <= 0) newErrors.scheduleValue = '间隔必须是正整数';
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
      finalScheduleValue = String(parseInt(intervalNumber, 10) * parseInt(intervalUnit, 10));
    } else if (formData.scheduleType === 'once') {
      finalScheduleValue = new Date(onceDateTime).toISOString();
    }
    setSubmitting(true);
    try {
      await onSubmit({ ...formData, scheduleValue: finalScheduleValue, notifyChannels });
    } catch (error) {
      console.error('Failed to create task:', error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGroupChange = (value: string) => {
    const g = groups.find((g) => g.folder === value);
    setFormData({ ...formData, groupFolder: value, chatJid: g?.jid || '' });
  };

  const scheduleTypeLabel = (type: string) => {
    if (type === 'cron') return 'Cron 表达式';
    if (type === 'interval') return '间隔执行';
    if (type === 'once') return '单次执行';
    return type;
  };

  // --- Notify channels UI (shared) ---
  const renderNotifyChannels = () => (
    <div>
      <label className="block text-sm font-medium text-foreground mb-2">通知渠道</label>
      <div className="flex flex-wrap gap-3">
        <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked disabled className="rounded" />
          Web（始终）
        </label>
        {CHANNEL_OPTIONS.map((ch) => {
          const connected = connectedChannels[ch.key];
          if (connected === undefined) return null;
          return (
            <label
              key={ch.key}
              className={cn(
                'inline-flex items-center gap-1.5 text-sm cursor-pointer',
                !connected && 'text-muted-foreground/50 cursor-not-allowed',
              )}
            >
              <input
                type="checkbox"
                checked={isChannelSelected(ch.key)}
                onChange={() => toggleChannel(ch.key)}
                disabled={!connected}
                className="rounded"
              />
              {ch.label}
              {!connected && <span className="text-xs text-muted-foreground/50">（未连接）</span>}
            </label>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        选择任务结果推送的 IM 渠道，默认推送到所有已连接渠道
      </p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-bold text-foreground">创建定时任务</h2>
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

        {/* AI Mode */}
        {mode === 'ai' && (
          <div className="p-6 space-y-4">
            {/* Group */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                执行工作区 <span className="text-red-500">*</span>
              </label>
              {groups.length === 1 ? (
                <p className="text-sm text-foreground bg-muted px-3 py-2 rounded border border-border">
                  {groups[0].name} ({groups[0].folder})
                </p>
              ) : (
                <Select value={aiGroupFolder || undefined} onValueChange={handleAiGroupChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="请选择" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((group) => (
                      <SelectItem key={group.jid} value={group.folder}>
                        {group.name} ({group.folder})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="mt-1 text-xs text-muted-foreground">默认使用主工作区，通常无需修改</p>
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                用自然语言描述你的任务
              </label>
              <Textarea
                value={aiDescription}
                onChange={(e) => { setAiDescription(e.target.value); setParsedTask(null); }}
                rows={4}
                className="resize-none"
                placeholder="例如：每天早上 9 点帮我总结最新的科技新闻&#10;每周一下午 2 点检查项目依赖是否有安全更新&#10;每隔 2 小时检查一次服务器状态"
              />
            </div>

            {/* Parse Button */}
            {!parsedTask && (
              <Button
                onClick={handleParse}
                disabled={parsing || !aiDescription.trim() || !aiGroupFolder}
                className="w-full"
              >
                {parsing ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    AI 解析中...
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" />
                    AI 解析
                  </>
                )}
              </Button>
            )}

            {parseError && (
              <p className="text-sm text-red-600">{parseError}</p>
            )}

            {/* Parsed Result */}
            {parsedTask && (
              <div className="space-y-4">
                <div className="bg-brand-50/50 border border-brand-200 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-primary">
                    <Sparkles className="w-4 h-4" />
                    AI 解析结果
                  </div>
                  <p className="text-sm text-muted-foreground">{parsedTask.summary}</p>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground">调度类型：</span>
                      <span className="text-foreground font-medium ml-1">
                        {scheduleTypeLabel(parsedTask.schedule_type)}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">调度值：</span>
                      <code className="text-foreground bg-card px-1.5 py-0.5 rounded border border-border text-xs ml-1">
                        {parsedTask.schedule_value}
                      </code>
                    </div>
                    <div>
                      <span className="text-muted-foreground">上下文：</span>
                      <span className="text-foreground font-medium ml-1">
                        {parsedTask.context_mode === 'isolated' ? '独立执行' : '共享上下文'}
                      </span>
                    </div>
                  </div>

                  {/* Editable prompt */}
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">任务 Prompt（可编辑）</label>
                    <Textarea
                      value={parsedTask.prompt}
                      onChange={(e) => setParsedTask({ ...parsedTask, prompt: e.target.value })}
                      rows={6}
                      className="resize-y min-h-[120px] text-sm"
                    />
                  </div>

                  {/* Editable schedule_value */}
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">调度值（可编辑）</label>
                    <Input
                      value={parsedTask.schedule_value}
                      onChange={(e) => setParsedTask({ ...parsedTask, schedule_value: e.target.value })}
                      className="text-sm font-mono"
                    />
                  </div>
                </div>

                {renderNotifyChannels()}

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setParsedTask(null)}
                  >
                    重新解析
                  </Button>
                  <Button
                    onClick={handleAiSubmit}
                    disabled={aiSubmitting}
                  >
                    {aiSubmitting && <Loader2 className="size-4 animate-spin" />}
                    {aiSubmitting ? '创建中...' : '确认创建'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Manual Mode */}
        {mode === 'manual' && (
          <form onSubmit={handleManualSubmit} className="p-6 space-y-4">
            {/* Group Selection */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                执行工作区 <span className="text-red-500">*</span>
              </label>
              {groups.length === 1 ? (
                <p className="text-sm text-foreground bg-muted px-3 py-2 rounded border border-border">
                  {groups[0].name} ({groups[0].folder})
                </p>
              ) : (
                <Select value={formData.groupFolder || undefined} onValueChange={handleGroupChange}>
                  <SelectTrigger className={cn("w-full", errors.groupFolder && "border-red-500")}>
                    <SelectValue placeholder="请选择" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((group) => (
                      <SelectItem key={group.jid} value={group.folder}>
                        {group.name} ({group.folder})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="mt-1 text-xs text-muted-foreground">默认使用主工作区，通常无需修改</p>
              {errors.groupFolder && (
                <p className="mt-1 text-sm text-red-600">{errors.groupFolder}</p>
              )}
            </div>

            {/* Execution Type */}
            {isAdmin && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  执行方式
                </label>
                <Select
                  value={formData.executionType}
                  onValueChange={(value) =>
                    setFormData({ ...formData, executionType: value as 'agent' | 'script' })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">Agent（AI 代理）</SelectItem>
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

            {/* Script Command */}
            {isScript && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  脚本命令 <span className="text-red-500">*</span>
                </label>
                <Textarea
                  value={formData.scriptCommand}
                  onChange={(e) => setFormData({ ...formData, scriptCommand: e.target.value })}
                  rows={3}
                  maxLength={4096}
                  className={cn("resize-none font-mono text-sm", errors.scriptCommand && "border-red-500")}
                  placeholder="例如: curl -s https://api.example.com/health | jq .status"
                />
                {errors.scriptCommand && (
                  <p className="mt-1 text-sm text-red-600">{errors.scriptCommand}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  命令在群组工作目录下执行，最大 4096 字符
                </p>
              </div>
            )}

            {/* Prompt */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {isScript ? '任务描述' : '任务 Prompt'}{' '}
                {!isScript && <span className="text-red-500">*</span>}
              </label>
              <Textarea
                value={formData.prompt}
                onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
                rows={isScript ? 2 : 4}
                className={cn("resize-none", errors.prompt && "border-red-500")}
                placeholder={isScript ? '可选的任务描述...' : '输入任务的提示词...'}
              />
              {errors.prompt && (
                <p className="mt-1 text-sm text-red-600">{errors.prompt}</p>
              )}
            </div>

            {/* Schedule Type */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                调度类型 <span className="text-red-500">*</span>
              </label>
              <Select
                value={formData.scheduleType}
                onValueChange={(value) => {
                  setIntervalNumber('');
                  setOnceDateTime('');
                  setFormData({ ...formData, scheduleType: value as 'cron' | 'interval' | 'once', scheduleValue: '' });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cron">Cron 表达式</SelectItem>
                  <SelectItem value="interval">间隔执行</SelectItem>
                  <SelectItem value="once">单次执行</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Schedule Value */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                调度值 <span className="text-red-500">*</span>
              </label>
              {formData.scheduleType === 'cron' && (
                <>
                  <Input
                    type="text"
                    value={formData.scheduleValue}
                    onChange={(e) => setFormData({ ...formData, scheduleValue: e.target.value })}
                    className={cn(errors.scheduleValue && "border-red-500")}
                    placeholder="例如: 0 0 * * * (每天 0 点)"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    格式: 分 时 日 月 星期（如 0 9 * * * = 每天 9 点）
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
                      className={cn("flex-1", errors.scheduleValue && "border-red-500")}
                      placeholder="数值"
                    />
                    <Select value={intervalUnit} onValueChange={setIntervalUnit}>
                      <SelectTrigger className="w-28">
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
                  <p className="mt-1 text-xs text-muted-foreground">设置任务执行间隔</p>
                </>
              )}
              {formData.scheduleType === 'once' && (
                <>
                  <Input
                    type="datetime-local"
                    value={onceDateTime}
                    onChange={(e) => setOnceDateTime(e.target.value)}
                    className={cn(errors.scheduleValue && "border-red-500")}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">选择任务的执行时间</p>
                </>
              )}
              {errors.scheduleValue && (
                <p className="mt-1 text-sm text-red-600">{errors.scheduleValue}</p>
              )}
            </div>

            {/* Context Mode */}
            {!isScript && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  上下文模式
                </label>
                <Select
                  value={formData.contextMode}
                  onValueChange={(value) =>
                    setFormData({ ...formData, contextMode: value as 'group' | 'isolated' })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="isolated">独立执行（推荐）</SelectItem>
                    <SelectItem value="group">共享群组上下文</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  共享群组上下文会复用该群组会话，独立执行每次使用隔离会话
                </p>
              </div>
            )}

            {renderNotifyChannels()}

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {submitting ? '创建中...' : '创建任务'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
