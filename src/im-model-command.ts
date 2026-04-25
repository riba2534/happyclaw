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
  targetChatJid: string;
  folder: string;
  agentId?: string | null;
  locationLine: string;
}

export interface ModelSwitchStartInput {
  target: ModelCommandTarget;
  binding: ModelBinding;
  actor: string;
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
    options?: { markPending?: boolean; handoffSummaryId?: string | null },
  ) => ConversationRuntimeState;
  broadcastModelChanged: (baseChatJid: string, agentId?: string) => void;
  startModelSwitch?: (input: ModelSwitchStartInput) => void;
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

    input.deps.startModelSwitch?.({
      target: input.target,
      binding: parsed.binding,
      actor: input.actor,
    });
    return `正在切换 ${input.target.locationLine} 的模型为 ${parsed.binding.provider_pool_id} ${formatModelLabel(parsed.binding.selected_model)}，正在生成上下文摘要。完成后下一条消息开始生效。`;
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
