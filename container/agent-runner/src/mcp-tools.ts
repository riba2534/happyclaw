/**
 * MCP Tool Definitions for HappyClaw Agent Runner.
 *
 * Uses SDK's `tool()` helper to define in-process MCP tools.
 * These tools communicate with the host process via IPC files.
 *
 * Context (chatJid, groupFolder, etc.) is passed via McpContext
 * rather than read from environment variables, enabling in-process usage.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { formatIsoLocal } from './utils.js';
import {
  normalizeChannelTurnContext,
  type ChannelTurnContext,
} from './types.js';
import { signWorkspaceMemoryMutation } from './workspace-memory-auth.js';
import {
  PROACTIVE_FINAL_DELIVERED_SENTINEL,
  proactiveFinalWasDeliveredForInput,
} from './proactive-turn-protocol.js';

/** Context required by MCP tools. Passed at construction time. */
export interface McpContext {
  chatJid: string;
  /** Mutable, credential-free context for the current input turn. */
  channelContext?: ChannelTurnContext;
  groupFolder: string;
  isHome: boolean;
  isAdminHome: boolean;
  /** Whether this runtime is an interactive session of the main HappyClaw. */
  agentBuilderEnabled: boolean;
  /** Host admitted Owner Profile capability for built-in HappyClaw in Home. */
  ownerProfileEnabled: boolean;
  /** Public reply contract selected by the workspace. */
  interactionMode?: 'assistant' | 'proactive';
  isScheduledTask?: boolean;
  /** Mutable: set when the current IPC turn was triggered by a task prompt.
   * Cleared between turns by the agent-runner main loop so that regular
   * follow-up messages aren't misattributed to the prior task. */
  currentTaskId?: string | null;
  /** Exact durable group-mode occurrence correlated from the scheduler prompt. */
  currentScheduledTaskRunId?: string | null;
  /** Mutable correlation id for the user input currently being answered.
   * Cold starts use the triggering message id; IPC turns use the host-issued
   * delivery id from their receipt. */
  currentInputTurnId?: string | null;
  /** Exact Proactive input whose final native utterance received a physical
   * Host ACK. This is a per-runner latch used to seal the turn and suppress a
   * second final if an older CLI injects a no-visible-output companion. */
  proactiveFinalDeliveredInputTurnId?: string | null;
  /** Current provider session id, used only as server-side provenance. */
  currentSessionId?: string | null;
  /** Runner-private HMAC material. Never expose through a tool schema/result. */
  workspaceMemoryMutationAuth?: {
    runnerInstanceId: string;
    secret: string;
    agentId?: string | null;
    taskRunId?: string | null;
  };
  workspaceIpc: string;
  workspaceGroup: string;
}

function writeIpcFile(dir: string, data: object): string {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: temp file then rename
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(tempPath, filepath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    throw new Error(
      `IPC 写入失败 (${dir}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return filename;
}

/**
 * Send an IPC request and poll for the result file.
 * Fixes TOCTOU by directly attempting readFileSync and catching ENOENT.
 * Returns the parsed JSON result, or throws on timeout.
 */
export async function pollIpcResult(
  dir: string,
  data: Record<string, unknown> & { requestId: string },
  resultFilePrefix: string,
  timeoutMs: number = 30_000,
  resultDir: string = dir,
): Promise<Record<string, unknown>> {
  const resultFileName = `${resultFilePrefix}_${data.requestId}.json`;
  const resultFilePath = path.join(resultDir, resultFileName);

  fs.mkdirSync(resultDir, { recursive: true });
  writeIpcFile(dir, data);

  const pollInterval = 500;
  const deadline = Date.now() + timeoutMs;

  const readResult = (): Record<string, unknown> | undefined => {
    try {
      const raw = fs.readFileSync(resultFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      fs.unlinkSync(resultFilePath);
      return parsed;
    } catch (err) {
      // File not ready yet — only swallow ENOENT
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return undefined;
    }
  };

  while (Date.now() < deadline) {
    const result = readResult();
    if (result) return result;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollInterval, remainingMs)),
    );
  }

  // A Host result can land during the final sleep (especially when its own
  // fallback poll period equals this timeout). Always perform one deadline
  // read before declaring the request unavailable.
  const finalResult = readResult();
  if (finalResult) return finalResult;
  throw new Error(
    `IPC result timeout: requestId=${data.requestId} type=${String(data.type ?? 'unknown')} action=${String(data.action ?? 'unknown')} timeoutMs=${timeoutMs} requestDir=${dir} resultDir=${resultDir} expected=${resultFileName}`,
  );
}

function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface WorkspaceMemorySnapshot {
  workspaceJid: string;
  storeRevision: number;
  items: Array<Record<string, unknown>>;
  renderedText: string;
  retrievalTrace: {
    itemRevisions: Array<{ id: string; revision: number }>;
    query?: string | null;
    generatedAt: string;
  };
}

export interface HappyClawOwnerProfileProjection {
  workspaceJid: string;
  preferredAddress: string | null;
  revision: number | null;
  onboarding: {
    state: 'pending' | 'claimed' | 'completed' | 'skipped';
    revision: number;
    leaseOwner: string | null;
    leaseToken: number | null;
    leaseExpiresAt: string | null;
    firstWakeAt?: string | null;
  };
}

export interface HappyClawOwnerProfileTurnResult {
  projection: HappyClawOwnerProfileProjection;
  onboardingStatus:
    | 'awaiting'
    | 'known'
    | 'cleared'
    | 'skipped'
    | 'unavailable';
  firstWake?: boolean;
  leaseAcquired?: boolean;
  /** @deprecated Compatibility with pre-v66 test fixtures/results. */
  newlyClaimed?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseWorkspaceMemorySnapshot(
  value: unknown,
): WorkspaceMemorySnapshot | null {
  if (!isRecord(value)) return null;
  const trace = value.retrievalTrace;
  if (
    typeof value.workspaceJid !== 'string' ||
    !Number.isInteger(value.storeRevision) ||
    (value.storeRevision as number) < 0 ||
    !Array.isArray(value.items) ||
    typeof value.renderedText !== 'string' ||
    !isRecord(trace) ||
    !Array.isArray(trace.itemRevisions) ||
    !trace.itemRevisions.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        Number.isInteger(item.revision) &&
        (item.revision as number) >= 0,
    ) ||
    typeof trace.generatedAt !== 'string' ||
    !(
      trace.query === undefined ||
      trace.query === null ||
      typeof trace.query === 'string'
    )
  ) {
    return null;
  }
  return {
    workspaceJid: value.workspaceJid,
    storeRevision: value.storeRevision as number,
    items: value.items as Array<Record<string, unknown>>,
    renderedText: value.renderedText,
    retrievalTrace: {
      itemRevisions: trace.itemRevisions as Array<{
        id: string;
        revision: number;
      }>,
      query: trace.query as string | null | undefined,
      generatedAt: trace.generatedAt,
    },
  };
}

const WORKSPACE_MEMORY_RESULT_PREFIX = 'workspace_memory_result';
const OWNER_PROFILE_RESULT_PREFIX = 'happyclaw_owner_profile_result';

async function callWorkspaceMemory(
  ctx: McpContext,
  operation: 'snapshot' | 'search' | 'get' | 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const tasksDir = path.join(ctx.workspaceIpc, 'tasks');
  const requestId = newRequestId();
  const request: Record<string, unknown> & { requestId: string } = {
    ...payload,
    type: 'workspace_memory',
    operation,
    requestId,
    inputTurnId: ctx.currentInputTurnId || undefined,
    taskId: ctx.currentTaskId || undefined,
    sessionId: ctx.currentSessionId || undefined,
    timestamp: new Date().toISOString(),
  };
  if (
    operation === 'create' ||
    operation === 'update' ||
    operation === 'delete'
  ) {
    const auth = ctx.workspaceMemoryMutationAuth;
    if (auth) {
      request.runnerInstanceId = auth.runnerInstanceId;
      request.mutationSignature = signWorkspaceMemoryMutation(
        auth.secret,
        {
          groupFolder: ctx.groupFolder,
          agentId: auth.agentId ?? null,
          taskRunId: auth.taskRunId ?? null,
        },
        request,
      );
    }
  }
  const result = await pollIpcResult(
    tasksDir,
    request,
    WORKSPACE_MEMORY_RESULT_PREFIX,
    timeoutMs,
  );
  if (!result.success) {
    const code = typeof result.code === 'string' ? ` (${result.code})` : '';
    throw new Error(
      `${typeof result.error === 'string' ? result.error : 'Workspace memory request failed'}${code}`,
    );
  }
  return result;
}

async function callHappyClawOwnerProfile(
  ctx: McpContext,
  operation: 'get' | 'set' | 'clear' | 'skip' | 'ack_first_wake',
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
  inputTurnId: string | null | undefined = ctx.currentInputTurnId,
): Promise<Record<string, unknown>> {
  const tasksDir = path.join(ctx.workspaceIpc, 'tasks');
  const requestId = newRequestId();
  const request: Record<string, unknown> & { requestId: string } = {
    ...payload,
    type: 'happyclaw_owner_profile',
    operation,
    requestId,
    inputTurnId: inputTurnId || undefined,
    sessionId: ctx.currentSessionId || undefined,
    timestamp: new Date().toISOString(),
  };
  const auth = ctx.workspaceMemoryMutationAuth;
  if (auth) {
    request.runnerInstanceId = auth.runnerInstanceId;
    request.mutationSignature = signWorkspaceMemoryMutation(
      auth.secret,
      {
        groupFolder: ctx.groupFolder,
        agentId: auth.agentId ?? null,
        taskRunId: auth.taskRunId ?? null,
      },
      request,
    );
  }
  const result = await pollIpcResult(
    tasksDir,
    request,
    OWNER_PROFILE_RESULT_PREFIX,
    timeoutMs,
  );
  if (!result.success) {
    const code = typeof result.code === 'string' ? ` (${result.code})` : '';
    throw new Error(
      `${typeof result.error === 'string' ? result.error : 'Owner Profile request failed'}${code}`,
    );
  }
  return result;
}

/**
 * Internal runner control-plane acknowledgement. This operation is
 * intentionally absent from createMcpTools(): the model can neither discover
 * nor invoke it, and the host additionally requires the exact active owner
 * turn plus the signed runner capability.
 */
export async function acknowledgeHappyClawOwnerProfileFirstWake(
  ctx: McpContext,
  leaseToken: number,
  inputTurnId: string,
  timeoutMs: number = 5_000,
): Promise<boolean> {
  if (
    !ctx.ownerProfileEnabled ||
    !inputTurnId ||
    !Number.isInteger(leaseToken) ||
    leaseToken < 1
  ) {
    return false;
  }
  try {
    const result = await callHappyClawOwnerProfile(
      ctx,
      'ack_first_wake',
      { leaseToken },
      timeoutMs,
      inputTurnId,
    );
    return result.acknowledged === true || result.acknowledged === false;
  } catch {
    return false;
  }
}

export async function fetchHappyClawOwnerProfileTurn(
  ctx: McpContext,
  timeoutMs: number = 8_000,
  inputTurnId: string | null | undefined = ctx.currentInputTurnId,
): Promise<HappyClawOwnerProfileTurnResult | null> {
  if (!ctx.ownerProfileEnabled || !inputTurnId) return null;
  try {
    const result = await callHappyClawOwnerProfile(
      ctx,
      'get',
      {},
      timeoutMs,
      inputTurnId,
    );
    if (!isRecord(result.projection)) return null;
    const projection =
      result.projection as unknown as HappyClawOwnerProfileProjection;
    const onboardingStatus = result.onboardingStatus;
    if (
      typeof projection.workspaceJid !== 'string' ||
      !isRecord(projection.onboarding) ||
      !['awaiting', 'known', 'cleared', 'skipped', 'unavailable'].includes(
        String(onboardingStatus),
      )
    ) {
      return null;
    }
    return {
      projection,
      onboardingStatus:
        onboardingStatus as HappyClawOwnerProfileTurnResult['onboardingStatus'],
      firstWake:
        result.firstWake === true ||
        (result.firstWake === undefined && result.newlyClaimed === true),
      leaseAcquired: result.leaseAcquired === true,
    };
  } catch {
    // Fail closed: no profile projection is safer than stale/private data.
    return null;
  }
}

/**
 * Fetch a bounded, query-relevant snapshot for the next model turn.
 * Failure is fail-open for answering: the turn can continue without memory,
 * while all mutation paths remain server-authorized and fail-closed.
 */
export async function fetchWorkspaceMemorySnapshot(
  ctx: McpContext,
  query: string,
  options: { limit?: number; maxChars?: number; timeoutMs?: number } = {},
): Promise<WorkspaceMemorySnapshot | null> {
  try {
    const result = await callWorkspaceMemory(
      ctx,
      'snapshot',
      {
        query: query.slice(0, 500),
        limit: Math.min(Math.max(options.limit ?? 8, 1), 20),
        maxChars: Math.min(Math.max(options.maxChars ?? 6000, 500), 12_000),
      },
      options.timeoutMs ?? 8_000,
    );
    return parseWorkspaceMemorySnapshot(result.snapshot);
  } catch (err) {
    console.error(
      `[agent-runner:warn] Workspace memory snapshot unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function workspaceMemoryToolResult(result: Record<string, unknown>) {
  const { success: _success, ...payload } = result;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function memoryIdempotencyKey(
  supplied: string | undefined,
  fallback: string,
): string {
  return (supplied ?? fallback).slice(0, 128);
}

/**
 * Build the IPC payload shared by send_message / send_image MCP tools.
 *
 * Always stamps `chatJid`, `groupFolder`, `timestamp`. Conditionally stamps
 * `isScheduledTask` (when ctx.isScheduledTask is truthy) and `taskId` (when
 * ctx.currentTaskId is non-empty). The conditional stamping matters for host-
 * side routing: a missing `taskId` key means "regular user-turn reply", while
 * a present `taskId` key triggers the task-broadcast branch in the IPC
 * consumer. `extras` carries per-tool fields (`type`, `text`, `imageBase64`, …).
 *
 * Pure function; exported for unit testing.
 */
export function buildSendMessageData(
  ctx: McpContext,
  extras: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    chatJid: ctx.chatJid,
    groupFolder: ctx.groupFolder,
    timestamp: new Date().toISOString(),
    ...extras,
    // Freeze the public delivery contract at IPC write time. The host must not
    // reinterpret an already-written side effect after a workspace mode change.
    interactionMode:
      ctx.interactionMode === 'proactive' ? 'proactive' : 'assistant',
  };
  if (ctx.isScheduledTask) {
    data.isScheduledTask = true;
  }
  if (ctx.currentTaskId) {
    data.taskId = ctx.currentTaskId;
  }
  if (ctx.currentScheduledTaskRunId) {
    data.scheduledTaskRunId = ctx.currentScheduledTaskRunId;
  }
  if (ctx.currentInputTurnId) {
    data.inputTurnId = ctx.currentInputTurnId;
  }
  return data;
}

/**
 * Create all HappyClaw MCP tool definitions for in-process SDK MCP server.
 */
export function createMcpTools(ctx: McpContext): SdkMcpToolDefinition<any>[] {
  const MESSAGES_DIR = path.join(ctx.workspaceIpc, 'messages');
  const MESSAGE_RESULTS_DIR = path.join(ctx.workspaceIpc, 'message-results');
  const TASKS_DIR = path.join(ctx.workspaceIpc, 'tasks');
  const hasCrossGroupAccess = ctx.isAdminHome;

  /**
   * Must stay in step with `usesProactiveInteractiveContract()` in
   * container/agent-runner/src/index.ts, which selects the system prompt.
   *
   * A message-triggered task run gets the task delivery contract, not the
   * interactive Proactive one. The tool descriptions here checked only
   * `isScheduledTask`, so such a run was told two different things at once: the
   * prompt said "send one complete result when the task is done" while the tool
   * said "call me zero, one, or many times".
   */
  const usesProactiveInteractiveContract =
    ctx.interactionMode === 'proactive' &&
    !ctx.isScheduledTask &&
    !ctx.currentTaskId;

  const currentChannelContext = (): ChannelTurnContext | undefined =>
    normalizeChannelTurnContext(ctx.channelContext, ctx.chatJid);

  const callFeishuCapability = async (
    operation: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const channelContext = currentChannelContext();
    if (channelContext?.provider !== 'feishu') {
      throw new Error(
        `Feishu capability is unavailable for the current ${channelContext?.provider || 'unknown'} turn.`,
      );
    }
    if (!ctx.currentInputTurnId) {
      throw new Error(
        'Feishu capability requires a current input turn correlation id.',
      );
    }
    const requestId = newRequestId();
    const result = await pollIpcResult(
      TASKS_DIR,
      {
        type: 'feishu_capability',
        operation,
        requestId,
        chatJid: ctx.chatJid,
        inputTurnId: ctx.currentInputTurnId,
        params,
        timestamp: new Date().toISOString(),
      },
      'feishu_capability_result',
      120_000,
    );
    if (!result.success) {
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : `Feishu ${operation} failed.`,
      );
    }
    return result;
  };

  const feishuResult = (result: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  });

  const callAgentBuilder = async (
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const requestId = newRequestId();
    const result = await pollIpcResult(
      TASKS_DIR,
      {
        type,
        ...payload,
        requestId,
        chatJid: ctx.chatJid,
        isScheduledTask: ctx.isScheduledTask || undefined,
        timestamp: new Date().toISOString(),
      },
      `${type}_result`,
      120_000,
    );
    if (!result.success) {
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : 'Agent Builder request failed',
      );
    }
    return result;
  };

  const tools: SdkMcpToolDefinition<any>[] = [
    // --- current channel context ---
    tool(
      'get_channel_context',
      'Return the host-verified, credential-free channel context for the current input turn: provider, bound Bot/account identity, chat/thread/message IDs, sender IDs, workspace/session identity, and available capabilities. Call this before channel-specific operations instead of guessing IDs.',
      {},
      async () => {
        const channelContext = currentChannelContext();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                channelContext ?? {
                  provider: 'unknown',
                  sourceJid: ctx.chatJid,
                  capabilities: [],
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    ),

    // --- Feishu Bot capability broker ---
    tool(
      'feishu_get_chat',
      'Get metadata for the current Feishu chat using the Bot account bound to this input turn. The host selects the account and chat; do not guess either.',
      {},
      async () => feishuResult(await callFeishuCapability('get_chat', {})),
    ),
    tool(
      'feishu_list_members',
      'List members of the current Feishu chat as the Bot bound to this input turn.',
      {
        page_size: z.number().int().min(1).max(100).optional().default(50),
        page_token: z.string().optional(),
      },
      async (args) =>
        feishuResult(
          await callFeishuCapability('list_members', {
            pageSize: args.page_size,
            pageToken: args.page_token,
          }),
        ),
    ),
    tool(
      'feishu_get_user',
      'Get the sender of the current Feishu input turn using the current bound Bot. The host fixes the target to the verified sender; no arbitrary user ID is accepted.',
      {},
      async () => feishuResult(await callFeishuCapability('get_user', {})),
    ),
    tool(
      'feishu_get_history',
      'Read recent messages from the current Feishu chat/thread using the current bound Bot.',
      {
        page_size: z.number().int().min(1).max(50).optional().default(20),
        page_token: z.string().optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
      },
      async (args) =>
        feishuResult(
          await callFeishuCapability('get_history', {
            pageSize: args.page_size,
            pageToken: args.page_token,
            startTime: args.start_time,
            endTime: args.end_time,
          }),
        ),
    ),
    tool(
      'feishu_send_card',
      'Send a Schema 2.0 interactive Feishu card to the current chat/thread as the Bot bound to this turn. The host locks the destination to the current context. Put standalone button elements directly in body.elements (never wrap them in tag=action); use header.template instead of header.theme, and notation-sized markdown instead of tag=note. If the provider rejects the card, send the final result with send_message instead.',
      {
        card: z.record(z.string(), z.unknown()),
        reply_to_message_id: z.string().optional(),
      },
      async (args) =>
        feishuResult(
          await callFeishuCapability('send_card', {
            card: args.card,
            replyToMessageId: args.reply_to_message_id,
          }),
        ),
    ),
    tool(
      'feishu_add_reaction',
      'Add a reaction to a Feishu message as the Bot bound to this turn. Omit message_id to target the triggering message.',
      {
        emoji_type: z.string().min(1),
        message_id: z.string().optional(),
      },
      async (args) =>
        feishuResult(
          await callFeishuCapability('add_reaction', {
            emojiType: args.emoji_type,
            messageId: args.message_id,
          }),
        ),
    ),
    tool(
      'feishu_remove_reaction',
      'Remove a reaction previously created by the current Feishu Bot.',
      {
        reaction_id: z.string().min(1),
        message_id: z.string().optional(),
      },
      async (args) =>
        feishuResult(
          await callFeishuCapability('remove_reaction', {
            reactionId: args.reaction_id,
            messageId: args.message_id,
          }),
        ),
    ),
    tool(
      'feishu_edit_message',
      'Edit a text message previously sent by the current Feishu Bot.',
      {
        message_id: z.string().min(1),
        text: z.string(),
      },
      async (args) =>
        feishuResult(
          await callFeishuCapability('edit_message', {
            messageId: args.message_id,
            text: args.text,
          }),
        ),
    ),
    tool(
      'feishu_recall_message',
      'Recall a message previously sent by the current Feishu Bot.',
      { message_id: z.string().min(1) },
      async (args) =>
        feishuResult(
          await callFeishuCapability('recall_message', {
            messageId: args.message_id,
          }),
        ),
    ),
    tool(
      'feishu_api_request',
      'Call a host-allowlisted Feishu OpenAPI endpoint as the Bot bound to the current input turn. Prefer typed feishu_* tools when available. Tokens and app secrets are never returned.',
      {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z
          .string()
          .startsWith('/open-apis/')
          .describe('Absolute Feishu OpenAPI path beginning with /open-apis/'),
        query: z.record(z.string(), z.unknown()).optional(),
        body: z.unknown().optional(),
      },
      async (args) =>
        feishuResult(
          await callFeishuCapability('api_request', {
            method: args.method,
            path: args.path,
            query: args.query,
            body: args.body,
          }),
        ),
    ),

    // --- send_message ---
    tool(
      'send_message',
      usesProactiveInteractiveContract
        ? 'Send one user-visible message now. The Workspace uses Proactive reply mode: every call creates an independent native chat message immediately, and your normal SDK final text is not published. Set delivery_role=progress for acknowledgements or updates and delivery_role=final for the last substantive answer. You may call this tool zero, one, or many times and continue working after each successful progress send. A delivery error is authoritative: do not sleep and retry, switch to a card, or call a raw channel API as a fallback.'
        : "Publish text through HappyClaw's turn-owned delivery coordinator. In an interactive user turn, delivery_role=progress updates the existing reply status and delivery_role=final stages the primary answer on the existing card; neither creates a second text reply. Use delivery_role=separate only when the user explicitly requested another message. Scheduled/background tasks always deliver separately because their normal SDK final is not published.",
      {
        // Trim/min-length at the schema layer: the host guard is `!data.text`,
        // which a whitespace-only string passes, so it reached the chat as an
        // empty message.
        text: z.string().trim().min(1).describe('The message text to publish'),
        delivery_role: z
          .enum(['progress', 'final', 'separate'])
          .optional()
          .describe(
            usesProactiveInteractiveContract
              ? 'Semantic completion hint used for delivery recovery. Both roles still create independent native messages. Use progress for interim updates and final for the last substantive answer; omitted defaults to progress.'
              : 'progress updates the active reply, final stages its answer, separate creates an additional message. Defaults to final for interactive turns and separate for scheduled tasks.',
          ),
      },
      async (args) => {
        const deliveryRole = ctx.isScheduledTask
          ? 'separate'
          : ctx.interactionMode === 'proactive'
            ? (args.delivery_role ?? 'progress')
            : (args.delivery_role ?? 'final');
        if (
          usesProactiveInteractiveContract &&
          deliveryRole === 'final' &&
          proactiveFinalWasDeliveredForInput(
            ctx.proactiveFinalDeliveredInputTurnId,
            ctx.currentInputTurnId,
          )
        ) {
          throw new Error(
            'This input turn is already sealed by a delivered final message; a second final was rejected.',
          );
        }
        const data = buildSendMessageData(ctx, {
          type: 'message',
          text: args.text,
          deliveryRole,
          ...(usesProactiveInteractiveContract
            ? { presentation: 'native' }
            : {}),
          requestId: newRequestId(),
        });
        const result = await pollIpcResult(
          MESSAGES_DIR,
          data as Record<string, unknown> & { requestId: string },
          'send_message_result',
          120_000,
          MESSAGE_RESULTS_DIR,
        );
        if (!result.success) {
          throw new Error(
            typeof result.error === 'string'
              ? result.error
              : 'Message delivery failed.',
          );
        }
        if (
          usesProactiveInteractiveContract &&
          deliveryRole === 'final' &&
          ctx.currentInputTurnId?.trim()
        ) {
          ctx.proactiveFinalDeliveredInputTurnId =
            ctx.currentInputTurnId.trim();
        }
        const disposition =
          typeof result.disposition === 'string'
            ? result.disposition
            : 'delivered_separately';
        const acknowledgement =
          disposition === 'staged_progress'
            ? 'Progress updated on the active reply.'
            : disposition === 'staged_final'
              ? 'Final answer staged on the active reply; return the same answer normally so the SDK Result can finalize it.'
              : usesProactiveInteractiveContract
                ? deliveryRole === 'progress'
                  ? 'Progress message delivered. This does not complete the user-visible answer. Continue the work, then call send_message(delivery_role=final) with the last substantive result before ending. Do not put a conclusion, completion phrase, or closing message only in SDK final text.'
                  : deliveryRole === 'final'
                    ? `Final message delivered. End the turn now by returning exactly ${PROACTIVE_FINAL_DELIVERED_SENTINEL} as the non-user-visible SDK control text. Do not repeat, summarize, acknowledge, or append anything else.`
                    : 'Separate message delivered. Continue the work; if this turn needs a final answer, call send_message(delivery_role=final) before ending.'
                : 'Message sent separately.';
        return {
          content: [{ type: 'text' as const, text: acknowledgement }],
        };
      },
    ),

    // --- send_image ---
    tool(
      'send_image',
      'Send an image file from the workspace to the current native IM conversation. Supports PNG/JPEG/GIF/WebP/TIFF/BMP, with a 10MB runner-side limit. Optional caption.',
      {
        file_path: z
          .string()
          .describe(
            'Path to the image file in the workspace (relative to workspace root or absolute)',
          ),
        caption: z
          .string()
          .optional()
          .describe('Optional caption text to send with the image'),
      },
      async (args) => {
        // NOTE: Web-prefixed JIDs (e.g. web:main) are no longer rejected here.
        // The main process routes the image to the correct IM channel via
        // activeImReplyRoutes, so the agent-runner should let the IPC
        // request through regardless of JID prefix.

        // Resolve path relative to workspace
        const absPath = path.isAbsolute(args.file_path)
          ? args.file_path
          : path.join(ctx.workspaceGroup, args.file_path);

        // Security: ensure path is within workspace
        // Use path.sep suffix to prevent prefix-bypass (e.g. /ws/group1 matching /ws/group10/evil.png)
        const resolved = path.resolve(absPath);
        const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
          ? ctx.workspaceGroup
          : ctx.workspaceGroup + path.sep;
        if (resolved !== ctx.workspaceGroup && !resolved.startsWith(safeRoot)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file path must be within workspace directory.`,
              },
            ],
            isError: true,
          };
        }

        // Check file exists
        if (!fs.existsSync(resolved)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file not found: ${args.file_path}`,
              },
            ],
            isError: true,
          };
        }

        // Read file and enforce the runner-side limit shared by every IM provider.
        const stat = fs.statSync(resolved);
        if (stat.size > 10 * 1024 * 1024) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: image file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
              },
            ],
            isError: true,
          };
        }
        if (stat.size === 0) {
          return {
            content: [
              { type: 'text' as const, text: `Error: image file is empty.` },
            ],
            isError: true,
          };
        }

        const buffer = fs.readFileSync(resolved);
        const base64 = buffer.toString('base64');

        // Detect MIME type from magic bytes
        const { detectImageMimeTypeFromBase64Strict } =
          await import('./image-detector.js');
        const mimeType = detectImageMimeTypeFromBase64Strict(base64);
        if (!mimeType) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file does not appear to be a supported image format (PNG, JPEG, GIF, WebP, TIFF, BMP).`,
              },
            ],
            isError: true,
          };
        }

        const data = buildSendMessageData(ctx, {
          type: 'image',
          imageBase64: base64,
          filePath: path.relative(ctx.workspaceGroup, resolved),
          mimeType,
          caption: args.caption || undefined,
          fileName: path.basename(resolved),
          requestId: newRequestId(),
        });
        const delivery = await pollIpcResult(
          MESSAGES_DIR,
          data as Record<string, unknown> & { requestId: string },
          'send_message_result',
          120_000,
          MESSAGE_RESULTS_DIR,
        );
        if (!delivery.success) {
          throw new Error(
            typeof delivery.error === 'string'
              ? delivery.error
              : 'Image delivery failed.',
          );
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Image sent: ${path.basename(resolved)} (${mimeType}, ${(stat.size / 1024).toFixed(1)}KB)`,
            },
          ],
        };
      },
    ),

    // --- send_file ---
    tool(
      'send_file',
      `Send a file to the current native IM conversation through its bound account (Feishu/Telegram/DingTalk/QQ/Discord/WeChat/WhatsApp). The file path must stay inside the workspace/group directory.
The actual file types and size limit are enforced by the selected provider.`,
      {
        filePath: z
          .string()
          .describe(
            'File path relative to workspace/group (e.g., "output/report.pdf")',
          ),
        fileName: z
          .string()
          .describe('File name to display (e.g., "report.pdf")'),
      },
      async (args) => {
        // NOTE: Web-prefixed JIDs (e.g. web:main) are no longer rejected here.
        // The main process routes the file to the correct IM channel via
        // activeImReplyRoutes, so the agent-runner should let the IPC
        // request through regardless of JID prefix.

        // Handle both absolute and relative paths
        let resolvedPath: string;
        let relativePath: string;

        if (path.isAbsolute(args.filePath)) {
          // Absolute path provided - validate and convert to relative
          resolvedPath = path.resolve(args.filePath);
          const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
            ? ctx.workspaceGroup
            : ctx.workspaceGroup + path.sep;
          if (
            resolvedPath !== ctx.workspaceGroup &&
            !resolvedPath.startsWith(safeRoot)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: file must be within the workspace/group directory.',
                },
              ],
              isError: true,
            };
          }
          // Convert to relative path
          relativePath = path.relative(ctx.workspaceGroup, resolvedPath);
        } else {
          // Relative path provided
          relativePath = args.filePath;
          resolvedPath = path.resolve(ctx.workspaceGroup, args.filePath);
          // Validate resolved path is still within workspace
          const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
            ? ctx.workspaceGroup
            : ctx.workspaceGroup + path.sep;
          if (
            resolvedPath !== ctx.workspaceGroup &&
            !resolvedPath.startsWith(safeRoot)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: file must be within the workspace/group directory.',
                },
              ],
              isError: true,
            };
          }
        }

        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file not found: ${args.filePath}`,
              },
            ],
            isError: true,
          };
        }

        const data = buildSendMessageData(ctx, {
          type: 'send_file',
          filePath: relativePath,
          fileName: args.fileName,
          requestId: newRequestId(),
        });
        const delivery = await pollIpcResult(
          TASKS_DIR,
          data as Record<string, unknown> & { requestId: string },
          'send_file_result',
          120_000,
        );
        if (!delivery.success) {
          throw new Error(
            typeof delivery.error === 'string'
              ? delivery.error
              : 'File delivery failed.',
          );
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `File sent: ${args.fileName}`,
            },
          ],
        };
      },
    ),

    // --- declare_artifact (R19) ---
    tool(
      'declare_artifact',
      'Declare a deliverable artifact file (report, summary, data file, etc.) produced by the current task run. The HappyClaw host will archive an immutable versioned copy with cryptographic hash verification.',
      {
        path: z
          .string()
          .describe(
            'Path to the artifact file relative to workspace root (e.g., "reports/summary.md")',
          ),
        name: z
          .string()
          .optional()
          .describe(
            'Human-friendly display name for the artifact (optional, defaults to filename)',
          ),
      },
      async (args) => {
        // Enforce task execution context: fail closed for regular chat sessions
        const isTaskContext = Boolean(
          ctx.isScheduledTask ||
          ctx.currentTaskId ||
          ctx.currentScheduledTaskRunId,
        );
        if (!isTaskContext) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: declare_artifact is only available within task execution context (scheduled or manual task runs). Standard chat turns cannot declare task artifacts.',
              },
            ],
            isError: true,
          };
        }

        const effectiveRunId =
          ctx.currentScheduledTaskRunId || ctx.currentTaskId || 'task-run';

        const rel = args.path.trim();
        if (rel.includes('..') || path.isAbsolute(rel) || rel.includes('\0')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: artifact path must be a relative path within the workspace and cannot contain ".."',
              },
            ],
            isError: true,
          };
        }

        const absPath = path.resolve(ctx.workspaceGroup, rel);
        const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
          ? ctx.workspaceGroup
          : ctx.workspaceGroup + path.sep;
        if (absPath !== ctx.workspaceGroup && !absPath.startsWith(safeRoot)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: artifact path escapes workspace directory.',
              },
            ],
            isError: true,
          };
        }

        const artifactsIpcDir = path.join(ctx.workspaceIpc, 'artifacts');
        try {
          writeIpcFile(artifactsIpcDir, {
            runId: effectiveRunId,
            taskId: ctx.currentTaskId || undefined,
            path: rel,
            name: args.name || path.basename(absPath),
            declaredAt: new Date().toISOString(),
          });
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error declaring artifact: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }

        const exists = fs.existsSync(absPath);
        return {
          content: [
            {
              type: 'text' as const,
              text: exists
                ? `Artifact declared successfully: ${args.name || path.basename(absPath)} (${rel}). It will be archived with version control upon task completion.`
                : `Artifact registered: ${args.name || path.basename(absPath)} (${rel}). Note: please ensure the file is written before the task ends.`,
            },
          ],
        };
      },
    ),

    // --- read_artifact (R19) ---
    tool(
      'read_artifact',
      'Read the immutable text content of an archived task delivery artifact by its artifact ID or relative path.',
      {
        path: z
          .string()
          .optional()
          .describe(
            'Relative path to the artifact (e.g. "inbound_artifacts/.../report.md")',
          ),
        artifact_id: z
          .string()
          .optional()
          .describe('The unique UUID of the archived artifact'),
      },
      async (args) => {
        if (!args.path && !args.artifact_id) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: either path or artifact_id must be provided.',
              },
            ],
            isError: true,
          };
        }

        if (args.path) {
          const rel = args.path.trim();
          if (
            rel.includes('..') ||
            path.isAbsolute(rel) ||
            rel.includes('\0')
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: path cannot contain ".." or be absolute.',
                },
              ],
              isError: true,
            };
          }
          const abs = path.resolve(ctx.workspaceGroup, rel);
          const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
            ? ctx.workspaceGroup
            : ctx.workspaceGroup + path.sep;
          if (abs !== ctx.workspaceGroup && !abs.startsWith(safeRoot)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: path escapes workspace directory.',
                },
              ],
              isError: true,
            };
          }
          if (!fs.existsSync(abs)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: artifact file not found at ${rel}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              { type: 'text' as const, text: fs.readFileSync(abs, 'utf-8') },
            ],
          };
        }

        const inboundRoot = path.join(ctx.workspaceGroup, 'inbound_artifacts');
        if (fs.existsSync(inboundRoot)) {
          const targetId = args.artifact_id!.trim();
          const expectedSuffix = `_${targetId}`;
          const subdirs = fs.readdirSync(inboundRoot);
          for (const sub of subdirs) {
            // Strict match: directory must end with `_${targetId}` or equal targetId
            // Eliminates substring false-positives when targetId is short or a common prefix
            if (sub === targetId || sub.endsWith(expectedSuffix)) {
              const dirPath = path.join(inboundRoot, sub);
              const files = fs.readdirSync(dirPath);
              if (files.length > 0) {
                const targetFile = path.join(dirPath, files[0]);
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: fs.readFileSync(targetFile, 'utf-8'),
                    },
                  ],
                };
              }
            }
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Artifact ID ${args.artifact_id} not found in workspace inbound_artifacts.`,
            },
          ],
          isError: true,
        };
      },
    ),

    // --- schedule_task ---
    tool(
      'schedule_task',
      `Schedule a recurring or one-time task.

EXECUTION TYPE:
\u2022 "agent" (default): Task runs as a full Claude Agent with access to all tools. Consumes API tokens.
\u2022 "script" (admin only): Task runs a shell command directly on the host. Zero API token cost. Use for deterministic tasks like health checks, data collection, cURL calls, or cron-like scripts.

EXECUTION MODE:
\u2022 "host": Task runs directly on the host machine. Admin only.
\u2022 "container" (default for non-admin): Task runs in a Docker container.
Each agent task runs in its source workspace (same files, mounts, skills, and Agent profile).

CONTEXT MODE (agent mode only) - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history.
\u2022 "isolated": Each trigger gets a fresh, independent session inside the source workspace. The session and virtual task chat are removed after that run.

MESSAGING BEHAVIOR - The task output is sent to the user or group.
\u2022 Agent mode: output is sent via MCP tool or stdout. Use <internal> tags to suppress.
\u2022 Script mode: stdout is sent as the result. stderr is included on failure.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
      {
        prompt: z
          .string()
          .optional()
          .default('')
          .describe(
            'The action to perform on EACH run (agent mode), or task description (script mode). The repeat cadence is expressed by schedule_type/schedule_value — do NOT put scheduling words like "每隔N/每天/定期/提醒我/every N" into the prompt. This prompt is replayed verbatim to the agent on every trigger to execute, so write it as a direct imperative action, not as a request to schedule something.',
          ),
        schedule_type: z
          .enum(['cron', 'interval', 'once'])
          .describe(
            'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
          ),
        schedule_value: z
          .string()
          .describe(
            'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
          ),
        execution_type: z
          .enum(['agent', 'script'])
          .default('agent')
          .describe(
            'agent=full Claude Agent (default), script=shell command (admin only, zero token cost)',
          ),
        script_command: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Shell command to execute (required for script mode). Runs in the group workspace directory.',
          ),
        execution_mode: z
          .enum(['host', 'container'])
          .optional()
          .describe(
            'Execution mode: host runs directly on the server, container runs in Docker isolation',
          ),
        context_mode: z
          .enum(['group', 'isolated'])
          .default('isolated')
          .describe(
            '(agent mode only) isolated=fresh session each time (default), group=runs with persistent workspace context',
          ),
        target_group_jid: z
          .string()
          .optional()
          .describe(
            '(Admin home only) JID of the group to schedule the task for. Defaults to the current group.',
          ),
      },
      async (args) => {
        const execType = args.execution_type || 'agent';

        // Validate execution_type constraints
        if (execType === 'agent' && !args.prompt?.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Agent mode requires a prompt. Provide instructions for what the agent should do.',
              },
            ],
            isError: true,
          };
        }
        if (execType === 'script' && !args.script_command?.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Script mode requires script_command. Provide the shell command to execute.',
              },
            ],
            isError: true,
          };
        }
        if (execType === 'script' && !ctx.isAdminHome) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Only admin home container can create script tasks.',
              },
            ],
            isError: true,
          };
        }

        // Validate schedule_value before writing IPC
        if (args.schedule_type === 'cron') {
          try {
            const interval = CronExpressionParser.parse(args.schedule_value, {
              tz: process.env.TZ || 'Asia/Shanghai',
            });
            if (interval.fields.second.values.length !== 1) {
              throw new Error('Cron frequency must be at least 60 seconds');
            }
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
                },
              ],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'interval') {
          const ms = Number(args.schedule_value);
          if (!Number.isFinite(ms) || ms < 60_000) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid interval: "${args.schedule_value}". Must be at least 60000 milliseconds (e.g., "300000" for 5 min).`,
                },
              ],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'once') {
          const date = new Date(args.schedule_value);
          if (isNaN(date.getTime())) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
                },
              ],
              isError: true,
            };
          }
        }

        const targetJid =
          hasCrossGroupAccess && args.target_group_jid
            ? args.target_group_jid
            : ctx.chatJid;
        const requestId = newRequestId();
        const data: Record<string, unknown> & { requestId: string } = {
          type: 'schedule_task',
          requestId,
          prompt: args.prompt || '',
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          context_mode: args.context_mode || 'isolated',
          execution_type: execType,
          targetJid,
          createdBy: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        if (execType === 'script') {
          data.script_command = args.script_command;
        }
        if (args.execution_mode) {
          data.execution_mode = args.execution_mode;
        }
        const modeLabel = execType === 'script' ? 'script' : 'agent';
        // 改为阻塞确认：等主进程真正落库后回执，避免 fire-and-forget 的“报成功但没建成”。
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            data,
            'schedule_task_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to schedule task: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const nextRun = result.nextRun
            ? ` 下次触发：${formatIsoLocal(result.nextRun as string)}`
            : '';
          const dup = result.duplicate
            ? '（已存在完全相同的活动任务，未重复创建，返回的是已有任务）'
            : '';
          return {
            content: [
              {
                type: 'text' as const,
                text: `Task scheduled [${modeLabel}] id=${result.taskId ?? '?'}: ${args.schedule_type} - ${args.schedule_value}.${nextRun}${dup}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for schedule_task confirmation. 任务可能已创建也可能未创建——请先用 list_tasks 核实，不要直接重试以免重复创建。',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- list_tasks ---
    tool(
      'list_tasks',
      "List all scheduled tasks. From admin home: shows all tasks. From other groups: shows only that group's tasks.",
      {
        include_deleted: z
          .boolean()
          .default(false)
          .describe(
            'Include soft-deleted tasks so they can be inspected/restored',
          ),
      },
      async (args) => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'list_tasks',
              requestId,
              groupFolder: ctx.groupFolder,
              isAdminHome: hasCrossGroupAccess,
              includeDeleted: args.include_deleted,
              timestamp: new Date().toISOString(),
            },
            'list_tasks_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error listing tasks: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const tasks = (result.tasks || []) as Array<{
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string | null;
            revision: number;
            current_run?: { id: string; status: string } | null;
            deleted_at?: string | null;
          }>;
          if (tasks.length === 0) {
            return {
              content: [
                { type: 'text' as const, text: 'No scheduled tasks found.' },
              ],
            };
          }
          const formatted = tasks
            .map(
              (t) =>
                `- [${t.id}] rev=${t.revision}${t.deleted_at ? ' [deleted]' : ''} ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.current_run?.status || t.status}, next: ${t.next_run ? formatIsoLocal(t.next_run) : '-'}`,
            )
            .join('\n');
          return {
            content: [
              { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for task list response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- pause_task ---
    tool(
      'pause_task',
      'Pause future scheduled occurrences. A currently running occurrence continues; use stop_task_run to stop it.',
      {
        task_id: z.string().describe('The task ID to pause'),
        expected_revision: z
          .number()
          .int()
          .positive()
          .describe('Revision returned by list_tasks'),
      },
      async (args) => {
        const data = {
          type: 'pause_task',
          requestId: newRequestId(),
          taskId: args.task_id,
          expectedRevision: args.expected_revision,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            data,
            'pause_task_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to pause task ${args.task_id}: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              { type: 'text' as const, text: `Task ${args.task_id} paused.` },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timeout waiting for pause confirmation for task ${args.task_id}.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- resume_task ---
    tool(
      'resume_task',
      'Resume a paused task.',
      {
        task_id: z.string().describe('The task ID to resume'),
        expected_revision: z
          .number()
          .int()
          .positive()
          .describe('Revision returned by list_tasks'),
      },
      async (args) => {
        const data = {
          type: 'resume_task',
          requestId: newRequestId(),
          taskId: args.task_id,
          expectedRevision: args.expected_revision,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            data,
            'resume_task_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to resume task ${args.task_id}: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              { type: 'text' as const, text: `Task ${args.task_id} resumed.` },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timeout waiting for resume confirmation for task ${args.task_id}.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- cancel_task ---
    tool(
      'cancel_task',
      'Soft-delete a scheduled task. Future runs stop, but run history is retained.',
      {
        task_id: z.string().describe('The task ID to delete'),
        expected_revision: z
          .number()
          .int()
          .positive()
          .describe('Revision returned by list_tasks'),
      },
      async (args) => {
        const data = {
          type: 'cancel_task',
          requestId: newRequestId(),
          taskId: args.task_id,
          expectedRevision: args.expected_revision,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            data,
            'cancel_task_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to cancel task ${args.task_id}: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Task ${args.task_id} deleted. Its run history is retained.`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timeout waiting for cancel confirmation for task ${args.task_id}.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- update_task ---
    tool(
      'update_task',
      `Update an existing scheduled task IN PLACE. Strongly PREFER this over cancel_task + schedule_task when modifying an existing task: delete-then-recreate risks leaving a duplicate (if the delete silently fails) or losing the task entirely. Only the fields you pass are changed; omit a field to keep its current value.`,
      {
        task_id: z.string().describe('The task ID to update'),
        expected_revision: z
          .number()
          .int()
          .positive()
          .describe(
            'Revision returned by list_tasks. The update is rejected if the task changed since it was listed.',
          ),
        prompt: z
          .string()
          .optional()
          .describe('New action/instructions for the task (agent mode)'),
        schedule_type: z
          .enum(['cron', 'interval', 'once'])
          .optional()
          .describe(
            'New schedule type. If you change this you MUST also pass schedule_value.',
          ),
        schedule_value: z
          .string()
          .optional()
          .describe(
            'New schedule value (LOCAL time): cron expr | interval ms | once "2026-02-01T15:30:00" (no Z).',
          ),
        context_mode: z
          .enum(['group', 'isolated'])
          .optional()
          .describe('New context mode (agent mode)'),
        execution_type: z
          .enum(['agent', 'script'])
          .optional()
          .describe('New execution type (script is admin only)'),
        script_command: z
          .string()
          .max(4096)
          .optional()
          .describe('New shell command (script mode)'),
        execution_mode: z
          .enum(['host', 'container'])
          .optional()
          .describe('New execution mode (host is admin only)'),
      },
      async (args) => {
        // 改 schedule_type 必须同时给 schedule_value，否则主进程无法据新类型重算 next_run。
        if (args.schedule_type && !args.schedule_value) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'When changing schedule_type you must also provide a matching schedule_value.',
              },
            ],
            isError: true,
          };
        }
        const data: Record<string, unknown> & { requestId: string } = {
          type: 'update_task',
          requestId: newRequestId(),
          taskId: args.task_id,
          expectedRevision: args.expected_revision,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        for (const k of [
          'prompt',
          'schedule_type',
          'schedule_value',
          'context_mode',
          'execution_type',
          'script_command',
          'execution_mode',
        ] as const) {
          if (args[k] !== undefined) data[k] = args[k];
        }
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            data,
            'update_task_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to update task ${args.task_id}: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const nextRun = result.nextRun
            ? ` 下次触发：${formatIsoLocal(result.nextRun as string)}`
            : '';
          return {
            content: [
              {
                type: 'text' as const,
                text: `Task ${args.task_id} updated.${nextRun}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timeout waiting for update confirmation for task ${args.task_id}.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- run_task_now ---
    tool(
      'run_task_now',
      'Run a scheduled task once now without changing its future schedule. A paused task stays paused.',
      {
        task_id: z.string().describe('The task ID to run'),
        idempotency_key: z
          .string()
          .optional()
          .describe(
            'Stable retry key; reuse it when retrying an uncertain request',
          ),
      },
      async (args) => {
        const requestId = newRequestId();
        const idempotencyKey = args.idempotency_key || requestId;
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'run_task_now',
              requestId,
              taskId: args.task_id,
              idempotencyKey,
              timestamp: new Date().toISOString(),
            },
            'run_task_now_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to run task ${args.task_id}: ${result.error || 'Unknown error'}`,
                },
              ],
              structuredContent: {
                success: false,
                task_id: args.task_id,
                error: result.error || 'Unknown error',
                existing_run_id: result.runId ?? null,
                idempotency_key: idempotencyKey,
              },
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Task queued. run_id=${result.runId ?? '?'}. This one-time run does not change the future schedule.`,
              },
            ],
            structuredContent: {
              success: true,
              task_id: args.task_id,
              run_id: result.runId ?? null,
              status: 'queued',
              idempotency_key: idempotencyKey,
            },
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timeout while starting task ${args.task_id}. Retry with idempotency_key=${idempotencyKey} or inspect task runs first.`,
              },
            ],
            structuredContent: {
              success: false,
              task_id: args.task_id,
              uncertain: true,
              idempotency_key: idempotencyKey,
            },
            isError: true,
          };
        }
      },
    ),

    // --- stop_task_run ---
    tool(
      'stop_task_run',
      'Stop one queued or running occurrence. This does not pause future scheduled runs.',
      {
        run_id: z
          .string()
          .describe('Run ID returned by run_task_now/list_task_runs'),
      },
      async (args) => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'stop_task_run',
              requestId,
              runId: args.run_id,
              timestamp: new Date().toISOString(),
            },
            'stop_task_run_result',
          );
          return result.success
            ? {
                content: [
                  {
                    type: 'text' as const,
                    text: `Run ${args.run_id} stopped. Future task schedules are unchanged.`,
                  },
                ],
              }
            : {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to stop run ${args.run_id}: ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timeout waiting for stop confirmation for run ${args.run_id}.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- restore_task ---
    tool(
      'restore_task',
      'Restore a soft-deleted task as paused. It will not run until explicitly resumed.',
      {
        task_id: z.string(),
        expected_revision: z.number().int().positive(),
      },
      async (args) => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'restore_task',
              requestId,
              taskId: args.task_id,
              expectedRevision: args.expected_revision,
              timestamp: new Date().toISOString(),
            },
            'restore_task_result',
          );
          return result.success
            ? {
                content: [
                  {
                    type: 'text' as const,
                    text: `Task ${args.task_id} restored as paused (revision ${result.revision ?? '?'}).`,
                  },
                ],
              }
            : {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to restore task ${args.task_id}: ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timeout waiting for restore confirmation for task ${args.task_id}.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- list_task_runs ---
    tool(
      'list_task_runs',
      'List recent occurrences for a scheduled task, including attempts and notification state.',
      {
        task_id: z.string(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      async (args) => {
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'list_task_runs',
              requestId,
              taskId: args.task_id,
              limit: args.limit,
              timestamp: new Date().toISOString(),
            },
            'list_task_runs_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to list runs: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const runs = (result.runs || []) as Array<Record<string, unknown>>;
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  runs.length === 0
                    ? 'No task runs found.'
                    : runs
                        .map(
                          (run) =>
                            `- [${String(run.id)}] ${String(run.status)} trigger=${String(run.trigger_type)} attempt=${String(run.attempt)} scheduled=${formatIsoLocal(String(run.scheduled_for))} notification=${String(run.notification_status)}`,
                        )
                        .join('\n'),
              },
            ],
          };
        } catch {
          return {
            content: [
              { type: 'text' as const, text: 'Timeout listing task runs.' },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- register_group ---
    tool(
      'register_group',
      `Register a new group so the agent can respond to messages there. Admin home only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").
You can optionally specify execution_mode: "container" (default, isolated Docker) or "host" (direct host access, admin only).`,
      {
        jid: z.string().describe('The chat JID (e.g., "feishu:oc_xxxx")'),
        name: z.string().describe('Display name for the group'),
        folder: z
          .string()
          // Strict regex: prevent path traversal / absolute paths flowing into
          // host's path.join(GROUPS_DIR, folder). The host re-validates with
          // the same shape — this is the documentation copy.
          .regex(
            /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
            'folder must be alphanumerics + ._- (no slashes, no leading dot, ≤128 chars)',
          )
          .describe(
            'Folder name for group files (lowercase, hyphens, e.g., "family-chat")',
          ),
        execution_mode: z
          .enum(['container', 'host'])
          .optional()
          .describe(
            'Execution mode: "container" (default, isolated Docker) or "host" (direct host access)',
          ),
      },
      async (args) => {
        if (!hasCrossGroupAccess) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Only the admin home container can register new groups.',
              },
            ],
            isError: true,
          };
        }
        const data = {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          executionMode: args.execution_mode,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
            },
          ],
        };
      },
    ),

    // --- discord_get_history ---
    tool(
      'discord_get_history',
      `Fetch recent messages from the current Discord channel or DM. Only works when the current chat is a Discord channel.
Returns up to 100 messages per call (default 50), ordered oldest-first. Use "before" with a message ID to paginate older messages.`,
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Number of messages to fetch (1-100, default 50)'),
        before: z
          .string()
          .regex(/^\d{17,20}$/, 'must be a Discord snowflake')
          .optional()
          .describe(
            'Message ID (snowflake) — only return messages older than this. Use the "id" of the oldest message in your previous batch to paginate.',
          ),
      },
      async (args) => {
        if (!ctx.chatJid.startsWith('discord:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: discord_get_history only works in Discord channels. Current chat: ${ctx.chatJid}`,
              },
            ],
            isError: true,
          };
        }
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'discord_get_history',
              chatJid: ctx.chatJid,
              limit: args.limit,
              before: args.before,
              requestId,
              timestamp: new Date().toISOString(),
            },
            'discord_get_history_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error fetching Discord history: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          const messages = (result.messages || []) as Array<{
            id: string;
            authorName: string;
            authorBot: boolean;
            content: string;
            timestamp: string;
            attachments: Array<{ name: string; url: string }>;
            replyToId?: string;
            edited: boolean;
          }>;
          if (messages.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'No messages found in this channel.',
                },
              ],
            };
          }
          const formatted = messages
            .map((m) => {
              const tag = m.authorBot ? ' [bot]' : '';
              const editFlag = m.edited ? ' (edited)' : '';
              const replyFlag = m.replyToId ? ` ↪${m.replyToId}` : '';
              const attachStr =
                m.attachments.length > 0
                  ? `\n  📎 ${m.attachments.map((a) => a.name).join(', ')}`
                  : '';
              return `[${m.timestamp}] ${m.authorName}${tag}${replyFlag}${editFlag} (id=${m.id})\n  ${m.content || '(empty)'}${attachStr}`;
            })
            .join('\n\n');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Discord history (${messages.length} messages, oldest first):\n\n${formatted}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for Discord history response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- discord_get_channel_info ---
    tool(
      'discord_get_channel_info',
      `Get metadata for the current Discord channel: name, type (guild_text/dm/etc), topic, NSFW flag, parent (category) ID, and guild ID.
Only works when the current chat is a Discord channel.`,
      {},
      async () => {
        if (!ctx.chatJid.startsWith('discord:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: discord_get_channel_info only works in Discord channels. Current chat: ${ctx.chatJid}`,
              },
            ],
            isError: true,
          };
        }
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'discord_get_channel_info',
              chatJid: ctx.chatJid,
              requestId,
              timestamp: new Date().toISOString(),
            },
            'discord_get_channel_info_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error fetching Discord channel info: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Discord channel info:\n${JSON.stringify(result.channel, null, 2)}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for Discord channel info response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),

    // --- discord_get_server_info ---
    tool(
      'discord_get_server_info',
      `Get metadata for the Discord server (guild) the current channel belongs to: name, description, owner ID, member count, icon URL.
Returns null if the current chat is a DM (DMs do not belong to a server). Only works when the current chat is a Discord channel.`,
      {},
      async () => {
        if (!ctx.chatJid.startsWith('discord:')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: discord_get_server_info only works in Discord channels. Current chat: ${ctx.chatJid}`,
              },
            ],
            isError: true,
          };
        }
        const requestId = newRequestId();
        try {
          const result = await pollIpcResult(
            TASKS_DIR,
            {
              type: 'discord_get_server_info',
              chatJid: ctx.chatJid,
              requestId,
              timestamp: new Date().toISOString(),
            },
            'discord_get_server_info_result',
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error fetching Discord server info: ${result.error || 'Unknown error'}`,
                },
              ],
              isError: true,
            };
          }
          if (result.guild === null) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'This is a DM channel — no server (guild) information available.',
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Discord server info:\n${JSON.stringify(result.guild, null, 2)}`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Timeout waiting for Discord server info response.',
              },
            ],
            isError: true,
          };
        }
      },
    ),
  ];

  // Agent Builder follows the effective top-level AgentProfile, not the
  // workspace type. The host independently revalidates every operation.
  if (ctx.agentBuilderEnabled) {
    const capabilityPolicySchema = z.object({
      mode: z.enum(['inherit', 'custom', 'disabled']),
      ids: z.array(z.string()).max(100),
    });
    const skillsPolicySchema = capabilityPolicySchema.extend({
      host: capabilityPolicySchema.optional(),
    });
    const requiredPromptSection = (description: string) =>
      z
        .string()
        .max(20_000)
        .refine((value) => value.trim().length > 0, description)
        .describe(description);
    const agentDefinitionSchema = z.object({
      name: z.string().min(1).max(80),
      prompt_schema_version: z.literal(2).optional().default(2),
      identity_prompt: requiredPromptSection(
        'Required IDENTITY: a concise role, core mission, and capability boundary. Do not put workflows, command examples, or tool instructions here.',
      ),
      soul_prompt: z
        .string()
        .max(20_000)
        .optional()
        .default('')
        .describe(
          'Optional SOUL: durable values, judgment principles, temperament, and communication style. May be empty for a purely mechanical Agent.',
        ),
      agents_prompt: requiredPromptSection(
        'Required AGENTS: executable workflows, inputs, outputs, defaults, branches, refusal rules, and failure handling.',
      ),
      tools_prompt: z
        .string()
        .max(20_000)
        .optional()
        .default('')
        .describe(
          'Optional TOOLS: how to select and use configured Skills, MCP servers, and tools, including ordering and limits. Do not copy entire Skill documents.',
        ),
      prompt_mode: z.enum(['append', 'replace']).optional().default('append'),
      avatar_emoji: z.string().max(8).nullable().optional().default(null),
      avatar_color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .optional()
        .default(null),
      runtime_policy: z
        .object({
          reasoning: z
            .object({
              effort: z.enum([
                'inherit',
                'low',
                'medium',
                'high',
                'xhigh',
                'max',
              ]),
            })
            .optional(),
          context: z
            .object({
              source: z.enum(['managed', 'host_claude']),
              auto_compact_window: z.number().int().min(0),
              auto_compact_percentage: z.number().int().min(0),
            })
            .optional(),
          skills: skillsPolicySchema.optional(),
          mcp: capabilityPolicySchema.optional(),
        })
        .optional(),
    });

    tools.push(
      tool(
        'agent_profile_list',
        "List the current user's top-level Agents and resumable ready drafts. Use this before editing or resuming work so you can identify the target, current version, draft ID, and draft revision. The main HappyClaw is returned for context but cannot edit itself with Agent Builder.",
        {},
        async () => {
          const result = await callAgentBuilder('agent_profile_list', {});
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),
      tool(
        'agent_profile_get',
        'Read the complete editable definition of one top-level Agent before preparing an update.',
        { profile_id: z.string().min(1) },
        async (args) => {
          const result = await callAgentBuilder('agent_profile_get', {
            profileId: args.profile_id,
          });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),
      tool(
        'agent_profile_draft_get',
        'Read the complete persisted definition and assumptions of a resumable Agent draft before revising or publishing it.',
        { draft_id: z.string().min(1) },
        async (args) => {
          const result = await callAgentBuilder('agent_profile_draft_get', {
            draftId: args.draft_id,
          });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),
      tool(
        'agent_capability_catalog',
        'List the real user Skills and MCP references that may be selected in an Agent definition. Use this before choosing custom capability IDs; never invent IDs.',
        {},
        async () => {
          const result = await callAgentBuilder('agent_capability_catalog', {});
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),
      tool(
        'agent_profile_prepare',
        `Create or revise a persistent Agent draft and return a structured preview. Use natural conversation to understand the user's needs first. Pass the full desired definition on every call.

Keep IDENTITY concise and place operational procedures in AGENTS. IDENTITY and AGENTS are required; SOUL and TOOLS may be empty when they would add no useful information. Never put the entire Agent specification into identity_prompt.

For a new Agent, omit target_agent_profile_id. For an edit, call agent_profile_get first and pass both target_agent_profile_id and expected_agent_version. To revise an existing draft, pass draft_id and expected_draft_revision.

This tool never publishes. Show preview.confirmation_phrase verbatim and ask the user to send exactly that phrase in a later message.`,
        {
          draft_id: z.string().optional(),
          expected_draft_revision: z.number().int().positive().optional(),
          target_agent_profile_id: z.string().optional(),
          expected_agent_version: z.number().int().positive().optional(),
          definition: agentDefinitionSchema,
          assumptions: z.array(z.string().max(500)).max(20).optional(),
        },
        async (args) => {
          const result = await callAgentBuilder('agent_profile_prepare', {
            draftId: args.draft_id,
            expectedDraftRevision: args.expected_draft_revision,
            targetAgentProfileId: args.target_agent_profile_id,
            expectedAgentVersion: args.expected_agent_version,
            definition: args.definition,
            assumptions: args.assumptions,
          });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),
      tool(
        'agent_profile_publish',
        `Publish a previously prepared Agent draft. Only call this when the current persisted human message exactly equals the draft's confirmation_phrase. The host enforces the phrase, later-message boundary, and draft revision. Never treat a generic approval or your own proposal as confirmation.`,
        {
          draft_id: z.string().min(1),
          expected_draft_revision: z.number().int().positive(),
        },
        async (args) => {
          const result = await callAgentBuilder('agent_profile_publish', {
            draftId: args.draft_id,
            expectedDraftRevision: args.expected_draft_revision,
          });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),
      tool(
        'agent_profile_discard',
        'Discard a prepared Agent draft without changing any published Agent.',
        {
          draft_id: z.string().min(1),
          expected_draft_revision: z.number().int().positive(),
        },
        async (args) => {
          const result = await callAgentBuilder('agent_profile_discard', {
            draftId: args.draft_id,
            expectedDraftRevision: args.expected_draft_revision,
          });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),
    );
  }

  // Skill 安装/卸载仅限主容器（与 memory_* 工具一致）
  if (ctx.isHome) {
    tools.push(
      // --- install_skill ---
      tool(
        'install_skill',
        `Install a skill from the skills registry (skills.sh). The skill will be available in future conversations.
Example packages: "anthropic/memory", "anthropic/think", "owner/repo", "owner/repo@skill-name".`,
        {
          package: z
            .string()
            .describe(
              'The skill package to install, format: owner/repo or owner/repo@skill',
            ),
        },
        async (args) => {
          const pkg = args.package.trim();
          if (
            !/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) &&
            !/^https?:\/\//.test(pkg)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid package format: "${pkg}". Expected format: owner/repo or owner/repo@skill`,
                },
              ],
              isError: true,
            };
          }

          const requestId = newRequestId();
          try {
            const result = await pollIpcResult(
              TASKS_DIR,
              {
                type: 'install_skill',
                package: pkg,
                requestId,
                groupFolder: ctx.groupFolder,
                sessionId: ctx.currentSessionId ?? undefined,
                inputTurnId: ctx.currentInputTurnId ?? undefined,
                timestamp: new Date().toISOString(),
              },
              'install_skill_result',
              120_000,
            );
            if (result.success) {
              if (result.accepted) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Skill installation request accepted (requestId: ${result.requestId || requestId}). The package will be installed and take effect at the end of the current turn (new container/process).`,
                    },
                  ],
                };
              }
              const installed =
                ((result.installed as string[]) || []).join(', ') || pkg;
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Skill installed successfully: ${installed}\n\nNote: The skill will be available in the next conversation (new container/process).`,
                  },
                ],
              };
            } else {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to install skill "${pkg}": ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Timeout waiting for skill installation result (120s). The installation may still be in progress.`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      // --- uninstall_skill ---
      tool(
        'uninstall_skill',
        `Uninstall a user-level skill by its ID. Project-level skills cannot be uninstalled.
Use the skills panel in the UI to find the skill ID (directory name, e.g. "memory", "think").`,
        {
          skill_id: z
            .string()
            .describe(
              'The skill ID to uninstall (the directory name, e.g. "memory", "think")',
            ),
        },
        async (args) => {
          const skillId = args.skill_id.trim();
          if (!skillId || !/^[\w\-]+$/.test(skillId)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid skill ID: "${skillId}". Must be alphanumeric with hyphens/underscores.`,
                },
              ],
              isError: true,
            };
          }

          const requestId = newRequestId();
          try {
            const result = await pollIpcResult(
              TASKS_DIR,
              {
                type: 'uninstall_skill',
                skillId,
                requestId,
                groupFolder: ctx.groupFolder,
                sessionId: ctx.currentSessionId ?? undefined,
                inputTurnId: ctx.currentInputTurnId ?? undefined,
                timestamp: new Date().toISOString(),
              },
              'uninstall_skill_result',
            );
            if (result.success) {
              if (result.accepted) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Skill uninstallation request accepted (requestId: ${result.requestId || requestId}). The skill will be uninstalled and take effect at the end of the current turn.`,
                    },
                  ],
                };
              }
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Skill "${skillId}" uninstalled successfully.`,
                  },
                ],
              };
            } else {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Failed to uninstall skill "${skillId}": ${result.error || 'Unknown error'}`,
                  },
                ],
                isError: true,
              };
            }
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Timeout waiting for skill uninstall result.`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  if (ctx.ownerProfileEnabled && !ctx.isScheduledTask && !ctx.currentTaskId) {
    tools.push(
      tool(
        'happyclaw_owner_profile',
        'Read or update the actual owner’s preferred form of address in the built-in HappyClaw Home Workspace. This is a dedicated profile field, not generic Workspace Memory. Call get before changing an existing value; set and clear use optimistic concurrency and host-managed idempotency. Use skip only when the owner explicitly declines first-wake onboarding.',
        {
          action: z.enum(['get', 'set', 'clear', 'skip']),
          preferred_address: z.string().min(1).max(200).optional(),
          expected_revision: z.number().int().min(0).optional(),
          expected_onboarding_revision: z.number().int().min(0).optional(),
        },
        async (args) => {
          try {
            if (args.action === 'set' && !args.preferred_address?.trim()) {
              throw new Error('preferred_address is required for set');
            }
            if (
              args.action === 'clear' &&
              (!Number.isInteger(args.expected_revision) ||
                (args.expected_revision ?? 0) < 1)
            ) {
              throw new Error(
                'expected_revision from a preceding get is required for clear',
              );
            }
            const payload: Record<string, unknown> = {
              preferredAddress: args.preferred_address?.trim(),
              expectedRevision: args.expected_revision,
              expectedOnboardingRevision: args.expected_onboarding_revision,
            };
            if (args.action === 'set' || args.action === 'clear') {
              payload.idempotencyKey = memoryIdempotencyKey(
                undefined,
                `${ctx.currentInputTurnId ?? 'turn'}:owner-profile:${args.action}:${args.expected_revision ?? 0}`,
              );
            }
            const result = await callHappyClawOwnerProfile(
              ctx,
              args.action,
              payload,
            );
            return workspaceMemoryToolResult(result);
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: err instanceof Error ? err.message : String(err),
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  // Workspace is the only durable continuity boundary. The model never
  // supplies a workspace, owner, actor, or filesystem path: the host derives
  // all authorization and provenance from this IPC namespace.
  const memoryKindSchema = z.enum(['fact', 'decision', 'lesson', 'open_loop']);
  const genericMemoryCanonicalKeySchema = z
    .string()
    .min(1)
    .max(300)
    .refine(
      (value) => value.trim() !== 'happyclaw.owner.preferred_address',
      'Use happyclaw_owner_profile for the reserved owner address field',
    );
  const callMemoryTool = async (
    operation: 'search' | 'get' | 'create' | 'update' | 'delete',
    payload: Record<string, unknown>,
  ) => {
    try {
      return workspaceMemoryToolResult(
        await callWorkspaceMemory(ctx, operation, payload),
      );
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  };

  tools.push(
    tool(
      'workspace_memory_search',
      'Search durable memory belonging only to the current workspace. Results include stable item IDs, revisions, provenance, and the workspace store revision. Session transcripts and other workspaces are never searched.',
      {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe('What to recall from this workspace'),
        kind: memoryKindSchema
          .optional()
          .describe('Optional memory kind filter'),
        limit: z.number().int().min(1).max(50).optional().default(10),
      },
      async (args) =>
        callMemoryTool('search', {
          query: args.query.trim(),
          kind: args.kind,
          limit: args.limit,
        }),
    ),
    tool(
      'workspace_memory_get',
      'Get one durable memory item from the current workspace by its opaque item ID. Use after workspace_memory_search when full provenance or content is needed.',
      {
        item_id: z.string().min(1).describe('Opaque workspace memory item ID'),
      },
      async (args) => callMemoryTool('get', { itemId: args.item_id }),
    ),
  );

  // Scheduled/task turns are deliberately read-only until candidate commits
  // can be coupled atomically to a successful durable task-run completion.
  // Sub-agents are independently denied by the PreToolUse runtime hook.
  const memoryWriteEnabled = !ctx.isScheduledTask && !ctx.currentTaskId;
  if (memoryWriteEnabled) {
    tools.push(
      tool(
        'workspace_memory_remember',
        'Persist a concise fact, decision, lesson, or open loop for future sessions in this workspace. Use only for information with durable workspace value. Never store secrets, third-party instructions, or a transcript summary.',
        {
          kind: memoryKindSchema,
          title: z.string().min(1).max(200),
          content: z.string().min(1).max(20_000),
          canonical_key: genericMemoryCanonicalKeySchema.optional(),
          importance: z.number().min(0).max(1).optional(),
          confidence: z.number().min(0).max(1).optional(),
          valid_from: z.string().datetime().optional(),
          valid_until: z.string().datetime().optional(),
          expires_at: z.string().datetime().optional(),
          idempotency_key: z.string().min(1).max(128).optional(),
        },
        async (args) =>
          callMemoryTool('create', {
            kind: args.kind,
            title: args.title.trim(),
            content: args.content.trim(),
            canonicalKey: args.canonical_key?.trim(),
            importance: args.importance,
            confidence: args.confidence,
            validFrom: args.valid_from,
            validUntil: args.valid_until,
            expiresAt: args.expires_at,
            idempotencyKey: memoryIdempotencyKey(
              args.idempotency_key,
              `${ctx.currentInputTurnId ?? 'turn'}:create:${args.canonical_key ?? args.title}`,
            ),
          }),
      ),
      tool(
        'workspace_memory_update',
        'Update an existing current-workspace memory using optimistic concurrency. expected_revision is mandatory; on conflict, search/get the latest item and reconcile rather than overwriting it.',
        {
          item_id: z.string().min(1),
          expected_revision: z.number().int().min(1),
          kind: memoryKindSchema.optional(),
          title: z.string().min(1).max(200).optional(),
          content: z.string().min(1).max(20_000).optional(),
          canonical_key: genericMemoryCanonicalKeySchema.nullable().optional(),
          importance: z.number().min(0).max(1).optional(),
          confidence: z.number().min(0).max(1).optional(),
          valid_from: z.string().datetime().nullable().optional(),
          valid_until: z.string().datetime().nullable().optional(),
          expires_at: z.string().datetime().nullable().optional(),
          idempotency_key: z.string().min(1).max(128).optional(),
        },
        async (args) =>
          callMemoryTool('update', {
            itemId: args.item_id,
            expectedRevision: args.expected_revision,
            patch: {
              kind: args.kind,
              title: args.title?.trim(),
              content: args.content?.trim(),
              canonicalKey: args.canonical_key,
              importance: args.importance,
              confidence: args.confidence,
              validFrom: args.valid_from,
              validUntil: args.valid_until,
              expiresAt: args.expires_at,
            },
            idempotencyKey: memoryIdempotencyKey(
              args.idempotency_key,
              `${ctx.currentInputTurnId ?? 'turn'}:update:${args.item_id}:${args.expected_revision}`,
            ),
          }),
      ),
      tool(
        'workspace_memory_forget',
        'Forget one current-workspace memory item. This creates an auditable tombstone and requires the item revision to prevent deleting a concurrently corrected memory.',
        {
          item_id: z.string().min(1),
          expected_revision: z.number().int().min(1),
          idempotency_key: z.string().min(1).max(128).optional(),
        },
        async (args) =>
          callMemoryTool('delete', {
            itemId: args.item_id,
            expectedRevision: args.expected_revision,
            idempotencyKey: memoryIdempotencyKey(
              args.idempotency_key,
              `${ctx.currentInputTurnId ?? 'turn'}:delete:${args.item_id}:${args.expected_revision}`,
            ),
          }),
      ),
    );
  }

  return tools;
}
