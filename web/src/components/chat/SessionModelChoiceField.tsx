import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { cn } from '@/lib/utils';
import { effortLabel } from '../settings/model-connections';
import {
  choiceEfforts,
  connectionModels,
  connectionOwnModel,
  connectionUnavailableReason,
  defaultUnusable,
  describeDefaultChoice,
  loadWorkspaceModelOptions,
  modelDisplayName,
  type ModelChoice,
  type WorkspaceModelOptions,
} from '../../lib/session-model-choice';

export type WorkspaceModelOptionsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; options: WorkspaceModelOptions }
  | { status: 'error' };

/**
 * The model options of a workspace; idle without one. `refresh` reads them
 * anew instead of taking the answer another row already got.
 */
export function useWorkspaceModelOptions(
  workspaceJid: string | null,
  { refresh = false }: { refresh?: boolean } = {},
): WorkspaceModelOptionsState {
  // Keyed by workspace: a switch must not show the previous one's options
  // while the new ones load.
  const [state, setState] = useState<{
    jid: string;
    loaded: WorkspaceModelOptionsState;
  } | null>(null);

  useEffect(() => {
    if (!workspaceJid) return;
    let active = true;
    setState({ jid: workspaceJid, loaded: { status: 'loading' } });
    loadWorkspaceModelOptions(workspaceJid, { refresh }).then(
      (options) => {
        if (active)
          setState({ jid: workspaceJid, loaded: { status: 'ready', options } });
      },
      () => {
        if (active)
          setState({ jid: workspaceJid, loaded: { status: 'error' } });
      },
    );
    return () => {
      active = false;
    };
  }, [workspaceJid, refresh]);

  if (!workspaceJid) return { status: 'idle' };
  return state?.jid === workspaceJid ? state.loaded : { status: 'loading' };
}

const FOLLOW_DEFAULT = '';
const OWN_MODEL = '';
const DEFAULT_EFFORT = '';

interface SessionModelChoiceFieldProps {
  /** The workspace whose conversations the choice is for. */
  workspaceJid: string;
  /** Null follows the default (the Agent's binding and what it falls to). */
  value: ModelChoice | null;
  onChange: (value: ModelChoice | null) => void;
  disabled?: boolean;
  /** For the connection control, so a field label can point at it. */
  id?: string;
}

/**
 * Follow the default, or pick a connection, one of its models and an
 * effort. Native selects: on a phone they open the system picker, which
 * works inside a bottom sheet and needs no room of its own.
 */
export function SessionModelChoiceField({
  workspaceJid,
  value,
  onChange,
  disabled = false,
  id,
}: SessionModelChoiceFieldProps) {
  // A picker opening wants the connections as they are now.
  const loaded = useWorkspaceModelOptions(workspaceJid, { refresh: true });
  const options = loaded.status === 'ready' ? loaded.options : null;
  const connections = options?.options ?? [];
  const picked = value
    ? connections.find((option) => option.id === value.modelConfigId)
    : undefined;
  const pickedReason = picked ? connectionUnavailableReason(picked) : '';

  // A choice the options no longer back (an automation's saved one) is still
  // shown as it is, so the form never changes it silently.
  const models = picked ? connectionModels(picked) : [];
  const ownModel = picked ? connectionOwnModel(picked) : '';
  const unlistedModel =
    value?.model && !models.some((entry) => entry.id === value.model)
      ? value.model
      : null;
  // The model and effort controls wait for the options rather than show a
  // saved choice by its ids for a moment.
  const settled = loaded.status !== 'loading';
  const showModel =
    !!value && settled && (models.length > 0 || !!unlistedModel);

  const levels = picked
    ? choiceEfforts(picked, value?.model ?? null)
    : { efforts: [], defaultEffort: null, unverified: false };
  const unlistedEffort =
    value?.effort && !levels.efforts.includes(value.effort)
      ? value.effort
      : null;
  const showEffort =
    !!value && settled && (levels.efforts.length > 0 || !!unlistedEffort);

  const pickConnection = (next: string) =>
    onChange(
      next === FOLLOW_DEFAULT
        ? null
        : { modelConfigId: next, model: null, effort: null },
    );
  const pickModel = (next: string) => {
    if (!value) return;
    const model = next === OWN_MODEL ? null : next;
    // An effort the new model does not take returns to its default.
    const keep =
      !!value.effort &&
      !!picked &&
      choiceEfforts(picked, model).efforts.includes(value.effort);
    onChange({ ...value, model, effort: keep ? value.effort : null });
  };
  const pickEffort = (next: string) => {
    if (value)
      onChange({ ...value, effort: next === DEFAULT_EFFORT ? null : next });
  };

  let note: { text: string; warning: boolean } | null = null;
  if (loaded.status === 'error') {
    note = {
      text: value ? '无法读取可选模型' : '无法读取可选模型，将跟随智能体',
      warning: true,
    };
  } else if (options && !value) {
    note = {
      text: describeDefaultChoice(options),
      warning: defaultUnusable(options),
    };
  } else if (options && value && !picked) {
    note = { text: '这个连接已删除，请重新选择', warning: true };
  } else if (pickedReason) {
    note = {
      text: `这个连接${pickedReason}，请选择其他连接`,
      warning: true,
    };
  }

  return (
    <div className="space-y-2">
      <NativeSelect
        id={id}
        aria-label="模型连接"
        value={value?.modelConfigId ?? FOLLOW_DEFAULT}
        disabled={disabled || loaded.status === 'loading'}
        onChange={(event) => pickConnection(event.target.value)}
        className="w-full"
      >
        <NativeSelectOption value={FOLLOW_DEFAULT}>
          跟随智能体
        </NativeSelectOption>
        {connections.map((option) => {
          const reason = connectionUnavailableReason(option);
          return (
            <NativeSelectOption
              key={option.id}
              value={option.id}
              disabled={!!reason}
            >
              {reason ? `${option.name}（${reason}）` : option.name}
            </NativeSelectOption>
          );
        })}
        {value && !picked && (
          <NativeSelectOption value={value.modelConfigId} disabled>
            {options ? '已删除的连接' : value.modelConfigId}
          </NativeSelectOption>
        )}
      </NativeSelect>

      {(showModel || showEffort) && (
        <div
          className={cn(
            'grid gap-2',
            showModel && showEffort && 'sm:grid-cols-[minmax(0,1fr)_10rem]',
          )}
        >
          {showModel && (
            <NativeSelect
              aria-label="连接中的模型"
              value={value?.model ?? OWN_MODEL}
              disabled={disabled}
              onChange={(event) => pickModel(event.target.value)}
              className="w-full"
            >
              <NativeSelectOption value={OWN_MODEL}>
                {ownModel
                  ? `连接默认模型（${modelDisplayName(picked, ownModel)}）`
                  : '连接默认模型'}
              </NativeSelectOption>
              {unlistedModel && (
                <NativeSelectOption value={unlistedModel}>
                  {picked
                    ? `${unlistedModel}（不在模型列表里）`
                    : unlistedModel}
                </NativeSelectOption>
              )}
              {models.map((entry) => (
                <NativeSelectOption key={entry.id} value={entry.id}>
                  {entry.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {showEffort && (
            <NativeSelect
              aria-label="推理等级"
              value={value?.effort ?? DEFAULT_EFFORT}
              disabled={disabled}
              onChange={(event) => pickEffort(event.target.value)}
              className="w-full"
            >
              <NativeSelectOption value={DEFAULT_EFFORT}>
                {levels.defaultEffort
                  ? `默认（${effortLabel(levels.defaultEffort)}）`
                  : '默认'}
              </NativeSelectOption>
              {levels.efforts.map((effort) => (
                <NativeSelectOption key={effort} value={effort}>
                  {levels.unverified
                    ? `${effortLabel(effort)}（未验证）`
                    : effortLabel(effort)}
                </NativeSelectOption>
              ))}
              {unlistedEffort && (
                <NativeSelectOption value={unlistedEffort}>
                  {picked
                    ? `${effortLabel(unlistedEffort)}（该模型不支持）`
                    : effortLabel(unlistedEffort)}
                </NativeSelectOption>
              )}
            </NativeSelect>
          )}
        </div>
      )}

      {loaded.status === 'loading' ? (
        <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          正在读取可选模型…
        </p>
      ) : (
        note && (
          <p
            data-testid="model-choice-note"
            className={cn(
              'text-caption',
              note.warning ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {note.text}
          </p>
        )
      )}
    </div>
  );
}
