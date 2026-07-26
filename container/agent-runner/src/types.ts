/**
 * Shared types for HappyClaw Agent Runner.
 *
 * These types are used across index.ts, stream-processor.ts, and mcp-tools.ts.
 */

// Streaming event types (canonical source: shared/stream-event.ts)
export type { StreamEventType, StreamEvent } from './stream-event.types.js';
import type { ClaudeContextAudit, StreamEvent } from './stream-event.types.js';

/**
 * Sanitized, per-input-turn channel identity supplied by the HappyClaw host.
 *
 * This is deliberately a capability context rather than a credential bag:
 * tokens, app secrets and provider client objects must never cross the runner
 * boundary.  All fields describe the message that triggered the current turn
 * and are therefore safe to expose to the Agent and its subagents.
 */
export interface ChannelTurnContext {
  schemaVersion: 1;
  provider: string;
  sourceJid: string;
  channelAccountId?: string | null;
  targetJid?: string;
  workspaceJid?: string;
  sessionAgentId?: string | null;
  bot?: {
    appId?: string;
    openId?: string;
    name?: string;
    avatarUrl?: string;
  };
  chat?: {
    id?: string;
    type?: string;
    name?: string;
    mode?: string;
    groupMessageType?: string;
    isTopicStyle?: boolean;
  };
  message?: {
    id?: string;
    rootId?: string;
    parentId?: string;
    threadId?: string;
    type?: string;
  };
  sender?: {
    openId?: string;
    userId?: string;
    unionId?: string;
    name?: string;
    tenantKey?: string;
    type?: string;
  };
  mentions?: Array<{
    key?: string;
    name?: string;
    openId?: string;
    userId?: string;
    unionId?: string;
  }>;
  capabilities?: string[];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compactObject<T extends UnknownRecord>(value: T): T | undefined {
  return Object.values(value).some((item) => item !== undefined)
    ? value
    : undefined;
}

/**
 * Enforce the credential-free runner boundary and tolerate older hosts that
 * only send sourceJid. Unknown keys (including token/secret-like data) are
 * intentionally discarded instead of being forwarded to the model.
 */
export function normalizeChannelTurnContext(
  value: unknown,
  fallbackSourceJid?: string,
): ChannelTurnContext | undefined {
  const source = asRecord(value);
  const sourceJid =
    optionalString(source?.sourceJid) || optionalString(fallbackSourceJid);
  if (!sourceJid && !source) return undefined;

  const legacyAccount = asRecord(source?.account);
  const bot = asRecord(source?.bot);
  const chat = asRecord(source?.chat);
  const message = asRecord(source?.message);
  const sender = asRecord(source?.sender);
  const legacyWorkspace = asRecord(source?.workspace);
  const provider =
    optionalString(source?.provider) || sourceJid?.split(':', 1)[0] || 'web';
  const mentions = Array.isArray(source?.mentions)
    ? source.mentions
        .map((mention) => {
          const item = asRecord(mention);
          if (!item) return undefined;
          return compactObject({
            key: optionalString(item.key),
            name: optionalString(item.name),
            openId: optionalString(item.openId),
            userId: optionalString(item.userId),
            unionId: optionalString(item.unionId),
          });
        })
        .filter((mention): mention is NonNullable<typeof mention> => !!mention)
    : undefined;
  const capabilities = Array.isArray(source?.capabilities)
    ? source.capabilities
        .map(optionalString)
        .filter((item): item is string => !!item)
    : undefined;

  return {
    schemaVersion: 1,
    provider,
    sourceJid: sourceJid || `${provider}:unknown`,
    channelAccountId:
      optionalString(source?.channelAccountId) ||
      optionalString(legacyAccount?.id) ||
      null,
    targetJid: optionalString(source?.targetJid),
    workspaceJid:
      optionalString(source?.workspaceJid) ||
      optionalString(legacyWorkspace?.jid),
    sessionAgentId:
      optionalString(source?.sessionAgentId) ||
      optionalString(legacyWorkspace?.sessionAgentId) ||
      null,
    bot: compactObject({
      appId: optionalString(bot?.appId),
      openId: optionalString(bot?.openId),
      name: optionalString(bot?.name),
      avatarUrl: optionalString(bot?.avatarUrl),
    }),
    chat: compactObject({
      id: optionalString(chat?.id),
      type: optionalString(chat?.type),
      name: optionalString(chat?.name),
      mode: optionalString(chat?.mode) || optionalString(chat?.chatMode),
      groupMessageType:
        optionalString(chat?.groupMessageType) ||
        optionalString(chat?.messageType),
      isTopicStyle:
        typeof chat?.isTopicStyle === 'boolean' ? chat.isTopicStyle : undefined,
    }),
    message: compactObject({
      id: optionalString(message?.id),
      rootId: optionalString(message?.rootId),
      parentId: optionalString(message?.parentId),
      threadId: optionalString(message?.threadId),
      type: optionalString(message?.type),
    }),
    sender: compactObject({
      openId: optionalString(sender?.openId),
      userId: optionalString(sender?.userId),
      unionId: optionalString(sender?.unionId),
      name: optionalString(sender?.name),
      tenantKey: optionalString(sender?.tenantKey),
      type: optionalString(sender?.type),
    }),
    mentions: mentions?.length ? mentions : undefined,
    capabilities: capabilities?.length ? capabilities : undefined,
  };
}

/** Compact per-turn prompt material. It is a user-turn prefix, not a frozen
 * system prompt, so warm SDK sessions always observe the latest channel. */
export function formatChannelTurnContextForPrompt(
  context: ChannelTurnContext | undefined,
): string {
  if (!context) return '';
  return [
    '<channel_context source="happyclaw_host" trust="verified">',
    JSON.stringify(context),
    '</channel_context>',
    'Use this context for the current input only. Never guess IDs or credentials that are absent.',
  ].join('\n');
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  turnId?: string;
  /** Exact GroupQueue query attempt for Web stream fencing. */
  queryRunId?: string;
  groupFolder: string;
  chatJid: string;
  /** Workspace-scoped interaction contract for this public Agent turn. */
  interactionMode?: 'assistant' | 'proactive';
  /** Source JID of the latest message that triggered this run (e.g. `discord:123…`).
   * Used by per-channel MCP tools (discord_*, etc.) to identify the current
   * incoming chat. Undefined when chatJid already encodes the IM source. */
  currentSourceJid?: string;
  /** Sanitized identity/capability context for the message that triggered the
   * current turn. This value is mutable on a warm runner and must be replaced
   * whenever a new IPC input becomes current. */
  channelContext?: ChannelTurnContext;
  /** @deprecated Use isHome + isAdminHome instead. Kept for backward compatibility with older host processes. */
  isMain?: boolean;
  /** Whether this is the user's home container (admin or member). */
  isHome?: boolean;
  /** Whether this is the admin's home container (full privileges). */
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** Claude session/provider namespace selected by the host runner. */
  sessionAgentId?: string;
  /** If the last unprocessed message was emitted by a scheduled task prompt,
   * this is that task's ID; used to tag MCP send_message outputs so the host
   * routes results to the task's configured chat_jid / notify channels. */
  messageTaskId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentProfile?: {
    id: string;
    name: string;
    version: number;
    identityHash: string;
    identityPrompt: string;
    includeClaudePreset: boolean;
    /** Opaque host-normalized policy; retained only for runtime provenance. */
    runtimePolicy?: unknown;
  };
  /** Host-derived capability flag. True only for an interactive session whose
   * effective top-level AgentProfile is the built-in main HappyClaw. */
  agentBuilderEnabled?: boolean;
  agentId?: string;
  agentName?: string;
  /**
   * Claude Code plugins to load for this session, passed straight to
   * SDK `options.plugins`. Each `path` must be an absolute path (already
   * runtime-translated by container-runner: container-internal for Docker,
   * host absolute path for host mode).
   */
  plugins?: Array<{ type: 'local'; path: string }>;
  /** Runtime context audit bootstrap from the host/container launcher. */
  contextAudit?: ClaudeContextAudit;
  /** Canonical effective Skill set resolved by the HappyClaw host. */
  skillManifest?: { hash: string; selectedSkillIds: string[] };
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  providerFailure?: boolean;
  /**
   * Set by the host after it quarantines the failed provider and checks the
   * remaining pool. The agent runner itself only emits providerFailure.
   */
  providerFailureTerminal?: boolean;
  /** Internal host-control marker: this turn is being retried in-process. */
  providerFailureRetrying?: boolean;
  /**
   * Provider failed during an internal side-query after the durable user turn
   * completed. The host quarantines it without replaying or notifying again.
   */
  providerFailureMaintenance?: boolean;
  streamEvent?: StreamEvent;
  /**
   * Immutable identity of the user input turn that produced this output.
   *
   * IPC turns use their durable deliveryId. The cold, non-IPC startup turn
   * falls back to the host-provided ContainerInput.turnId. Unlike the legacy
   * presentation turnId, this value must not rotate while a later steer is
   * merely queued behind the currently executing SDK turn.
   */
  readonly inputTurnId?: string;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?:
    | 'sdk_final'
    | 'sdk_send_message'
    | 'interrupt_partial'
    | 'overflow_partial'
    | 'compact_partial'
    | 'legacy'
    | 'auto_continue'
    | 'truncation_continue';
  /** 'truncated'：上游断流截断的 partial（usage 双零指纹，runner 会自动续写） */
  finalizationReason?: 'completed' | 'interrupted' | 'error' | 'truncated';
  /** 本 result 发出时仍未 settle 的后台任务数（异步 Agent / backgrounded Bash）。
   * >0 时主进程应把流式卡片保持在「后台任务运行中」而非定稿，后续 turn 的
   * 内容会继续追加到同一张卡。仅 sdk_final 类 result 携带。 */
  pendingBgTasks?: number;
  /** This SDK result durably completed the user-input turn associated with it.
   * False/absent for truncated, background-pending, interrupted, and error paths. */
  inputTurnCompleted?: boolean;
  /** True only when the completed SDK input turn left no accepted steer turns
   * waiting in the same streaming query. Hosts use this—not merely a result—to
   * release the next durable queued follow-up. */
  queryIdle?: boolean;
  ipcReceipts?: Array<{
    deliveryId: string;
    chatJid: string;
    coveredCursors?: Array<{
      timestamp: string;
      id: string;
      sourceJid?: string;
    }>;
    cursor: { timestamp: string; id: string; sourceJid?: string };
  }>;
}

export interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

export interface SessionsIndex {
  entries: SessionEntry[];
}

export type ImageMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

export interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | {
              type: 'image';
              source: {
                type: 'base64';
                media_type: ImageMediaType;
                data: string;
              };
            }
        >;
  };
  parent_tool_use_id: null;
  session_id: string;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}
