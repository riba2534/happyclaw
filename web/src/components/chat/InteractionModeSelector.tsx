import type { ReactNode } from 'react';
import { Bot, CircleCheck, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InteractionMode } from '../../types';

export interface ModeChoiceOption<V extends string> {
  value: V;
  title: string;
  description: string;
  icon: typeof Bot;
}

export interface ModeChoiceGroupProps<V extends string> {
  legend: string;
  options: ModeChoiceOption<V>[];
  value: V;
  onChange: (value: V) => void;
  disabled?: boolean;
  name: string;
  /** Above the choices; omitted when empty. */
  description?: string;
  /** Below the choices, e.g. what the selected choice means. */
  hint?: ReactNode;
  /** Use a denser choice row in compact creation dialogs. */
  compact?: boolean;
  /** Keep the legend for screen readers only when a dialog title already names the choice. */
  hideLegend?: boolean;
}

/**
 * A workspace mode as a radio group of choice cards: icon, title and, unless
 * compact, the description; the native radio stays for keyboards and screen
 * readers.
 */
export function ModeChoiceGroup<V extends string>({
  legend,
  options,
  value,
  onChange,
  disabled = false,
  name,
  description,
  hint,
  compact = false,
  hideLegend = false,
}: ModeChoiceGroupProps<V>) {
  return (
    <fieldset disabled={disabled}>
      <legend
        className={cn(
          'text-body font-medium text-foreground',
          hideLegend && 'sr-only',
        )}
      >
        {legend}
      </legend>
      {description && (
        <p
          className={cn(
            'text-caption text-muted-foreground',
            !compact && 'leading-5',
            !hideLegend && 'mt-1',
          )}
        >
          {description}
        </p>
      )}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const Icon = option.icon;
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                'relative flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 ring-1 transition-colors duration-100',
                // One line per choice; still a 44px target on a phone.
                compact && 'items-center px-2 py-1.5 phone:min-h-11',
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
                aria-description={compact ? option.description : undefined}
                className="sr-only"
              />
              <Icon
                aria-hidden="true"
                className={cn(
                  compact ? 'size-3.5 shrink-0' : 'mt-0.5 size-4 shrink-0',
                  selected ? 'text-foreground' : 'text-muted-foreground',
                )}
              />
              <span className="min-w-0">
                <span
                  className={cn(
                    'block pr-5 text-foreground',
                    compact ? 'text-caption font-medium' : 'text-label',
                  )}
                >
                  {option.title}
                </span>
                {!compact && (
                  <span className="mt-0.5 block text-caption leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
              {selected && (
                <CircleCheck
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none absolute text-primary-text',
                    compact
                      ? 'top-1/2 right-2 size-3.5 -translate-y-1/2'
                      : 'top-2.5 right-2.5 size-4',
                  )}
                />
              )}
            </label>
          );
        })}
      </div>
      {hint}
    </fieldset>
  );
}

const OPTIONS: ModeChoiceOption<InteractionMode>[] = [
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
  description = '选择由框架在任务结束时交付一条主回复，还是由智能体在处理过程中主动发出多条消息。身份、Skills、记忆与渠道响应范围不变。',
  ...props
}: Omit<ModeChoiceGroupProps<InteractionMode>, 'legend' | 'options' | 'hint'>) {
  return (
    <ModeChoiceGroup
      legend="工作区回复模式"
      options={OPTIONS}
      description={description}
      {...props}
    />
  );
}
