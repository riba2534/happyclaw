import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type {
  AgentRuntimeAdapter,
  RuntimeEmit,
  RuntimeRunInput,
  RuntimeRunResult,
} from './runtime-adapter.js';
import {
  buildResumeFailureRetryInput,
  classifyRuntimeError,
  runtimeContextMetaFromRunInput,
  runtimeErrorMessage,
} from './runtime-adapter.js';
import { resolveCodexPermissionOptions } from './runtime-permissions.js';

const CODEX_APP_CLI = '/Applications/Codex.app/Contents/Resources/codex';
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

export function findCodexCli(): string {
  const configured =
    process.env.HAPPYCLAW_CODEX_CLI_PATH || process.env.CODEX_CLI_PATH;
  if (configured) return configured;
  if (fs.existsSync(CODEX_APP_CLI)) return CODEX_APP_CLI;
  return 'codex';
}

export function writeTempImages(
  images: RuntimeRunInput['images'],
  workspaceIpc: string,
): string[] {
  if (!images?.length) return [];
  const dir = path.join(workspaceIpc, 'codex-images');
  fs.mkdirSync(dir, { recursive: true });
  return images.map((img, idx) => {
    const ext =
      img.mimeType?.includes('png')
        ? 'png'
        : img.mimeType?.includes('webp')
          ? 'webp'
          : img.mimeType?.includes('gif')
            ? 'gif'
            : 'jpg';
    const filePath = path.join(dir, `${Date.now()}-${idx}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
    return filePath;
  });
}

function parseSessionIdFromEvent(event: Record<string, unknown>): string | null {
  for (const key of ['session_id', 'sessionId', 'conversation_id', 'thread_id']) {
    const value = event[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const nested = event.msg || event.message || event.data;
  if (nested && typeof nested === 'object') {
    return parseSessionIdFromEvent(nested as Record<string, unknown>);
  }
  return null;
}

export function buildPrompt(input: RuntimeRunInput): string {
  return [
    input.systemPromptAppend,
    '',
    '<user-message>',
    input.prompt,
    '</user-message>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function writeMcpContext(input: RuntimeRunInput): string {
  const workspaceIpc = process.env.HAPPYCLAW_WORKSPACE_IPC || '/tmp';
  const filePath = path.join(
    workspaceIpc,
    `happyclaw-mcp-context-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.json`,
  );
  const context = {
    chatJid: input.input.chatJid,
    groupFolder: input.input.groupFolder,
    isHome: !!input.input.isHome,
    isAdminHome: !!input.input.isAdminHome,
    isScheduledTask: !!input.input.isScheduledTask,
    currentTaskId: input.input.messageTaskId ?? null,
    privacyMode: !!input.input.privacyMode,
    workspaceIpc,
    workspaceGroup: process.env.HAPPYCLAW_WORKSPACE_GROUP || input.cwd,
    workspaceGlobal: process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global',
    workspaceMemory: process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory',
    disableMemoryLayer: process.env.HAPPYCLAW_DISABLE_MEMORY_LAYER === 'true',
    resumeMode: input.resumeMode ?? null,
    inputContextHash: input.inputContextHash ?? null,
    workspaceInstructionHash: input.workspaceInstructionHash ?? null,
    softInjectionReason: input.softInjectionReason ?? null,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(context), 'utf-8');
  return filePath;
}

function tomlKeySegment(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlString(value: unknown): string {
  return JSON.stringify(String(value ?? ''));
}

function tomlArray(values: unknown): string {
  if (!Array.isArray(values)) return '[]';
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function tomlInlineStringTable(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => typeof item === 'string',
  );
  if (entries.length === 0) return null;
  return `{ ${entries
    .map(([key, item]) => `${tomlKeySegment(key)} = ${tomlString(item)}`)
    .join(', ')} }`;
}

function readMcpServersFromSettingsFile(
  settingsFile: string,
): Record<string, Record<string, unknown>> {
  try {
    if (!fs.existsSync(settingsFile)) return {};
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    if (settings.mcpServers && typeof settings.mcpServers === 'object') {
      return settings.mcpServers as Record<string, Record<string, unknown>>;
    }
  } catch {
    // Invalid MCP settings should not prevent the core HappyClaw MCP bridge.
  }
  return {};
}

function loadUserMcpServers(): Record<string, Record<string, unknown>> {
  const envJson = process.env.HAPPYCLAW_USER_MCP_SERVERS_JSON;
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, Record<string, unknown>>;
      }
    } catch {
      // Fall back to settings.json.
    }
  }
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || '/home/node', '.claude');
  return readMcpServersFromSettingsFile(path.join(configDir, 'settings.json'));
}

function loadWorkspaceMcpServers(
  cwd: string,
): Record<string, Record<string, unknown>> {
  return readMcpServersFromSettingsFile(
    path.join(cwd, '.claude', 'settings.json'),
  );
}

function pushMcpServerConfigArgs(
  args: string[],
  name: string,
  config: Record<string, unknown>,
): void {
  const prefix = `mcp_servers.${tomlKeySegment(name)}`;
  if (typeof config.type === 'string') {
    args.push('-c', `${prefix}.type=${tomlString(config.type)}`);
  }
  if (typeof config.command === 'string') {
    args.push('-c', `${prefix}.command=${tomlString(config.command)}`);
  }
  if (Array.isArray(config.args)) {
    args.push('-c', `${prefix}.args=${tomlArray(config.args)}`);
  }
  if (typeof config.url === 'string') {
    args.push('-c', `${prefix}.url=${tomlString(config.url)}`);
  }
  const envTable = tomlInlineStringTable(config.env);
  if (envTable) {
    args.push('-c', `${prefix}.env=${envTable}`);
  }
  const headerTable = tomlInlineStringTable(config.headers);
  if (headerTable) {
    args.push('-c', `${prefix}.headers=${headerTable}`);
  }
}

function pushMcpConfigArgs(
  args: string[],
  contextPath: string,
  cwd: string,
): void {
  const externalServers = {
    ...loadUserMcpServers(),
    ...loadWorkspaceMcpServers(cwd),
  };
  for (const [name, config] of Object.entries(externalServers)) {
    if (!config || typeof config !== 'object') continue;
    if (name === 'happyclaw') continue;
    pushMcpServerConfigArgs(args, name, config);
  }

  const serverPath = path.join(DIST_DIR, 'happyclaw-mcp-server.js');
  args.push(
    '-c',
    'mcp_servers.happyclaw.command="node"',
    '-c',
    `mcp_servers.happyclaw.args=${JSON.stringify([serverPath, contextPath])}`,
  );
}

export function buildCodexConfigObject(
  contextPath: string,
  cwd: string,
): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  const externalServers = {
    ...loadUserMcpServers(),
    ...loadWorkspaceMcpServers(cwd),
  };
  for (const [name, config] of Object.entries(externalServers)) {
    if (!config || typeof config !== 'object') continue;
    if (name === 'happyclaw') continue;
    mcpServers[name] = config;
  }

  const serverPath = path.join(DIST_DIR, 'happyclaw-mcp-server.js');
  mcpServers.happyclaw = {
    command: 'node',
    args: [serverPath, contextPath],
  };

  return {
    project_doc_fallback_filenames: ['CLAUDE.md'],
    mcp_servers: mcpServers,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function truncate(value: string, max = 2000): string {
  return value.length <= max ? value : `${value.slice(0, max)}... [truncated]`;
}

function contentBlocksToText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const record = asRecord(block);
      if (!record) return '';
      return typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function codexToolName(item: Record<string, unknown>): string {
  const type = String(item.type || '');
  if (type === 'command_execution') return 'Bash';
  if (type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : 'mcp';
    const tool = typeof item.tool === 'string' ? item.tool : 'tool';
    return `mcp__${server}__${tool}`;
  }
  if (type === 'file_change') return 'apply_patch';
  if (type === 'web_search') return 'web_search';
  return type || 'codex_tool';
}

function codexToolSummary(item: Record<string, unknown>): string {
  const type = String(item.type || '');
  if (type === 'command_execution') {
    return truncate(String(item.command || ''));
  }
  if (type === 'mcp_tool_call') {
    return truncate(JSON.stringify(item.arguments ?? {}, null, 2));
  }
  if (type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return truncate(
      changes
        .map((change) => {
          const record = asRecord(change);
          return record
            ? `${record.kind || 'update'} ${record.path || ''}`.trim()
            : '';
        })
        .filter(Boolean)
        .join('\n'),
    );
  }
  if (type === 'web_search') return truncate(String(item.query || ''));
  return truncate(JSON.stringify(item, null, 2));
}

function emitCodexItemEvent(
  lifecycle: 'started' | 'updated' | 'completed',
  item: Record<string, unknown>,
  emit: RuntimeEmit,
  state?: CodexEventNormalizerState,
): string | null {
  const itemType = String(item.type || '');
  const id = typeof item.id === 'string' ? item.id : `${itemType}-${Date.now()}`;

  if (itemType === 'agent_message') {
    if (lifecycle !== 'completed' && lifecycle !== 'updated') return null;
    const text = typeof item.text === 'string' ? item.text : '';
    if (!text) return null;
    if (state) {
      if (
        state.currentAgentMessageId &&
        state.currentAgentMessageId !== id &&
        state.currentAgentMessageText.trim()
      ) {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'assistant_text_boundary',
            segmentText: state.currentAgentMessageText,
          },
        });
      }
      const previousText = state.agentMessageTextById.get(id) || '';
      const delta = text.startsWith(previousText)
        ? text.slice(previousText.length)
        : text;
      if (delta) {
        emit({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'text_delta', text: delta },
        });
      }
      state.agentMessageTextById.set(id, text);
      state.currentAgentMessageId = id;
      state.currentAgentMessageText = text;
      return text;
    }
    emit({
      status: 'stream',
      result: null,
      streamEvent: { eventType: 'text_delta', text },
    });
    return text;
  }

  if (itemType === 'reasoning') {
    const text = typeof item.text === 'string' ? item.text : '';
    if (text) {
      emit({
        status: 'stream',
        result: null,
        streamEvent: { eventType: 'thinking_delta', text },
      });
    }
    return null;
  }

  if (itemType === 'todo_list' && Array.isArray(item.items)) {
    emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'todo_update',
        todos: item.items.map((todo, index) => {
          const record = asRecord(todo) || {};
          return {
            id: `${id}-${index}`,
            content: String(record.text || ''),
            status: record.completed ? 'completed' : 'pending',
          };
        }),
      },
    });
    return null;
  }

  if (itemType === 'error') {
    emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'status',
        statusText: String(item.message || 'Codex item error'),
      },
    });
    return null;
  }

  const toolTypes = new Set([
    'command_execution',
    'mcp_tool_call',
    'file_change',
    'web_search',
  ]);
  if (!toolTypes.has(itemType)) return null;

  const toolName = codexToolName(item);
  if (lifecycle === 'started') {
    emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'tool_use_start',
        toolName,
        toolUseId: id,
        toolInputSummary: codexToolSummary(item),
      },
    });
    return null;
  }

  if (lifecycle === 'updated') {
    const progress =
      itemType === 'command_execution'
        ? String(item.aggregated_output || '')
        : itemType === 'mcp_tool_call'
          ? contentBlocksToText(asRecord(item.result)?.content)
          : codexToolSummary(item);
    if (progress) {
      emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_progress',
          toolName,
          toolUseId: id,
          toolInputSummary: truncate(progress),
        },
      });
    }
    return null;
  }

  emit({
    status: 'stream',
    result: null,
    streamEvent: {
      eventType: 'tool_use_end',
      toolName,
      toolUseId: id,
      toolInputSummary: codexToolSummary(item),
    },
  });
  return null;
}

export interface CodexEventNormalizerState {
  currentAgentMessageId: string | null;
  currentAgentMessageText: string;
  agentMessageTextById: Map<string, string>;
}

export class CodexEventNormalizer {
  private readonly state: CodexEventNormalizerState = {
    currentAgentMessageId: null,
    currentAgentMessageText: '',
    agentMessageTextById: new Map(),
  };

  constructor(
    private readonly emit: RuntimeEmit,
    private readonly startedAt: number,
  ) {}

  handle(event: Record<string, unknown>): { agentText?: string; usage?: boolean } {
    return emitCodexEvent(event, this.emit, this.startedAt, this.state);
  }
}

export function emitCodexEvent(
  event: Record<string, unknown>,
  emit: RuntimeEmit,
  startedAt: number,
  state?: CodexEventNormalizerState,
): { agentText?: string; usage?: boolean } {
  const eventType = String(event.type || event.event || '');
  if (eventType === 'turn.completed') {
    const usage = asRecord(event.usage) || {};
    emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'usage',
        usage: {
          inputTokens: Number(usage.input_tokens || 0),
          outputTokens: Number(usage.output_tokens || 0),
          cacheReadInputTokens: Number(usage.cached_input_tokens || 0),
          cacheCreationInputTokens: 0,
          costUSD: 0,
          durationMs: Date.now() - startedAt,
          numTurns: 1,
        },
      },
    });
    return { usage: true };
  }

  if (eventType === 'turn.failed' || eventType === 'error') {
    const error = asRecord(event.error);
    emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'status',
        statusText: String(error?.message || event.message || 'Codex 返回错误事件'),
      },
    });
    return {};
  }

  const item = asRecord(event.item);
  if (!item) return {};
  if (eventType === 'item.started') {
    emitCodexItemEvent('started', item, emit, state);
    return {};
  }
  if (eventType === 'item.updated') {
    const agentText = emitCodexItemEvent('updated', item, emit, state);
    return agentText ? { agentText } : {};
  }
  if (eventType === 'item.completed') {
    const agentText = emitCodexItemEvent('completed', item, emit, state);
    return agentText ? { agentText } : {};
  }
  return {};
}

export const codexCliAdapter: AgentRuntimeAdapter = {
  runtime: 'codex',
  supportsNativeResume: true,
  supportsLiveInput: false,
  supportsPreCompactHook: false,
  canNativeResume(sessionId) {
    return !!sessionId?.trim();
  },
  classifyError: classifyRuntimeError,
  async run(input: RuntimeRunInput, emit: RuntimeEmit): Promise<RuntimeRunResult> {
    const cli = findCodexCli();
    const outputFile = path.join(
      process.env.HAPPYCLAW_WORKSPACE_IPC || '/tmp',
      `codex-last-message-${Date.now()}.md`,
    );
    const imageFiles = writeTempImages(
      input.images,
      process.env.HAPPYCLAW_WORKSPACE_IPC || '/tmp',
    );
    const mcpContextPath = writeMcpContext(input);
    const model = input.model || input.input.selectedModel || undefined;
    const permissionOptions = resolveCodexPermissionOptions({
      privacyMode: !!input.input.privacyMode,
    });
    const args = ['exec'];
    args.push('--json', '--skip-git-repo-check', '--cd', input.cwd);
    for (const dir of input.additionalDirectories || []) {
      args.push('--add-dir', dir);
    }
    args.push(
      '--sandbox',
      permissionOptions.sandboxMode,
      '-c',
      `approval_policy="${permissionOptions.approvalPolicy}"`,
    );
    args.push('-c', 'project_doc_fallback_filenames=["CLAUDE.md"]');
    pushMcpConfigArgs(args, mcpContextPath, input.cwd);
    args.push('--output-last-message', outputFile);
    if (model) args.push('--model', model);
    for (const imageFile of imageFiles) args.push('--image', imageFile);
    if (input.sessionId) args.push('resume', input.sessionId);
    args.push('-');

    emit({
      status: 'stream',
      result: null,
      streamEvent: {
        eventType: 'status',
        statusText: 'Codex 正在处理...',
      },
    });

    const prompt = buildPrompt(input);
    const rawStdout: string[] = [];
    const rawStderr: string[] = [];
    let newSessionId: string | undefined = input.sessionId;
    let emittedAgentMessageText = false;
    let emittedUsage = false;
    let lastAgentMessageText = '';
    const startedAt = Date.now();
    const normalizer = new CodexEventNormalizer(emit, startedAt);

    return await new Promise<RuntimeRunResult>((resolve) => {
      let settled = false;
      const resolveOnce = (result: RuntimeRunResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const proc = spawn(cli, args, {
        cwd: input.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: input.signal,
      });

      let stdoutRemainder = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        rawStdout.push(text);
        stdoutRemainder += text;
        const lines = stdoutRemainder.split('\n');
        stdoutRemainder = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            const sessionId = parseSessionIdFromEvent(event);
            if (sessionId) newSessionId = sessionId;
            const normalized = normalizer.handle(event);
            if (normalized.agentText) {
              emittedAgentMessageText = true;
              lastAgentMessageText = normalized.agentText;
            }
            if (normalized.usage) {
              emittedUsage = true;
            }
          } catch {
            // Keep raw output for fallback.
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        rawStderr.push(chunk.toString('utf-8'));
      });

      proc.stdin.on('error', () => {
        // Process may exit before stdin flushes on early auth errors.
      });
      proc.stdin.write(prompt);
      proc.stdin.end();

      const onAbort = () => {
        try {
          if (!proc.killed) proc.kill('SIGTERM');
        } catch {
          // Process may already be gone.
        }
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });

      proc.on('error', (err) => {
        const errorClass = classifyRuntimeError(err);
        if (errorClass === 'cancelled') {
          resolveOnce({
            status: 'closed',
            result: null,
            error: runtimeErrorMessage(err),
            errorClass,
            newSessionId,
          });
          return;
        }
        resolveOnce({
          status: 'error',
          result: null,
          error: `Codex CLI 启动失败：${err.message}`,
          errorClass,
          newSessionId,
        });
      });

      proc.on('close', async (code) => {
        input.signal?.removeEventListener('abort', onAbort);
        const stderr = rawStderr.join('').trim();
        if (input.signal?.aborted) {
          resolveOnce({
            status: 'closed',
            result: null,
            error: 'Codex CLI run cancelled',
            errorClass: 'cancelled',
            newSessionId,
          });
          return;
        }
        if (code !== 0) {
          if (
            input.sessionId &&
            /resume|session|conversation|thread|not found|does not exist/i.test(
              stderr,
            )
          ) {
            emit({
              status: 'stream',
              result: null,
              streamEvent: {
                eventType: 'status',
                statusText: 'Codex resume 失败，正在用新会话重试...',
              },
            });
            const retryInput = buildResumeFailureRetryInput(
              input,
              'codex_resume_failed',
            );
            const retryResult = await codexCliAdapter.run(retryInput, emit);
            resolveOnce({
              ...retryResult,
              runtimeContext:
                retryResult.runtimeContext ||
                runtimeContextMetaFromRunInput(retryInput),
            });
            return;
          }
          const errorText = stderr || rawStdout.join('').trim() || 'Codex CLI failed';
          resolveOnce({
            status: 'error',
            result: errorText,
            error: stderr || `Codex CLI exited with code ${code}`,
            errorClass: classifyRuntimeError(errorText),
            newSessionId,
          });
          return;
        }

        let result = '';
        try {
          if (fs.existsSync(outputFile)) {
            result = fs.readFileSync(outputFile, 'utf-8').trim();
          }
        } catch {
          // Fall back to stdout below.
        }
        if (!result) result = lastAgentMessageText || rawStdout.join('').trim();
        if (result && !emittedAgentMessageText) {
          emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'text_delta',
              text: result,
            },
          });
        }
        if (!emittedUsage) {
          emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'usage',
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
                costUSD: 0,
                durationMs: Date.now() - startedAt,
                numTurns: 1,
              },
            },
          });
        }
        resolveOnce({
          status: 'success',
          result,
          newSessionId,
        });
      });
    });
  },
};
