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
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

// 路径解析：优先读取环境变量，降级到容器内默认路径（保持向后兼容）
const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';

// 模型配置：支持别名（opus/sonnet/haiku）或完整模型 ID
// 别名自动解析为最新版本，如 opus → Opus 4.6
const CLAUDE_MODEL = process.env.HAPPYCLAW_MODEL || 'opus';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  /** @deprecated Use isHome + isAdminHome instead. Kept for backward compatibility with older host processes. */
  isMain?: boolean;
  /** Whether this is the user's home container (admin or member). */
  isHome?: boolean;
  /** Whether this is the admin's home container (full privileges). */
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
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

// --- Streaming event types ---
// ⚠️ 与 src/types.ts (后端) 和 web/src/stores/chat.ts (前端) 保持同步
export type StreamEventType =
  | 'text_delta' | 'thinking_delta'
  | 'tool_use_start' | 'tool_use_end' | 'tool_progress'
  | 'hook_started' | 'hook_progress' | 'hook_response' // TODO: hook 事件尚未实现
  | 'status' | 'init'; // TODO: init 事件尚未实现

export interface StreamEvent {
  eventType: StreamEventType;
  text?: string;
  toolName?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  elapsedSeconds?: number;
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
  statusText?: string;
}

interface ContainerOutput {
  status: 'success' | 'error' | 'stream';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content:
      | string
      | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;
  };
  parent_tool_use_id: null;
  session_id: string;
}

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

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: Array<{ data: string; mimeType?: string }>): void {
    let content:
      | string
      | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;

    if (images && images.length > 0) {
      // 多模态消息：text + images
      content = [
        { type: 'text', text },
        ...images.map((img) => ({
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
 * 检测是否为上下文溢出错误
 */
function isContextOverflowError(msg: string): boolean {
  const patterns = [
    /prompt is too long/i,
    /maximum context length/i,
    /context.*too large/i,
    /exceeds.*token limit/i,
    /context window.*exceeded/i,
  ];
  return patterns.some(pattern => pattern.test(msg));
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

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
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
        } else if (data.type === 'agent_result') {
          // Sub-agent completed — format result as a message injection
          const statusLabel = data.status === 'completed' ? '已完成任务' : '执行出错';
          const promptSnippet = data.prompt ? data.prompt.slice(0, 200) : '';
          const lines = [
            `[子 Agent "${data.agentName || data.agentId}" ${statusLabel}]`,
            '',
            promptSnippet ? `任务: ${promptSnippet}` : '',
            '',
            '结果:',
            data.result || '(无结果)',
          ].filter(Boolean);
          messages.push({ text: lines.join('\n') });
        } else if (data.type === 'agent_message' && data.message) {
          // Message from main agent to sub-agent (via message_agent)
          messages.push({ text: `[来自主 Agent 的消息]\n${data.message}` });
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

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  memoryRecall: string,
  resumeAt?: string,
  emitOutput = true,
  allowedTools: string[] = DEFAULT_ALLOWED_TOOLS,
  disallowedTools?: string[],
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; contextOverflow?: boolean; interruptedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt, images);
  const emit = (output: ContainerOutput): void => {
    if (emitOutput) writeOutput(output);
  };

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
      stream.push(msg.text, msg.images);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  // 文本聚合缓冲区 - 流式事件批量发送
  let textBuf = '', thinkBuf = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let seenTextualResult = false;
  const FLUSH_MS = 100, FLUSH_CHARS = 200;
  // 完整文本累积器 - SDK 的 result.result 仅包含最后一个文本块，
  // 当 agent 在工具调用前后都有文本输出时，前面的文本会丢失。
  // 用此累积器拼接所有 text_delta，作为最终消息的完整内容。
  let fullTextAccumulator = '';

  function flushBuffers() {
    if (textBuf) {
      emit({ status: 'stream', result: null, streamEvent: { eventType: 'text_delta', text: textBuf } });
      textBuf = '';
    }
    if (thinkBuf) {
      emit({ status: 'stream', result: null, streamEvent: { eventType: 'thinking_delta', text: thinkBuf } });
      thinkBuf = '';
    }
    flushTimer = null;
  }

  function scheduleFlush() {
    if (textBuf.length >= FLUSH_CHARS || thinkBuf.length >= FLUSH_CHARS) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flushBuffers();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushBuffers, FLUSH_MS);
    }
  }

  function shorten(input: string, maxLen = 180): string {
    if (input.length <= maxLen) return input;
    return `${input.slice(0, maxLen)}...`;
  }

  function redactSensitive(input: unknown, depth = 0): unknown {
    if (depth > 3) return '[truncated]';
    if (input == null) return input;
    if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
      return input;
    }
    if (Array.isArray(input)) {
      return input.slice(0, 10).map((item) => redactSensitive(item, depth + 1));
    }
    if (typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (/(token|password|secret|api[_-]?key|authorization|cookie)/iu.test(k)) {
          out[k] = '[REDACTED]';
        } else {
          out[k] = redactSensitive(v, depth + 1);
        }
      }
      return out;
    }
    return '[unsupported]';
  }

  function summarizeToolInput(input: unknown): string | undefined {
    if (input == null) return undefined;

    if (typeof input === 'string') {
      return shorten(input.trim());
    }

    if (typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      const keyCandidates = ['command', 'query', 'path', 'pattern', 'prompt', 'url', 'name'];
      for (const key of keyCandidates) {
        const value = obj[key];
        if (typeof value === 'string' && value.trim()) {
          return `${key}: ${shorten(value.trim())}`;
        }
      }
      try {
        const json = JSON.stringify(redactSensitive(obj));
        // Skip empty or trivial objects (e.g. {} at content_block_start)
        if (!json || json === '{}' || json === '[]') return undefined;
        return shorten(json);
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  function extractSkillName(toolName: unknown, input: unknown): string | undefined {
    if (toolName !== 'Skill') return undefined;
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;
    const raw =
      (typeof obj.skillName === 'string' && obj.skillName) ||
      (typeof obj.skill === 'string' && obj.skill) ||
      (typeof obj.name === 'string' && obj.name) ||
      (typeof obj.command === 'string' && obj.command) ||
      '';
    if (!raw) return undefined;
    const matched = raw.match(/\/([A-Za-z0-9._-]+)/);
    if (matched && matched[1]) return matched[1];
    return raw.replace(/^\/+/, '').trim() || undefined;
  }

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

  const systemPromptAppend = [
    globalClaudeMd,
    memoryRecall,
    outputGuidelines,
    webFetchGuidelines,
  ].filter(Boolean).join('\n');

  // 追踪顶层工具执行状态（用于精确发送 tool_use_end）
  let activeTopLevelToolUseId: string | null = null;
  // 追踪活跃的 Skill 工具 ID：Skill 内部调用的工具可能没有 parent_tool_use_id，
  // 需要避免将它们误判为新的顶层工具而提前结束 Skill
  let activeSkillToolUseId: string | null = null;

  // 累积 Skill 工具的 input_json_delta 以提取 skillName
  // （content_block_start 时 input 为空，实际 JSON 通过 delta 到达）
  // 以 content block 索引（event.index）为 key，确保 delta 正确匹配到对应的 block
  const pendingSkillInput: Map<number, { toolUseId: string; inputJson: string; resolved: boolean; parentToolUseId: string | null; isNested: boolean }> = new Map();

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
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      includePartialMessages: true,
      mcpServers: {
        happyclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            HAPPYCLAW_CHAT_JID: containerInput.chatJid,
            HAPPYCLAW_GROUP_FOLDER: containerInput.groupFolder,
            HAPPYCLAW_IS_HOME: isHome ? '1' : '0',
            HAPPYCLAW_IS_ADMIN_HOME: isAdminHome ? '1' : '0',
            // Legacy compat: keep IS_MAIN for any external tools that may read it
            HAPPYCLAW_IS_MAIN: isAdminHome ? '1' : '0',
            HAPPYCLAW_WORKSPACE_GROUP: WORKSPACE_GROUP,
            HAPPYCLAW_WORKSPACE_GLOBAL: WORKSPACE_GLOBAL,
            HAPPYCLAW_WORKSPACE_MEMORY: WORKSPACE_MEMORY,
            HAPPYCLAW_WORKSPACE_IPC: WORKSPACE_IPC,
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(isHome, isAdminHome)] }]
      },
    }
  });
    queryRef = q;
    for await (const message of q) {
    // 流式事件处理
    if (message.type === 'stream_event') {
      const partial = message;
      const parentToolUseId =
        partial.parent_tool_use_id === undefined ? null : partial.parent_tool_use_id;
      const isNested = parentToolUseId !== null;

      const event = partial.event;
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          // 判断是否为 Skill 内部的工具调用：SDK 可能不设置 parent_tool_use_id，
          // 但如果当前有活跃的 Skill 且此工具不是 Skill 本身，则视为嵌套
          const isInsideSkill = !isNested && activeSkillToolUseId && block.name !== 'Skill';
          const effectiveIsNested = isNested || !!isInsideSkill;
          const effectiveParentToolUseId = isInsideSkill ? activeSkillToolUseId : parentToolUseId;

          if (!effectiveIsNested && activeTopLevelToolUseId && activeTopLevelToolUseId !== block.id) {
            emit({
              status: 'stream',
              result: null,
              streamEvent: { eventType: 'tool_use_end', toolUseId: activeTopLevelToolUseId },
            });
            // 如果被结束的是 Skill 工具，清除 Skill 追踪
            if (activeTopLevelToolUseId === activeSkillToolUseId) {
              activeSkillToolUseId = null;
            }
          }
          if (!effectiveIsNested) activeTopLevelToolUseId = block.id || null;

          emit({
            status: 'stream',
            result: null,
            streamEvent: {
              eventType: 'tool_use_start',
              toolName: block.name,
              toolUseId: block.id,
              parentToolUseId: effectiveParentToolUseId,
              isNested: effectiveIsNested,
              skillName: extractSkillName(block.name, block.input),
              toolInputSummary: summarizeToolInput(block.input),
            },
          });

          // 追踪 Skill 工具的 tool_use block — input 通过 delta 到达，start 时为空
          // 使用 event.index（content block 索引）确保 delta 正确匹配
          if (block.name === 'Skill' && block.id) {
            activeSkillToolUseId = block.id;
            const blockIndex = event.index;
            if (typeof blockIndex === 'number') {
              pendingSkillInput.set(blockIndex, {
                toolUseId: block.id,
                inputJson: '',
                resolved: false,
                parentToolUseId,
                isNested,
              });
            }
          }
        } else if (block?.type === 'text') {
          // 新的文本 block 开始意味着顶层工具已执行完毕
          if (activeTopLevelToolUseId) {
            emit({
              status: 'stream',
              result: null,
              streamEvent: { eventType: 'tool_use_end', toolUseId: activeTopLevelToolUseId },
            });
            activeTopLevelToolUseId = null;
            activeSkillToolUseId = null;
          }
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          textBuf += delta.text;
          fullTextAccumulator += delta.text;
          scheduleFlush();
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          thinkBuf += delta.thinking;
          scheduleFlush();
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          // 累积 Skill 工具的 input JSON，提取 skillName
          // 通过 content block 索引匹配，避免并行工具调用时的错误关联
          const blockIndex = event.index;
          if (typeof blockIndex === 'number') {
            const pending = pendingSkillInput.get(blockIndex);
            if (pending && !pending.resolved) {
              pending.inputJson += delta.partial_json;
              // 从累积的 JSON 中匹配 "skill":"value" 模式
              const skillMatch = pending.inputJson.match(/"skill"\s*:\s*"([^"]+)"/);
              if (skillMatch) {
                pending.resolved = true;
                pendingSkillInput.delete(blockIndex);
                emit({
                  status: 'stream',
                  result: null,
                  streamEvent: {
                    eventType: 'tool_progress',
                    toolName: 'Skill',
                    toolUseId: pending.toolUseId,
                    parentToolUseId: pending.parentToolUseId,
                    isNested: pending.isNested,
                    skillName: skillMatch[1],
                  },
                });
              }
            }
          }
        }
      }
      continue; // stream_event 不走后续处理
    }

    if (message.type === 'tool_progress') {
      const tp = message as any;
      const parentToolUseId =
        tp.parent_tool_use_id === undefined ? null : tp.parent_tool_use_id;
      emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'tool_progress',
          toolName: tp.tool_name,
          toolUseId: tp.tool_use_id,
          parentToolUseId,
          isNested: parentToolUseId !== null,
          elapsedSeconds: tp.elapsed_time_seconds,
        },
      });
      continue;
    }

    if (message.type === 'tool_use_summary') {
      const summary = message as any;
      const ids = Array.isArray(summary.preceding_tool_use_ids)
        ? summary.preceding_tool_use_ids.filter((id: unknown): id is string => typeof id === 'string')
        : [];
      for (const id of ids) {
        emit({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'tool_use_end', toolUseId: id },
        });
        if (activeTopLevelToolUseId === id) {
          activeTopLevelToolUseId = null;
        }
      }
      continue;
    }

    // Hook 事件
    if (message.type === 'system') {
      const sys = message as any;
      if (sys.subtype === 'status') {
        const statusText = sys.status?.type || null;
        emit({ status: 'stream', result: null, streamEvent: { eventType: 'status', statusText } });
        continue;
      }
      if (sys.subtype === 'hook_started') {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'hook_started',
            hookName: sys.hook_name,
            hookEvent: sys.hook_event,
          },
        });
        continue;
      }
      if (sys.subtype === 'hook_progress') {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'hook_progress',
            hookName: sys.hook_name,
            hookEvent: sys.hook_event,
          },
        });
        continue;
      }
      if (sys.subtype === 'hook_response') {
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'hook_response',
            hookName: sys.hook_name,
            hookEvent: sys.hook_event,
            hookOutcome: sys.outcome,
          },
        });
        continue;
      }
    }

    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      // 兜底：从完整的 assistant 消息中提取 skill 名称
      // 处理 input_json_delta 事件未到达的情况
      const assistantMsg = message as { message?: { content?: Array<{ type: string; name?: string; id?: string; input?: Record<string, unknown> }> } };
      const content = assistantMsg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Skill' && block.id && block.input) {
            const skillName = extractSkillName(block.name, block.input);
            if (skillName) {
              // 检查是否已通过 input_json_delta 解析过
              let alreadyResolved = false;
              for (const pending of pendingSkillInput.values()) {
                if (pending.toolUseId === block.id && pending.resolved) {
                  alreadyResolved = true;
                  break;
                }
              }
              if (!alreadyResolved) {
                emit({
                  status: 'stream',
                  result: null,
                  streamEvent: {
                    eventType: 'tool_progress',
                    toolName: 'Skill',
                    toolUseId: block.id,
                    skillName,
                  },
                });
              }
            }
          }
        }
      }
      // assistant 消息处理完毕，清空残留的 pendingSkillInput 避免内存泄漏
      pendingSkillInput.clear();
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      // Emit pending deltas before final textual result, then mark to avoid
      // emitting duplicated tail deltas in the post-loop cleanup flush.
      if (textResult) {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        flushBuffers();
        seenTextualResult = true;
      }
      // SDK 的 result.result 仅包含最后一个文本块。当 agent 在工具调用前后
      // 都有文本输出时，使用 fullTextAccumulator 作为完整内容。
      const effectiveResult = fullTextAccumulator.length > (textResult?.length || 0)
        ? fullTextAccumulator
        : textResult;
      emit({
        status: 'success',
        result: effectiveResult || null,
        newSessionId
      });
      // 重置累积器，为下一个 query 循环做准备
      fullTextAccumulator = '';
    }
  }

  // 清理：先取消 pending timer，再 flush 剩余缓冲区，最后清除残留工具状态
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (seenTextualResult) {
    // Textual result already emitted. Drop any buffered tail to avoid
    // stale stream residue in UI after message persistence.
    textBuf = '';
    thinkBuf = '';
  } else {
    flushBuffers();
  }
  if (activeTopLevelToolUseId) {
    emit({
      status: 'stream',
      result: null,
      streamEvent: { eventType: 'tool_use_end', toolUseId: activeTopLevelToolUseId },
    });
    activeTopLevelToolUseId = null;
    activeSkillToolUseId = null;
  }

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

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
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

  // Query loop: run query → wait for IPC message → run new query → repeat
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
        mcpServerPath,
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
          mcpServerPath,
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
