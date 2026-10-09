import { Bot, CircleCheck, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InteractionMode } from '../../types';

interface InteractionModeSelectorProps {
  value: InteractionMode;
  onChange: (value: InteractionMode) => void;
  disabled?: boolean;
  name: string;
  description?: string;
  /** Keep the legend for screen readers only when a dialog title already names the choice. */
  hideLegend?: boolean;
}

const OPTIONS: Array<{
  value: InteractionMode;
  title: string;
  description: string;
  icon: typeof Bot;
}> = [
  {
    value: 'assistant',
    title: 'Assistant 模式（推荐）',
    description:
      '任务完成后由框架交付一条主回复。Web 可实时展示过程，飞书等渠道按能力使用流式卡片或消息气泡。',
    icon: Bot,
  },
  {
    value: 'proactive',
    title: '主动模式',
    description:
      '智能体在处理过程中主动发消息；每次发送立即形成一条独立消息，一轮可以发送多条。身份与语气仍由智能体配置决定。',
    icon: MessagesSquare,
  },
];

export function InteractionModeSelector({
  value,
  onChange,
  disabled = false,
  name,
  hideLegend = false,
  description = '选择由框架在任务结束时交付一条主回复，还是由智能体在处理过程中主动发出多条消息。身份、Skills、记忆与渠道响应范围不变。',
}: InteractionModeSelectorProps) {
  return (
    <fieldset disabled={disabled}>
      <legend
        className={cn(
          'text-body font-medium text-foreground',
          hideLegend && 'sr-only',
        )}
      >
        工作区回复模式
      </legend>
      <p
        className={cn(
          'text-caption leading-5 text-muted-foreground',
          !hideLegend && 'mt-1',
        )}
      >
        {description}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                'relative flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 ring-1 transition-colors duration-100',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                selected
                  ? 'bg-surface-selected ring-foreground/25'
                  : 'bg-transparent ring-surface-border hover:bg-surface-hover',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <Icon
                aria-hidden="true"
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  selected ? 'text-foreground' : 'text-muted-foreground',
                )}
              />
              <span className="min-w-0">
                <span className="block pr-5 text-label text-foreground">
                  {option.title}
                </span>
                <span className="mt-0.5 block text-caption leading-5 text-muted-foreground">
                  {option.description}
                </span>
              </span>
              {selected && (
                <CircleCheck
                  aria-hidden="true"
                  className="pointer-events-none absolute top-2.5 right-2.5 size-4 text-primary-text"
                />
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
