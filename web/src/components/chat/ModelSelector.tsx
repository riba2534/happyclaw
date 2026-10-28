import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain,
  Check,
  ChevronDown,
  LayoutGrid,
  Loader2,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { splitOneMillionSuffix } from '@/lib/model-providers';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { vendorOfConnection, vendorOfModel } from '../brand/vendor';
import { VendorTile } from '../brand/VendorTile';
import { api } from '../../api/client';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useAuthStore } from '../../stores/auth';
import {
  effortLabel,
  modelBindingErrorMessage,
} from '../settings/model-connections';
import { getErrorMessage } from '../settings/types';

/** One model a ChatGPT login may run, with the efforts this user may pick on it. */
export interface CodexModelChoice {
  value: string;
  label: string;
  /** Low to high; levels the user may not pick are not listed. */
  efforts: string[];
  /** What the model runs at when no effort is picked. */
  defaultEffort: string;
}

export interface CodexSelectionView {
  /** The configuration's own model: what "default" runs. */
  defaultModel: string;
  defaultEffort: string;
  /** `live` is the account's own list; anything else is a fallback. */
  source: string;
  /** The login was rejected and has to be redone before it can run. */
  needsReauth: boolean;
  models: CodexModelChoice[];
}

/** One model of a non-ChatGPT configuration. */
export interface ConnectionModelChoice {
  id: string;
  /** Left out of the menu unless the conversation already runs on it. */
  hidden: boolean;
  /** Reasoning efforts the model takes, low to high; absent when none. */
  efforts?: string[];
  /** The level it runs at when none is picked. */
  defaultEffort?: string;
  contextWindow?: number;
}

export interface SessionModelOption {
  id: string;
  name: string;
  kind: 'official' | 'third_party' | 'codex';
  enabled: boolean;
  /** The configuration's default model; '' lets a relay decide. */
  model: string;
  /** False when the configuration holds no credential and would fail. */
  usable?: boolean;
  /** Present on ChatGPT configurations: the models and efforts to choose from. */
  codex?: CodexSelectionView;
  /**
   * The models a non-ChatGPT configuration offers, its default included.
   * Older servers send none and the configuration stays a single row.
   */
  models?: ConnectionModelChoice[];
}

export interface SessionModelSelection {
  selectedModelConfigId: string | null;
  /**
   * The model picked within the selected configuration; null follows its
   * default. Older servers do not send this nor the effort.
   */
  selectedModel?: string | null;
  selectedEffort?: string | null;
  default: {
    source: 'agent' | 'default' | 'single' | 'pool' | 'workspace_env' | 'none';
    modelConfigId: string | null;
    enabledCount: number;
    /**
     * The model the default runs on that connection: what a launch with no
     * pick would use. Null for the pool and the workspace override; older
     * servers do not send it.
     */
    model?: string | null;
    /** The effort a launch with no pick runs at, when its model takes one. */
    effort?: string | null;
  };
  options: SessionModelOption[];
}

/** Human label for "what the default resolves to" in this conversation. */
export function describeDefaultModel(selection: SessionModelSelection): string {
  const { source, modelConfigId, enabledCount, model } = selection.default;
  const named = selection.options.find((option) => option.id === modelConfigId);
  switch (source) {
    case 'agent':
    case 'default':
    case 'single':
      // A ChatGPT configuration is named by the model it runs; the others by
      // name and, when known, the model.
      if (named?.codex) return model || named.codex.defaultModel;
      if (!named) return '默认';
      return model ? `${named.name} · ${modelLabel(model)}` : named.name;
    case 'pool':
      return `自动 · ${enabledCount} 个`;
    case 'workspace_env':
      return '工作区环境变量';
    default:
      return '系统默认';
  }
}

function defaultHint(selection: SessionModelSelection): string {
  switch (selection.default.source) {
    case 'agent':
      return '跟随智能体绑定的模型配置';
    case 'default':
      return '使用模型配置里设为默认的模型';
    case 'pool':
      return '未设置默认模型，在已启用的模型配置间自动选择';
    case 'workspace_env':
      return '使用工作区环境变量中的模型网关';
    case 'single':
      return '使用唯一启用的模型配置';
    default:
      return '使用系统设置';
  }
}

/**
 * Why a configuration is listed but cannot be chosen ('' when it can).
 * Whether it is in the automatic pool is left to Settings: an explicit pick
 * ignores the pool.
 */
function optionStatus(option: SessionModelOption): string {
  if (option.usable === false) return '缺少凭据';
  if (option.codex?.needsReauth) return '需重新登录';
  return '';
}

/** A model id for a label, with the 1M context window spelled out. */
function modelLabel(id: string): string {
  const { model, oneMillion } = splitOneMillionSuffix(id);
  return oneMillion ? `${model}（1M）` : model;
}

function ownModel(option: SessionModelOption): string {
  return option.codex ? option.codex.defaultModel : option.model;
}

/** The vendor a row's model comes from, else the connection's. */
function vendorOf(option: SessionModelOption, model: string) {
  return (
    vendorOfModel(model) ??
    vendorOfConnection({ kind: option.kind, model: ownModel(option) })
  );
}

/**
 * The connection and model the conversation runs on: the pick, or what the
 * default resolves to (the server sends a connection only for an Agent, the
 * global default or a single enabled one). '' when nothing names a model.
 */
function modelInUse(selection: SessionModelSelection): {
  option: SessionModelOption | null;
  model: string;
} {
  const selected = selection.options.find(
    (option) => option.id === selection.selectedModelConfigId,
  );
  if (selected) {
    return {
      option: selected,
      model: selection.selectedModel || ownModel(selected),
    };
  }
  const option =
    selection.options.find(
      (item) => item.id === selection.default.modelConfigId,
    ) ?? null;
  return {
    option,
    model:
      selection.default.model ||
      (option?.codex ? option.codex.defaultModel : ''),
  };
}

/** The efforts a connection's model takes, and its own default level. */
function modelEfforts(
  option: SessionModelOption,
  model: string,
): { efforts: string[]; defaultEffort: string | null } | null {
  if (option.codex) {
    const choice = option.codex.models.find((item) => item.value === model);
    return choice?.efforts.length
      ? { efforts: choice.efforts, defaultEffort: choice.defaultEffort || null }
      : null;
  }
  const entry = option.models?.find((item) => item.id === model);
  return entry?.efforts?.length
    ? { efforts: entry.efforts, defaultEffort: entry.defaultEffort ?? null }
    : null;
}

const DEFAULT_ROW_KEY = '__default__';
const DEFAULT_EFFORT = '__default__';

/** One row of the panel: what picking it saves and how it reads. */
interface ModelRow {
  key: string;
  option: SessionModelOption;
  /** The model picking this pins; null follows the connection's own. */
  pick: string | null;
  /** The model shown; '' when a relay decides. */
  id: string;
  note?: string;
}

function rowKey(optionId: string, id: string): string {
  return `${optionId}:${id}`;
}

/**
 * The rows a configuration offers. Hidden models are left out unless
 * `pinned` names one, and a pinned model the list lacks stays too, so the
 * panel shows what is really selected. An older server (no list) gives one
 * row standing for the configuration.
 */
function optionRows(
  option: SessionModelOption,
  pinned: string | null,
): ModelRow[] {
  const defaultModel = ownModel(option);
  const listed = option.codex
    ? option.codex.models.map((model) => ({ id: model.value, hidden: false }))
    : option.models;
  const row = (id: string, note?: string): ModelRow => ({
    key: rowKey(option.id, id),
    option,
    pick: id === defaultModel ? null : id,
    id,
    note,
  });
  if (!listed?.length) return [row(defaultModel)];
  const rows: ModelRow[] = [];
  if (
    pinned &&
    pinned !== defaultModel &&
    !listed.some((model) => model.id === pinned)
  ) {
    rows.push(
      row(pinned, option.codex ? '不在账号的模型列表里' : '不在模型列表里'),
    );
  }
  // A relay without a model of its own still lets the relay decide.
  if (!option.codex && !defaultModel) rows.push(row(''));
  for (const model of listed) {
    if (!model.hidden) rows.push(row(model.id));
    else if (model.id === pinned) rows.push(row(model.id, '已隐藏'));
  }
  return rows;
}

export interface EffortContext {
  /** The connection the conversation runs on. */
  option: SessionModelOption;
  /** The model it runs there. */
  model: string;
  /** The levels that model takes, low to high. */
  efforts: string[];
  /** The level when none is picked: the default's, else the model's own. */
  defaultEffort: string | null;
  /** The picked level; null follows the default. */
  effort: string | null;
  /** The conversation picked its connection (else it follows the default). */
  picked: boolean;
  /** The model a picked connection was pinned to; null follows its own. */
  pinnedModel: string | null;
}

/**
 * The reasoning effort of the model the conversation runs on — the pick, or
 * the default's model — when that model takes efforts; null hides the effort
 * control.
 */
export function resolveEffortContext(
  selection: SessionModelSelection,
): EffortContext | null {
  const { option, model } = modelInUse(selection);
  const levels = option && model ? modelEfforts(option, model) : null;
  if (!option || !levels) return null;
  const picked = !!selection.selectedModelConfigId;
  return {
    option,
    model,
    efforts: levels.efforts,
    defaultEffort:
      (picked ? null : selection.default.effort) ?? levels.defaultEffort,
    effort: picked ? (selection.selectedEffort ?? null) : null,
    picked,
    pinnedModel: picked ? (selection.selectedModel ?? null) : null,
  };
}

/**
 * What the effort control shows, and what a screen reader hears: the picked
 * level, else the default's (marked as such), else 默认 alone when Claude
 * Code picks the level itself.
 */
function effortShown(context: EffortContext): {
  level: string | null;
  spoken: string;
} {
  const level = context.effort ?? context.defaultEffort;
  const spoken = context.effort
    ? effortLabel(context.effort)
    : context.defaultEffort
      ? `默认（${effortLabel(context.defaultEffort)}）`
      : '默认';
  return { level, spoken };
}

/** The `phone:` variant: below the desktop layout and driven by touch. */
const PHONE_QUERY = '(max-width: 1023px) and (pointer: coarse)';

/**
 * A phone's single control for model and effort, after cindy's model pill:
 * a filled 34px pill, 12px medium text. The model name truncates first; the
 * level after it stays whole.
 */
const PHONE_PILL_CLASS =
  'inline-flex h-[34px] max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-surface-border bg-muted pr-2.5 pl-1.5 text-caption font-medium text-foreground transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:bg-surface-hover disabled:cursor-default data-[state=open]:bg-surface-hover';

/**
 * The composer's model and effort controls: plain text at rest, a filled
 * pill on hover or while open. Labels truncate; tooltips carry the full name.
 */
const TRIGGER_CLASS =
  'inline-flex h-[30px] min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-label font-medium text-foreground transition-colors duration-100 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:h-10';

/**
 * A tooltip on a menu trigger. Focus comes back to the trigger when the menu
 * closes; that alone must not pop the tooltip up over what was just picked.
 * Leaving the trigger lets it show again.
 */
function useQuietTooltip() {
  const [open, setOpen] = useState(false);
  const muted = useRef(false);
  return {
    open,
    onOpenChange: (next: boolean) => setOpen(next && !muted.current),
    /** The menu opened or closed. */
    onMenuOpenChange: (menuOpen: boolean) => {
      if (!menuOpen) muted.current = true;
      setOpen(false);
    },
    triggerProps: {
      onPointerLeave: () => {
        muted.current = false;
      },
      onBlur: () => {
        muted.current = false;
      },
    },
  };
}

/**
 * A closed menu hands focus back to its trigger once its exit animation ends.
 * If the model panel was opened in the meantime, focus already sits there;
 * pulling it back would close the panel again.
 */
function keepFocusThatMovedOn(event: Event) {
  const active = document.activeElement;
  if (active && active !== document.body) event.preventDefault();
}

interface ModelSelectorProps {
  groupJid: string;
  /** Runtime Session id; null addresses the main conversation. */
  agentId: string | null;
  canChange: boolean;
}

export function ModelSelector({
  groupJid,
  agentId,
  canChange,
}: ModelSelectorProps) {
  const navigate = useNavigate();
  const canManageModels = useAuthStore((s) =>
    s.hasPermission('manage_system_config'),
  );
  // A phone gets one pill for model and effort and picks the effort in the
  // sheet; a narrow window keeps the desktop controls but the sheet too.
  const phone = useMediaQuery(PHONE_QUERY);
  const narrow = useMediaQuery('(max-width: 639px)');
  const inSheet = phone || narrow;
  const [selection, setSelection] = useState<SessionModelSelection | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const modelTooltip = useQuietTooltip();
  const lastRefreshAt = useRef(0);
  // Bumped by every save: a look-up that started before one must not put an
  // older selection back over the saved one.
  const saves = useRef(0);
  const basePath = `/api/groups/${encodeURIComponent(groupJid)}/model-selection`;
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';

  const load = useCallback(async () => {
    try {
      setSelection(await api.get<SessionModelSelection>(`${basePath}${query}`));
    } catch {
      // Older server or no access: the picker simply stays hidden.
      setSelection(null);
    }
  }, [basePath, query]);

  useEffect(() => {
    lastRefreshAt.current = Date.now();
    void load();
  }, [load]);

  // The first list of a ChatGPT login is the global catalog until the server
  // has fetched the account's own: look again when the panel is opened. A
  // failed look keeps what is shown.
  const refreshCatalog = () => {
    if (
      Date.now() - lastRefreshAt.current < 5_000 ||
      !selection?.options.some(
        (option) => option.codex && option.codex.source !== 'live',
      )
    ) {
      return;
    }
    lastRefreshAt.current = Date.now();
    const startedAt = saves.current;
    api
      .get<SessionModelSelection>(`${basePath}${query}`)
      .then((next) => {
        if (saves.current === startedAt) setSelection(next);
      })
      .catch(() => {});
  };

  const handleOpenChange = (next: boolean) => {
    modelTooltip.onMenuOpenChange(next);
    setOpen(next);
    if (next) refreshCatalog();
  };

  const save = async (
    body: {
      modelConfigId: string | null;
      model?: string | null;
      effort?: string | null;
    },
    success: (next: SessionModelSelection) => string,
  ) => {
    if (saving) return;
    saves.current += 1;
    setSaving(true);
    try {
      const next = await api.put<SessionModelSelection>(basePath, {
        agentId,
        ...body,
      });
      setSelection(next);
      toast.success(success(next));
    } catch (err) {
      toast.error(
        modelBindingErrorMessage(err) ?? getErrorMessage(err, '切换模型失败'),
      );
      void load();
    } finally {
      setSaving(false);
    }
  };

  if (!selection || selection.options.length === 0) return null;

  const pinnedModel = selection.selectedModelConfigId
    ? (selection.selectedModel ?? null)
    : null;
  const inUse = modelInUse(selection);
  const picked = !!selection.selectedModelConfigId && !!inUse.option;
  const selectedKey =
    picked && inUse.option
      ? rowKey(inUse.option.id, inUse.model)
      : DEFAULT_ROW_KEY;
  const effortContext = resolveEffortContext(selection);
  // The trigger names the model in use, without a 「默认 ·」 prefix.
  const triggerName = inUse.model
    ? splitOneMillionSuffix(inUse.model).model
    : (inUse.option?.name ?? describeDefaultModel(selection));
  const fullLabel = inUse.model
    ? [inUse.option?.name, modelLabel(inUse.model)].filter(Boolean).join(' · ')
    : triggerName;
  const tooltip = picked ? fullLabel : `默认 · ${fullLabel}`;

  const pickRow = (row: ModelRow | null) => {
    const modelConfigId = row ? row.option.id : null;
    const model = row?.pick ?? null;
    if (
      modelConfigId === selection.selectedModelConfigId &&
      model === pinnedModel
    ) {
      return;
    }
    const option = row?.option;
    if (!option) {
      // Exactly the request older servers understand.
      void save(
        { modelConfigId: null },
        () => '已恢复默认模型，从下一条消息开始生效',
      );
      return;
    }
    // A model keeps the effort picked before only if it has that level;
    // otherwise the conversation returns to the model's default.
    const modelToRun = model ?? ownModel(option);
    const levels = modelEfforts(option, modelToRun);
    const keptEffort =
      modelConfigId === selection.selectedModelConfigId
        ? (selection.selectedEffort ?? null)
        : null;
    const effort =
      keptEffort && levels?.efforts.includes(keptEffort) ? keptEffort : null;
    const name = modelToRun
      ? `${option.name} · ${modelLabel(modelToRun)}`
      : option.name;
    const dropped =
      keptEffort && !effort
        ? `；该模型不支持${effortLabel(keptEffort)}，推理等级已恢复为默认${
            levels?.defaultEffort
              ? `（${effortLabel(levels.defaultEffort)}）`
              : ''
          }`
        : '';
    // Older servers know `{ modelConfigId }` alone: send a model or an
    // effort only when there is one to send, or one to clear.
    void save(
      {
        modelConfigId,
        ...(model || option.codex ? { model } : {}),
        ...(keptEffort || option.codex ? { effort } : {}),
      },
      () => `已切换到「${name}」，从下一条消息开始生效${dropped}`,
    );
  };

  const pickEffort = (value: string | null) => {
    if (!effortContext || value === effortContext.effort) return;
    void save(
      {
        modelConfigId: effortContext.option.id,
        // On 「默认」 the effort needs the default's connection and model
        // named explicitly; a pick keeps what it pinned.
        model: effortContext.picked
          ? effortContext.pinnedModel
          : effortContext.model || null,
        effort: value,
      },
      () =>
        value
          ? `推理等级已设为${effortLabel(value)}，从下一条消息开始生效`
          : '已恢复默认推理等级，从下一条消息开始生效',
    );
  };

  const disabled = !canChange || saving;
  const effortDisabled =
    disabled || (!!effortContext && !!optionStatus(effortContext.option));
  const shown = effortContext ? effortShown(effortContext) : null;
  const panel = (
    <ModelPanel
      selection={selection}
      pinnedModel={pinnedModel}
      selectedKey={selectedKey}
      disabled={disabled}
      effort={
        phone
          ? effortContext && {
              context: effortContext,
              disabled: effortDisabled,
              onPick: pickEffort,
            }
          : undefined
      }
      onPick={(row) => {
        handleOpenChange(false);
        pickRow(row);
      }}
      compact={phone}
      onManage={
        canManageModels
          ? () => {
              handleOpenChange(false);
              navigate('/settings?tab=claude');
            }
          : null
      }
    />
  );

  const mark = saving ? (
    <Loader2 className="size-5 shrink-0 animate-spin p-0.5" />
  ) : inUse.option ? (
    <VendorTile
      size="sm"
      vendor={vendorOf(inUse.option, inUse.model)}
      name={inUse.option.name}
    />
  ) : (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-surface-selected text-muted-foreground">
      <Sparkles className="size-3" aria-hidden="true" />
    </span>
  );
  const chevron = canChange && (
    <ChevronDown
      className="size-3.5 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  );

  // A sheet on phones and narrow windows, a popover otherwise; both roots
  // hand the trigger its open state and popup semantics.
  const Root = inSheet ? Sheet : Popover;
  const Trigger = inSheet ? SheetTrigger : PopoverTrigger;
  return (
    <>
      <Root open={open} onOpenChange={handleOpenChange}>
        {phone ? (
          <Trigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={`模型：${fullLabel}${
                shown ? `，推理等级：${shown.spoken}` : ''
              }`}
              data-model-pill=""
              className={PHONE_PILL_CLASS}
            >
              {mark}
              <span className="min-w-0 truncate">{triggerName}</span>
              {shown?.level && (
                <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                  <span className="text-muted-foreground" aria-hidden="true">
                    ·
                  </span>
                  {effortLabel(shown.level)}
                </span>
              )}
              {chevron}
            </button>
          </Trigger>
        ) : (
          <Tooltip
            open={modelTooltip.open}
            onOpenChange={modelTooltip.onOpenChange}
          >
            <Trigger asChild>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`模型：${fullLabel}`}
                  // A disabled button gets no tooltip; the title still reads.
                  title={disabled ? tooltip : undefined}
                  {...modelTooltip.triggerProps}
                  className={cn(TRIGGER_CLASS, 'max-w-[240px]')}
                >
                  {mark}
                  <span className="min-w-0 truncate">{triggerName}</span>
                  {chevron}
                </button>
              </TooltipTrigger>
            </Trigger>
            <TooltipContent side="top">{tooltip}</TooltipContent>
          </Tooltip>
        )}
        {inSheet ? (
          <SheetContent
            side="bottom"
            detents
            className="gap-0 p-0"
            // Focus the sheet, not the search field: a phone keyboard would
            // cover the list.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (event.currentTarget as HTMLElement | null)?.focus();
            }}
          >
            <SheetHeader className="shrink-0 border-b border-surface-border px-4 py-3 pr-12">
              <SheetTitle className="text-title-sm">选择模型</SheetTitle>
              <SheetDescription className="sr-only">
                本会话使用的模型
              </SheetDescription>
            </SheetHeader>
            {panel}
          </SheetContent>
        ) : (
          <PopoverContent
            side="top"
            align="start"
            collisionPadding={8}
            aria-label="选择模型"
            className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(460px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden rounded-xl p-0"
          >
            {panel}
          </PopoverContent>
        )}
      </Root>
      {effortContext && !phone && (
        <EffortMenu
          context={effortContext}
          disabled={effortDisabled}
          onPick={pickEffort}
        />
      )}
    </>
  );
}

interface EffortMenuProps {
  context: EffortContext;
  disabled: boolean;
  onPick: (effort: string | null) => void;
}

/** The reasoning effort of the model in use, next to the model control. */
function EffortMenu({ context, disabled, onPick }: EffortMenuProps) {
  const tooltip = useQuietTooltip();
  const { level, spoken } = effortShown(context);
  // The accessible name carries the level the control shows.
  const name = `推理等级：${spoken}，选择推理等级`;
  return (
    <DropdownMenu onOpenChange={tooltip.onMenuOpenChange}>
      <Tooltip open={tooltip.open} onOpenChange={tooltip.onOpenChange}>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={name}
              title={disabled ? name : undefined}
              {...tooltip.triggerProps}
              className={cn(TRIGGER_CLASS, 'shrink-0')}
            >
              <Brain
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="whitespace-nowrap">
                {level ? effortLabel(level) : '选择推理等级'}
              </span>
              {!disabled && (
                <ChevronDown
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent side="top">选择推理等级</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        collisionPadding={8}
        onCloseAutoFocus={keepFocusThatMovedOn}
        className="w-56 max-w-[calc(100vw-2rem)]"
      >
        <DropdownMenuLabel>推理等级</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={context.effort ?? DEFAULT_EFFORT}
          onValueChange={(value) =>
            onPick(value === DEFAULT_EFFORT ? null : value)
          }
        >
          <DropdownMenuRadioItem value={DEFAULT_EFFORT}>
            默认
            {context.defaultEffort && (
              <span className="text-muted-foreground">
                {' · '}
                {effortLabel(context.defaultEffort)}
              </span>
            )}
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {context.efforts.map((effort) => (
            <DropdownMenuRadioItem key={effort} value={effort}>
              {effortLabel(effort)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-micro leading-4 text-muted-foreground">
          只影响推理深度，从下一条消息开始生效，不会重置会话。
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ModelPanelProps {
  selection: SessionModelSelection;
  /** The model picked within the selected configuration, if any. */
  pinnedModel: string | null;
  selectedKey: string;
  disabled: boolean;
  /**
   * A phone picks the effort here, under the model in use; null when that
   * model takes none. Undefined leaves the effort to the control beside the
   * model.
   */
  effort?: {
    context: EffortContext;
    disabled: boolean;
    onPick: (effort: string | null) => void;
  } | null;
  /** Null picks the default. */
  onPick: (row: ModelRow | null) => void;
  onManage: (() => void) | null;
  /**
   * A phone's sheet: the rows take the width (search still reaches every
   * connection) and the footer keeps only the way to Settings.
   */
  compact?: boolean;
}

/**
 * The model panel after cindy's unified selector: a search field, a rail of
 * connections that filters the list, two-line rows with a check on the one
 * in use, and the way to Settings.
 */
function ModelPanel({
  selection,
  pinnedModel,
  selectedKey,
  disabled,
  effort,
  onPick,
  onManage,
  compact = false,
}: ModelPanelProps) {
  const effortRow = effort && (
    <EffortSegments
      context={effort.context}
      disabled={effort.disabled}
      onPick={effort.onPick}
    />
  );
  const [query, setQuery] = useState('');
  const [rail, setRail] = useState<string>('all');
  const listRef = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();
  // A search looks through every connection, whatever the rail shows.
  const rows = selection.options
    .filter((option) => needle || rail === 'all' || option.id === rail)
    .flatMap((option) =>
      optionRows(
        option,
        option.id === selection.selectedModelConfigId ? pinnedModel : null,
      ).filter(
        (row) =>
          !needle ||
          row.id.toLowerCase().includes(needle) ||
          option.name.toLowerCase().includes(needle),
      ),
    );
  const showDefault =
    rail === 'all' &&
    (!needle || '默认'.includes(needle) || 'default'.includes(needle));
  const showRail = (id: string) => {
    setRail(id);
    setQuery('');
  };

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-model-row]:not(:disabled)',
      ) ?? []),
    ];
    if (items.length === 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      index < 0
        ? step > 0
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, index + step));
    items[next].focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={moveFocus}>
      <div className="relative shrink-0 border-b border-surface-border">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型"
          aria-label="搜索模型"
          className="h-10 w-full bg-transparent pr-3 pl-9 text-body text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="flex h-[min(26rem,60dvh)] min-h-0 flex-1">
        {!compact && (
          <div
            role="group"
            aria-label="模型配置"
            className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-surface-border py-2"
          >
            <RailButton
              label="全部"
              active={rail === 'all' && !needle}
              onClick={() => showRail('all')}
            >
              <LayoutGrid className="size-4" aria-hidden="true" />
            </RailButton>
            {selection.options.map((option) => (
              <RailButton
                key={option.id}
                label={option.name}
                active={rail === option.id && !needle}
                onClick={() => showRail(option.id)}
              >
                <VendorTile
                  vendor={vendorOfConnection({
                    kind: option.kind,
                    model: ownModel(option),
                  })}
                  name={option.name}
                />
              </RailButton>
            ))}
          </div>
        )}

        <div
          ref={listRef}
          role="radiogroup"
          aria-label="本会话使用的模型"
          className="min-w-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5"
        >
          {showDefault && (
            <RowButton
              checked={selectedKey === DEFAULT_ROW_KEY}
              disabled={disabled}
              onClick={() => onPick(null)}
              mark={
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-selected text-muted-foreground">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                </span>
              }
              title={`默认 · ${describeDefaultModel(selection)}`}
              detail={defaultHint(selection)}
            />
          )}
          {showDefault && selectedKey === DEFAULT_ROW_KEY && effortRow}
          {rows.map((row) => {
            const { model, oneMillion } = splitOneMillionSuffix(row.id);
            const status = optionStatus(row.option);
            return (
              <Fragment key={row.key}>
                <RowButton
                  checked={row.key === selectedKey}
                  disabled={disabled || !!status}
                  onClick={() => onPick(row)}
                  mark={
                    <VendorTile
                      vendor={vendorOf(row.option, row.id)}
                      name={row.option.name}
                    />
                  }
                  title={model || '由中转站决定'}
                  detail={[
                    row.option.name,
                    oneMillion ? '1M 上下文' : null,
                    row.note,
                    status,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
                {row.key === selectedKey && effortRow}
              </Fragment>
            );
          })}
          {rows.length === 0 && !showDefault && (
            <p className="px-3 py-6 text-center text-caption text-muted-foreground">
              没有匹配的模型
            </p>
          )}
        </div>
      </div>

      <div
        className={cn(
          'shrink-0 space-y-1 border-t border-surface-border px-3 py-2',
          compact && !onManage && 'hidden',
        )}
      >
        {!compact && (
          <p className="text-micro leading-4 text-muted-foreground">
            {effort === undefined
              ? '切换模型会开启新的底层会话，并自动带上最近的对话记录；推理等级在输入框旁调整。'
              : '切换模型会开启新的底层会话，并自动带上最近的对话记录。'}
          </p>
        )}
        {onManage && (
          <button
            type="button"
            onClick={onManage}
            className="-ml-1.5 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-caption text-primary-text hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Settings2 className="size-3.5" aria-hidden="true" />
            管理模型配置
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A phone's effort choice: 默认 and the model's levels as a segmented row
 * under the model in use. A pick applies in place; the sheet stays open.
 */
function EffortSegments({
  context,
  disabled,
  onPick,
}: {
  context: EffortContext;
  disabled: boolean;
  onPick: (effort: string | null) => void;
}) {
  return (
    // The fieldset only disables the levels; the segmented group names them.
    <fieldset
      data-effort-segments=""
      role="none"
      disabled={disabled}
      className="min-w-0 space-y-1 pt-0.5 pr-2 pb-2 pl-[2.875rem] disabled:opacity-50"
    >
      <p className="text-micro text-muted-foreground" aria-hidden="true">
        推理等级
        {context.defaultEffort &&
          ` · 默认${effortLabel(context.defaultEffort)}`}
      </p>
      <SegmentedControl
        label={
          context.defaultEffort
            ? `推理等级（默认${effortLabel(context.defaultEffort)}）`
            : '推理等级'
        }
        size="sm"
        value={context.effort ?? DEFAULT_EFFORT}
        options={[
          { value: DEFAULT_EFFORT, label: '默认' },
          ...context.efforts.map((level) => ({
            value: level,
            label: effortLabel(level),
          })),
        ]}
        onChange={(value) => {
          if (!disabled) onPick(value === DEFAULT_EFFORT ? null : value);
        }}
      />
    </fieldset>
  );
}

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconButton
      label={label}
      icon={children}
      tooltipSide="right"
      size="icon"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'size-9 rounded-lg',
        active
          ? 'bg-surface-selected text-foreground ring-1 ring-surface-border hover:bg-surface-selected'
          : 'text-muted-foreground',
      )}
    />
  );
}

function RowButton({
  checked,
  disabled,
  onClick,
  mark,
  title,
  detail,
}: {
  checked: boolean;
  disabled: boolean;
  onClick: () => void;
  mark: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-model-row=""
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-100 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        checked && 'bg-surface-selected hover:bg-surface-selected',
      )}
    >
      {mark}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-foreground">
          {title}
        </span>
        <span className="block truncate text-caption text-muted-foreground">
          {detail}
        </span>
      </span>
      {checked && (
        <Check
          className="size-4 shrink-0 text-primary-text"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
