import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  MODEL_EFFORTS,
  defaultEffortFor,
  normalizeContextWindow,
  resolveModelCapabilities,
  type ConnectionModelRoles,
  type ModelEffort,
  type ProviderModelEntry,
} from '@/lib/model-providers';
import { effortLabel } from './model-connections';

/**
 * The per-model fields the wizard and the connection detail share: context
 * window and reasoning efforts, and the connection's 后台与子代理 roles.
 */

const CONTEXT_PRESETS = [128_000, 200_000, 256_000, 1_000_000] as const;

const EFFORTS_UNVERIFIED_TITLE =
  '没有这个模型的资料，先按全部档位列出；不支持的档位请取消';
const EFFORTS_UNKNOWN_TITLE =
  '没有这个模型的资料，对话里可以选任意档位；点选档位后只提供所选的';
const EFFORTS_NONE_TITLE = '不向这个模型传推理等级；点选档位后只提供所选的';
const NO_THINKING_TITLE = '服务商声明这个模型不推理，对话会关闭思考';

/**
 * What a model added to a connection starts with. A third-party connection
 * declares the window the registry suggests (launches use only declared
 * windows); an official one does not, since above 200K that is the billed 1M
 * opt-in. A model nothing is known about gets every effort, unverified, for
 * the user to trim; one the vendor declared to take none keeps its empty
 * list, which is a declaration and not a gap.
 */
export function withAddDefaults(
  entry: ProviderModelEntry,
  declareSuggestedWindow: boolean,
): {
  entry: ProviderModelEntry;
  effortsUnverified: boolean;
  /** The window came from the suggestion, not from the user or vendor. */
  windowSuggested: boolean;
} {
  const next = { ...entry };
  const known = resolveModelCapabilities(entry);
  const windowSuggested =
    declareSuggestedWindow &&
    !next.contextWindow &&
    !!known.suggestedContextWindow;
  if (windowSuggested) next.contextWindow = known.suggestedContextWindow!;
  if (known.effortsSource !== 'none') {
    return { entry: next, effortsUnverified: false, windowSuggested };
  }
  return {
    entry: { ...next, efforts: [...MODEL_EFFORTS] },
    effortsUnverified: true,
    windowSuggested,
  };
}

/** 200000 → 200K, 1000000 → 1M, 1050000 → 1.05M. */
export function formatContextWindow(tokens: number): string {
  const trim = (value: number) => String(Number(value.toFixed(2)));
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trim(tokens / 1_000)}K`;
  return String(tokens);
}

/** "400K", "1.5M" or "400000" → tokens; null when it is not a window. */
function parseContextWindow(raw: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(raw);
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const tokens =
    Number(match[1]) * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1);
  return normalizeContextWindow(tokens) ?? null;
}

interface ModelCapabilityFieldsProps {
  entry: ProviderModelEntry;
  /** `effortsTouched`: the user changed the efforts themselves. */
  onChange: (next: ProviderModelEntry, effortsTouched: boolean) => void;
  /** The efforts were filled in because nothing is known about the model. */
  effortsUnverified?: boolean;
  /** Offer the model's default effort (the connection detail does). */
  showDefaultEffort?: boolean;
  disabled?: boolean;
}

/** Context window, efforts and (optionally) default effort of one model. */
export function ModelCapabilityFields({
  entry,
  onChange,
  effortsUnverified = false,
  showDefaultEffort = false,
  disabled = false,
}: ModelCapabilityFieldsProps) {
  // What is known about the model without the entry's own fields.
  const known = resolveModelCapabilities({ id: entry.id });
  const resolved = resolveModelCapabilities(entry);
  const efforts = resolved.efforts;

  const setWindow = (contextWindow: number | undefined) => {
    const next: ProviderModelEntry = { ...entry, contextWindow };
    if (!contextWindow) delete next.contextWindow;
    onChange(next, false);
  };

  const toggleEffort = (effort: ModelEffort) => {
    const set = new Set(efforts);
    if (set.has(effort)) set.delete(effort);
    else set.add(effort);
    const nextEfforts = MODEL_EFFORTS.filter((item) => set.has(item));
    const next: ProviderModelEntry = { ...entry, efforts: nextEfforts };
    if (next.defaultEffort && !nextEfforts.includes(next.defaultEffort)) {
      delete next.defaultEffort;
    }
    onChange(next, true);
  };

  const setDefaultEffort = (effort: ModelEffort | '') => {
    const next: ProviderModelEntry = { ...entry };
    if (effort) next.defaultEffort = effort;
    else delete next.defaultEffort;
    onChange(next, false);
  };

  const automaticDefault = defaultEffortFor(efforts, known.defaultEffort);
  // An empty list is either a declaration (the vendor's, or the admin who
  // unticked every level: no effort is passed) or nothing known at all (a
  // launch may try any level). Both keep the levels to tick.
  const unknown = resolved.effortsSource === 'none';
  const declaredNone = !unknown && efforts.length === 0;
  const effortBadge = effortsUnverified
    ? { label: '未验证', title: EFFORTS_UNVERIFIED_TITLE }
    : unknown
      ? { label: '未知', title: EFFORTS_UNKNOWN_TITLE }
      : declaredNone
        ? resolved.thinkingDisabled
          ? { label: '不推理', title: NO_THINKING_TITLE }
          : { label: '不传档位', title: EFFORTS_NONE_TITLE }
        : resolved.effortsSource === 'family'
          ? { label: '推断', title: '按同系列模型推断' }
          : null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <ContextWindowField
        id={entry.id}
        value={entry.contextWindow}
        suggestedWindow={resolved.suggestedContextWindow}
        onChange={setWindow}
        disabled={disabled}
      />
      <div
        role="group"
        aria-label={`${entry.id} 的推理等级`}
        className="flex min-w-0 flex-wrap items-center gap-1"
      >
        {MODEL_EFFORTS.map((effort) => {
          const on = efforts.includes(effort);
          return (
            <Toggle
              key={effort}
              variant="outline"
              size="sm"
              pressed={on}
              onPressedChange={() => toggleEffort(effort)}
              // Unticking the last level leaves an empty list: no effort is
              // passed, and thinking stays as the vendor says.
              disabled={disabled}
              title={effort}
              className="text-caption text-faint-foreground data-[state=on]:text-foreground pointer-coarse:h-11 pointer-coarse:min-w-11"
            >
              {effortLabel(effort)}
            </Toggle>
          );
        })}
        {effortBadge && (
          <Badge
            variant={effortsUnverified || unknown ? 'warning' : 'neutral'}
            title={effortBadge.title}
          >
            {effortBadge.label}
          </Badge>
        )}
      </div>
      {showDefaultEffort && efforts.length > 0 && (
        <NativeSelect
          size="sm"
          value={entry.defaultEffort ?? ''}
          onChange={(event) =>
            setDefaultEffort(event.target.value as ModelEffort | '')
          }
          disabled={disabled}
          aria-label={`${entry.id} 的默认档位`}
          title="智能体和对话都没有选择推理等级时使用"
          className="w-36 text-caption"
        >
          <NativeSelectOption value="">
            {automaticDefault
              ? `默认档位：${effortLabel(automaticDefault)}`
              : '默认档位：不设置'}
          </NativeSelectOption>
          {efforts.map((effort) => (
            <NativeSelectOption key={effort} value={effort}>
              默认档位：{effortLabel(effort)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}

/**
 * The context window: one of the common sizes or a custom one. Launches use
 * only this; left empty, Claude Code runs the model at 200K. What the
 * registry knows is offered as a one-tap suggestion.
 */
function ContextWindowField({
  id,
  value,
  suggestedWindow,
  onChange,
  disabled,
}: {
  id: string;
  value: number | undefined;
  suggestedWindow: number | null;
  onChange: (next: number | undefined) => void;
  disabled: boolean;
}) {
  const preset = value
    ? (CONTEXT_PRESETS as readonly number[]).includes(value)
    : false;
  const ownValue = value && !preset ? formatContextWindow(value) : '';
  // 自定义 picked while the value is still empty or a common size.
  const [choosingCustom, setChoosingCustom] = useState(false);
  const custom = choosingCustom || !!ownValue;
  const [draft, setDraft] = useState(ownValue);
  const [invalid, setInvalid] = useState(false);
  // A saved, reverted or normalized value replaces what was typed.
  useEffect(() => setDraft(ownValue), [ownValue]);
  const selected = custom ? 'custom' : value ? String(value) : '';

  const commit = () => {
    if (!draft.trim()) {
      setInvalid(false);
      onChange(undefined);
      return;
    }
    const tokens = parseContextWindow(draft);
    setInvalid(tokens === null);
    if (tokens !== null && tokens !== value) onChange(tokens);
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <NativeSelect
        size="sm"
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'custom') {
            setChoosingCustom(true);
            setDraft(value ? formatContextWindow(value) : '');
            return;
          }
          setChoosingCustom(false);
          setInvalid(false);
          onChange(next ? Number(next) : undefined);
        }}
        disabled={disabled}
        aria-label={`${id} 的上下文长度`}
        className="w-40 text-caption"
      >
        <NativeSelectOption value="">
          上下文：未填（按 200K）
        </NativeSelectOption>
        {CONTEXT_PRESETS.map((tokens) => (
          <NativeSelectOption key={tokens} value={String(tokens)}>
            上下文：{formatContextWindow(tokens)}
          </NativeSelectOption>
        ))}
        <NativeSelectOption value="custom">自定义</NativeSelectOption>
      </NativeSelect>
      {custom && (
        <Input
          variant="code"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              commit();
            }
          }}
          placeholder="如 400K"
          aria-label={`${id} 的自定义上下文长度`}
          aria-invalid={invalid ? true : undefined}
          title="1K 到 10M 之间，例如 400K、1.5M 或 400000"
          disabled={disabled}
          className="h-7 w-24 font-mono text-caption md:text-caption"
        />
      )}
      {suggestedWindow && suggestedWindow !== value && (
        <button
          type="button"
          onClick={() => {
            setChoosingCustom(false);
            setInvalid(false);
            onChange(suggestedWindow);
          }}
          disabled={disabled}
          title="使用模型资料里的上下文长度"
          className="shrink-0 rounded-md px-1.5 text-caption text-primary-text underline-offset-2 hover:underline disabled:opacity-50 pointer-coarse:min-h-11"
        >
          建议：{formatContextWindow(suggestedWindow)}
        </button>
      )}
    </div>
  );
}

interface ModelRolesFieldsProps {
  /** The connection's models the roles may name, in list order. */
  models: readonly string[];
  roles: ConnectionModelRoles;
  onChange: (next: ConnectionModelRoles) => void;
  disabled?: boolean;
}

const FOLLOW = '跟随当前模型';

/** 后台与子代理: which of the connection's models Claude Code uses besides the turn's. */
export function ModelRolesFields({
  models,
  roles,
  onChange,
  disabled = false,
}: ModelRolesFieldsProps) {
  const set = (role: keyof ConnectionModelRoles, value: string) => {
    const next = { ...roles };
    if (value) next[role] = value;
    else delete next[role];
    onChange(next);
  };
  const field = (
    role: keyof ConnectionModelRoles,
    label: string,
    hint: string,
    /** Shown while the role follows the turn's model. */
    unsetHint?: string,
  ) => {
    const value =
      roles[role] && models.includes(roles[role]) ? roles[role] : '';
    const id = `connection-role-${role}`;
    return (
      <div className="grid min-w-0 gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-3">
        <label htmlFor={id} className="text-label text-foreground">
          {label}
        </label>
        <div className="min-w-0">
          <NativeSelect
            id={id}
            value={value}
            onChange={(event) => set(role, event.target.value)}
            disabled={disabled || models.length === 0}
            className="w-full font-mono text-caption sm:max-w-80"
          >
            <NativeSelectOption value="">{FOLLOW}</NativeSelectOption>
            {models.map((model) => (
              <NativeSelectOption key={model} value={model}>
                {model}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="mt-0.5 text-caption text-muted-foreground">{hint}</p>
          {unsetHint && !value && models.length > 1 && (
            <p className="mt-0.5 text-caption text-primary-text">{unsetHint}</p>
          )}
        </div>
      </div>
    );
  };
  const advancedSet = !!(roles.opus || roles.sonnet);

  return (
    <section
      aria-labelledby="connection-roles-heading"
      className="space-y-3 rounded-lg p-3 ring-1 ring-surface-border"
    >
      <div>
        <h3
          id="connection-roles-heading"
          className="text-label text-foreground"
        >
          后台与子代理
        </h3>
        <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
          不设置时跟随对话当前使用的模型。
        </p>
      </div>
      {field('subagent', '子代理模型', '子代理（Task）使用的模型。')}
      {/* Unset, every background call runs on the turn's model, which on a
          third-party connection is usually its priciest one. */}
      {field(
        'smallFast',
        '轻量后台模型',
        '生成标题、摘要、读取网页等后台调用使用的模型。',
        '建议选一个便宜的模型：这些后台调用很频繁，未设置时也用对话的模型。',
      )}
      <details className="group/roles" open={advancedSet || undefined}>
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-caption text-muted-foreground select-none hover:text-foreground pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-3.5 transition-transform duration-150 group-open/roles:rotate-90"
            aria-hidden="true"
          />
          高级
        </summary>
        <div className="mt-2 space-y-3">
          {field(
            'opus',
            'Opus 档模型',
            '子代理指定 opus 时，以及 Claude Code 的 opus 档使用的模型。',
          )}
          {field(
            'sonnet',
            'Sonnet 档模型',
            '子代理指定 sonnet 时，以及 Claude Code 的 sonnet 档使用的模型。',
          )}
        </div>
      </details>
    </section>
  );
}
