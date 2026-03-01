import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
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
  }) => Promise<void>;
  onClose: () => void;
  isAdmin?: boolean;
}

const INTERVAL_UNITS = [
  { label: '秒', ms: 1000 },
  { label: '分钟', ms: 60 * 1000 },
  { label: '小时', ms: 60 * 60 * 1000 },
  { label: '天', ms: 24 * 60 * 60 * 1000 },
] as const;

export function CreateTaskForm({ groups, onSubmit, onClose, isAdmin }: CreateTaskFormProps) {
  const [formData, setFormData] = useState({
    groupFolder: '',
    chatJid: '',
    prompt: '',
    scheduleType: 'cron' as 'cron' | 'interval' | 'once',
    scheduleValue: '',
    contextMode: 'isolated' as 'group' | 'isolated',
    executionType: 'agent' as 'agent' | 'script',
    scriptCommand: '',
  });
  const [intervalNumber, setIntervalNumber] = useState('');
  const [intervalUnit, setIntervalUnit] = useState('60000'); // default: minutes
  const [onceDateTime, setOnceDateTime] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const isScript = formData.executionType === 'script';

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.groupFolder) {
      newErrors.groupFolder = '请选择群组';
    }

    if (isScript) {
      if (!formData.scriptCommand.trim()) {
        newErrors.scriptCommand = '请输入脚本命令';
      }
    } else {
      if (!formData.prompt.trim()) {
        newErrors.prompt = '请输入 Prompt';
      }
    }

    if (formData.scheduleType === 'cron') {
      if (!formData.scheduleValue.trim()) {
        newErrors.scheduleValue = '请输入 Cron 表达式';
      } else {
        const parts = formData.scheduleValue.trim().split(' ');
        if (parts.length < 5) {
          newErrors.scheduleValue = 'Cron 表达式格式错误（至少需要 5 个字段）';
        }
      }
    } else if (formData.scheduleType === 'interval') {
      if (!intervalNumber.trim()) {
        newErrors.scheduleValue = '请输入间隔数值';
      } else {
        const num = parseInt(intervalNumber);
        if (isNaN(num) || num <= 0) {
          newErrors.scheduleValue = '间隔必须是正整数';
        }
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    // Compute final scheduleValue for interval/once before submit
    let finalScheduleValue = formData.scheduleValue;
    if (formData.scheduleType === 'interval') {
      const num = parseInt(intervalNumber, 10);
      const unitMs = parseInt(intervalUnit, 10);
      finalScheduleValue = String(num * unitMs);
    } else if (formData.scheduleType === 'once') {
      finalScheduleValue = new Date(onceDateTime).toISOString();
    }

    setSubmitting(true);
    try {
      await onSubmit({ ...formData, scheduleValue: finalScheduleValue });
    } catch (error) {
      console.error('Failed to create task:', error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGroupChange = (value: string) => {
    const selectedGroup = groups.find((g) => g.folder === value);
    setFormData({
      ...formData,
      groupFolder: value,
      chatJid: selectedGroup?.jid || '',
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-200">
          <h2 className="text-xl font-bold text-slate-900">创建定时任务</h2>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Group Selection */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              选择群组 <span className="text-red-500">*</span>
            </label>
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
            {errors.groupFolder && (
              <p className="mt-1 text-sm text-red-600">{errors.groupFolder}</p>
            )}
          </div>

          {/* Execution Type */}
          {isAdmin && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                执行方式
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
                <SelectContent>
                  <SelectItem value="agent">Agent（AI 代理）</SelectItem>
                  <SelectItem value="script">脚本（Shell 命令）</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-slate-500">
                {isScript
                  ? '直接执行 Shell 命令，零 API 消耗，适合确定性任务'
                  : '启动完整 Claude Agent，消耗 API tokens'}
              </p>
            </div>
          )}

          {/* Script Command (script mode only) */}
          {isScript && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
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
              <p className="mt-1 text-xs text-slate-500">
                命令在群组工作目录下执行，最大 4096 字符
              </p>
            </div>
          )}

          {/* Prompt / Task Description */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
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
            <label className="block text-sm font-medium text-slate-700 mb-2">
              调度类型 <span className="text-red-500">*</span>
            </label>
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
            <label className="block text-sm font-medium text-slate-700 mb-2">
              调度值 <span className="text-red-500">*</span>
            </label>

            {formData.scheduleType === 'cron' && (
              <>
                <Input
                  type="text"
                  value={formData.scheduleValue}
                  onChange={(e) =>
                    setFormData({ ...formData, scheduleValue: e.target.value })
                  }
                  className={cn(errors.scheduleValue && "border-red-500")}
                  placeholder="例如: 0 0 * * * (每天 0 点)"
                />
                <p className="mt-1 text-xs text-slate-500">
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
                <p className="mt-1 text-xs text-slate-500">
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
                  className={cn(errors.scheduleValue && "border-red-500")}
                />
                <p className="mt-1 text-xs text-slate-500">
                  选择任务的执行时间
                </p>
              </>
            )}

            {errors.scheduleValue && (
              <p className="mt-1 text-sm text-red-600">{errors.scheduleValue}</p>
            )}
          </div>

          {/* Context Mode (agent mode only) */}
          {!isScript && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                上下文模式
              </label>
              <Select
                value={formData.contextMode}
                onValueChange={(value) =>
                  setFormData({
                    ...formData,
                    contextMode: value as 'group' | 'isolated',
                  })
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
              <p className="mt-1 text-xs text-slate-500">
                共享群组上下文会复用该群组会话，独立执行每次使用隔离会话
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting ? '创建中...' : '创建任务'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
