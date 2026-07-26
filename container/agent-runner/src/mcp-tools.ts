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
  /** Public reply contract selected by the workspace. */
  interactionMode?: 'assistant' | 'proactive';
  isScheduledTask?: boolean;
  /** Mutable: set when the current IPC turn was triggered by a task prompt.
   * Cleared between turns by the agent-runner main loop so that regular
   * follow-up messages aren't misattributed to the prior task. */
  currentTaskId?: string | null;
  /** Mutable correlation id for the user input currently being answered.
   * Cold starts use the triggering message id; IPC turns use the host-issued
   * delivery id from their receipt. */
  currentInputTurnId?: string | null;
  workspaceIpc: string;
  workspaceGroup: string;
  workspaceGlobal: string;
  workspaceMemory: string;
}

function writeIpcFile(dir: string, data: object): string {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: temp file then rename
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
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
async function pollIpcResult(
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

  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(resultFilePath, 'utf-8');
      fs.unlinkSync(resultFilePath);
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      // File not ready yet — only swallow ENOENT
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  throw new Error(`Timeout waiting for IPC result (${timeoutMs / 1000}s)`);
}

function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Memory helpers ---
const MEMORY_EXTENSIONS = new Set(['.md', '.txt']);
const MEMORY_SUBDIRS = new Set(['memory', 'conversations']);
const MEMORY_SKIP_DIRS = new Set(['logs', '.claude', 'node_modules', '.git']);
const MAX_MEMORY_FILE_SIZE = 512 * 1024; // 512KB per file
const MAX_MEMORY_APPEND_SIZE = 16 * 1024; // 16KB per append
const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function collectMemoryFiles(
  baseDir: string,
  out: string[],
  maxDepth: number,
  depth = 0,
): void {
  if (depth > maxDepth || !fs.existsSync(baseDir)) return;
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name);
      if (entry.isDirectory()) {
        if (MEMORY_SKIP_DIRS.has(entry.name)) continue;
        if (depth === 0 || MEMORY_SUBDIRS.has(entry.name)) {
          collectMemoryFiles(fullPath, out, maxDepth, depth + 1);
        }
      } else if (entry.isFile()) {
        if (
          entry.name === 'CLAUDE.md' ||
          MEMORY_EXTENSIONS.has(path.extname(entry.name))
        ) {
          out.push(fullPath);
        }
      }
    }
  } catch {
    /* skip unreadable */
  }
}

function createToRelativePath(ctx: McpContext) {
  return (filePath: string): string => {
    if (
      filePath === ctx.workspaceGlobal ||
      filePath.startsWith(ctx.workspaceGlobal + path.sep)
    ) {
      return `[global] ${path.relative(ctx.workspaceGlobal, filePath)}`;
    }
    if (
      filePath === ctx.workspaceMemory ||
      filePath.startsWith(ctx.workspaceMemory + path.sep)
    ) {
      return `[memory] ${path.relative(ctx.workspaceMemory, filePath)}`;
    }
    return path.relative(ctx.workspaceGroup, filePath);
  };
}

function parseMemoryFileReference(fileRef: string): {
  pathRef: string;
  lineFromRef?: number;
} {
  const trimmed = fileRef.trim();
  const lineRefMatch = trimmed.match(/^(.*?):(\d+)$/);
  if (!lineRefMatch) return { pathRef: trimmed };

  const lineFromRef = Number(lineRefMatch[2]);
  if (!Number.isInteger(lineFromRef) || lineFromRef <= 0) {
    return { pathRef: trimmed };
  }
  return { pathRef: lineRefMatch[1].trim(), lineFromRef };
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
  const toRelativePath = createToRelativePath(ctx);

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
      'Send an interactive Feishu card to the current chat/thread as the Bot bound to this turn. The host locks the destination to the current context.',
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
        ? 'Send one user-visible message now. The Workspace uses Proactive reply mode: every call creates an independent native chat message immediately, and your normal SDK final text is not published. You may call this tool zero, one, or many times and continue working after each successful send. A delivery error is authoritative: do not sleep and retry, switch to a card, or call a raw channel API as a fallback.'
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
              ? 'Ignored in Proactive reply mode: every call is delivered as an independent native message.'
              : 'progress updates the active reply, final stages its answer, separate creates an additional message. Defaults to final for interactive turns and separate for scheduled tasks.',
          ),
      },
      async (args) => {
        const deliveryRole = ctx.isScheduledTask
          ? 'separate'
          : ctx.interactionMode === 'proactive'
            ? 'separate'
            : (args.delivery_role ?? 'final');
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
                ? 'Message delivered. If this completes the thought, end the turn now. Send again only for new, non-redundant content; never repeat this message in SDK final text.'
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
                timestamp: new Date().toISOString(),
              },
              'install_skill_result',
              120_000,
            );
            if (result.success) {
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
                timestamp: new Date().toISOString(),
              },
              'uninstall_skill_result',
            );
            if (result.success) {
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

  // --- memory_append --- (only available for home containers)
  if (ctx.isHome) {
    tools.push(
      tool(
        'memory_append',
        `\u5c06**\u65f6\u6548\u6027\u8bb0\u5fc6**\u8ffd\u52a0\u5230 memory/YYYY-MM-DD.md\uff08\u72ec\u7acb\u8bb0\u5fc6\u76ee\u5f55\uff0c\u4e0d\u5728\u5de5\u4f5c\u533a\u5185\uff09\u3002
\u4ec5\u8ffd\u52a0\u5199\u5165\uff0c\u4e0d\u4f1a\u8986\u76d6\u5df2\u6709\u5185\u5bb9\u3002

\u4ec5\u7528\u4e8e\u660e\u786e\u53ea\u8ddf\u5f53\u5929/\u77ed\u671f\u6709\u5173\u7684\u4fe1\u606f\uff1a\u4eca\u65e5\u9879\u76ee\u8fdb\u5c55\u3001\u4e34\u65f6\u6280\u672f\u51b3\u7b56\u3001\u5f85\u529e\u4e8b\u9879\u3001\u4f1a\u8bae\u8981\u70b9\u7b49\u3002

**\u91cd\u8981**\uff1a\u4e0b\u6b21\u5bf9\u8bdd\u4ecd\u53ef\u80fd\u7528\u5230\u7684\u4fe1\u606f\uff08\u7528\u6237\u8eab\u4efd\u3001\u504f\u597d\u3001\u5e38\u7528\u9879\u76ee\u3001\u7528\u6237\u8bf4\u201c\u8bb0\u4f4f\u201d\u7684\u5185\u5bb9\uff09\u5e94\u76f4\u63a5\u7528 Edit \u5de5\u5177\u7f16\u8f91 /workspace/global/CLAUDE.md\uff0c\u4e0d\u8981\u7528\u6b64\u5de5\u5177\u3002`,
        {
          content: z
            .string()
            .describe('\u8981\u8ffd\u52a0\u7684\u8bb0\u5fc6\u5185\u5bb9'),
          date: z
            .string()
            .optional()
            .describe(
              '\u76ee\u6807\u65e5\u671f\uff0c\u683c\u5f0f YYYY-MM-DD\uff08\u9ed8\u8ba4\uff1a\u4eca\u5929\uff09',
            ),
        },
        async (args) => {
          const normalizedContent = args.content.replace(/\r\n?/g, '\n').trim();
          if (!normalizedContent) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a\u3002',
                },
              ],
              isError: true,
            };
          }
          const appendBytes = Buffer.byteLength(normalizedContent, 'utf-8');
          if (appendBytes > MAX_MEMORY_APPEND_SIZE) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u5185\u5bb9\u8fc7\u5927\uff1a${appendBytes} \u5b57\u8282\uff08\u4e0a\u9650 ${MAX_MEMORY_APPEND_SIZE}\uff09\u3002`,
                },
              ],
              isError: true,
            };
          }
          const date = (
            args.date ?? new Date().toISOString().split('T')[0]
          ).trim();
          if (!MEMORY_DATE_PATTERN.test(date)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u65e5\u671f\u683c\u5f0f\u65e0\u6548\uff1a\u201c${date}\u201d\uff0c\u8bf7\u4f7f\u7528 YYYY-MM-DD\u3002`,
                },
              ],
              isError: true,
            };
          }
          const resolvedPath = path.normalize(
            path.join(ctx.workspaceMemory, `${date}.md`),
          );
          const inMemory =
            resolvedPath === ctx.workspaceMemory ||
            resolvedPath.startsWith(ctx.workspaceMemory + path.sep);
          if (!inMemory) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '\u8bbf\u95ee\u88ab\u62d2\u7edd\uff1a\u8def\u5f84\u8d85\u51fa\u5de5\u4f5c\u533a\u8303\u56f4\u3002',
                },
              ],
              isError: true,
            };
          }
          try {
            fs.mkdirSync(ctx.workspaceMemory, { recursive: true });
            const fileExists = fs.existsSync(resolvedPath);
            const currentSize = fileExists ? fs.statSync(resolvedPath).size : 0;
            const separator = currentSize > 0 ? '\n---\n\n' : '';
            const entry = `${separator}### ${new Date().toISOString()}\n${normalizedContent}\n`;
            const nextSize = currentSize + Buffer.byteLength(entry, 'utf-8');
            if (nextSize > MAX_MEMORY_FILE_SIZE) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `\u8bb0\u5fc6\u6587\u4ef6\u5c06\u8d85\u8fc7 ${MAX_MEMORY_FILE_SIZE} \u5b57\u8282\u4e0a\u9650\uff0c\u8bf7\u7f29\u77ed\u5185\u5bb9\u3002`,
                  },
                ],
                isError: true,
              };
            }
            fs.appendFileSync(resolvedPath, entry, 'utf-8');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u5df2\u8ffd\u52a0\u5230 memory/${date}.md\uff08${appendBytes} \u5b57\u8282\uff09\u3002`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u8ffd\u52a0\u8bb0\u5fc6\u65f6\u51fa\u9519\uff1a${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  // --- memory_search + memory_get ---
  {
    tools.push(
      tool(
        'memory_search',
        `\u5728\u5de5\u4f5c\u533a\u7684\u8bb0\u5fc6\u6587\u4ef6\u4e2d\u641c\u7d22\uff08CLAUDE.md\u3001memory/\u3001conversations/ \u53ca\u5176\u4ed6 .md/.txt \u6587\u4ef6\uff09\u3002
\u8fd4\u56de\u6587\u4ef6\u8def\u5f84\u3001\u884c\u53f7\u548c\u4e0a\u4e0b\u6587\u7247\u6bb5\u3002\u8d85\u8fc7 512KB \u7684\u6587\u4ef6\u4f1a\u88ab\u8df3\u8fc7\u3002
\u7528\u4e8e\u56de\u5fc6\u8fc7\u53bb\u7684\u51b3\u7b56\u3001\u504f\u597d\u3001\u9879\u76ee\u4e0a\u4e0b\u6587\u6216\u5bf9\u8bdd\u5386\u53f2\u3002`,
        {
          query: z
            .string()
            .describe(
              '\u641c\u7d22\u5173\u952e\u8bcd\u6216\u77ed\u8bed\uff08\u4e0d\u533a\u5206\u5927\u5c0f\u5199\uff09',
            ),
          max_results: z
            .number()
            .optional()
            .default(20)
            .describe(
              '\u6700\u5927\u7ed3\u679c\u6570\uff08\u9ed8\u8ba4 20\uff0c\u4e0a\u9650 50\uff09',
            ),
        },
        async (args) => {
          if (!args.query.trim()) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '\u641c\u7d22\u5173\u952e\u8bcd\u4e0d\u80fd\u4e3a\u7a7a\u3002',
                },
              ],
              isError: true,
            };
          }
          const maxResults = Math.min(Math.max(args.max_results ?? 20, 1), 50);
          const queryLower = args.query.toLowerCase();
          const files: string[] = [];
          collectMemoryFiles(ctx.workspaceMemory, files, 4);
          collectMemoryFiles(ctx.workspaceGroup, files, 4);
          collectMemoryFiles(ctx.workspaceGlobal, files, 4);
          const uniqueFiles = Array.from(new Set(files));
          if (uniqueFiles.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '\u672a\u627e\u5230\u8bb0\u5fc6\u6587\u4ef6\u3002',
                },
              ],
            };
          }
          const results: string[] = [];
          let skippedLarge = 0;
          for (const filePath of uniqueFiles) {
            if (results.length >= maxResults) break;
            try {
              const stat = fs.statSync(filePath);
              if (stat.size > MAX_MEMORY_FILE_SIZE) {
                skippedLarge++;
                continue;
              }
              const content = fs.readFileSync(filePath, 'utf-8');
              const lines = content.split('\n');
              let lastEnd = -1;
              for (let i = 0; i < lines.length; i++) {
                if (results.length >= maxResults) break;
                if (lines[i].toLowerCase().includes(queryLower)) {
                  const start = Math.max(0, i - 1);
                  if (start <= lastEnd) continue;
                  const end = Math.min(lines.length, i + 2);
                  lastEnd = end;
                  const snippet = lines.slice(start, end).join('\n');
                  results.push(
                    `${toRelativePath(filePath)}:${i + 1}\n${snippet}`,
                  );
                }
              }
            } catch {
              /* skip unreadable */
            }
          }
          const skippedNote =
            skippedLarge > 0
              ? `\uff08\u8df3\u8fc7 ${skippedLarge} \u4e2a\u5927\u6587\u4ef6\uff09`
              : '';
          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u5728 ${uniqueFiles.length} \u4e2a\u8bb0\u5fc6\u6587\u4ef6\u4e2d\u672a\u627e\u5230\u201c${args.query}\u201d\u7684\u5339\u914d\u3002${skippedNote}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `\u627e\u5230 ${results.length} \u6761\u5339\u914d${skippedNote}\uff1a\n\n${results.join('\n---\n')}`,
              },
            ],
          };
        },
      ),

      // --- memory_get ---
      tool(
        'memory_get',
        `\u8bfb\u53d6\u8bb0\u5fc6\u6587\u4ef6\u6216\u6307\u5b9a\u884c\u8303\u56f4\u3002\u5728 memory_search \u4e4b\u540e\u4f7f\u7528\u4ee5\u83b7\u53d6\u5b8c\u6574\u4e0a\u4e0b\u6587\u3002`,
        {
          file: z
            .string()
            .describe(
              '\u76f8\u5bf9\u8def\u5f84\uff0c\u53ef\u5e26 :\u884c\u53f7\uff08\u5982 "CLAUDE.md:12"\u3001"[global] CLAUDE.md:8" \u6216 "[memory] 2026-01-15.md"\uff09',
            ),
          from_line: z
            .number()
            .optional()
            .describe(
              '\u8d77\u59cb\u884c\u53f7\uff08\u4ece 1 \u5f00\u59cb\uff0c\u9ed8\u8ba4\uff1a1\uff09',
            ),
          lines: z
            .number()
            .optional()
            .describe(
              '\u8bfb\u53d6\u884c\u6570\uff08\u9ed8\u8ba4\uff1a\u5168\u90e8\uff0c\u4e0a\u9650\uff1a200\uff09',
            ),
        },
        async (args) => {
          const { pathRef, lineFromRef } = parseMemoryFileReference(args.file);
          let resolvedPath: string;
          if (pathRef.startsWith('[global] ')) {
            resolvedPath = path.join(
              ctx.workspaceGlobal,
              pathRef.slice('[global] '.length),
            );
          } else if (pathRef.startsWith('[memory] ')) {
            resolvedPath = path.join(
              ctx.workspaceMemory,
              pathRef.slice('[memory] '.length),
            );
          } else {
            resolvedPath = path.join(ctx.workspaceGroup, pathRef);
          }
          resolvedPath = path.normalize(resolvedPath);
          const inGroup =
            resolvedPath === ctx.workspaceGroup ||
            resolvedPath.startsWith(ctx.workspaceGroup + path.sep);
          const inGlobal =
            resolvedPath === ctx.workspaceGlobal ||
            resolvedPath.startsWith(ctx.workspaceGlobal + path.sep);
          const inMemory =
            resolvedPath === ctx.workspaceMemory ||
            resolvedPath.startsWith(ctx.workspaceMemory + path.sep);
          if (!inGroup && !inGlobal && !inMemory) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: '\u8bbf\u95ee\u88ab\u62d2\u7edd\uff1a\u8def\u5f84\u8d85\u51fa\u5de5\u4f5c\u533a\u8303\u56f4\u3002',
                },
              ],
              isError: true,
            };
          }
          if (!fs.existsSync(resolvedPath)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u6587\u4ef6\u672a\u627e\u5230\uff1a${pathRef}`,
                },
              ],
              isError: true,
            };
          }
          try {
            const content = fs.readFileSync(resolvedPath, 'utf-8');
            const allLines = content.split('\n');
            const fromLine = Math.max(
              (args.from_line ?? lineFromRef ?? 1) - 1,
              0,
            );
            const maxLines = Math.min(args.lines ?? allLines.length, 200);
            const slice = allLines.slice(fromLine, fromLine + maxLines);
            const header = `${pathRef}\uff08\u7b2c ${fromLine + 1}-${fromLine + slice.length} \u884c\uff0c\u5171 ${allLines.length} \u884c\uff09`;
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `${header}\n\n${slice.join('\n')}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `\u8bfb\u53d6\u6587\u4ef6\u65f6\u51fa\u9519\uff1a${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );
  }

  return tools;
}
