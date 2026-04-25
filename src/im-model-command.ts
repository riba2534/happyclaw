import {
  commandParts,
  formatModelLabel,
  formatModelList,
  formatRuntimeState,
  parseModelBindingFromArgs,
  shouldIncludeAllModelOptions,
} from './model-command.js';
import type { ConversationRuntimeState, ModelBinding } from './types.js';

export interface ModelCommandTarget {
  baseChatJid: string;
  folder: string;
  agentId?: string | null;
  locationLine: string;
}

export interface ModelCommandTargetDeps {
  ensureConversationRuntimeState: (
    groupFolder: string,
    agentId?: string | null,
    updatedBy?: string | null,
  ) => ConversationRuntimeState;
  setConversationRuntimeBinding: (
    groupFolder: string,
    agentId: string | null | undefined,
    binding: ModelBinding,
    bindingSource: 'user_pinned',
    updatedBy?: string | null,
    options?: { markPending?: boolean },
  ) => ConversationRuntimeState;
  broadcastModelChanged: (baseChatJid: string, agentId?: string) => void;
}

export function handleModelCommandForTarget(input: {
  rawArgs: string;
  target: ModelCommandTarget;
  actor: string;
  defaultUpdatedBy?: string | null;
  deps: ModelCommandTargetDeps;
}): string {
  const args = commandParts(input.rawArgs);
  const subcommand = (args[0] || '').toLowerCase();

  if (subcommand === 'list' || subcommand === 'ls') {
    return formatModelList(shouldIncludeAllModelOptions(args.slice(1)));
  }

  if (subcommand === 'use') {
    const parsed = parseModelBindingFromArgs(args.slice(1));
    if (!parsed.binding) return parsed.error || '模型切换失败。';

    const state = input.deps.setConversationRuntimeBinding(
      input.target.folder,
      input.target.agentId ?? '',
      parsed.binding,
      'user_pinned',
      input.actor,
      { markPending: true },
    );
    input.deps.broadcastModelChanged(
      input.target.baseChatJid,
      input.target.agentId || undefined,
    );
    return `已切换 ${input.target.locationLine} 的模型为 ${state.provider_pool_id} ${formatModelLabel(state.selected_model)}，下一条消息开始生效。`;
  }

  if (subcommand) {
    return '可用命令：/model、/model list、/model use <claude|gpt> [model]';
  }

  const state = input.deps.ensureConversationRuntimeState(
    input.target.folder,
    input.target.agentId ?? '',
    input.defaultUpdatedBy ?? null,
  );
  return `${formatRuntimeState(state, input.target.locationLine)}\n版本：${state.binding_revision}`;
}
