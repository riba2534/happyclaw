import { logger } from './logger.js';
import { deleteSession, setSessionModel, setSessionProviderId } from './db.js';
import { buildRecentConversationHistoryContext } from './conversation-history.js';
export interface ProviderSwitchInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  turnId?: string;
  /** Persisted message IDs already represented by this cold-run prompt. */
  readonly currentBatchMessageIds?: readonly string[];
  agentId?: string;
}

const PROVIDER_SWITCH_HISTORY_INTRO =
  '检测到本次因切换 provider 或模型需要使用新的底层模型 session。以下是 HappyClaw 保存的最近对话记录，供你延续上下文。';

export interface ProviderSwitchSelection {
  profileId: string;
  previousProviderId?: string;
  resetSession?: boolean;
  /** The upstream model the fresh session starts on; none for a pass-through relay. */
  sessionModel?: string | null;
}

function conversationHistoryChatJid(input: ProviderSwitchInput): string {
  if (!input.agentId) return input.chatJid;
  if (input.chatJid.includes('#agent:')) return input.chatJid;
  return `${input.chatJid}#agent:${input.agentId}`;
}

function seedPromptWithPersistedHistory<T extends ProviderSwitchInput>(
  input: T,
): T {
  // Orchestration may already have prepended recovery/provider-switch history.
  if (input.prompt.includes('<system_context>')) return input;

  const pendingMessageIds = new Set(input.currentBatchMessageIds);
  if (input.turnId) pendingMessageIds.add(input.turnId);

  const chatJid = conversationHistoryChatJid(input);
  const history = buildRecentConversationHistoryContext(
    chatJid,
    pendingMessageIds,
    {
      limit: 30,
      maxMessageLength: 700,
      intro: PROVIDER_SWITCH_HISTORY_INTRO,
    },
  );
  if (!history) return input;

  logger.info(
    {
      groupFolder: input.groupFolder,
      chatJid,
      historyCount: history.count,
    },
    'Provider switch: injected recent conversation history into prompt',
  );
  return { ...input, prompt: history.context + input.prompt };
}

/**
 * Claude SDK sessions are bound to one OAuth account / provider, and a ChatGPT
 * session's encrypted reasoning verifies only for the model that issued it.
 * When the pool fails over or the conversation changes model, drop the resume
 * token and seed the replacement session with HappyClaw's persisted
 * transcript so prior user/assistant turns survive.
 */
export function applyProviderSwitchToInput<T extends ProviderSwitchInput>(
  input: T,
  poolResult: ProviderSwitchSelection | null,
): T {
  if (!poolResult?.resetSession) return input;

  logger.info(
    {
      groupFolder: input.groupFolder,
      agentId: input.agentId || null,
      previousProviderId: poolResult.previousProviderId,
      providerId: poolResult.profileId,
    },
    'Clearing Claude session after switching providers',
  );

  // deleteSession removes the whole sessions row, including the provider_id
  // binding trySelectPoolProvider just wrote. Re-bind the freshly-selected
  // provider so the next turn stays sticky to it instead of degrading to a
  // fresh pool pick, and the model so the next launch compares against the
  // model this new session actually starts on.
  if (input.sessionId) {
    deleteSession(input.groupFolder, input.agentId);
    setSessionProviderId(
      input.groupFolder,
      input.agentId,
      poolResult.profileId,
    );
    if (poolResult.sessionModel) {
      setSessionModel(
        input.groupFolder,
        input.agentId,
        poolResult.sessionModel,
      );
    }
  }

  return {
    ...seedPromptWithPersistedHistory(input),
    sessionId: undefined,
  };
}
