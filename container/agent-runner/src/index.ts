/**
 * HappyClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

import type {
  ContainerInput,
  ContainerOutput,
  SessionsIndex,
  SDKUserMessage,
  ParsedMessage,
} from './types.js';
export type { StreamEventType, StreamEvent } from './types.js';

import { sanitizeFilename, generateFallbackName } from './utils.js';
import { StreamEventProcessor } from './stream-processor.js';
import { PREDEFINED_AGENTS } from './agent-definitions.js';
import { createMcpTools } from './mcp-tools.js';

// 路径解析：优先读取环境变量，降级到容器内默认路径（保持向后兼容）
const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';

// 模型配置：支持别名（opus/sonnet/haiku）或完整模型 ID
// 别名自动解析为最新版本，如 opus → Opus 4.6
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'opus';

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

let needsMemoryFlush = false;

const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__happyclaw__*'
];

const MEMORY_FLUSH_ALLOWED_TOOLS = [
  'mcp__happyclaw__memory_search',
  'mcp__happyclaw__memory_get',
  'mcp__happyclaw__memory_append',
  'Read',  // 读取全局 CLAUDE.md 当前内容
  'Edit',  // 编辑全局 CLAUDE.md（永久记忆）
];

// Memory flush 期间禁用的工具（disallowedTools 会从模型上下文中完全移除这些工具）
// 注意：allowedTools 仅控制自动审批，不限制工具可见性；
//       bypassPermissions 模式下所有工具都自动通过，所以必须用 disallowedTools 来限制
const MEMORY_FLUSH_DISALLOWED_TOOLS = [
  'Bash', 'Write', 'WebSearch', 'WebFetch', 'Glob', 'Grep',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
  'mcp__happyclaw__send_message',
  'mcp__happyclaw__schedule_task',
  'mcp__happyclaw__list_tasks',
  'mcp__happyclaw__pause_task',
  'mcp__happyclaw__resume_task',
  'mcp__happyclaw__cancel_task',
  'mcp__happyclaw__register_group',
];

const IMAGE_MAX_DIMENSION = 8000; // Anthropic API 限制

/**
 * 从 base64 编码的图片数据中提取宽高（支持 PNG / JPEG / GIF / WebP / BMP）。
 * 仅解析头部字节，不需要完整解码图片。
 * 返回 null 表示无法识别格式。
 */
function getImageDimensions(base64Data: string): { width: number; height: number } | null {
  try {
    const headerB64 = base64Data.slice(0, 400);
    const buf = Buffer.from(headerB64, 'base64');

    // PNG: 固定位置 (bytes 16-23)
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // JPEG: 扫描 SOF marker（SOF 可能在大 EXIF/ICC 之后，需要 ~30KB）
    if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      const JPEG_SCAN_B64_LEN = 40000; // ~30KB binary，覆盖大多数 EXIF/ICC 场景
      const fullHeader = Buffer.from(base64Data.slice(0, JPEG_SCAN_B64_LEN), 'base64');
      for (let i = 2; i < fullHeader.length - 9; i++) {
        if (fullHeader[i] !== 0xFF) continue;
        const marker = fullHeader[i + 1];
        if (marker >= 0xC0 && marker <= 0xC3) {
          return { width: fullHeader.readUInt16BE(i + 7), height: fullHeader.readUInt16BE(i + 5) };
        }
        if (marker !== 0xD8 && marker !== 0xD9 && marker !== 0x00) {
          i += 1 + fullHeader.readUInt16BE(i + 2);
        }
      }
    }

    // GIF: bytes 6-9 (little-endian)
    if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    // BMP: bytes 18-25
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }

    // WebP
    if (buf.length >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
      if (fourCC === 'VP8L' && buf.length >= 25) { const b = buf.readUInt32LE(21); return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 }; }
      if (fourCC === 'VP8X' && buf.length >= 30) return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
    }

    return null;
  } catch { return null; }
}

/**
 * 过滤超过 API 尺寸限制的图片。
 */
function filterOversizedImages(
  images: Array<{ data: string; mimeType?: string }>,
): { valid: Array<{ data: string; mimeType?: string }>; rejected: string[] } {
  const valid: Array<{ data: string; mimeType?: string }> = [];
  const rejected: string[] = [];
  for (const img of images) {
    const dims = getImageDimensions(img.data);
    if (dims && (dims.width > IMAGE_MAX_DIMENSION || dims.height > IMAGE_MAX_DIMENSION)) {
      const reason = `图片尺寸 ${dims.width}×${dims.height} 超过 API 限制（最大 ${IMAGE_MAX_DIMENSION}px），已跳过`;
      log(reason);
      rejected.push(reason);
    } else {
      valid.push(img);
    }
  }
  return { valid, rejected };
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: Array<{ data: string; mimeType?: string }>): string[] {
    const rejectedReasons: string[] = [];
    let filteredImages = images;

    // 过滤超限图片，在发送给 SDK 之前拦截
    if (filteredImages && filteredImages.length > 0) {
      const { valid, rejected } = filterOversizedImages(filteredImages);
      rejectedReasons.push(...rejected);
      filteredImages = valid.length > 0 ? valid : undefined;
    }

    let content:
      | string
      | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;

    if (filteredImages && filteredImages.length > 0) {
      // 多模态消息：text + images
      content = [
        { type: 'text', text },
        ...filteredImages.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mimeType || 'image/png',
            data: img.data,
          },
        })),
      ];
    } else {
      // 纯文本消息
      content = text;
    }

    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
    return rejectedReasons;
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Normalize isMain/isHome/isAdminHome flags for backward compatibility.
 * If the host sends the old `isMain` field, treat it as isHome=true + isAdminHome=true.
 */
function normalizeHomeFlags(input: ContainerInput): { isHome: boolean; isAdminHome: boolean } {
  if (input.isHome !== undefined) {
    return { isHome: !!input.isHome, isAdminHome: !!input.isAdminHome };
  }
  // Legacy: isMain was the only flag
  const legacy = !!input.isMain;
  return { isHome: legacy, isAdminHome: legacy };
}

/**
 * 检测是否为上下文溢出错误
 */
function isContextOverflowError(msg: string): boolean {
  const patterns: RegExp[] = [
    /prompt is too long/i,
    /maximum context length/i,
    /context.*too large/i,
    /exceeds.*token limit/i,
    /context window.*exceeded/i,
  ];
  return patterns.some(pattern => pattern.test(msg));
}

/**
 * 检测会话转录中不可恢复的请求错误（400 invalid_request_error）。
 * 这类错误被固化在会话历史中，每次 resume 都会重放导致永久失败。
 * 例如：图片尺寸超过 8000px 限制、消息格式非法等。
 *
 * 判定条件：必须同时满足「图片特征」+「API 拒绝」，避免对通用 400 错误误判导致会话丢失。
 */
function isUnrecoverableTranscriptError(msg: string): boolean {
  const isImageSizeError =
    /image.*dimensions?\s+exceed/i.test(msg) ||
    /max\s+allowed\s+size.*pixels/i.test(msg);
  const isApiReject = /invalid_request_error/i.test(msg);
  return isImageSizeError && isApiReject;
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(_isHome: boolean, isAdminHome: boolean): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Flag memory flush for admin home container (full memory write access)
    if (isAdminHome) {
      needsMemoryFlush = true;
      log('PreCompact: flagged memory flush for admin home container');
    }

    return {};
  };
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'HappyClaw';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

const IPC_INPUT_INTERRUPT_SENTINEL = path.join(IPC_INPUT_DIR, '_interrupt');

/**
 * Check for _interrupt sentinel (graceful query interruption).
 */
function shouldInterrupt(): boolean {
  if (fs.existsSync(IPC_INPUT_INTERRUPT_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found (with optional images), or empty array.
 */
function drainIpcInput(): Array<{ text: string; images?: Array<{ data: string; mimeType?: string }> }> {
  try {
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: Array<{ text: string; images?: Array<{ data: string; mimeType?: string }> }> = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({
            text: data.text,
            images: data.images,
          });
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages (with optional images), or null if _close.
 */
function waitForIpcMessage(): Promise<{ text: string; images?: Array<{ data: string; mimeType?: string }> } | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        // 合并多条消息的文本和图片
        const combinedText = messages.map((m) => m.text).join('\n');
        const allImages = messages.flatMap((m) => m.images || []);
        resolve({ text: combinedText, images: allImages.length > 0 ? allImages : undefined });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function buildMemoryRecallPrompt(isHome: boolean, isAdminHome: boolean): string {
  if (isHome) {
    // Home container (admin or member): full memory system with read/write access to user's global CLAUDE.md
    return [
      '',
      '## 记忆系统',
      '',
      '你拥有跨会话的持久记忆能力，请积极使用。',
      '',
      '### 回忆',
      '在回答关于过去的工作、决策、日期、偏好或待办事项之前：',
      '先用 `memory_search` 搜索，再用 `memory_get` 获取完整上下文。',
      '',
      '### 存储——两层记忆架构',
      '',
      '获知重要信息后**必须立即保存**，不要等到上下文压缩。',
      '根据信息的**时效性**选择存储位置：',
      '',
      '#### 全局记忆（永久）→ 直接编辑 `/workspace/global/CLAUDE.md`',
      '',
      '**优先使用全局记忆。** 适用于所有**跨会话仍然有用**的信息：',
      '- 用户身份：姓名、生日、联系方式、地址、工作单位',
      '- 长期偏好：沟通风格、称呼方式、喜好厌恶、技术栈偏好',
      '- 身份配置：你的名字、角色设定、行为准则',
      '- 常用项目与上下文：反复提到的仓库、服务、架构信息',
      '- 用户明确要求「记住」的任何内容',
      '',
      '使用 `Read` 工具读取当前内容，再用 `Edit` 工具**原地更新对应字段**。',
      '文件中标记「待记录」的字段发现信息后**必须立即填写**。',
      '不要追加重复信息，保持文件简洁有序。',
      '',
      '#### 日期记忆（时效性）→ 调用 `memory_append`',
      '',
      '适用于**过一段时间会过时**的信息：',
      '- 项目进展：今天做了什么、决定了什么、遇到了什么问题',
      '- 临时技术决策：选型理由、架构方案、变更记录',
      '- 待办与承诺：约定事项、截止日期、后续跟进',
      '- 会议/讨论要点：关键结论、行动项',
      '',
      '`memory_append` 自动保存到独立的记忆目录（不在工作区内）。',
      '',
      '#### 判断标准',
      '> **默认优先全局记忆。** 问自己：这条信息下次对话还可能用到吗？',
      '> - 是 / 可能 → **全局记忆**（编辑 `/workspace/global/CLAUDE.md`）',
      '> - 明确只跟今天有关 → 日期记忆（`memory_append`）',
      '> - 用户说「记住这个」→ **一定写全局记忆**',
      '',
      '系统也会在上下文压缩前提示你保存记忆。',
    ].join('\n');
  }
  // Non-home group container
  return [
    '',
    '## 记忆',
    '',
    '可使用 `memory_search` 和 `memory_get` 工具搜索记忆文件。',
    '获知重要信息（项目决策、待办、讨论要点等）时，**必须立即**调用 `memory_append` 保存。',
    '不要等待——获知后立刻存储。',
    '全局记忆（`/workspace/global/CLAUDE.md`）为只读，无法直接修改。',
  ].join('\n');
}

/** 从 settings.json 读取用户配置的 MCP servers（stdio/http/sse 类型） */
function loadUserMcpServers(): Record<string, unknown> {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    || path.join(process.env.HOME || '/home/node', '.claude');
  const settingsFile = path.join(configDir, 'settings.json');
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (settings.mcpServers && typeof settings.mcpServers === 'object') {
        return settings.mcpServers;
      }
    }
  } catch { /* ignore parse errors */ }
  return {};
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerConfig: ReturnType<typeof createSdkMcpServer>,
  containerInput: ContainerInput,
  memoryRecall: string,
  resumeAt?: string,
  emitOutput = true,
  allowedTools: string[] = DEFAULT_ALLOWED_TOOLS,
  disallowedTools?: string[],
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; contextOverflow?: boolean; unrecoverableTranscriptError?: boolean; interruptedDuringQuery: boolean }> {
  const stream = new MessageStream();
  const initialRejected = stream.push(prompt, images);
  const emit = (output: ContainerOutput): void => {
    if (emitOutput) writeOutput(output);
  };

  // 如果有图片被拒绝，立即通知用户
  for (const reason of initialRejected) {
    emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId: undefined });
  }

  // Poll IPC for follow-up messages and _close/_interrupt sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let interruptedDuringQuery = false;
  // queryRef is set just before the for-await loop so pollIpcDuringQuery can call interrupt()
  let queryRef: { interrupt(): Promise<void> } | null = null;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    if (shouldInterrupt()) {
      log('Interrupt sentinel detected, interrupting current query');
      interruptedDuringQuery = true;
      queryRef?.interrupt().catch((err: unknown) => log(`Interrupt call failed: ${err}`));
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const msg of messages) {
      log(`Piping IPC message into active query (${msg.text.length} chars, ${msg.images?.length || 0} images)`);
      const rejected = stream.push(msg.text, msg.images);
      for (const reason of rejected) {
        emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId: undefined });
      }
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  // Create the StreamEventProcessor
  const processor = new StreamEventProcessor(emit, log);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Build system prompt: memory recall guidance + global CLAUDE.md (for non-admin-home)
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
  const globalClaudeMdPath = path.join(WORKSPACE_GLOBAL, 'CLAUDE.md');

  // Always inject global CLAUDE.md content into system prompt so the agent
  // has memory context from the start. Home containers also get filesystem
  // read/write access via additionalDirectories for editing.
  let globalClaudeMd = '';
  if (fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }
  const outputGuidelines = [
    '',
    '## 输出格式',
    '',
    '### 图片引用',
    '当你生成了图片文件并需要在回复中展示时，使用 Markdown 图片语法引用**相对路径**（相对于当前工作目录）：',
    '`![描述](filename.png)`',
    '',
    '**禁止使用绝对路径**（如 `/workspace/group/filename.png`）。Web 界面会自动将相对路径解析为正确的文件下载地址。',
    '',
    '### 技术图表',
    '需要输出技术图表（流程图、时序图、架构图、ER 图、类图、状态图、甘特图等）时，**使用 Mermaid 语法**，用 ```mermaid 代码块包裹。',
    'Web 界面会自动将 Mermaid 代码渲染为可视化图表。',
  ].join('\n');

  const webFetchGuidelines = [
    '',
    '## 网页访问策略',
    '',
    '访问外部网页时优先使用 WebFetch（速度快）。',
    '如果 WebFetch 失败（403、被拦截、内容为空或需要 JavaScript 渲染），',
    '且 agent-browser 可用，立即改用 agent-browser 通过真实浏览器访问。不要反复重试 WebFetch。',
  ].join('\n');

  // Read HEARTBEAT.md (recent work summary) for context injection
  let heartbeatContent = '';
  const heartbeatPath = path.join(WORKSPACE_GLOBAL, 'HEARTBEAT.md');
  if (fs.existsSync(heartbeatPath)) {
    try {
      const raw = fs.readFileSync(heartbeatPath, 'utf-8');
      heartbeatContent = raw.length > 4096 ? raw.slice(0, 4096) + '\n\n[...截断]' : raw;
    } catch { /* skip */ }
  }

  const systemPromptAppend = [
    globalClaudeMd,
    heartbeatContent,
    memoryRecall,
    outputGuidelines,
    webFetchGuidelines,
  ].filter(Boolean).join('\n');

  // Home containers (admin & member) can access global and memory directories
  // Non-home containers only access memory (global CLAUDE.md injected via systemPromptAppend)
  const extraDirs = isHome
    ? [WORKSPACE_GLOBAL, WORKSPACE_MEMORY]
    : [WORKSPACE_MEMORY];

  try {
    const q = query({
    prompt: stream,
    options: {
      model: CLAUDE_MODEL,
      cwd: WORKSPACE_GROUP,
      additionalDirectories: extraDirs,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend },
      allowedTools,
      ...(disallowedTools && { disallowedTools }),
      maxThinkingTokens: 16384,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      includePartialMessages: true,
      mcpServers: {
        ...loadUserMcpServers(),     // 用户配置的 MCP（stdio/http/sse），SDK 原生支持
        happyclaw: mcpServerConfig,  // 内置 SDK MCP 放最后，确保不被同名覆盖
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(isHome, isAdminHome)] }]
      },
      agents: PREDEFINED_AGENTS,
    }
  });
    queryRef = q;
    for await (const message of q) {
    // 流式事件处理
    if (message.type === 'stream_event') {
      processor.processStreamEvent(message as any);
      continue;
    }

    if (message.type === 'tool_progress') {
      processor.processToolProgress(message as any);
      continue;
    }

    if (message.type === 'tool_use_summary') {
      processor.processToolUseSummary(message as any);
      continue;
    }

    // Hook 事件
    if (message.type === 'system') {
      const sys = message as any;
      if (processor.processSystemMessage(sys)) {
        continue;
      }
    }

    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    const msgParentToolUseId = (message as any).parent_tool_use_id ?? null;
    // 诊断：对所有 assistant/user 消息打印 parent_tool_use_id 和内容块类型
    if (message.type === 'assistant' || message.type === 'user') {
      const rawParent = (message as any).parent_tool_use_id;
      const contentTypes = (Array.isArray((message as any).message?.content)
        ? ((message as any).message.content as Array<{ type: string }>).map(b => b.type).join(',')
        : typeof (message as any).message?.content === 'string' ? 'string' : 'none');
      log(`[msg #${messageCount}] type=${msgType} parent_tool_use_id=${rawParent === undefined ? 'UNDEFINED' : rawParent === null ? 'NULL' : rawParent} content_types=[${contentTypes}] keys=[${Object.keys(message).join(',')}]`);
    } else {
      log(`[msg #${messageCount}] type=${msgType}${msgParentToolUseId ? ` parent=${msgParentToolUseId.slice(0, 12)}` : ''}`);
    }

    // ── 子 Agent 消息转 StreamEvent ──
    processor.processSubAgentMessage(message as any);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      processor.processAssistantMessage(message as any);
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as unknown as { task_id: string; status: string; summary: string };
      processor.processTaskNotification(tn);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

      // SDK 将某些 API 错误包装为 subtype=success 的 result（不抛异常）
      if (textResult && isContextOverflowError(textResult)) {
        log(`Context overflow detected in result: ${textResult.slice(0, 100)}`);
        processor.resetFullTextAccumulator();
        return { newSessionId, lastAssistantUuid, closedDuringQuery, contextOverflow: true, interruptedDuringQuery };
      }
      if (textResult && isUnrecoverableTranscriptError(textResult)) {
        log(`Unrecoverable transcript error in result: ${textResult.slice(0, 200)}`);
        processor.resetFullTextAccumulator();
        return { newSessionId, lastAssistantUuid, closedDuringQuery, unrecoverableTranscriptError: true, interruptedDuringQuery };
      }

      const { effectiveResult } = processor.processResult(textResult);
      emit({
        status: 'success',
        result: effectiveResult,
        newSessionId
      });
    }
  }

  // Cleanup residual state
  processor.cleanup();

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, interruptedDuringQuery: ${interruptedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery };
  } catch (err) {
    ipcPolling = false;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // 检测上下文溢出错误
    if (isContextOverflowError(errorMessage)) {
      log(`Context overflow detected: ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, contextOverflow: true, interruptedDuringQuery };
    }

    // 检测不可恢复的转录错误
    if (isUnrecoverableTranscriptError(errorMessage)) {
      log(`Unrecoverable transcript error: ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, unrecoverableTranscriptError: true, interruptedDuringQuery };
    }

    // 其他错误继续抛出
    throw err;
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

  // Create in-process SDK MCP server (replaces the stdio subprocess)
  const mcpTools = createMcpTools({
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isHome,
    isAdminHome,
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
    workspaceGlobal: WORKSPACE_GLOBAL,
    workspaceMemory: WORKSPACE_MEMORY,
  });
  const mcpServerConfig = createSdkMcpServer({
    name: 'happyclaw',
    version: '1.0.0',
    tools: mcpTools,
  });
  const memoryRecallPrompt = buildMemoryRecallPrompt(isHome, isAdminHome);
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale sentinels from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  if (containerInput.isScheduledTask) {
    prompt = `[定时任务 - 以下内容由系统自动发送，并非来自用户或群组的直接消息。]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.map((m) => m.text).join('\n');
    const pendingImages = pending.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  let resumeAt: string | undefined;
  let overflowRetryCount = 0;
  const MAX_OVERFLOW_RETRIES = 3;
  try {
    while (true) {
      // 清理残留的 _interrupt sentinel，防止空闲期间写入的中断信号影响下一次 query
      try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }

      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerConfig,
        containerInput,
        memoryRecallPrompt,
        resumeAt,
        true,
        DEFAULT_ALLOWED_TOOLS,
        undefined,
        promptImages,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // 不可恢复的转录错误（如超大图片绕过预检后被固化在会话历史中）
      if (queryResult.unrecoverableTranscriptError) {
        const errorMsg = '会话历史中包含无法处理的数据（如超大图片），会话需要重置。';
        log(`Unrecoverable transcript error, signaling session reset`);
        writeOutput({
          status: 'error',
          result: null,
          error: `unrecoverable_transcript: ${errorMsg}`,
          newSessionId: sessionId,
        });
        process.exit(1);
      }

      // 检查上下文溢出
      if (queryResult.contextOverflow) {
        overflowRetryCount++;
        log(`Context overflow detected, retry ${overflowRetryCount}/${MAX_OVERFLOW_RETRIES}`);

        if (overflowRetryCount >= MAX_OVERFLOW_RETRIES) {
          const errorMsg = `上下文溢出错误：已重试 ${MAX_OVERFLOW_RETRIES} 次仍失败。请联系管理员检查 CLAUDE.md 大小或减少会话历史。`;
          log(errorMsg);
          writeOutput({
            status: 'error',
            result: null,
            error: `context_overflow: ${errorMsg}`,
            newSessionId: sessionId,
          });
          process.exit(1);
        }

        // 未超过重试次数，等待后继续下一轮循环（会触发自动压缩）
        log('Retrying query after context overflow (will trigger auto-compaction)...');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // 成功执行后重置溢出重试计数器
      overflowRetryCount = 0;

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        // Notify host that this exit was due to _close, not a normal completion.
        // Without this marker the host treats the exit as silent success and
        // commits the message cursor, causing the in-flight IM message to be
        // consumed without a reply (the "swallowed message" bug).
        writeOutput({ status: 'closed', result: null });
        break;
      }

      // 中断后：跳过 memory flush 和 session update，等待下一条消息
      if (queryResult.interruptedDuringQuery) {
        log('Query interrupted by user, waiting for next message');
        writeOutput({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'status', statusText: 'interrupted' },
        });
        // 清理可能残留的 _interrupt 文件
        try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }
        // 不 break，等待下一条消息
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received after interrupt, exiting');
          break;
        }
        prompt = nextMessage.text;
        promptImages = nextMessage.images;
        continue;
      }

      // Memory Flush: run an extra query to let agent save durable memories (admin home only)
      if (needsMemoryFlush && isAdminHome) {
        needsMemoryFlush = false;
        log('Running memory flush query after compaction...');

        const today = new Date().toISOString().split('T')[0];
        const flushPrompt = [
          '上下文压缩前记忆刷新。',
          '**优先检查全局记忆**：先 Read /workspace/global/CLAUDE.md，如果有「待记录」字段且你已获知对应信息（用户身份、偏好、常用项目等），用 Edit 工具立即填写。',
          '用户明确要求记住的内容，以及下次对话仍可能用到的信息，也写入全局记忆。',
          `然后使用 memory_append 将时效性记忆保存到 memory/${today}.md（今日进展、临时决策、待办等）。`,
          '如需确认上下文，可先用 memory_search/memory_get 查阅。',
          '如果没有值得保存的内容，回复一个字：OK。',
        ].join(' ');

        const flushResult = await runQuery(
          flushPrompt,
          sessionId,
          mcpServerConfig,
          containerInput,
          memoryRecallPrompt,
          resumeAt,
          false,
          MEMORY_FLUSH_ALLOWED_TOOLS,
          MEMORY_FLUSH_DISALLOWED_TOOLS,
        );
        if (flushResult.newSessionId) sessionId = flushResult.newSessionId;
        if (flushResult.lastAssistantUuid) resumeAt = flushResult.lastAssistantUuid;
        log('Memory flush completed');

        if (flushResult.closedDuringQuery) {
          log('Close sentinel during memory flush, exiting');
          writeOutput({ status: 'closed', result: null });
          break;
        }
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.text.length} chars, ${nextMessage.images?.length || 0} images), starting new query`);
      prompt = nextMessage.text;
      promptImages = nextMessage.images;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`Agent error stack: ${err.stack}`);
    }
    // 不在 error output 中携带 sessionId：
    // 流式输出已通过 onOutput 回调传递了有效的 session 更新。
    // 如果这里携带的是 throw 前的旧 sessionId，会覆盖中间成功产生的新 session。
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
