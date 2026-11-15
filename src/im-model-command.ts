/**
 * IM `/model`: show and change the model of the conversation a chat routes
 * to, the way the Web chat picker does.
 *
 *   /model                         the current model and the numbered connections
 *   /model <n> [page]              the numbered models of connection n
 *   /model <n>.<m> [effort]        pick model m of connection n
 *   /model <model name|id> [effort] pick the one model of that name
 *   /model default                 back to the default
 *
 * The caller has already applied the owner gate (the listing shows the
 * owner's connections) and resolved the session like `/clear`. A choice is
 * checked and saved by session-model-service, with the workspace owner as
 * the chooser, so what IM can pick is exactly what the owner could pick on
 * the Web. Replies stay short enough for one IM message: long model lists
 * are paged.
 */
import {
  buildSessionModelSelectionView,
  checkSessionModelChoice,
  saveSessionModelChoice,
  type SessionModelChooser,
  type SessionRunnerControl,
} from './session-model-service.js';
import type { RegisteredGroup } from './types.js';

type SelectionView = ReturnType<typeof buildSessionModelSelectionView>;
type ConnectionOption = SelectionView['options'][number];

/** Models shown per page of `/model <n>`. */
export const MODEL_COMMAND_PAGE_SIZE = 20;
/** Connections shown by a bare `/model`; the rest are counted. */
const CONNECTION_LIST_LIMIT = 30;

const HINT =
  '发送 /model <编号> 查看连接的模型，/model <编号>.<模型编号> [档位] 切换，/model default 恢复默认。';

const DEFAULT_SOURCE_LABELS: Record<
  SelectionView['default']['source'],
  string
> = {
  // The default never comes from the session itself; listed for the type.
  session: '本会话选择',
  agent: '跟随智能体',
  owner_main: '跟随主智能体',
  system_main: '跟随主 HappyClaw',
  workspace_env: '工作区环境变量',
  none: '未选择模型',
};

/** One model a connection offers, as `/model` lists and matches it. */
interface ModelEntry {
  id: string;
  /** A name the connection declares for it, when it differs from the id. */
  displayName: string | null;
  efforts: readonly string[];
}

/**
 * A declared display name, when the entry carries one. The model list may
 * name a model for people; matching and listing use it besides the id.
 */
function declaredDisplayName(entry: object): string | null {
  const value = (entry as { displayName?: unknown }).displayName;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function modelsOf(option: ConnectionOption): ModelEntry[] {
  if ('codex' in option && option.codex) {
    return option.codex.models.map((entry) => ({
      id: entry.value,
      displayName: entry.label !== entry.value ? entry.label : null,
      efforts: entry.efforts,
    }));
  }
  if (!('models' in option) || !option.models) return [];
  return option.models.map((entry) => {
    const displayName = declaredDisplayName(entry);
    return {
      id: entry.id,
      displayName: displayName && displayName !== entry.id ? displayName : null,
      efforts: entry.efforts,
    };
  });
}

/** The model a connection runs when the choice names none. */
function ownModel(option: ConnectionOption): string {
  return 'codex' in option && option.codex
    ? option.codex.defaultModel
    : option.model;
}

function modelLabel(entry: ModelEntry): string {
  return entry.displayName ? `${entry.displayName}（${entry.id}）` : entry.id;
}

/** `连接 · 模型 · 档位 x`, leaving out what is not known. */
function describeChoice(
  option: ConnectionOption | undefined,
  model: string | null | undefined,
  effort: string | null | undefined,
): string {
  const parts = [option?.name ?? '未知连接'];
  const runs = model || (option ? ownModel(option) : '');
  parts.push(runs || '连接默认模型');
  if (effort) parts.push(`档位 ${effort}`);
  return parts.join(' · ');
}

/** What the conversation runs on now, and where that comes from. */
function describeCurrent(view: SelectionView): string {
  const selected = view.options.find(
    (option) => option.id === view.selectedModelConfigId,
  );
  if (selected) {
    return `${describeChoice(selected, view.selectedModel, view.selectedEffort)}（本会话选择）`;
  }
  const { source, modelConfigId, model, effort, connectionMissing } =
    view.default;
  const from = DEFAULT_SOURCE_LABELS[source] ?? DEFAULT_SOURCE_LABELS.none;
  if (connectionMissing) {
    return `默认绑定的连接已删除或缺少凭据，运行会失败（${from}）`;
  }
  if (source === 'workspace_env') return '工作区自带的 Provider 环境变量';
  const option = view.options.find((item) => item.id === modelConfigId);
  if (source === 'none' || !option) return '还没有选择模型，运行会失败';
  return `${describeChoice(option, model, effort)}（${from}）`;
}

/** Why a connection cannot be picked, or ''. */
function unusableReason(option: ConnectionOption): string {
  if (option.usable === false) return '缺少凭据';
  if ('codex' in option && option.codex?.needsReauth) return '需重新登录';
  return '';
}

function overview(view: SelectionView): string {
  const inUse = view.selectedModelConfigId ?? view.default.modelConfigId;
  const lines = [`当前模型：${describeCurrent(view)}`];
  if (view.options.length === 0) {
    lines.push('还没有可用的模型连接，请先在 Web 设置里添加。');
    return lines.join('\n');
  }
  lines.push('连接：');
  view.options.slice(0, CONNECTION_LIST_LIMIT).forEach((option, index) => {
    const notes = [
      option.id === inUse ? '当前' : '',
      unusableReason(option),
    ].filter(Boolean);
    lines.push(
      `${index + 1}. ${option.name}${notes.length ? `（${notes.join('，')}）` : ''}`,
    );
  });
  if (view.options.length > CONNECTION_LIST_LIMIT) {
    lines.push(
      `…还有 ${view.options.length - CONNECTION_LIST_LIMIT} 个连接，可在 Web 上查看`,
    );
  }
  lines.push(HINT);
  return lines.join('\n');
}

function listModels(
  view: SelectionView,
  connectionIndex: number,
  page: number,
): string {
  const option = view.options[connectionIndex - 1];
  if (!option) return noConnection(connectionIndex);
  const models = modelsOf(option);
  if (models.length === 0) {
    return `${option.name} 没有可选的模型，发送 /model 查看其他连接。`;
  }
  const pages = Math.ceil(models.length / MODEL_COMMAND_PAGE_SIZE);
  if (page < 1 || page > pages) {
    return `${option.name} 的模型只有 ${pages} 页。`;
  }
  const current =
    view.selectedModelConfigId === option.id
      ? view.selectedModel || ownModel(option)
      : view.selectedModelConfigId === null &&
          view.default.modelConfigId === option.id
        ? view.default.model
        : null;
  const start = (page - 1) * MODEL_COMMAND_PAGE_SIZE;
  const lines = [
    pages > 1
      ? `${option.name} 的模型（第 ${page}/${pages} 页）：`
      : `${option.name} 的模型：`,
  ];
  models
    .slice(start, start + MODEL_COMMAND_PAGE_SIZE)
    .forEach((entry, offset) => {
      const efforts = entry.efforts.length
        ? ` · 档位 ${entry.efforts.join('/')}`
        : '';
      const mark = entry.id === current ? '（当前）' : '';
      lines.push(
        `${start + offset + 1}. ${modelLabel(entry)}${efforts}${mark}`,
      );
    });
  const reason = unusableReason(option);
  if (reason) lines.push(`这个连接${reason}，暂时不能选择。`);
  lines.push(
    page < pages
      ? `发送 /model ${connectionIndex}.<编号> [档位] 切换，/model ${connectionIndex} ${page + 1} 看下一页。`
      : `发送 /model ${connectionIndex}.<编号> [档位] 切换。`,
  );
  return lines.join('\n');
}

function noConnection(index: number): string {
  return `没有编号为 ${index} 的连接，发送 /model 查看列表。`;
}

interface ModelMatch {
  /** 1-based numbers, as `/model <n>.<m>` takes them. */
  connection: number;
  model: number;
  option: ConnectionOption;
  entry: ModelEntry;
}

/** Every (connection, model) whose id or declared name is `name`. */
function findModels(view: SelectionView, name: string): ModelMatch[] {
  const wanted = name.toLowerCase();
  const matches: ModelMatch[] = [];
  view.options.forEach((option, index) => {
    modelsOf(option).forEach((entry, position) => {
      if (
        entry.id.toLowerCase() === wanted ||
        entry.displayName?.toLowerCase() === wanted
      ) {
        matches.push({
          connection: index + 1,
          model: position + 1,
          option,
          entry,
        });
      }
    });
  });
  return matches;
}

export interface ModelCommandInput {
  /** Everything after `/model`. */
  args: string;
  /** The workspace the session belongs to. */
  workspace: RegisteredGroup;
  workspaceJid: string;
  /** The session the chat routes to. */
  agentId: string;
  /** The workspace owner, who chooses. */
  chooser: SessionModelChooser & { id: string };
  runners: SessionRunnerControl | null;
}

export function runModelCommand(input: ModelCommandInput): string {
  const view = buildSessionModelSelectionView(
    input.workspace,
    input.agentId,
    input.chooser,
  );
  const args = input.args.trim();
  if (!args) return overview(view);

  const choose = (
    option: ConnectionOption | null,
    model: string | null,
    effort: string | null,
  ): string => {
    const checked = checkSessionModelChoice(
      input.workspace,
      { modelConfigId: option?.id ?? null, model, effort },
      input.chooser,
    );
    if (!checked.ok) return `⚠️ ${checked.rejection.error}`;
    saveSessionModelChoice({
      group: input.workspace,
      workspaceJid: input.workspaceJid,
      agentId: input.agentId,
      choice: checked.choice,
      updatedBy: input.chooser.id,
      runners: input.runners,
    });
    const after = buildSessionModelSelectionView(
      input.workspace,
      input.agentId,
      input.chooser,
    );
    return option
      ? `已切换到 ${describeChoice(option, checked.choice.model, checked.choice.effort)}，下一条消息起生效。`
      : `已恢复默认：${describeCurrent(after)}，下一条消息起生效。`;
  };

  if (args.toLowerCase() === 'default') return choose(null, null, null);

  const listing = args.match(/^(\d+)(?:\s+(\d+))?$/);
  if (listing) {
    return listModels(view, Number(listing[1]), Number(listing[2] ?? 1));
  }

  const numbered = args.match(/^(\d+)\.(\d+)(?:\s+(\S+))?$/);
  if (numbered) {
    const index = Number(numbered[1]);
    const option = view.options[index - 1];
    if (!option) return noConnection(index);
    const entry = modelsOf(option)[Number(numbered[2]) - 1];
    if (!entry) {
      return `${option.name} 没有编号为 ${numbered[2]} 的模型，发送 /model ${index} 查看列表。`;
    }
    return choose(option, entry.id, numbered[3] ?? null);
  }

  // A trailing word is an effort when the rest names a model; otherwise the
  // whole text is the name (a display name may contain spaces).
  const split = args.match(/^(.+?)\s+(\S+)$/);
  let matches = split ? findModels(view, split[1]) : [];
  let effort = split ? split[2] : null;
  if (matches.length === 0) {
    matches = findModels(view, args);
    effort = null;
  }
  if (matches.length === 0) {
    return `没有找到模型 ${args}，发送 /model 查看连接和模型。`;
  }
  if (matches.length > 1) {
    return [
      '多个连接都有这个模型，请用编号选择：',
      ...matches
        .slice(0, MODEL_COMMAND_PAGE_SIZE)
        .map(
          (match) =>
            `/model ${match.connection}.${match.model} → ${match.option.name} · ${modelLabel(match.entry)}`,
        ),
    ].join('\n');
  }
  const [match] = matches;
  return choose(match.option, match.entry.id, effort);
}
