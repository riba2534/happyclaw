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
  History,
  LayoutGrid,
  Loader2,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import type { ModelCapabilitySource } from '@/lib/model-providers';
import type { ConnectionModel } from '@/types';
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
import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { vendorOfConnection, vendorOfModel } from '../brand/vendor';
import { VendorTile } from '../brand/VendorTile';
import { api } from '../../api/client';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useAuthStore } from '../../stores/auth';
import { showToast } from '../../utils/toast';
import { useIsPhone } from '../layout/phone';
import { useComposerDock, useDockOverlay } from './composer/composerDock';
import {
  ConversationContextUsageLine,
  formatTokenCount,
} from './composer/ContextUsageRing';
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

/** One model of a non-ChatGPT connection. */
export type ConnectionModelChoice = ConnectionModel;

export interface SessionModelOption {
  id: string;
  name: string;
  kind: 'official' | 'third_party' | 'codex';
  /** The connection's own model; '' lets a relay decide. */
  model: string;
  /** False when the connection holds no credential and would fail. */
  usable?: boolean;
  /** Present on ChatGPT connections: the models and efforts to choose from. */
  codex?: CodexSelectionView;
  /** Every model a non-ChatGPT connection offers, its own included. */
  models?: ConnectionModelChoice[];
}

/** Which step of the resolution order the conversation's default comes from. */
export type DefaultModelSource =
  | 'agent'
  | 'owner_main'
  | 'system_main'
  | 'workspace_env'
  | 'none';

export interface SessionModelSelection {
  selectedModelConfigId: string | null;
  /** The model picked within the selected connection; null follows its own. */
  selectedModel?: string | null;
  selectedEffort?: string | null;
  default: {
    source: DefaultModelSource;
    modelConfigId: string | null;
    /** The model a launch with no pick runs; null for the workspace override. */
    model?: string | null;
    /** The effort a launch with no pick runs at, when its model takes one. */
    effort?: string | null;
    /**
     * The bound connection is deleted or has no credential: a run on the
     * default fails rather than falling back to another connection.
     */
    connectionMissing?: boolean;
  };
  options: SessionModelOption[];
}

const DEFAULT_SOURCE_LABELS: Record<DefaultModelSource, string> = {
  agent: '智能体默认',
  owner_main: '跟随主智能体',
  system_main: '跟随主 HappyClaw',
  workspace_env: '工作区环境变量',
  none: '未选择模型',
};

/** Where the conversation's default comes from, as the default row reads. */
export function defaultSourceLabel(selection: SessionModelSelection): string {
  return (
    DEFAULT_SOURCE_LABELS[selection.default.source] ??
    DEFAULT_SOURCE_LABELS.none
  );
}

/** The default cannot run: nothing is chosen, or its connection is unusable. */
export function defaultUnusable(selection: SessionModelSelection): boolean {
  return (
    selection.default.source === 'none' || !!selection.default.connectionMissing
  );
}

/**
 * What the default resolves to in this conversation: connection and model,
 * or why it cannot run and what to do about it.
 */
export function describeDefaultModel(
  selection: SessionModelSelection,
  canAddModel = false,
): string {
  const { source, modelConfigId, model, connectionMissing } = selection.default;
  if (connectionMissing) return '连接不可用，绑定的连接已删除或缺少凭据';
  if (source === 'workspace_env') return '使用工作区自带的 Provider 环境变量';
  const named = selection.options.find((option) => option.id === modelConfigId);
  if (source === 'none' || !named) {
    return canAddModel
      ? '选择一个模型，或在下方添加模型'
      : '请联系管理员添加模型';
  }
  // A ChatGPT connection is named by the model it runs; the others by name
  // and, when known, the model.
  if (named.codex) return model || named.codex.defaultModel;
  return model ? `${named.name} · ${model}` : named.name;
}

/** Why a connection is listed but cannot be chosen ('' when it can). */
function optionStatus(option: SessionModelOption): string {
  if (option.usable === false) return '缺少凭据';
  if (option.codex?.needsReauth) return '需重新登录';
  return '';
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
 * default resolves to. '' when nothing names a model.
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

interface ModelLevels {
  efforts: string[];
  defaultEffort: string | null;
  source: ModelCapabilitySource;
}

/** The efforts a connection's model takes, and its own default level. */
function modelEfforts(
  option: SessionModelOption,
  model: string,
): ModelLevels | null {
  if (option.codex) {
    const choice = option.codex.models.find((item) => item.value === model);
    return choice?.efforts.length
      ? {
          efforts: choice.efforts,
          defaultEffort: choice.defaultEffort || null,
          source: 'registry',
        }
      : null;
  }
  const entry = option.models?.find((item) => item.id === model);
  return entry?.efforts?.length
    ? {
        efforts: entry.efforts,
        defaultEffort: entry.defaultEffort ?? null,
        source: entry.effortsSource ?? 'registry',
      }
    : null;
}

/** The badge a list of efforts carries when the registry did not supply it. */
export function effortsSourceBadge(
  source: ModelCapabilitySource,
): string | null {
  if (source === 'family') return '推断';
  if (source === 'declared') return '自定义';
  return null;
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
  /** Its context window in tokens; null when unknown. */
  contextWindow: number | null;
}

function rowKey(optionId: string, id: string): string {
  return `${optionId}:${id}`;
}

/**
 * The rows a connection offers: every model it lists, and a pinned model the
 * list lacks too, so the panel shows what is really selected. A connection
 * without a list gives one row standing for it.
 */
function optionRows(
  option: SessionModelOption,
  pinned: string | null,
): ModelRow[] {
  const defaultModel = ownModel(option);
  const listed = option.codex
    ? option.codex.models.map((model) => ({
        id: model.value,
        contextWindow: null,
      }))
    : (option.models ?? []);
  const row = (
    id: string,
    { note, contextWindow = null }: Partial<ModelRow> = {},
  ): ModelRow => ({
    key: rowKey(option.id, id),
    option,
    pick: id === defaultModel ? null : id,
    id,
    note,
    contextWindow,
  });
  if (!listed.length) return [row(defaultModel)];
  const rows: ModelRow[] = [];
  if (
    pinned &&
    pinned !== defaultModel &&
    !listed.some((model) => model.id === pinned)
  ) {
    rows.push(
      row(pinned, {
        note: option.codex ? '不在账号的模型列表里' : '不在模型列表里',
      }),
    );
  }
  // A relay without a model of its own still lets the relay decide.
  if (!option.codex && !defaultModel) rows.push(row(''));
  for (const model of listed) rows.push(row(model.id, model));
  return rows;
}

/** The second line of a model row. */
function rowDetail(row: ModelRow): string {
  return [
    row.option.name,
    row.contextWindow
      ? `${formatTokenCount(row.contextWindow)} 上下文`
      : row.option.models && row.id
        ? '上下文未知'
        : null,
    row.note,
    optionStatus(row.option),
  ]
    .filter(Boolean)
    .join(' · ');
}

// ─── Recently used ─────────────────────────────────────────────

/** A model picked in some conversation: its connection and the model run. */
export interface RecentModel {
  modelConfigId: string;
  model: string;
}

const MAX_RECENT_MODELS = 5;

export function recentModelsKey(userId: string): string {
  return `happyclaw:model-picker:recent:${userId}`;
}

/** Most recent first; empty without a user or a readable storage. */
export function readRecentModels(userId: string | undefined): RecentModel[] {
  if (!userId) return [];
  try {
    const value: unknown = JSON.parse(
      globalThis.localStorage.getItem(recentModelsKey(userId)) ?? '[]',
    );
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is RecentModel =>
          typeof item?.modelConfigId === 'string' &&
          typeof item?.model === 'string',
      )
      .slice(0, MAX_RECENT_MODELS);
  } catch {
    return [];
  }
}

/** Puts a pick first, without duplicates, keeping the last five. */
export function rememberRecentModel(
  userId: string | undefined,
  pick: RecentModel,
): RecentModel[] {
  const next = [
    pick,
    ...readRecentModels(userId).filter(
      (item) =>
        item.modelConfigId !== pick.modelConfigId || item.model !== pick.model,
    ),
  ].slice(0, MAX_RECENT_MODELS);
  if (userId) {
    try {
      globalThis.localStorage.setItem(
        recentModelsKey(userId),
        JSON.stringify(next),
      );
    } catch {
      // Storage full or disabled: the list just is not remembered.
    }
  }
  return next;
}

/** The rows of the recent view, in the order they were used. */
function recentRows(
  selection: SessionModelSelection,
  recent: RecentModel[],
): ModelRow[] {
  return recent.flatMap((item) => {
    const option = selection.options.find(
      (candidate) => candidate.id === item.modelConfigId,
    );
    if (!option) return [];
    const found = optionRows(option, null).find((row) => row.id === item.model);
    return found ? [found] : [];
  });
}

export interface EffortContext {
  /** The connection the conversation runs on. */
  option: SessionModelOption;
  /** The model it runs there. */
  model: string;
  /** The levels that model takes, low to high. */
  efforts: string[];
  /** Where those levels come from. */
  effortsSource: ModelCapabilitySource;
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
  // Nothing to set an effort on while the default cannot run.
  if (!picked && defaultUnusable(selection)) return null;
  return {
    option,
    model,
    efforts: levels.efforts,
    effortsSource: levels.source,
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

/**
 * A phone's single control for model and effort, after cindy's model pill:
 * a filled 34px pill, 12px medium text. The model name truncates first; the
 * level after it stays whole. In the resting composer pill it shrinks to a
 * 34px chip of the vendor mark alone, its touch target padded to 44px.
 */
const PHONE_PILL_CLASS =
  'relative inline-flex h-[34px] max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-surface-border bg-muted text-caption font-medium text-foreground transition-colors duration-100 before:absolute before:-inset-[5px] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:bg-surface-hover aria-disabled:cursor-default data-[state=open]:bg-surface-hover';

function phonePillClass(compact: boolean): string {
  return cn(
    PHONE_PILL_CLASS,
    compact ? 'w-[34px] justify-center' : 'pr-2.5 pl-1.5',
  );
}

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
  /** The session whose model this picks. */
  agentId: string;
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
  const userId = useAuthStore((s) => s.user?.id);
  // Read once: a sign-out unmounts the composer, so the user never changes
  // under a mounted picker.
  const [recent, setRecent] = useState<RecentModel[]>(() =>
    readRecentModels(userId),
  );
  // A phone gets one pill for model and effort and picks the effort in the
  // sheet; a narrow window keeps the desktop controls but the sheet too.
  const phone = useIsPhone();
  const narrow = useMediaQuery('(max-width: 639px)');
  const inSheet = phone || narrow;
  const compact = (useComposerDock()?.compact ?? false) && phone;
  const [selection, setSelection] = useState<SessionModelSelection | null>(
    null,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useDockOverlay();
  // The sheet's detent: half on open, full while searching (cindy's picker
  // makes room for the keyboard when its field gets focus).
  // Full, not half: the search field, connection chips and footer take
  // most of a half sheet, which left about one model row in view.
  const [snap, setSnap] = useState<'half' | 'full'>('full');
  const [saving, setSaving] = useState(false);
  const modelTooltip = useQuietTooltip();
  const lastRefreshAt = useRef(0);
  // Bumped by every save: a look-up that started before one must not put an
  // older selection back over the saved one.
  const saves = useRef(0);
  const basePath = `/api/groups/${encodeURIComponent(groupJid)}/model-selection`;
  const query = `?agentId=${encodeURIComponent(agentId)}`;

  const load = useCallback(async () => {
    try {
      setSelection(await api.get<SessionModelSelection>(`${basePath}${query}`));
      setLoadFailed(false);
    } catch {
      // Older server or no access: a desktop simply hides the picker; a
      // phone keeps its chip, which says so when tapped.
      setSelection(null);
      setLoadFailed(true);
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
    // A phone's pill is never really disabled (a tap that does nothing reads
    // as broken): it says why instead of opening.
    if (next && phone && !canChange) {
      showToast('无法切换模型', '你没有修改此工作区配置的权限');
      return;
    }
    if (next && phone && saving) {
      showToast('正在切换模型', '请稍候再试');
      return;
    }
    modelTooltip.onMenuOpenChange(next);
    if (next) setSnap('full');
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
  ): Promise<boolean> => {
    if (saving) return false;
    saves.current += 1;
    setSaving(true);
    try {
      const next = await api.put<SessionModelSelection>(basePath, {
        agentId,
        ...body,
      });
      setSelection(next);
      toast.success(success(next));
      return true;
    } catch (err) {
      toast.error(
        modelBindingErrorMessage(err) ?? getErrorMessage(err, '切换模型失败'),
      );
      void load();
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!selection || selection.options.length === 0) {
    if (!phone || (!selection && !loadFailed)) return null;
    return (
      <UnavailablePill
        compact={compact}
        onTap={() => {
          if (selection) {
            showToast(
              '还没有可用的模型',
              canManageModels
                ? '在 设置 → 模型 中添加模型'
                : '请联系管理员添加模型',
            );
          } else {
            showToast('无法读取模型配置', '已重新加载，请稍后再试');
            void load();
          }
        }}
      />
    );
  }

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
  // The trigger names the model in use, without where the default came from.
  const unusable = !picked && defaultUnusable(selection);
  const triggerName = unusable
    ? selection.default.connectionMissing
      ? '连接不可用'
      : '未选择模型'
    : inUse.model ||
      inUse.option?.name ||
      (selection.default.source === 'workspace_env'
        ? defaultSourceLabel(selection)
        : '未选择模型');
  const fullLabel =
    inUse.model && !unusable
      ? [inUse.option?.name, inUse.model].filter(Boolean).join(' · ')
      : triggerName;
  const tooltip = picked
    ? fullLabel
    : `${defaultSourceLabel(selection)} · ${fullLabel}`;

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
    const name = modelToRun ? `${option.name} · ${modelToRun}` : option.name;
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
    ).then((saved) => {
      if (saved && row) {
        setRecent(
          rememberRecentModel(userId, {
            modelConfigId: option.id,
            model: row.id,
          }),
        );
      }
    });
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
      recent={recent}
      pinnedModel={pinnedModel}
      selectedKey={selectedKey}
      disabled={disabled}
      inSheet={inSheet}
      touch={phone}
      effort={
        phone
          ? effortContext && {
              context: effortContext,
              disabled: effortDisabled,
              onPick: pickEffort,
            }
          : undefined
      }
      // A phone keeps the sheet open on the new model, its levels under it,
      // so changing both takes one visit.
      onPick={(row) => {
        if (!phone) handleOpenChange(false);
        pickRow(row);
      }}
      onSearchFocus={phone ? () => setSnap('full') : undefined}
      footer={
        phone && (
          <ConversationContextUsageLine jid={groupJid} agentId={agentId} />
        )
      }
      onAddModel={
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
  ) : inUse.option && !unusable ? (
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
            {/* One element at rest and in the card, so the sheet's focus
                return and open state survive the pill opening into it. */}
            <button
              type="button"
              // Never disabled outright: a tap says why (handleOpenChange).
              aria-disabled={disabled || undefined}
              aria-label={`模型：${fullLabel}${
                shown ? `，推理等级：${shown.spoken}` : ''
              }`}
              data-model-pill={compact ? 'compact' : ''}
              className={phonePillClass(compact)}
            >
              {mark}
              {!compact && (
                <>
                  <span
                    className={cn(
                      'min-w-0 truncate',
                      unusable && 'text-warning',
                    )}
                  >
                    {triggerName}
                  </span>
                  {shown?.level && (
                    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                      <span
                        className="text-muted-foreground"
                        aria-hidden="true"
                      >
                        ·
                      </span>
                      {effortLabel(shown.level)}
                    </span>
                  )}
                  {!disabled && chevron}
                </>
              )}
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
                  <span
                    className={cn(
                      'min-w-0 truncate',
                      unusable && 'text-warning',
                    )}
                  >
                    {triggerName}
                  </span>
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
            snap={snap}
            onSnapChange={setSnap}
            // The sheet takes focus itself (below); that is no keyboard
            // position, so it draws no focus ring.
            className="gap-0 p-0 outline-none"
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

/**
 * A phone's model chip while there is nothing to pick from (the selection
 * could not be read, or no configuration exists): it stays where the model
 * sits and says why when tapped.
 */
function UnavailablePill({
  compact,
  onTap,
}: {
  compact: boolean;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      aria-disabled
      aria-label="模型：不可用"
      data-model-pill={compact ? 'compact' : ''}
      onClick={onTap}
      className={cn(phonePillClass(compact), 'text-muted-foreground')}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-surface-selected">
        <Sparkles className="size-3" aria-hidden="true" />
      </span>
      {!compact && <span className="truncate">模型</span>}
    </button>
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
        <DropdownMenuLabel className="flex items-center gap-1.5">
          推理等级
          <EffortsSourceBadge source={context.effortsSource} />
        </DropdownMenuLabel>
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
  /** Models this user picked lately, most recent first. */
  recent: RecentModel[];
  /** The model picked within the selected connection, if any. */
  pinnedModel: string | null;
  selectedKey: string;
  disabled: boolean;
  /** In a bottom sheet: the list fills it instead of a fixed height. */
  inSheet: boolean;
  /** A phone: connections are filtered by name chips (no tooltips there). */
  touch: boolean;
  /** Below the hint, e.g. a phone's context usage. */
  footer?: ReactNode;
  /** The search field got focus. */
  onSearchFocus?: () => void;
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
  /** Opens Settings to add a model; null for whoever may not. */
  onAddModel: (() => void) | null;
}

const RECENT_RAIL = 'recent';
const ALL_RAIL = 'all';

/**
 * The model panel after cindy's unified selector: a search field, a rail of
 * 最近, 全部 and the connections that filters the list, two-line rows with a
 * check on the one in use, and the way to add a model.
 */
function ModelPanel({
  selection,
  recent,
  pinnedModel,
  selectedKey,
  disabled,
  inSheet,
  touch,
  footer,
  onSearchFocus,
  effort,
  onPick,
  onAddModel,
}: ModelPanelProps) {
  const effortRow = effort && (
    <EffortSegments
      context={effort.context}
      disabled={effort.disabled}
      onPick={effort.onPick}
    />
  );
  const [query, setQuery] = useState('');
  const [rail, setRail] = useState<string>(ALL_RAIL);
  const listRef = useRef<HTMLDivElement>(null);

  // Opens on the model in use (cindy's picker scrolls to it), centred when
  // the list is longer than its box. Only the list scrolls, not the page.
  // A frame later: a sheet sets its height in its own layout effect, which
  // runs after this panel's.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const row = list?.querySelector<HTMLElement>(
        '[data-model-row][aria-checked="true"]',
      );
      if (!list || !row) return;
      const top =
        row.getBoundingClientRect().top -
        list.getBoundingClientRect().top +
        list.scrollTop;
      list.scrollTop = top - (list.clientHeight - row.offsetHeight) / 2;
    });
    return () => cancelAnimationFrame(frame);
    // Only on open: picking a row must not move the list under the finger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needle = query.trim().toLowerCase();
  const recentView = rail === RECENT_RAIL && !needle;
  // A search looks through every connection, whatever the rail shows.
  const rows = recentView
    ? recentRows(selection, recent)
    : selection.options
        .filter((option) => needle || rail === ALL_RAIL || option.id === rail)
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
  const sourceLabel = defaultSourceLabel(selection);
  const showDefault =
    rail === ALL_RAIL &&
    (!needle ||
      '默认'.includes(needle) ||
      'default'.includes(needle) ||
      sourceLabel.toLowerCase().includes(needle));
  const showRail = (id: string) => {
    setRail(id);
    setQuery('');
  };
  // 最近, 全部 and each connection: chips on a phone, marks otherwise.
  const railItems = [
    {
      id: RECENT_RAIL,
      label: '最近',
      mark: <History className="size-4" aria-hidden="true" />,
    },
    {
      id: ALL_RAIL,
      label: '全部',
      mark: <LayoutGrid className="size-4" aria-hidden="true" />,
    },
    ...selection.options.map((option) => ({
      id: option.id,
      label: option.name,
      mark: (
        <VendorTile
          vendor={vendorOfConnection({
            kind: option.kind,
            model: ownModel(option),
          })}
          name={option.name}
        />
      ),
    })),
  ].map((item) => ({ ...item, active: rail === item.id && !needle }));

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
          onFocus={onSearchFocus}
          aria-label="搜索模型"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          className="h-10 w-full bg-transparent pr-3 pl-9 text-body text-foreground outline-none placeholder:text-muted-foreground phone:h-11 phone:text-base"
        />
      </div>

      {touch && (
        // Names, not marks: a touch screen shows no tooltips.
        <div
          role="group"
          aria-label="模型配置"
          className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-surface-border px-3 py-2 [scrollbar-width:none]"
        >
          {railItems.map((item) => (
            <RailChip
              key={item.id}
              label={item.label}
              active={item.active}
              onClick={() => showRail(item.id)}
            />
          ))}
        </div>
      )}

      <div
        className={cn(
          'flex min-h-0 flex-1',
          !inSheet && 'h-[min(26rem,60dvh)]',
        )}
      >
        <div
          role="group"
          aria-label="模型配置"
          className={cn(
            'flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-surface-border py-2',
            touch && 'hidden',
          )}
        >
          {railItems.map((item) => (
            <RailButton
              key={item.id}
              label={item.label}
              active={item.active}
              onClick={() => showRail(item.id)}
            >
              {item.mark}
            </RailButton>
          ))}
        </div>

        <div
          ref={listRef}
          role="radiogroup"
          aria-label="本会话使用的模型"
          className="relative min-w-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5"
        >
          {showDefault && (
            <RowButton
              checked={selectedKey === DEFAULT_ROW_KEY}
              // A default that cannot run is not offered as a choice.
              disabled={
                disabled ||
                (defaultUnusable(selection) && selectedKey !== DEFAULT_ROW_KEY)
              }
              onClick={() => onPick(null)}
              mark={
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-selected text-muted-foreground">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                </span>
              }
              title={sourceLabel}
              detail={describeDefaultModel(selection, !!onAddModel)}
              warning={defaultUnusable(selection)}
            />
          )}
          {showDefault && selectedKey === DEFAULT_ROW_KEY && effortRow}
          {rows.map((row) => (
            <Fragment key={row.key}>
              <RowButton
                checked={row.key === selectedKey}
                disabled={disabled || !!optionStatus(row.option)}
                onClick={() => onPick(row)}
                mark={
                  <VendorTile
                    vendor={vendorOf(row.option, row.id)}
                    name={row.option.name}
                  />
                }
                title={row.id || '由中转站决定'}
                detail={rowDetail(row)}
              />
              {row.key === selectedKey && effortRow}
            </Fragment>
          ))}
          {rows.length === 0 && !showDefault && (
            <p className="px-3 py-6 text-center text-caption text-muted-foreground">
              {recentView ? '还没有最近使用的模型' : '没有匹配的模型'}
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 space-y-1 border-t border-surface-border px-3 py-2">
        <p className="text-micro leading-4 text-muted-foreground">
          {effort === undefined
            ? '切换模型会开启新的底层会话，并自动带上最近的对话记录；推理等级在输入框旁调整。'
            : '切换模型会开启新的底层会话，并自动带上最近的对话记录。'}
        </p>
        {(onAddModel || footer) && (
          // One row: adding a model on the left, the context use on the right.
          <div className="flex items-center justify-between gap-3">
            {onAddModel && (
              <button
                type="button"
                onClick={onAddModel}
                className="-ml-1.5 inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-caption text-primary-text hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:h-10"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                添加模型
              </button>
            )}
            <div className="min-w-0 text-right">{footer}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 推断 or 自定义 next to a list of efforts the registry did not supply. */
function EffortsSourceBadge({ source }: { source: ModelCapabilitySource }) {
  const badge = effortsSourceBadge(source);
  return badge ? (
    <Badge
      variant="neutral"
      title={
        source === 'family'
          ? '按同系列模型推断，未经上游确认'
          : '在模型连接里手动声明'
      }
    >
      {badge}
    </Badge>
  ) : null;
}

/**
 * A phone's effort choice: 默认 and the model's levels as a segmented row
 * under the model in use. A pick applies in place; the sheet stays open. On
 * a narrow screen the row drops its indent and scrolls sideways if needed.
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
      className="min-w-0 space-y-1 pt-0.5 pr-2 pb-2 pl-2 disabled:opacity-50 min-[420px]:pl-[2.875rem]"
    >
      <p
        className="flex items-center gap-1.5 text-micro text-muted-foreground"
        aria-hidden="true"
      >
        推理等级
        {context.defaultEffort &&
          ` · 默认${effortLabel(context.defaultEffort)}`}
        <EffortsSourceBadge source={context.effortsSource} />
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

function RailChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        // 36px, its touch target padded to 44px within the row.
        'relative h-9 max-w-[12rem] shrink-0 cursor-pointer truncate rounded-full border px-3 before:absolute before:-inset-y-1 before:inset-x-0 text-caption font-medium transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active
          ? 'border-surface-border bg-surface-selected text-foreground'
          : 'border-transparent bg-muted text-muted-foreground active:bg-surface-hover',
      )}
    >
      {label}
    </button>
  );
}

function RowButton({
  checked,
  disabled,
  onClick,
  mark,
  title,
  detail,
  warning = false,
}: {
  checked: boolean;
  disabled: boolean;
  onClick: () => void;
  mark: ReactNode;
  title: string;
  detail: string;
  /** The second line says why this cannot run. */
  warning?: boolean;
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
        <span
          className={cn(
            'block truncate text-caption',
            warning ? 'text-warning' : 'text-muted-foreground',
          )}
        >
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
