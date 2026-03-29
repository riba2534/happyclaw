import { useState } from 'react';
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
import { INTERVAL_UNITS, CHANNEL_OPTIONS, toggleNotifyChannel } from '../../utils/task-utils';
import { useConnectedChannels } from '../../hooks/useConnectedChannels';

interface CreateTaskFormProps {
  onSubmit: (data: {
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    executionType: 'agent' | 'script';
    executionMode?: 'host' | 'container';
    scriptCommand: string;
    notifyChannels: string[] | null;
  }) => Promise<void>;
  onClose: () => void;
  isAdmin?: boolean;
}

type CreateMode = 'ai' | 'manual';

export function CreateTaskForm({ onSubmit, onClose, isAdmin }: CreateTaskFormProps) {
  const [mode, setMode] = useState<CreateMode>('ai');

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
  const connectedChannels = useConnectedChannels();

  const isScript = formData.executionType === 'script';

  const connectedKeys = CHANNEL_OPTIONS.filter((c) => connectedChannels[c.key]).map((c) => c.key);

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
      await api.post('/api/tasks/ai', {
        description: aiDescription.trim(),
        notify_channels: notifyChannels,
      });
      showToast('任务已创建', 'AI 正在后台解析调度参数，稍后自动激活');
      onClose();
    } catch (error) {
      showToast('创建失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setAiSubmitting(false);
    }
  };

  // --- Manual mode handlers ---
  const validateForm = () => {
    const newErrors: Record<string, string> = {};
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
      await onSubmit({
        prompt: formData.prompt,
        scheduleType: formData.scheduleType,
        scheduleValue: finalScheduleValue,
        executionType: formData.executionType,
        executionMode: formData.executionMode,
        scriptCommand: formData.scriptCommand,
        notifyChannels,
      });
    } catch (error) {
      console.error('Failed to create task:', error);
    } finally {
      setSubmitting(false);
    }
  };

  // --- Notify channels UI (shared) ---
  const connectedOptions = CHANNEL_OPTIONS.filter((ch) => connectedChannels[ch.key]);

  const renderNotifyChannels = () => (
    <div>
      <label className="block text-sm font-medium text-foreground mb-2">通知渠道</label>
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
      {connectedOptions.length === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          未绑定任何 IM 渠道，任务结果仅在 Web 工作区展示
        </p>
      )}
      {connectedOptions.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          选择任务结果推送的 IM 渠道，默认推送到所有已连接渠道
        </p>
      )}
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
            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                用自然语言描述你的任务
              </label>
              <Textarea
                value={aiDescription}
                onChange={(e) => setAiDescription(e.target.value)}
                rows={4}
                className="resize-none"
                placeholder="例如：每天早上 9 点帮我总结最新的科技新闻&#10;每周一下午 2 点检查项目依赖是否有安全更新&#10;每隔 2 小时检查一次服务器状态"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                AI 会自动解析调度时间和任务内容，创建后在后台完成解析
              </p>
            </div>

            {renderNotifyChannels()}

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
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
              </Button>
            </div>
          </div>
        )}

        {/* Manual Mode */}
        {mode === 'manual' && (
          <form onSubmit={handleManualSubmit} className="p-6 space-y-4">
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

            {/* Execution Mode */}
            {isAdmin && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  执行模式
                </label>
                <Select
                  value={formData.executionMode}
                  onValueChange={(value) =>
                    setFormData({ ...formData, executionMode: value as 'host' | 'container' })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="host">宿主机</SelectItem>
                    <SelectItem value="container">Docker 容器</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  宿主机模式直接在服务器上运行，Docker 容器模式在隔离环境中运行
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
                  <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.scriptCommand}</p>
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
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.prompt}</p>
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
                    placeholder="例如: 0 9 * * * (每天 9 点)"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    格式: 分 时 日 月 星期（北京时间 UTC+8）。常用: <code className="bg-muted px-1 rounded">*/5 * * * *</code> 每5分钟, <code className="bg-muted px-1 rounded">0 9 * * 1-5</code> 工作日9点, <code className="bg-muted px-1 rounded">@daily</code> 每天
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
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.scheduleValue}</p>
              )}
            </div>

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
