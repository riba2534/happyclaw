/**
 * Zero-dependency stdio MCP server exposing HappyClaw's workspace-scoped
 * built-in tools (IM messaging, images/files, automations, channel context)
 * to `agy` CLI sessions via HappyClaw's native host IPC protocol.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { detectImageMimeTypeFromBase64Strict } from '../image-detector.js';

export interface AgyTurnContext {
  chatJid: string;
  groupFolder: string;
  interactionMode: 'assistant' | 'proactive';
  inputTurnId?: string;
  sourceJid?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || process.cwd();
const MESSAGES_DIR = path.join(WORKSPACE_IPC, 'messages');
const MESSAGE_RESULTS_DIR = path.join(WORKSPACE_IPC, 'message-results');
const TASKS_DIR = path.join(WORKSPACE_IPC, 'tasks');
const TURN_CONTEXT_FILE = path.join(WORKSPACE_IPC, '.agy-turn-context.json');
const FINAL_SENT_FILE = path.join(WORKSPACE_IPC, '.agy-final-sent.json');

function readTurnContext(): AgyTurnContext {
  const fallback: AgyTurnContext = {
    chatJid: process.env.HAPPYCLAW_CHAT_JID || '',
    groupFolder: process.env.HAPPYCLAW_GROUP_FOLDER || '',
    interactionMode:
      process.env.HAPPYCLAW_INTERACTION_MODE === 'proactive'
        ? 'proactive'
        : 'assistant',
  };
  try {
    if (!fs.existsSync(TURN_CONTEXT_FILE)) return fallback;
    const raw = JSON.parse(
      fs.readFileSync(TURN_CONTEXT_FILE, 'utf-8'),
    ) as Partial<AgyTurnContext>;
    return {
      chatJid: raw.chatJid || fallback.chatJid,
      groupFolder: raw.groupFolder || fallback.groupFolder,
      interactionMode:
        raw.interactionMode === 'proactive' ? 'proactive' : 'assistant',
      ...(raw.inputTurnId ? { inputTurnId: raw.inputTurnId } : {}),
      ...(raw.sourceJid ? { sourceJid: raw.sourceJid } : {}),
    };
  } catch {
    return fallback;
  }
}

function recordFinalSent(inputTurnId?: string): void {
  try {
    const tmp = `${FINAL_SENT_FILE}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ inputTurnId: inputTurnId || null, at: Date.now() }),
    );
    fs.renameSync(tmp, FINAL_SENT_FILE);
  } catch {
    // best effort
  }
}

function writeIpcFile(dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  const tmpPath = path.join(dir, `${filename}.tmp`);
  const finalPath = path.join(dir, filename);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, finalPath);
}

async function pollIpcResult(
  dir: string,
  data: Record<string, unknown> & { requestId: string },
  resultPrefix: string,
  timeoutMs = 30_000,
  resultDir: string = dir,
): Promise<Record<string, unknown>> {
  const resultPath = path.join(resultDir, `${resultPrefix}_${data.requestId}.json`);
  fs.mkdirSync(resultDir, { recursive: true });
  writeIpcFile(dir, data);

  let pollMs = 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(resultPath, 'utf-8');
      try {
        fs.unlinkSync(resultPath);
      } catch {
        // ignore
      }
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await new Promise((r) => setTimeout(r, pollMs));
    pollMs = Math.min(500, pollMs * 2);
  }
  throw new Error(`Timed out waiting for host IPC response (${resultPrefix})`);
}

function resolveInsideWorkspace(filePath: string): {
  resolved: string;
  relative: string;
} {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(WORKSPACE_GROUP, filePath);
  const resolved = path.resolve(abs);
  const root = path.resolve(WORKSPACE_GROUP);
  const safeRoot = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(safeRoot)) {
    throw new Error('File path must be within workspace directory.');
  }
  return { resolved, relative: path.relative(root, resolved) };
}

export const HAPPYCLAW_MCP_TOOLS: McpToolDef[] = [
  {
    name: 'get_channel_context',
    description:
      'Return the current HappyClaw conversation context (chatJid, groupFolder, interactionMode, sourceJid).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_message',
    description:
      'Send a user-visible message or progress update to the current HappyClaw chat/IM channel. In proactive workspaces, use delivery_role="progress" for interim updates, delivery_role="final" for the final reply, or delivery_role="separate" for an extra standalone message.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to publish' },
        delivery_role: {
          type: 'string',
          enum: ['progress', 'final', 'separate'],
          description: 'Delivery role (progress | final | separate)',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'send_image',
    description:
      'Send an image file from the workspace to the current HappyClaw conversation (PNG/JPEG/GIF/WebP/TIFF/BMP, max 10MB).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the image file (relative to workspace or absolute inside workspace)',
        },
        caption: { type: 'string', description: 'Optional caption text' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'send_file',
    description:
      'Send a file from the workspace to the current HappyClaw IM conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'File path relative to workspace (or absolute inside workspace)',
        },
        fileName: { type: 'string', description: 'Display file name' },
      },
      required: ['filePath', 'fileName'],
    },
  },
  {
    name: 'automation_list',
    description:
      'List all scheduled automations in the current HappyClaw workspace (id, revision, status, schedule, next run).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'automation_create',
    description:
      'Create a new HappyClaw scheduled automation (cron, interval, once, or manual).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short display name' },
        prompt: {
          type: 'string',
          description: 'Prompt executed on each run (required when execution is agent)',
        },
        schedule: {
          type: 'object',
          description:
            'Schedule object: { kind: "cron", expr, tz? } | { kind: "interval", everyMs } | { kind: "once", at } | { kind: "manual" }',
        },
        session: {
          type: 'string',
          enum: ['current', 'fresh', 'persistent'],
          description: 'Session mode (default: current)',
        },
        stopWhen: { type: 'string' },
        endAt: { type: 'string' },
        silentWhenIdle: { type: 'boolean' },
        execution: { type: 'string', enum: ['agent', 'script'] },
        scriptCommand: { type: 'string' },
      },
      required: ['name', 'schedule'],
    },
  },
  {
    name: 'automation_update',
    description: 'Update an existing HappyClaw automation by id and expectedRevision.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expectedRevision: { type: 'number' },
        name: { type: 'string' },
        prompt: { type: 'string' },
        schedule: { type: 'object' },
        stopWhen: { type: ['string', 'null'] },
        endAt: { type: ['string', 'null'] },
        silentWhenIdle: { type: 'boolean' },
      },
      required: ['id', 'expectedRevision'],
    },
  },
  {
    name: 'automation_pause',
    description: 'Pause a HappyClaw automation by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'automation_resume',
    description: 'Resume a paused HappyClaw automation by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'automation_complete',
    description: 'Mark a HappyClaw automation as completed by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'automation_delete',
    description: 'Permanently delete a HappyClaw automation by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'automation_run_now',
    description: 'Trigger an immediate run of a HappyClaw automation by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'automation_list_runs',
    description: 'List recent execution runs of a HappyClaw automation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['id'],
    },
  },
];

function toolText(text: string, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const ctx = readTurnContext();

  if (name === 'get_channel_context') {
    return toolText(JSON.stringify(ctx, null, 2));
  }

  if (name === 'send_message') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return toolText('Error: text must be a non-empty string.', true);
    const isProactive = ctx.interactionMode === 'proactive';
    const role =
      args.delivery_role === 'progress' ||
      args.delivery_role === 'final' ||
      args.delivery_role === 'separate'
        ? args.delivery_role
        : isProactive
          ? 'progress'
          : 'final';
    const requestId = `agy-mcp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const delivery = await pollIpcResult(
      MESSAGES_DIR,
      {
        type: 'message',
        chatJid: ctx.chatJid,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
        text,
        deliveryRole: role,
        ...(isProactive ? { presentation: 'native' } : {}),
        interactionMode: ctx.interactionMode,
        ...(ctx.inputTurnId ? { inputTurnId: ctx.inputTurnId } : {}),
        requestId,
      },
      'send_message_result',
      60_000,
      MESSAGE_RESULTS_DIR,
    );
    if (!delivery.success) {
      return toolText(
        typeof delivery.error === 'string'
          ? delivery.error
          : 'Message delivery failed.',
        true,
      );
    }
    if (isProactive && role === 'final') {
      recordFinalSent(ctx.inputTurnId);
    }
    return toolText(`Message delivered (${role}).`);
  }

  if (name === 'send_image') {
    const filePath = typeof args.file_path === 'string' ? args.file_path : '';
    if (!filePath) return toolText('Error: file_path is required.', true);
    const { resolved, relative } = resolveInsideWorkspace(filePath);
    if (!fs.existsSync(resolved)) {
      return toolText(`Error: file not found: ${filePath}`, true);
    }
    const stat = fs.statSync(resolved);
    if (stat.size === 0) return toolText('Error: image file is empty.', true);
    if (stat.size > 10 * 1024 * 1024) {
      return toolText('Error: image file exceeds 10MB limit.', true);
    }
    const base64 = fs.readFileSync(resolved).toString('base64');
    const mimeType = detectImageMimeTypeFromBase64Strict(base64);
    if (!mimeType) {
      return toolText(
        'Error: unsupported image format (PNG, JPEG, GIF, WebP, TIFF, BMP).',
        true,
      );
    }
    const requestId = `agy-img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const delivery = await pollIpcResult(
      MESSAGES_DIR,
      {
        type: 'image',
        chatJid: ctx.chatJid,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
        interactionMode: ctx.interactionMode,
        ...(ctx.inputTurnId ? { inputTurnId: ctx.inputTurnId } : {}),
        imageBase64: base64,
        filePath: relative,
        mimeType,
        caption: typeof args.caption === 'string' ? args.caption : undefined,
        fileName: path.basename(resolved),
        requestId,
      },
      'send_message_result',
      120_000,
      MESSAGE_RESULTS_DIR,
    );
    if (!delivery.success) {
      return toolText(
        typeof delivery.error === 'string'
          ? delivery.error
          : 'Image delivery failed.',
        true,
      );
    }
    return toolText(
      `Image sent: ${path.basename(resolved)} (${mimeType}, ${(stat.size / 1024).toFixed(1)}KB)`,
    );
  }

  if (name === 'send_file') {
    const filePath = typeof args.filePath === 'string' ? args.filePath : '';
    const fileName = typeof args.fileName === 'string' ? args.fileName : '';
    if (!filePath || !fileName) {
      return toolText('Error: filePath and fileName are required.', true);
    }
    const { resolved, relative } = resolveInsideWorkspace(filePath);
    if (!fs.existsSync(resolved)) {
      return toolText(`Error: file not found: ${filePath}`, true);
    }
    const requestId = `agy-file-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const delivery = await pollIpcResult(
      TASKS_DIR,
      {
        type: 'send_file',
        chatJid: ctx.chatJid,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
        interactionMode: ctx.interactionMode,
        ...(ctx.inputTurnId ? { inputTurnId: ctx.inputTurnId } : {}),
        filePath: relative,
        fileName,
        requestId,
      },
      'send_file_result',
      120_000,
    );
    if (!delivery.success) {
      return toolText(
        typeof delivery.error === 'string'
          ? delivery.error
          : 'File delivery failed.',
        true,
      );
    }
    return toolText(`File sent: ${fileName}`);
  }

  // Automation IPC tools
  const automationTools = new Set([
    'automation_list',
    'automation_create',
    'automation_update',
    'automation_pause',
    'automation_resume',
    'automation_complete',
    'automation_delete',
    'automation_run_now',
    'automation_list_runs',
  ]);
  if (automationTools.has(name)) {
    const requestId = crypto.randomUUID();
    const result = await pollIpcResult(
      TASKS_DIR,
      {
        type: name,
        requestId,
        inputTurnId: ctx.inputTurnId || null,
        timestamp: new Date().toISOString(),
        ...args,
      },
      `${name}_result`,
      30_000,
    );
    if (!result.success) {
      return toolText(
        typeof result.error === 'string' ? result.error : 'Operation failed.',
        true,
      );
    }
    return toolText(JSON.stringify(result, null, 2));
  }

  return toolText(`Unknown tool: ${name}`, true);
}

function sendResponse(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function runStdioServer(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return;
    }

    const id = req.id;
    const method = req.method;

    // Notifications (no id) require no response
    if (id === undefined || id === null) {
      return;
    }

    try {
      if (method === 'initialize') {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'happyclaw', version: '1.0.0' },
          },
        });
        return;
      }

      if (method === 'ping') {
        sendResponse({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (method === 'tools/list') {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: { tools: HAPPYCLAW_MCP_TOOLS },
        });
        return;
      }

      if (method === 'tools/call') {
        const params = req.params ?? {};
        const toolName = typeof params.name === 'string' ? params.name : '';
        const toolArgs =
          params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {};
        const result = await handleToolCall(toolName, toolArgs);
        sendResponse({ jsonrpc: '2.0', id, result });
        return;
      }

      sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch (err) {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: toolText(
          err instanceof Error ? err.message : String(err),
          true,
        ),
      });
    }
  });
}

// Start stdio server only when executed directly as a script
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);

if (isDirectRun) {
  runStdioServer();
}
