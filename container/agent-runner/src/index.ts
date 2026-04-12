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
import { detectImageMimeTypeFromBase64Strict } from './image-detector.js';
import { getChannelFromJid } from './channel-prefixes.js';

import type {
  ContainerInput,
  ContainerOutput,
  ImageMediaType,
  SessionsIndex,
  SDKUserMessage,
  ParsedMessage,
  StreamEvent,
} from './types.js';
export type { StreamEventType, StreamEvent } from './types.js';

import { sanitizeFilename, generateFallbackName } from './utils.js';
import {
  extractSessionHistory as extractSessionHistoryImpl,
  parseTranscript,
} from './session-history.js';
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
// [1m] 后缀启用 1M 上下文窗口（CLI 内部 jG() 识别后缀，sM() 返回 1M 窗口）
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'opus[1m]';

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_FALLBACK_POLL_MS = 5000; // 后备轮询间隔（仅防止 inotify 事件丢失）


let needsMemoryFlush = false;
let hadCompaction = false;
// Module-level session ID so SIGTERM handler can emit it before exit.
// Updated in main() whenever a query returns a new session.
let latestSessionId: string | undefined;

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

// ── 系统提示词优化：安全守则（从独立 Markdown 文件加载，始终注入所有容器） ──

const SECURITY_RULES_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'prompts',
  'security-rules.md',
);
const SECURITY_RULES = fs.readFileSync(SECURITY_RULES_PATH, 'utf-8');

// HEARTBEAT.md 截断上限（仅作用于 fresh session 的近期工作提示）
const HEARTBEAT_MAX_CHARS = 2048;

const OUTPUT_GUIDELINES = [
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

const INTERACTION_GUIDELINES = [
  '',
  '## 交互原则',
  '',
  '**始终专注于用户当前的实际消息。**',
  '',
  '- 你可能拥有多种 MCP 工具和 Skills，这些是你的辅助能力，**不是用户发送的内容**。',
  '- **不要主动介绍、列举或描述你的可用工具**，除非用户明确询问「你能做什么」或「你有什么功能」。',
  '- 当用户需要某个功能时，直接使用对应工具完成任务即可，无需事先解释工具的存在。',
  '- 如果用户的消息很简短（如打招呼），简洁回应即可，不要用工具列表填充回复。',
].join('\n');

const SKILL_ROUTING_GUIDELINES = [
  '',
  '## 技能路由',
  '',
  '响应前检查 <system-reminder> 中列出的已安装 skills，将用户意图与 skill description 做匹配：',
  '- 有明确匹配 → 使用 Skill 工具调用',
  '- 不确定是否匹配 → 用 ToolSearch 搜索确认',
  '- 无匹配 → 使用基础工具或直接回答',
].join('\n');

const WEB_FETCH_GUIDELINES = [
  '',
  '## 网页访问策略',
  '',
  '访问外部网页时优先使用 WebFetch（速度快）。',
  '如果 WebFetch 失败（403、被拦截、内容为空或需要 JavaScript 渲染），',
  '且 agent-browser 可用，立即改用 agent-browser 通过真实浏览器访问。不要反复重试 WebFetch。',
].join('\n');

const BACKGROUND_TASK_GUIDELINES = [
  '',
  '## 后台任务',
  '',
  '当用户要求执行耗时较长的批量任务（如批量文件处理、大规模数据操作等），',
  '你应该使用 Task 工具并设置 `run_in_background: true`，让任务在后台运行。',
  '这样用户无需等待，可以继续与你交流其他事项。',
  '任务结束时你会自动收到通知，届时在对话中向用户汇报即可。',
  '告知用户：「已为您在后台启动该任务，完成后我会第一时间反馈。现在有其他问题也可以随时问我。」',
  '',
  '### 任务通知处理（重要）',
  '',
  '当你收到多条后台任务的完成或失败通知时：',
  '- **禁止逐条回复**。不要对每条通知都调用 `send_message`，这会导致 IM 群刷屏。',
  '- **等待所有通知到齐后，汇总为一条消息回复用户**，例如：「N 个任务完成，M 个失败，失败原因：...」',
  '- 对于已知的无害失败（如浏览器进程被回收、临时资源超时），**不需要通知用户**，静默忽略即可。',
].join('\n');

const GUIDELINES_BLOCK = `<guidelines>\n${OUTPUT_GUIDELINES}\n${WEB_FETCH_GUIDELINES}\n${BACKGROUND_TASK_GUIDELINES}\n</guidelines>`;

const CONVERSATION_AGENT_GUIDELINES = [
  '',
  '## 子会话行为规则（最高优先级，覆盖其他冲突指令）',
  '',
  '你正在一个**子会话**中运行，不是主会话。以下规则覆盖全局记忆中的"响应行为准则"：',
  '',
  '1. **不要用 `send_message` 发送"收到"之类的确认消息** — 你的正常文本输出就是回复，不需要额外发消息',
  '2. **每次回复只产生一条消息** — 把分析、结论、建议整合到一条回复中，不要拆成多条',
  '3. **只在以下情况使用 `send_message`**：',
  '   - 执行超过 2 分钟的长任务时，发送一次进度更新（不是确认收到）',
  '   - 用户明确要求你"先回复一下"时',
  '4. **你的正常文本输出会自动发送给用户**，不需要通过 `send_message` 转发',
  '5. **回复语言使用简体中文**，除非用户用其他语言提问',
].join('\n');

const CONVERSATION_AGENT_BLOCK = `<agent-override>\n${CONVERSATION_AGENT_GUIDELINES}\n</agent-override>`;

const CHANNEL_GUIDELINES: Record<string, string> = {
  feishu: [
    '## 飞书消息格式',
    '',
    '当前消息来自飞书。飞书卡片支持的 Markdown：**加粗**、_斜体_、`行内代码`、代码块、标题、列表、链接。',
    '用户同时可以在 Web 端查看你的回复，Web 端支持完整 Markdown + Mermaid 图表渲染，因此**不要因为来源是飞书就限制输出格式**。',
    '可使用 `send_image` 和 `send_file` 工具直接发送文件到飞书。',
  ].join('\n'),
  telegram: [
    '## Telegram 消息格式',
    '',
    '当前消息来自 Telegram。Markdown 自动转换为 Telegram HTML，长消息自动分片（3800 字符）。',
    '用户同时可以在 Web 端查看你的回复，Web 端支持完整 Markdown + Mermaid 图表渲染，因此**不要因为来源是 Telegram 就限制输出格式**。',
    '可使用 `send_image` 和 `send_file` 工具直接发送文件到 Telegram。',
  ].join('\n'),
  qq: [
    '## QQ 消息格式',
    '',
    '当前消息来自 QQ。Markdown 自动转换为纯文本，长消息自动分片（5000 字符）。',
    '用户同时可以在 Web 端查看你的回复，Web 端支持完整 Markdown + Mermaid 图表渲染，因此**不要因为来源是 QQ 就限制输出格式**。',
  ].join('\n'),
};

/**
 * 规范化图片 MIME：
 * - 优先使用声明值（若合法且与内容一致）
 * - 若声明缺失或与内容不一致，使用内容识别值
 * - 最后兜底 image/jpeg
 */
function resolveImageMimeType(img: { data: string; mimeType?: string }): ImageMediaType {
  const declared =
    typeof img.mimeType === 'string' && img.mimeType.startsWith('image/')
      ? img.mimeType.toLowerCase()
      : undefined;
  const detected = detectImageMimeTypeFromBase64Strict(img.data);

  if (declared && detected && declared !== detected) {
    log(`Image MIME mismatch: declared=${declared}, detected=${detected}, using detected`);
    return detected as ImageMediaType;
  }

  return (declared || detected || 'image/jpeg') as ImageMediaType;
}

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
    // stream.done=true 后禁止写入已关闭的 SDK transport，否则触发 "ProcessTransport is not ready for writing"
    if (this.done) {
      return ['Stream already ended, message will be processed in the next query'];
    }

    const rejectedReasons: string[] = [];
    let filteredImages = images;

    if (filteredImages && filteredImages.length > 0) {
      const { valid, rejected } = filterOversizedImages(filteredImages);
      rejectedReasons.push(...rejected);
      filteredImages = valid.length > 0 ? valid : undefined;
    }

    let content:
      | string
      | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }>;

    if (filteredImages && filteredImages.length > 0) {
      // 多模态消息：text + images
      content = [
        { type: 'text', text },
        ...filteredImages.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: resolveImageMimeType(img),
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

  get ended(): boolean {
    return this.done;
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

function generateTurnId(): string {
  return `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
 * 例如：图片尺寸超过 8000px 限制、图片 MIME 声明与真实内容不一致等。
 *
 * 判定条件：必须同时满足「图片特征」+「API 拒绝」，避免对通用 400 错误误判导致会话丢失。
 */
function isImageMimeMismatchError(msg: string): boolean {
  return (
    /image\s+was\s+specified\s+using\s+the\s+image\/[a-z0-9.+-]+\s+media\s+type,\s+but\s+the\s+image\s+appears\s+to\s+be\s+(?:an?\s+)?image\/[a-z0-9.+-]+\s+image/i.test(msg) ||
    /image\/[a-z0-9.+-]+\s+media\s+type.*appears\s+to\s+be.*image\/[a-z0-9.+-]+/i.test(msg)
  );
}

function isUnrecoverableTranscriptError(msg: string): boolean {
  const isImageSizeError =
    /image.*dimensions?\s+exceed/i.test(msg) ||
    /max\s+allowed\s+size.*pixels/i.test(msg);
  const isMimeMismatch = isImageMimeMismatchError(msg);
  const isApiReject = /invalid_request_error/i.test(msg);
  return isApiReject && (isImageSizeError || isMimeMismatch);
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
 * Trim session JSONL file by removing all entries before the last compact_boundary.
 * After compaction, entries before the boundary are already summarized and no longer
 * needed for session reconstruction. This prevents unbounded file growth.
 *
 * Safety: uses atomic write (tmp + rename) to avoid data loss on crash.
 */
function trimSessionJsonl(jsonlPath: string): void {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n');
    const nonEmptyLines: { index: number; line: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) nonEmptyLines.push({ index: i, line: lines[i] });
    }

    // Find the last compact_boundary entry
    let lastBoundaryPos = -1;
    let parseSkipped = 0;
    for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(nonEmptyLines[i].line);
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          lastBoundaryPos = i;
          break;
        }
      } catch {
        parseSkipped++;
      }
    }
    if (parseSkipped > 0) {
      log(`Session trim: skipped ${parseSkipped} unparseable JSONL lines`);
    }

    if (lastBoundaryPos <= 0) {
      // No boundary found or it's already the first entry — nothing to trim
      log('Session trim: no compact_boundary found or already minimal');
      return;
    }

    // Keep entries from last compact_boundary onwards
    const trimmedLines = nonEmptyLines.slice(lastBoundaryPos).map(e => e.line);
    const removedCount = lastBoundaryPos;

    const TRIM_MIN_ENTRIES = 50; // Skip trimming if fewer entries before boundary (not worth the I/O)
    if (removedCount < TRIM_MIN_ENTRIES) {
      log(`Session trim: only ${removedCount} entries before boundary, skipping`);
      return;
    }

    // Atomic write: temp file + rename
    const tmpPath = jsonlPath + '.trim-tmp';
    fs.writeFileSync(tmpPath, trimmedLines.join('\n') + '\n');
    fs.renameSync(tmpPath, jsonlPath);

    const sizeBefore = Buffer.byteLength(content, 'utf-8');
    const sizeAfter = fs.statSync(jsonlPath).size;
    log(`Session trim: ${nonEmptyLines.length} → ${trimmedLines.length} entries (removed ${removedCount}), ` +
        `${(sizeBefore / 1024 / 1024).toFixed(1)}MB → ${(sizeAfter / 1024 / 1024).toFixed(1)}MB`);
  } catch (err) {
    log(`Session trim failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Archive the full transcript to conversations/ before compaction.
 * Also flush any accumulated streaming text as a compact_partial message
 * so users don't lose the response that was being generated.
 * Finally, trim the JSONL file to remove already-compacted history.
 */
function createPreCompactHook(
  isHome: boolean,
  _isAdminHome: boolean,
  deps: { emit: (output: ContainerOutput) => void; getFullText: () => string; resetFullText: () => void },
): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    // Skip sub-agent compactions — they'd archive the unchanged main transcript
    // and set hadCompaction, triggering spurious auto-continue + memory flush (#321)
    if (preCompact.agent_id) {
      log(`PreCompact: skipping sub-agent compact (agent_id=${preCompact.agent_id})`);
      return {};
    }

    // ── Flush accumulated streaming text as compact_partial ──
    // This ensures users see the partial response even after compaction.
    const partialText = deps.getFullText();
    if (partialText.trim()) {
      log(`PreCompact: flushing ${partialText.length} chars as compact_partial`);
      deps.emit({
        status: 'success',
        result: partialText,
        sourceKind: 'compact_partial',
        finalizationReason: 'completed',
      });
      deps.resetFullText();
    }

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

    // ── Trim session JSONL to prevent unbounded growth ──
    // Remove entries before the last compact_boundary (already summarized).
    // Must run AFTER archiving (archive needs full transcript).
    trimSessionJsonl(transcriptPath);

    // Flag compaction so the query loop auto-continues instead of
    // waiting for user input (non-blocking compaction #229).
    hadCompaction = true;

    // Flag memory flush for home containers (full memory write access)
    if (isHome) {
      needsMemoryFlush = true;
      log('PreCompact: flagged memory flush for home container');
    }

    return {};
  };
}

/**
 * Wrapper around the pure extractSessionHistory implementation in
 * session-history.ts. Resolves the SDK transcript directory using the
 * runtime CLAUDE_CONFIG_DIR + WORKSPACE_GROUP layout, then delegates.
 */
function extractSessionHistory(oldSessionId: string): string | null {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || '/home/node', '.claude');
  // SDK stores transcripts at: <configDir>/projects/<encoded-cwd>/<sessionId>.jsonl
  // where encoded-cwd replaces '/' with '-'
  const encodedCwd = WORKSPACE_GROUP.replace(/\//g, '-');
  const transcriptDir = path.join(configDir, 'projects', encodedCwd);
  return extractSessionHistoryImpl({
    transcriptDir,
    sessionId: oldSessionId,
    log,
  });
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

const IPC_INPUT_DRAIN_SENTINEL = path.join(IPC_INPUT_DIR, '_drain');

const IPC_INPUT_INTERRUPT_SENTINEL = path.join(IPC_INPUT_DIR, '_interrupt');
const INTERRUPT_GRACE_WINDOW_MS = 10_000;
let lastInterruptRequestedAt = 0;

function markInterruptRequested(): void {
  lastInterruptRequestedAt = Date.now();
}

function clearInterruptRequested(): void {
  lastInterruptRequestedAt = 0;
}

function isWithinInterruptGraceWindow(): boolean {
  return lastInterruptRequestedAt > 0 && Date.now() - lastInterruptRequestedAt <= INTERRUPT_GRACE_WINDOW_MS;
}

function isInterruptRelatedError(err: unknown): boolean {
  const errno = err as NodeJS.ErrnoException;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return errno?.code === 'ABORT_ERR'
    || /abort|aborted|interrupt|interrupted|cancelled|canceled/i.test(message);
}

/**
 * Check for _interrupt sentinel (graceful query interruption).
 */
function shouldInterrupt(): boolean {
  if (fs.existsSync(IPC_INPUT_INTERRUPT_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }
    markInterruptRequested();
    return true;
  }
  return false;
}

function cleanupStartupInterruptSentinel(): void {
  try {
    const stat = fs.statSync(IPC_INPUT_INTERRUPT_SENTINEL);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs <= INTERRUPT_GRACE_WINDOW_MS) {
      log(`Preserving recent interrupt sentinel at startup (${Math.round(ageMs)}ms old)`);
      return;
    }
    fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL);
    log(`Removed stale interrupt sentinel at startup (${Math.round(ageMs)}ms old)`);
  } catch {
    /* ignore */
  }
}

/**
 * Check for _drain sentinel (finish current query then exit).
 * Unlike _close which exits from idle wait, _drain is checked after
 * a query completes to implement one-question-one-answer semantics.
 */
function shouldDrain(): boolean {
  if (fs.existsSync(IPC_INPUT_DRAIN_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_DRAIN_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found (with optional images), or empty array.
 */
interface IpcDrainResult {
  messages: Array<{ text: string; images?: Array<{ data: string; mimeType?: string }> }>;
}

function drainIpcInput(): IpcDrainResult {
  const result: IpcDrainResult = { messages: [] };
  try {
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          result.messages.push({
            text: data.text,
            images: data.images,
          });
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

/**
 * Create a fs.watch() based IPC watcher for event-driven file detection.
 * Falls back to periodic polling every IPC_FALLBACK_POLL_MS.
 */
function createIpcWatcher(onFileDetected: () => void): { close: () => void } {
  let watcher: fs.FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const debouncedDetect = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onFileDetected();
    }, 50);
  };

  // Ensure IPC_INPUT_DIR exists
  try { fs.mkdirSync(IPC_INPUT_DIR, { recursive: true }); } catch {}

  try {
    // Listen to all event types — 'rename' covers atomic writes on Linux,
    // but Docker bind mounts (macOS virtiofs) may emit 'change' instead.
    watcher = fs.watch(IPC_INPUT_DIR, () => {
      debouncedDetect();
    });
    watcher.on('error', (err) => {
      log(`IPC watcher error: ${err.message}, degrading to ${IPC_FALLBACK_POLL_MS}ms fallback polling`);
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    log(`Failed to create IPC watcher: ${err instanceof Error ? err.message : String(err)}, using fallback polling`);
  }

  // Fallback polling for reliability
  fallbackTimer = setInterval(() => {
    if (!closed) onFileDetected();
  }, IPC_FALLBACK_POLL_MS);
  fallbackTimer.unref();  // Don't prevent process from naturally exiting

  return {
    close() {
      closed = true;
      watcher?.close();
      watcher = null;
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    },
  };
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages (with optional images), or null if _close.
 */
function waitForIpcMessage(): Promise<{ text: string; images?: Array<{ data: string; mimeType?: string }> } | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const tryDrain = () => {
      if (resolved) return;

      if (shouldClose()) {
        resolved = true;
        ipcWatcher?.close();
        resolve(null);
        return;
      }

      if (shouldDrain()) {
        log('Drain sentinel received, exiting after completed query');
        resolved = true;
        ipcWatcher?.close();
        resolve(null);
        return;
      }

      if (shouldInterrupt()) {
        log('Interrupt sentinel received while idle, ignoring');
        clearInterruptRequested();
      }

      const { messages } = drainIpcInput();

      if (messages.length > 0) {
        const combinedText = messages.map((m) => m.text).join('\n');
        const allImages = messages.flatMap((m) => m.images || []);
        resolved = true;
        ipcWatcher?.close();
        resolve({ text: combinedText, images: allImages.length > 0 ? allImages : undefined });
        return;
      }
    };

    const ipcWatcher = createIpcWatcher(tryDrain);
    // Initial check in case files already exist
    tryDrain();
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
  // Non-home group container: read-only access to home memory, use Claude auto memory
  return [
    '',
    '## 记忆',
    '',
    '### 查询主工作区记忆',
    '可使用 `memory_search` 和 `memory_get` 工具搜索主工作区的记忆（全局记忆和日期记忆）。',
    '需要回忆过去的决策、偏好或项目上下文时使用这些工具。',
    '',
    '### 本地记忆',
    '重要信息直接记录在当前工作区的 CLAUDE.md 或其他文件中。',
    'Claude 会自动维护你的会话记忆，无需额外操作。',
    '',
    '全局记忆（`/workspace/global/CLAUDE.md`）为只读参考。',
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
  sourceKindOverride?: ContainerOutput['sourceKind'],
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; contextOverflow?: boolean; unrecoverableTranscriptError?: boolean; interruptedDuringQuery: boolean; sessionResumeFailed?: boolean }> {
  const stream = new MessageStream();
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let canonicalAssistantText: string | undefined;
  let canonicalAssistantUuid: string | undefined;
  const initialRejected = stream.push(prompt, images);
  const decorateStreamEvent = (event: StreamEvent): StreamEvent => ({
    ...event,
    turnId: containerInput.turnId,
    sessionId: newSessionId || sessionId,
  });
  const emit = (output: ContainerOutput): void => {
    if (output.streamEvent) {
      output = {
        ...output,
        streamEvent: decorateStreamEvent(output.streamEvent),
        turnId: containerInput.turnId,
        sessionId: newSessionId || sessionId,
      };
    } else if (output.status === 'success' || output.status === 'error') {
      output = {
        ...output,
        turnId: containerInput.turnId,
        sessionId: newSessionId || sessionId,
      };
    }
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
  let suppressOutputAfterInterrupt = false;
  let visibleOutputStarted = false;
  // After a result is received, allow a short window for the host to write _drain
  // before force-closing the stream.
  let resultReceivedAt: number | null = null;
  const POST_RESULT_TIMEOUT_MS = 5_000;
  // queryRef is set just before the for-await loop so pollIpcDuringQuery can call interrupt()
  let queryRef: { interrupt(): Promise<void> } | null = null;
  let messageCount = 0;
  let resultCount = 0;

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;

    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }
    if (shouldInterrupt()) {
      log('Interrupt sentinel detected, interrupting current query');
      interruptedDuringQuery = true;
      if (!visibleOutputStarted && resultCount === 0) {
        suppressOutputAfterInterrupt = true;
        log('Interrupt arrived before visible output, suppressing query output');
      }
      lastInterruptRequestedAt = Date.now();
      queryRef?.interrupt().catch((err: unknown) => log(`Interrupt call failed: ${err}`));
      stream.end();
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }
    // _drain: finish current query then exit. Once a result has been received,
    // the query is logically done but the MessageStream keeps the SDK alive.
    // Treat drain as close at this point to release the container.
    if (resultCount > 0 && shouldDrain()) {
      log('Drain sentinel detected after query result, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }
    // ── 结果后超时：result 已收到，给 host 短暂时间写 _drain ──
    // 注意：不设置 closedDuringQuery — 这只是 stream 清理，不是退出信号。
    // 主循环会继续进入 waitForIpcMessage()，等待 _close/_drain 才退出。
    // 这保证了终端预热等场景下容器不会在查询完成后立即退出。
    if (resultReceivedAt && Date.now() - resultReceivedAt > POST_RESULT_TIMEOUT_MS) {
      log(`Post-result timeout (${POST_RESULT_TIMEOUT_MS / 1000}s), closing stream`);
      stream.end();
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }
    // Side-queries (emitOutput=false, e.g. memory flush / CLAUDE.md update) must NOT
    // consume user IPC messages — those belong to the main query loop. Only sentinels
    // are checked above. Without this guard, a user message arriving during a side-query
    // gets silently consumed, leaving queryInFlight=true on the host forever (bug #259).
    if (!emitOutput) {
      return; // No setTimeout needed — watcher will trigger next check on file change
    }

    // 预防性 invariant：当前所有 stream.end() 路径（sentinel handlers / interrupt-before-query
    // / immediate-interrupt）都在同一同步 tick 把 ipcPolling=false，理论上 !ipcPolling 早退
    // 已覆盖 stream.ended=true 的情况；此守护保留作为未来重构时的 invariant 断言，
    // 避免后续改动引入"流已关闭但 polling 未停"的竞态窗口（消息会被 drain 后又被 stream.push 拒绝丢失）。
    if (stream.ended) {
      log('Stream already ended, skipping IPC drain (messages will be picked up by waitForIpcMessage)');
      ipcPolling = false;
      ipcQueryWatcher.close();
      return;
    }

    const { messages } = drainIpcInput();
    for (const msg of messages) {
      log(`Piping IPC message into active query (${msg.text.length} chars, ${msg.images?.length || 0} images)`);
      const rejected = stream.push(msg.text, msg.images);
      for (const reason of rejected) {
        emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId: undefined });
      }
    }
    // No setTimeout needed — watcher will trigger next check on file change
  };

  const ipcQueryWatcher = createIpcWatcher(() => {
    if (!ipcPolling) return;
    pollIpcDuringQuery();
  });
  // Initial drain to process any pre-existing files
  pollIpcDuringQuery();

  const processor = new StreamEventProcessor(emit, log);

  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

  // Resumed sessions carry prior history — skip re-injecting HEARTBEAT.md to save cache tokens.
  let heartbeatContent = '';
  if (isHome && !sessionId) {
    const heartbeatPath = path.join(WORKSPACE_GLOBAL, 'HEARTBEAT.md');
    if (fs.existsSync(heartbeatPath)) {
      try {
        const raw = fs.readFileSync(heartbeatPath, 'utf-8');
        const truncated = raw.length > HEARTBEAT_MAX_CHARS
          ? raw.slice(0, HEARTBEAT_MAX_CHARS) + '\n\n[...截断]'
          : raw;
        heartbeatContent = [
          '',
          '## 近期工作参考（仅供背景了解）',
          '',
          '> 以下是系统自动生成的近期工作摘要，仅供参考。',
          '> **不要主动继续这些工作**，除非用户明确要求「继续」或主动提到相关话题。',
          '> 请专注于用户当前的消息。',
          '',
          truncated,
        ].join('\n');
      } catch { /* skip */ }
    }
  }

  const channel = getChannelFromJid(containerInput.chatJid);
  const channelGuidelines = CHANNEL_GUIDELINES[channel] ?? '';

  // SDK settingSources 只加载 ~/.claude/CLAUDE.md 本体，不递归加载 rules/；
  // 容器模式下 $HOME 指向会话目录，宿主机 CLAUDE.md 也读不到。因此 guidelines 必须 inline 注入。
  const systemPromptAppend = [
    `<behavior>\n${INTERACTION_GUIDELINES}\n</behavior>`,
    `<skill-routing>\n${SKILL_ROUTING_GUIDELINES}\n</skill-routing>`,
    `<security>\n${SECURITY_RULES}\n</security>`,
    `<memory-system>\n${memoryRecall}\n</memory-system>`,
    heartbeatContent && `<recent-work>\n${heartbeatContent}\n</recent-work>`,
    GUIDELINES_BLOCK,
    channelGuidelines && `<channel-format>\n${channelGuidelines}\n</channel-format>`,
    containerInput.agentId && CONVERSATION_AGENT_BLOCK,
  ].filter(Boolean).join('\n');

  // Home containers (admin & member) can access global and memory directories.
  // Non-home containers only access memory directory; global CLAUDE.md is NOT
  // injected into systemPrompt but remains accessible via filesystem (readonly mount).
  const extraDirs = isHome
    ? [WORKSPACE_GLOBAL, WORKSPACE_MEMORY]
    : [WORKSPACE_MEMORY];

  if (shouldInterrupt()) {
    log('Interrupt sentinel detected before query start, skipping query');
    interruptedDuringQuery = true;
    suppressOutputAfterInterrupt = true;
    ipcPolling = false;
    stream.end();
    return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery };
  }

  // SystemSettings.autoCompactWindow（通过 AUTO_COMPACT_WINDOW 环境变量注入）
  // 0 = SDK 默认（约 1M）；>0 = 通过 settings flag-layer 提前触发对话压缩
  const autoCompactWindow = parseInt(process.env.AUTO_COMPACT_WINDOW ?? '0', 10);
  const flagSettings: Record<string, unknown> = {};
  if (Number.isFinite(autoCompactWindow) && autoCompactWindow > 0) {
    flagSettings.autoCompactWindow = autoCompactWindow;
  }

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
      thinking: { type: 'adaptive' as const },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      agentProgressSummaries: true,
      settingSources: ['project', 'user'],
      includePartialMessages: true,
      ...(Object.keys(flagSettings).length > 0 ? { settings: flagSettings as any } : {}),
      mcpServers: {
        ...loadUserMcpServers(),     // 用户配置的 MCP（stdio/http/sse），SDK 原生支持
        happyclaw: mcpServerConfig,  // 内置 SDK MCP 放最后，确保不被同名覆盖
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(isHome, isAdminHome, {
          emit,
          getFullText: () => processor.getFullText(),
          resetFullText: () => processor.resetFullTextAccumulator(),
        })] }]
      },
      agents: PREDEFINED_AGENTS,
    }
  });
    queryRef = q;
    if (shouldInterrupt()) {
      log('Interrupt sentinel already present when query started, interrupting immediately');
      interruptedDuringQuery = true;
      if (!visibleOutputStarted && resultCount === 0) {
        suppressOutputAfterInterrupt = true;
      }
      queryRef.interrupt().catch((err: unknown) => log(`Immediate interrupt call failed: ${err}`));
      stream.end();
      ipcPolling = false;
    }
    for await (const message of q) {
    // 流式事件处理
    if (message.type === 'stream_event') {
      if (!suppressOutputAfterInterrupt) {
        visibleOutputStarted = true;
      }
      if (suppressOutputAfterInterrupt) {
        continue;
      }
      processor.processStreamEvent(message as any);
      continue;
    }

    if (message.type === 'tool_progress') {
      if (!suppressOutputAfterInterrupt) {
        visibleOutputStarted = true;
      }
      if (suppressOutputAfterInterrupt) {
        continue;
      }
      processor.processToolProgress(message as any);
      continue;
    }

    if (message.type === 'tool_use_summary') {
      if (!suppressOutputAfterInterrupt) {
        visibleOutputStarted = true;
      }
      if (suppressOutputAfterInterrupt) {
        continue;
      }
      processor.processToolUseSummary(message as any);
      continue;
    }

    // Rate limit event — notify user and keep activity alive
    if (message.type === 'rate_limit_event') {
      const info = (message as any).rate_limit_info;
      if (info?.status === 'rejected') {
        const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : '未知';
        processor.emitStatus(`API 限流中，预计 ${resetsAt} 恢复`);
      } else if (info?.status === 'allowed_warning') {
        processor.emitStatus(`接近 API 限流阈值`);
      }
      continue;
    }

    // System messages
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

    if (message.type !== 'system') {
      visibleOutputStarted = true;
    }
    if (suppressOutputAfterInterrupt && message.type !== 'system') {
      if (message.type === 'result') {
        resultCount++;
        resultReceivedAt = Date.now();
      }
      log(`[msg #${messageCount}] suppressed after early interrupt`);
      continue;
    }

    // ── 子 Agent 消息转 StreamEvent ──
    processor.processSubAgentMessage(message as any);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      const assistantMsg = message as Record<string, unknown>;
      if ((assistantMsg.parent_tool_use_id ?? null) === null) {
        const msgContent = (assistantMsg.message as Record<string, unknown> | undefined)?.content;
        const topLevelText = Array.isArray(msgContent)
          ? (msgContent as Array<{ type: string; text?: string }>)
              .filter((block) => block.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text!)
              .join('')
          : '';
        if (topLevelText) {
          canonicalAssistantText = topLevelText;
          canonicalAssistantUuid = assistantMsg.uuid as string;
        }
      }
      processor.processAssistantMessage(message as any);
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);

      // Log skills and context usage for observability.
      // getContextUsage() is a newer SDK API; feature-detect to avoid spamming
      // error logs on older SDK versions where the method is absent.
      const getCtxUsage = (q as unknown as { getContextUsage?: () => Promise<{
        skills?: { includedSkills: number; totalSkills: number; tokens: number };
        totalTokens: number;
        maxTokens: number;
        percentage: number;
      }> }).getContextUsage;
      if (typeof getCtxUsage === 'function') {
        try {
          const ctxUsage = await getCtxUsage.call(q);
          if (ctxUsage.skills) {
            log(`Skills: ${ctxUsage.skills.includedSkills}/${ctxUsage.skills.totalSkills} loaded, ${ctxUsage.skills.tokens} tokens`);
          }
          log(`Context: ${ctxUsage.totalTokens}/${ctxUsage.maxTokens} tokens (${ctxUsage.percentage.toFixed(1)}%)`);
        } catch (ctxErr) {
          log(`[debug] getContextUsage failed: ${ctxErr instanceof Error ? ctxErr.message : String(ctxErr)}`);
        }
      }
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as unknown as { task_id: string; tool_use_id?: string; status: string; summary: string };
      processor.processTaskNotification(tn);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const resultSubtype = message.subtype;
      log(`Result #${resultCount}: subtype=${resultSubtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

      // SDK 在某些失败场景会返回 error_* subtype 且不抛异常。
      // 不能把这类结果当 success(null)，否则前端会一直停留在"思考中"。
      // 匹配策略：显式枚举已知的 error subtype，并用 startsWith('error') 兜底未知的未来 error subtype。
      // 参考 SDK result subtype 约定：error_during_execution、error_max_turns 等均以 'error' 开头。
      if (typeof resultSubtype === 'string' && (resultSubtype === 'error_during_execution' || resultSubtype.startsWith('error'))) {
        // If session never initialized (no system/init), resume itself failed — report it
        // so the caller can retry with a fresh session instead of crashing.
        if (!newSessionId) {
          log(`Session resume failed (no init): ${resultSubtype}`);
          return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery, sessionResumeFailed: true };
        }
        const detail = textResult?.trim()
          ? textResult.trim()
          : `Claude Code execution failed (${resultSubtype})`;
        throw new Error(detail);
      }

      // SDK 将某些 API 错误包装为 subtype=success 的 result（不抛异常）
      if (textResult && isContextOverflowError(textResult)) {
        log(`Context overflow detected in result: ${textResult.slice(0, 100)}`);
        // ── 发射已累积的部分回复，避免用户已看到的流式内容丢失 ──
        const partialText = processor.getFullText();
        if (partialText.trim()) {
          log(`Emitting overflow_partial with ${partialText.length} chars`);
          emit({
            status: 'success',
            result: partialText,
            newSessionId,
            sourceKind: 'overflow_partial',
            finalizationReason: 'error',
          });
        }
        processor.resetFullTextAccumulator();
        return { newSessionId, lastAssistantUuid, closedDuringQuery, contextOverflow: true, interruptedDuringQuery };
      }
      if (textResult && isUnrecoverableTranscriptError(textResult)) {
        log(`Unrecoverable transcript error in result: ${textResult.slice(0, 200)}`);
        processor.resetFullTextAccumulator();
        return { newSessionId, lastAssistantUuid, closedDuringQuery, unrecoverableTranscriptError: true, interruptedDuringQuery };
      }

      const { effectiveResult } = processor.processResult(textResult);
      const finalText = canonicalAssistantText || effectiveResult;
      emit({
        status: 'success',
        result: finalText,
        newSessionId,
        sdkMessageUuid: canonicalAssistantUuid || lastAssistantUuid,
        sourceKind: sourceKindOverride ?? 'sdk_final',
        finalizationReason: 'completed',
      });
      // After emitting an sdk_final result, rotate turnId so that if
      // another result is emitted within the same query (e.g. user sent
      // a follow-up via IPC mid-query), it won't overwrite this one (#214).
      containerInput.turnId = generateTurnId();

      // Emit usage stream event with token counts and cost
      const resultMsg = message as Record<string, unknown>;
      const sdkUsage = resultMsg.usage as Record<string, number> | undefined;
      const sdkModelUsage = resultMsg.modelUsage as Record<string, Record<string, number>> | undefined;
      if (sdkUsage) {
        const modelUsageSummary: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }> = {};
        if (sdkModelUsage && Object.keys(sdkModelUsage).length > 0) {
          for (const [model, mu] of Object.entries(sdkModelUsage)) {
            modelUsageSummary[model] = {
              inputTokens: mu.inputTokens || 0,
              outputTokens: mu.outputTokens || 0,
              cacheReadInputTokens: mu.cacheReadInputTokens || 0,
              cacheCreationInputTokens: mu.cacheCreationInputTokens || 0,
              costUSD: mu.costUSD || 0,
            };
          }
        } else {
          // Fallback: use session-level model name when SDK doesn't provide per-model breakdown
          modelUsageSummary[CLAUDE_MODEL] = {
            inputTokens: sdkUsage.input_tokens || 0,
            outputTokens: sdkUsage.output_tokens || 0,
            cacheReadInputTokens: sdkUsage.cache_read_input_tokens || 0,
            cacheCreationInputTokens: sdkUsage.cache_creation_input_tokens || 0,
            costUSD: (resultMsg.total_cost_usd as number) || 0,
          };
        }
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'usage',
            usage: {
              inputTokens: sdkUsage.input_tokens || 0,
              outputTokens: sdkUsage.output_tokens || 0,
              cacheReadInputTokens: sdkUsage.cache_read_input_tokens || 0,
              cacheCreationInputTokens: sdkUsage.cache_creation_input_tokens || 0,
              costUSD: (resultMsg.total_cost_usd as number) || 0,
              durationMs: (resultMsg.duration_ms as number) || 0,
              numTurns: (resultMsg.num_turns as number) || 0,
              modelUsage: Object.keys(modelUsageSummary).length > 0 ? modelUsageSummary : undefined,
            },
          },
        });
        log(`Usage: input=${sdkUsage.input_tokens} output=${sdkUsage.output_tokens} cost=$${resultMsg.total_cost_usd} turns=${resultMsg.num_turns}`);
      }

      // ── 标记结果已收到 ──
      // pollIpcDuringQuery 会在 POST_RESULT_TIMEOUT_MS 后关闭 stream，
      // 期间仍可检测 _drain/_close/_interrupt sentinel。
      resultReceivedAt = Date.now();
    }
  }

  // Cleanup residual state
  processor.cleanup();

  ipcPolling = false;
  ipcQueryWatcher.close();
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, interruptedDuringQuery: ${interruptedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery };
  } catch (err) {
    ipcPolling = false;
    ipcQueryWatcher.close();
    const errorMessage = err instanceof Error ? err.message : String(err);

    // 检测上下文溢出错误
    if (isContextOverflowError(errorMessage)) {
      log(`Context overflow detected: ${errorMessage}`);
      // ── 发射已累积的部分回复，避免用户已看到的流式内容丢失 ──
      const partialText = processor.getFullText();
      if (partialText.trim()) {
        log(`Emitting overflow_partial (catch) with ${partialText.length} chars`);
        emit({
          status: 'success',
          result: partialText,
          newSessionId,
          sourceKind: 'overflow_partial',
          finalizationReason: 'error',
        });
      }
      return { newSessionId, lastAssistantUuid, closedDuringQuery, contextOverflow: true, interruptedDuringQuery };
    }

    // 检测不可恢复的转录错误
    if (isUnrecoverableTranscriptError(errorMessage)) {
      log(`Unrecoverable transcript error: ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, unrecoverableTranscriptError: true, interruptedDuringQuery };
    }

    // 中断导致的 SDK 错误（error_during_execution 等）：正常返回，不抛出
    if (interruptedDuringQuery) {
      log(`runQuery error during interrupt (non-fatal): ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery };
    }

    // SDK 在 yield result 后可能再抛异常（如检测到 result text 含错误内容），
    // 但此时 success 结果已通过 emit() 发送给调用方。再 re-throw 会导致
    // 外层 catch 额外发射一条 error output 并 exit(1)，引发无意义的重试。
    // 如果已成功发射过结果，将后续 SDK 异常降级为警告。
    if (resultCount > 0) {
      log(`runQuery post-result SDK error (non-fatal, ${resultCount} result(s) already emitted): ${errorMessage}`);
      if (err instanceof Error && err.stack) {
        log(`runQuery post-result error stack:\n${err.stack}`);
      }
      return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery };
    }

    // 其他错误：记录完整堆栈后继续抛出
    log(`runQuery error [${(err as NodeJS.ErrnoException).code ?? 'unknown'}]: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`runQuery error stack:\n${err.stack}`);
    }
    // 继续抛出
    throw err;
  }
}

/**
 * process.exit() with SIGKILL safety net.
 * When SDK has pending async resources (background Task tools, MCP connections),
 * process.exit() may hang indefinitely. Force SIGKILL after 5 seconds.
 * See GitHub issue #236.
 *
 * The timer must NOT use .unref() — if process.exit() silently fails to
 * terminate (observed with SDK MCP transports holding the event loop),
 * an unref'd timer won't keep the loop alive and the SIGKILL never fires.
 * Using a ref'd timer guarantees the safety net triggers.
 */
function forceExitWithSafetyNet(code: number): never {
  log(`Exiting with code ${code}, SIGKILL safety net in 5s`);
  setTimeout(() => {
    console.error('[agent-runner] process.exit() did not terminate, forcing SIGKILL');
    process.kill(process.pid, 'SIGKILL');
  }, 5000);
  process.exit(code);
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
  latestSessionId = sessionId;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

  // Create in-process SDK MCP server (replaces the stdio subprocess)
  const mcpToolsConfig = {
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isHome,
    isAdminHome,
    isScheduledTask: containerInput.isScheduledTask || false,
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
    workspaceGlobal: WORKSPACE_GLOBAL,
    workspaceMemory: WORKSPACE_MEMORY,
  };
  const buildMcpServerConfig = () => createSdkMcpServer({
    name: 'happyclaw',
    version: '1.0.0',
    tools: createMcpTools(mcpToolsConfig),
  });
  let mcpServerConfig = buildMcpServerConfig();
  const memoryRecallPrompt = buildMemoryRecallPrompt(isHome, isAdminHome);
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale sentinels from previous container runs.
  // Note: _drain is NOT cleaned here — the host's cleanupIpcSentinels() in
  // runForGroup's finally block already removes stale sentinels between runs.
  // A _drain present at startup was written by registerProcess() for the
  // CURRENT run (indicating pending messages arrived during container boot).
  // Deleting it here causes those messages to be silently lost (#xxx).
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  cleanupStartupInterruptSentinel();

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  if (containerInput.isScheduledTask) {
    const scheduledTaskPrefixLines = [
      '[定时任务 - 以下内容由系统自动发送，并非来自用户或群组的直接消息。]',
      '',
      '重要：你正在定时任务模式下运行。你的最终输出不会自动发送给用户。你必须使用 mcp__happyclaw__send_message 工具来发送消息，否则用户将收不到任何内容。',
      '',
      '注意：只在完成任务后调用一次 send_message 发送最终结果，不要发送中间状态或重复消息。',
    ];
    const scheduledTaskPrefix = scheduledTaskPrefixLines.join('\n');
    prompt = scheduledTaskPrefix + '\n\n' + prompt;
  }
  const pendingDrain = drainIpcInput();
  if (pendingDrain.messages.length > 0) {
    log(`Draining ${pendingDrain.messages.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pendingDrain.messages.map((m) => m.text).join('\n');
    const pendingImages = pendingDrain.messages.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  let resumeAt: string | undefined;
  let overflowRetryCount = 0;
  const MAX_OVERFLOW_RETRIES = 3;
  let consecutiveCompactions = 0;
  const MAX_CONSECUTIVE_COMPACTIONS = 3;
  // 暂存的会话历史上下文：当 auto-continue 阶段发生 sessionResumeFailed 时，
  // 历史无法直接拼到 auto-continue prompt（因为 fall-through 等下一条 IPC 消息后才重启 query），
  // 需要在下一轮主循环 query 之前消费它，避免新会话完全丢失上下文。
  let pendingHistoryContext: string | null = null;
  try {
    while (true) {
      // 清理残留的 _interrupt sentinel（空闲期间写入的中断信号不应影响下一次 query）。
      // 注意：_drain 不在此处清理 — 如果 _drain 存在，说明有待处理的消息，
      // pollIpcDuringQuery 会在查询结果后检测到并正确退出容器。
      try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }
      clearInterruptRequested();

      // 消费 auto-continue 阶段暂存的 history context（如果存在）。
      // 对应 sessionResumeFailed 在 auto-continue 路径上的镜像处理：
      // 此时 sessionId 已被清空，pendingHistoryContext 是从旧 JSONL 转录中
      // 提取的最近对话历史，需在 fresh session 启动前注入到 prompt 前面。
      if (pendingHistoryContext) {
        prompt = pendingHistoryContext + prompt;
        log('Injected pending session history context (from auto-continue resume failure) into prompt');
        pendingHistoryContext = null;
      }

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
        latestSessionId = sessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // Session resume 失败（SDK 无法恢复旧会话）：清除 session，以新会话重试
      // 同时从旧会话的 JSONL 转录中提取最近对话历史，注入到 prompt 中，
      // 避免新会话完全丢失上下文（类似 recoveryGroups 机制）。
      if (queryResult.sessionResumeFailed) {
        log(`Session resume failed, retrying with fresh session (old: ${sessionId})`);
        // Extract recent history from the old session transcript before clearing
        if (sessionId) {
          const historyContext = extractSessionHistory(sessionId);
          if (historyContext) {
            prompt = historyContext + prompt;
            log(`Injected session history context into prompt for fresh session retry`);
          }
        }
        sessionId = undefined;
        latestSessionId = undefined;
        resumeAt = undefined;
        consecutiveCompactions = 0;
        // Rebuild MCP server to avoid "Already connected to a transport" error
        mcpServerConfig = buildMcpServerConfig();
        continue;
      }

      // 不可恢复的转录错误（如超大图片或 MIME 错配被固化在会话历史中）
      if (queryResult.unrecoverableTranscriptError) {
        const errorMsg = '会话历史中包含无法处理的数据（如超大图片或图片 MIME 错配），会话需要重置。';
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
        // 中断后清除 resumeAt：被中断的 assistant 消息可能未完整提交到 session 历史。
        // 使用 undefined 让 SDK 自行选择恢复点，避免因指向不完整消息的 UUID 导致 resume 失败。
        resumeAt = undefined;
        writeOutput({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'status', statusText: 'interrupted' },
          newSessionId: sessionId,  // 确保主进程持久化 session ID
        });
        // 清理可能残留的 _interrupt 文件
        try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }
        // 不 break，等待下一条消息
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received after interrupt, exiting');
          // 退出前发送 session 更新，确保主进程持久化最新 session ID
          writeOutput({ status: 'success', result: null, newSessionId: sessionId });
          break;
        }
        clearInterruptRequested();
        consecutiveCompactions = 0;
        prompt = nextMessage.text;
        promptImages = nextMessage.images;
        containerInput.turnId = generateTurnId();
        continue;
      }

      // Memory Flush: run an extra query to let agent save durable memories (home containers only)
      // Skip flush when already in a compaction loop — context is too full for productive work.
      if (needsMemoryFlush && isHome && consecutiveCompactions === 0) {
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
        if (flushResult.newSessionId) { sessionId = flushResult.newSessionId; latestSessionId = sessionId; }
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

      // ── Non-blocking compaction: auto-continue after context compaction ──
      // Instead of waiting for user to send "继续", automatically start a
      // new query so the agent resumes seamlessly where it left off.
      // The query is tagged with sourceKind='auto_continue' so the host
      // process can suppress system-maintenance noise (memory flush "OK",
      // CLAUDE.md update acks, etc.) that leaked into the agent's session
      // transcript — the host will only forward substantive user-facing
      // content to IM, preventing the bug described in issue #275.
      //
      // Guard: if compaction keeps firing repeatedly (e.g. system prompt alone
      // nearly fills the context window), stop auto-continuing to avoid an
      // infinite loop that burns API tokens without producing useful work.
      if (hadCompaction) {
        hadCompaction = false;
        consecutiveCompactions++;
        if (consecutiveCompactions <= MAX_CONSECUTIVE_COMPACTIONS) {
          log(`Auto-continuing after compaction (${consecutiveCompactions}/${MAX_CONSECUTIVE_COMPACTIONS})`);
          const autoContinuePrompt = [
            '继续。',
            '注意：刚刚发生了上下文压缩，系统已自动执行了记忆刷新和 CLAUDE.md 更新（这些是内部维护操作）。',
            '请**只关注与用户的实际对话**，从压缩前的最后一个对话话题自然衔接。',
            '如果压缩前你正在进行方案设计、讨论或等待用户确认，请简要回顾当前状态和待确认事项。',
            '如果压缩前已经在执行中，则继续执行。',
            '**重要**：不要提及、确认或重复任何系统维护相关的内容（如 "OK"、"已更新 CLAUDE.md"、"记忆已刷新" 等），',
            '这些内部状态对用户不可见。如果你的回复中确实包含此类内容，请用 <internal>...</internal> 标签包裹。',
          ].join('');
          containerInput.turnId = generateTurnId();
          const autoContResult = await runQuery(
            autoContinuePrompt,
            sessionId,
            mcpServerConfig,
            containerInput,
            memoryRecallPrompt,
            resumeAt,
            true,
            DEFAULT_ALLOWED_TOOLS,
            undefined,
            undefined,
            'auto_continue',
          );
          if (autoContResult.newSessionId) {
            sessionId = autoContResult.newSessionId;
            latestSessionId = sessionId;
          }
          if (autoContResult.lastAssistantUuid) {
            resumeAt = autoContResult.lastAssistantUuid;
          }
          if (autoContResult.closedDuringQuery) {
            log('Close sentinel during auto-continue, exiting');
            writeOutput({ status: 'closed', result: null });
            break;
          }
          if (autoContResult.sessionResumeFailed) {
            log('WARN: Session resume failed during auto-continue, clearing session');
            if (sessionId) {
              const historyContext = extractSessionHistory(sessionId);
              if (historyContext) {
                pendingHistoryContext = historyContext;
                log('Stashed session history context for next user-initiated query');
              }
            }
            sessionId = undefined;
            latestSessionId = undefined;
            resumeAt = undefined;
            mcpServerConfig = buildMcpServerConfig();
          }
          if (autoContResult.unrecoverableTranscriptError) {
            log('WARN: Unrecoverable transcript error during auto-continue, signaling reset');
            writeOutput({
              status: 'error',
              result: null,
              error: 'unrecoverable_transcript: 会话历史中包含无法处理的数据，会话需要重置。',
              newSessionId: sessionId,
            });
            process.exit(1);
          }
          if (autoContResult.contextOverflow) {
            log('WARN: Context overflow during auto-continue, will be handled on next query');
            // Don't retry here — the main loop's overflow-retry logic will
            // kick in on the next user-initiated query.
          }
          if (autoContResult.interruptedDuringQuery) {
            log('WARN: Auto-continue query was interrupted by user');
            resumeAt = undefined;
            try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }
          }
          // After auto-continue, fall through to wait for next IPC message.
        } else {
          log(`Compaction loop detected (${consecutiveCompactions} consecutive), stopping auto-continue and waiting for user input`);
          consecutiveCompactions = 0;
        }
      } else {
        consecutiveCompactions = 0;
      }

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
      containerInput.turnId = generateTurnId();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`Agent error stack:\n${err.stack}`);
    }
    // Log cause chain for SDK-wrapped errors (e.g. EPIPE from internal claude CLI)
    const cause = err instanceof Error ? (err as NodeJS.ErrnoException & { cause?: unknown }).cause : undefined;
    if (cause) {
      const causeMsg = cause instanceof Error ? cause.stack || cause.message : String(cause);
      log(`Agent error cause:\n${causeMsg}`);
    }
    log(`Agent error errno: ${(err as NodeJS.ErrnoException).code ?? 'none'} exitCode: ${process.exitCode ?? 'none'}`);
    // 不在 error output 中携带 sessionId：
    // 流式输出已通过 onOutput 回调传递了有效的 session 更新。
    // 如果这里携带的是 throw 前的旧 sessionId，会覆盖中间成功产生的新 session。
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    forceExitWithSafetyNet(1);
  }

  // main() 正常结束后必须显式退出。
  // SDK 内部可能留有未关闭的异步资源（MCP 连接、定时器等），
  // 如果不调用 process.exit()，Node.js 事件循环不会自动退出，
  // 导致 agent-runner 进程以 0% CPU 挂起，阻塞队列。
  //
  // Safety net: 当 SDK 的后台 Task (run_in_background) 持有异步资源时，
  // process.exit() 可能无法终止进程。5 秒后强制 SIGKILL。
  // 参考 GitHub issue #236。
  forceExitWithSafetyNet(0);
}

// 处理管道断开（EPIPE）：父进程关闭管道后仍有写入时，静默退出避免 code 1 错误输出
(process.stdout as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
(process.stderr as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

/**
 * 某些 SDK/底层 socket 会在管道断开后触发未捕获 EPIPE。
 * 这类错误通常发生在结果已输出之后，属于"收尾写入失败"，
 * 不应把整个 host query 标记为启动失败（code 1）。
 */
process.on('SIGTERM', () => {
  log('Received SIGTERM, exiting gracefully');
  // Emit latest session ID so the host can persist it before we exit.
  // Without this, the host starts a fresh session on restart, losing context.
  if (latestSessionId) {
    try {
      writeOutput({ status: 'success', result: null, newSessionId: latestSessionId });
    } catch { /* stdout may be closed */ }
  }
  forceExitWithSafetyNet(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, exiting gracefully');
  forceExitWithSafetyNet(0);
});

process.on('uncaughtException', (err: unknown) => {
  const errno = err as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (isWithinInterruptGraceWindow() && isInterruptRelatedError(err)) {
    console.error('Suppressing interrupt-related uncaught exception:', err);
    process.exit(0);
  }
  console.error('Uncaught exception:', err);
  // 尝试输出结构化错误，让主进程能收到错误信息而非仅看到 exit code 1
  try { writeOutput({ status: 'error', result: null, error: String(err) }); } catch { /* ignore */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const errno = reason as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (isWithinInterruptGraceWindow()) {
    console.error('Unhandled rejection during interrupt (non-fatal):', reason);
    return;
  }
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
main().catch((err) => {
  console.error('Fatal error in main():', err);
  process.exit(1);
});
