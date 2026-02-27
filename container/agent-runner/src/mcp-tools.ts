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

/** Context required by MCP tools. Passed at construction time. */
export interface McpContext {
  chatJid: string;
  groupFolder: string;
  isHome: boolean;
  isAdminHome: boolean;
  workspaceIpc: string;
  workspaceGroup: string;
  workspaceGlobal: string;
  workspaceMemory: string;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

// --- Memory helpers ---
const MEMORY_EXTENSIONS = new Set(['.md', '.txt']);
const MEMORY_SUBDIRS = new Set(['memory', 'conversations']);
const MEMORY_SKIP_DIRS = new Set(['logs', '.claude', 'node_modules', '.git']);
const MAX_MEMORY_FILE_SIZE = 512 * 1024; // 512KB per file
const MAX_MEMORY_APPEND_SIZE = 16 * 1024; // 16KB per append
const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function collectMemoryFiles(baseDir: string, out: string[], maxDepth: number, depth = 0): void {
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
        if (entry.name === 'CLAUDE.md' || MEMORY_EXTENSIONS.has(path.extname(entry.name))) {
          out.push(fullPath);
        }
      }
    }
  } catch { /* skip unreadable */ }
}

function createToRelativePath(ctx: McpContext) {
  return (filePath: string): string => {
    if (filePath === ctx.workspaceGlobal || filePath.startsWith(ctx.workspaceGlobal + path.sep)) {
      return `[global] ${path.relative(ctx.workspaceGlobal, filePath)}`;
    }
    if (filePath === ctx.workspaceMemory || filePath.startsWith(ctx.workspaceMemory + path.sep)) {
      return `[memory] ${path.relative(ctx.workspaceMemory, filePath)}`;
    }
    return path.relative(ctx.workspaceGroup, filePath);
  };
}

function parseMemoryFileReference(fileRef: string): { pathRef: string; lineFromRef?: number } {
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
 * Create all HappyClaw MCP tool definitions for in-process SDK MCP server.
 */
export function createMcpTools(ctx: McpContext): SdkMcpToolDefinition<any>[] {
  const MESSAGES_DIR = path.join(ctx.workspaceIpc, 'messages');
  const TASKS_DIR = path.join(ctx.workspaceIpc, 'tasks');
  const hasCrossGroupAccess = ctx.isAdminHome;
  const toRelativePath = createToRelativePath(ctx);

  return [
    // --- send_message ---
    tool(
      'send_message',
      "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
      { text: z.string().describe('The message text to send') },
      async (args) => {
        const data = {
          type: 'message',
          chatJid: ctx.chatJid,
          text: args.text,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(MESSAGES_DIR, data);
        return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
      },
    ),

    // --- schedule_task ---
    tool(
      'schedule_task',
      `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
      {
        prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
        schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
        schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
        context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
        target_group_jid: z.string().optional().describe('(Admin home only) JID of the group to schedule the task for. Defaults to the current group.'),
      },
      async (args) => {
        // Validate schedule_value before writing IPC
        if (args.schedule_type === 'cron') {
          try {
            CronExpressionParser.parse(args.schedule_value);
          } catch {
            return {
              content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'interval') {
          const ms = parseInt(args.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            return {
              content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'once') {
          const date = new Date(args.schedule_value);
          if (isNaN(date.getTime())) {
            return {
              content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
              isError: true,
            };
          }
        }

        const targetJid = hasCrossGroupAccess && args.target_group_jid ? args.target_group_jid : ctx.chatJid;
        const data = {
          type: 'schedule_task',
          prompt: args.prompt,
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          context_mode: args.context_mode || 'group',
          targetJid,
          createdBy: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        const filename = writeIpcFile(TASKS_DIR, data);
        return {
          content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
        };
      },
    ),

    // --- list_tasks ---
    tool(
      'list_tasks',
      "List all scheduled tasks. From admin home: shows all tasks. From other groups: shows only that group's tasks.",
      {},
      async () => {
        const tasksFile = path.join(ctx.workspaceIpc, 'current_tasks.json');
        try {
          if (!fs.existsSync(tasksFile)) {
            return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
          }
          const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
          const tasks = hasCrossGroupAccess
            ? allTasks
            : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === ctx.groupFolder);
          if (tasks.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
          }
          const formatted = tasks
            .map(
              (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
                `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
            )
            .join('\n');
          return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
          };
        }
      },
    ),

    // --- pause_task ---
    tool(
      'pause_task',
      'Pause a scheduled task. It will not run until resumed.',
      { task_id: z.string().describe('The task ID to pause') },
      async (args) => {
        const data = {
          type: 'pause_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
      },
    ),

    // --- resume_task ---
    tool(
      'resume_task',
      'Resume a paused task.',
      { task_id: z.string().describe('The task ID to resume') },
      async (args) => {
        const data = {
          type: 'resume_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
      },
    ),

    // --- cancel_task ---
    tool(
      'cancel_task',
      'Cancel and delete a scheduled task.',
      { task_id: z.string().describe('The task ID to cancel') },
      async (args) => {
        const data = {
          type: 'cancel_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
      },
    ),

    // --- register_group ---
    tool(
      'register_group',
      `Register a new group so the agent can respond to messages there. Admin home only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
      {
        jid: z.string().describe('The chat JID (e.g., "feishu:oc_xxxx")'),
        name: z.string().describe('Display name for the group'),
        folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
      },
      async (args) => {
        if (!hasCrossGroupAccess) {
          return {
            content: [{ type: 'text' as const, text: 'Only the admin home container can register new groups.' }],
            isError: true,
          };
        }
        const data = {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
        };
      },
    ),

    // --- install_skill ---
    tool(
      'install_skill',
      `Install a skill from the skills registry (skills.sh). The skill will be available in future conversations.
Example packages: "anthropic/memory", "anthropic/think", "owner/repo", "owner/repo@skill-name".`,
      {
        package: z.string().describe('The skill package to install, format: owner/repo or owner/repo@skill'),
      },
      async (args) => {
        const pkg = args.package.trim();
        if (!/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid package format: "${pkg}". Expected format: owner/repo or owner/repo@skill` }],
            isError: true,
          };
        }

        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const resultFileName = `install_skill_result_${requestId}.json`;
        const resultFilePath = path.join(TASKS_DIR, resultFileName);

        const data = {
          type: 'install_skill',
          package: pkg,
          requestId,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);

        // Poll for result file (timeout 120s)
        const timeout = 120_000;
        const pollInterval = 500;
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
          try {
            if (fs.existsSync(resultFilePath)) {
              const raw = fs.readFileSync(resultFilePath, 'utf-8');
              fs.unlinkSync(resultFilePath);
              const result = JSON.parse(raw);
              if (result.success) {
                const installed = (result.installed || []).join(', ') || pkg;
                return {
                  content: [{ type: 'text' as const, text: `Skill installed successfully: ${installed}\n\nNote: The skill will be available in the next conversation (new container/process).` }],
                };
              } else {
                return {
                  content: [{ type: 'text' as const, text: `Failed to install skill "${pkg}": ${result.error || 'Unknown error'}` }],
                  isError: true,
                };
              }
            }
          } catch {
            // ignore read errors, retry
          }
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }
        return {
          content: [{ type: 'text' as const, text: `Timeout waiting for skill installation result (${timeout / 1000}s). The installation may still be in progress.` }],
          isError: true,
        };
      },
    ),

    // --- uninstall_skill ---
    tool(
      'uninstall_skill',
      `Uninstall a user-level skill by its ID. Project-level skills cannot be uninstalled.
Use the skills panel in the UI to find the skill ID (directory name, e.g. "memory", "think").`,
      {
        skill_id: z.string().describe('The skill ID to uninstall (the directory name, e.g. "memory", "think")'),
      },
      async (args) => {
        const skillId = args.skill_id.trim();
        if (!skillId || !/^[\w\-]+$/.test(skillId)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid skill ID: "${skillId}". Must be alphanumeric with hyphens/underscores.` }],
            isError: true,
          };
        }

        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const resultFileName = `uninstall_skill_result_${requestId}.json`;
        const resultFilePath = path.join(TASKS_DIR, resultFileName);

        const data = {
          type: 'uninstall_skill',
          skillId,
          requestId,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);

        // Poll for result file (timeout 30s)
        const timeout = 30_000;
        const pollInterval = 500;
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
          try {
            if (fs.existsSync(resultFilePath)) {
              const raw = fs.readFileSync(resultFilePath, 'utf-8');
              fs.unlinkSync(resultFilePath);
              const result = JSON.parse(raw);
              if (result.success) {
                return {
                  content: [{ type: 'text' as const, text: `Skill "${skillId}" uninstalled successfully.` }],
                };
              } else {
                return {
                  content: [{ type: 'text' as const, text: `Failed to uninstall skill "${skillId}": ${result.error || 'Unknown error'}` }],
                  isError: true,
                };
              }
            }
          } catch {
            // ignore read errors, retry
          }
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }
        return {
          content: [{ type: 'text' as const, text: `Timeout waiting for skill uninstall result.` }],
          isError: true,
        };
      },
    ),

    // --- memory_append ---
    tool(
      'memory_append',
      `\u5c06**\u65f6\u6548\u6027\u8bb0\u5fc6**\u8ffd\u52a0\u5230 memory/YYYY-MM-DD.md\uff08\u72ec\u7acb\u8bb0\u5fc6\u76ee\u5f55\uff0c\u4e0d\u5728\u5de5\u4f5c\u533a\u5185\uff09\u3002
\u4ec5\u8ffd\u52a0\u5199\u5165\uff0c\u4e0d\u4f1a\u8986\u76d6\u5df2\u6709\u5185\u5bb9\u3002

\u4ec5\u7528\u4e8e\u660e\u786e\u53ea\u8ddf\u5f53\u5929/\u77ed\u671f\u6709\u5173\u7684\u4fe1\u606f\uff1a\u4eca\u65e5\u9879\u76ee\u8fdb\u5c55\u3001\u4e34\u65f6\u6280\u672f\u51b3\u7b56\u3001\u5f85\u529e\u4e8b\u9879\u3001\u4f1a\u8bae\u8981\u70b9\u7b49\u3002

**\u91cd\u8981**\uff1a\u4e0b\u6b21\u5bf9\u8bdd\u4ecd\u53ef\u80fd\u7528\u5230\u7684\u4fe1\u606f\uff08\u7528\u6237\u8eab\u4efd\u3001\u504f\u597d\u3001\u5e38\u7528\u9879\u76ee\u3001\u7528\u6237\u8bf4\u201c\u8bb0\u4f4f\u201d\u7684\u5185\u5bb9\uff09\u5e94\u76f4\u63a5\u7528 Edit \u5de5\u5177\u7f16\u8f91 /workspace/global/CLAUDE.md\uff0c\u4e0d\u8981\u7528\u6b64\u5de5\u5177\u3002`,
      {
        content: z.string().describe('\u8981\u8ffd\u52a0\u7684\u8bb0\u5fc6\u5185\u5bb9'),
        date: z.string().optional().describe('\u76ee\u6807\u65e5\u671f\uff0c\u683c\u5f0f YYYY-MM-DD\uff08\u9ed8\u8ba4\uff1a\u4eca\u5929\uff09'),
      },
      async (args) => {
        const normalizedContent = args.content.replace(/\r\n?/g, '\n').trim();
        if (!normalizedContent) {
          return { content: [{ type: 'text' as const, text: '\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a\u3002' }], isError: true };
        }
        const appendBytes = Buffer.byteLength(normalizedContent, 'utf-8');
        if (appendBytes > MAX_MEMORY_APPEND_SIZE) {
          return {
            content: [{ type: 'text' as const, text: `\u5185\u5bb9\u8fc7\u5927\uff1a${appendBytes} \u5b57\u8282\uff08\u4e0a\u9650 ${MAX_MEMORY_APPEND_SIZE}\uff09\u3002` }],
            isError: true,
          };
        }
        const date = (args.date ?? new Date().toISOString().split('T')[0]).trim();
        if (!MEMORY_DATE_PATTERN.test(date)) {
          return { content: [{ type: 'text' as const, text: `\u65e5\u671f\u683c\u5f0f\u65e0\u6548\uff1a\u201c${date}\u201d\uff0c\u8bf7\u4f7f\u7528 YYYY-MM-DD\u3002` }], isError: true };
        }
        const resolvedPath = path.normalize(path.join(ctx.workspaceMemory, `${date}.md`));
        const inMemory = resolvedPath === ctx.workspaceMemory || resolvedPath.startsWith(ctx.workspaceMemory + path.sep);
        if (!inMemory) {
          return { content: [{ type: 'text' as const, text: '\u8bbf\u95ee\u88ab\u62d2\u7edd\uff1a\u8def\u5f84\u8d85\u51fa\u5de5\u4f5c\u533a\u8303\u56f4\u3002' }], isError: true };
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
              content: [{ type: 'text' as const, text: `\u8bb0\u5fc6\u6587\u4ef6\u5c06\u8d85\u8fc7 ${MAX_MEMORY_FILE_SIZE} \u5b57\u8282\u4e0a\u9650\uff0c\u8bf7\u7f29\u77ed\u5185\u5bb9\u3002` }],
              isError: true,
            };
          }
          fs.appendFileSync(resolvedPath, entry, 'utf-8');
          return { content: [{ type: 'text' as const, text: `\u5df2\u8ffd\u52a0\u5230 memory/${date}.md\uff08${appendBytes} \u5b57\u8282\uff09\u3002` }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `\u8ffd\u52a0\u8bb0\u5fc6\u65f6\u51fa\u9519\uff1a${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    ),

    // --- memory_search ---
    tool(
      'memory_search',
      `\u5728\u5de5\u4f5c\u533a\u7684\u8bb0\u5fc6\u6587\u4ef6\u4e2d\u641c\u7d22\uff08CLAUDE.md\u3001memory/\u3001conversations/ \u53ca\u5176\u4ed6 .md/.txt \u6587\u4ef6\uff09\u3002
\u8fd4\u56de\u6587\u4ef6\u8def\u5f84\u3001\u884c\u53f7\u548c\u4e0a\u4e0b\u6587\u7247\u6bb5\u3002\u8d85\u8fc7 512KB \u7684\u6587\u4ef6\u4f1a\u88ab\u8df3\u8fc7\u3002
\u7528\u4e8e\u56de\u5fc6\u8fc7\u53bb\u7684\u51b3\u7b56\u3001\u504f\u597d\u3001\u9879\u76ee\u4e0a\u4e0b\u6587\u6216\u5bf9\u8bdd\u5386\u53f2\u3002`,
      {
        query: z.string().describe('\u641c\u7d22\u5173\u952e\u8bcd\u6216\u77ed\u8bed\uff08\u4e0d\u533a\u5206\u5927\u5c0f\u5199\uff09'),
        max_results: z.number().optional().default(20).describe('\u6700\u5927\u7ed3\u679c\u6570\uff08\u9ed8\u8ba4 20\uff0c\u4e0a\u9650 50\uff09'),
      },
      async (args) => {
        if (!args.query.trim()) {
          return { content: [{ type: 'text' as const, text: '\u641c\u7d22\u5173\u952e\u8bcd\u4e0d\u80fd\u4e3a\u7a7a\u3002' }], isError: true };
        }
        const maxResults = Math.min(Math.max(args.max_results ?? 20, 1), 50);
        const queryLower = args.query.toLowerCase();
        const files: string[] = [];
        collectMemoryFiles(ctx.workspaceMemory, files, 4);
        collectMemoryFiles(ctx.workspaceGroup, files, 4);
        collectMemoryFiles(ctx.workspaceGlobal, files, 4);
        const uniqueFiles = Array.from(new Set(files));
        if (uniqueFiles.length === 0) {
          return { content: [{ type: 'text' as const, text: '\u672a\u627e\u5230\u8bb0\u5fc6\u6587\u4ef6\u3002' }] };
        }
        const results: string[] = [];
        let skippedLarge = 0;
        for (const filePath of uniqueFiles) {
          if (results.length >= maxResults) break;
          try {
            const stat = fs.statSync(filePath);
            if (stat.size > MAX_MEMORY_FILE_SIZE) { skippedLarge++; continue; }
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
                results.push(`${toRelativePath(filePath)}:${i + 1}\n${snippet}`);
              }
            }
          } catch { /* skip unreadable */ }
        }
        const skippedNote = skippedLarge > 0 ? `\uff08\u8df3\u8fc7 ${skippedLarge} \u4e2a\u5927\u6587\u4ef6\uff09` : '';
        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: `\u5728 ${uniqueFiles.length} \u4e2a\u8bb0\u5fc6\u6587\u4ef6\u4e2d\u672a\u627e\u5230\u201c${args.query}\u201d\u7684\u5339\u914d\u3002${skippedNote}` }] };
        }
        return {
          content: [{ type: 'text' as const, text: `\u627e\u5230 ${results.length} \u6761\u5339\u914d${skippedNote}\uff1a\n\n${results.join('\n---\n')}` }],
        };
      },
    ),

    // --- memory_get ---
    tool(
      'memory_get',
      `\u8bfb\u53d6\u8bb0\u5fc6\u6587\u4ef6\u6216\u6307\u5b9a\u884c\u8303\u56f4\u3002\u5728 memory_search \u4e4b\u540e\u4f7f\u7528\u4ee5\u83b7\u53d6\u5b8c\u6574\u4e0a\u4e0b\u6587\u3002`,
      {
        file: z.string().describe('\u76f8\u5bf9\u8def\u5f84\uff0c\u53ef\u5e26 :\u884c\u53f7\uff08\u5982 "CLAUDE.md:12"\u3001"[global] CLAUDE.md:8" \u6216 "[memory] 2026-01-15.md"\uff09'),
        from_line: z.number().optional().describe('\u8d77\u59cb\u884c\u53f7\uff08\u4ece 1 \u5f00\u59cb\uff0c\u9ed8\u8ba4\uff1a1\uff09'),
        lines: z.number().optional().describe('\u8bfb\u53d6\u884c\u6570\uff08\u9ed8\u8ba4\uff1a\u5168\u90e8\uff0c\u4e0a\u9650\uff1a200\uff09'),
      },
      async (args) => {
        const { pathRef, lineFromRef } = parseMemoryFileReference(args.file);
        let resolvedPath: string;
        if (pathRef.startsWith('[global] ')) {
          resolvedPath = path.join(ctx.workspaceGlobal, pathRef.slice('[global] '.length));
        } else if (pathRef.startsWith('[memory] ')) {
          resolvedPath = path.join(ctx.workspaceMemory, pathRef.slice('[memory] '.length));
        } else {
          resolvedPath = path.join(ctx.workspaceGroup, pathRef);
        }
        resolvedPath = path.normalize(resolvedPath);
        const inGroup = resolvedPath === ctx.workspaceGroup || resolvedPath.startsWith(ctx.workspaceGroup + path.sep);
        const inGlobal = resolvedPath === ctx.workspaceGlobal || resolvedPath.startsWith(ctx.workspaceGlobal + path.sep);
        const inMemory = resolvedPath === ctx.workspaceMemory || resolvedPath.startsWith(ctx.workspaceMemory + path.sep);
        if (!inGroup && !inGlobal && !inMemory) {
          return {
            content: [{ type: 'text' as const, text: '\u8bbf\u95ee\u88ab\u62d2\u7edd\uff1a\u8def\u5f84\u8d85\u51fa\u5de5\u4f5c\u533a\u8303\u56f4\u3002' }],
            isError: true,
          };
        }
        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [{ type: 'text' as const, text: `\u6587\u4ef6\u672a\u627e\u5230\uff1a${pathRef}` }],
            isError: true,
          };
        }
        try {
          const content = fs.readFileSync(resolvedPath, 'utf-8');
          const allLines = content.split('\n');
          const fromLine = Math.max((args.from_line ?? lineFromRef ?? 1) - 1, 0);
          const maxLines = Math.min(args.lines ?? allLines.length, 200);
          const slice = allLines.slice(fromLine, fromLine + maxLines);
          const header = `${pathRef}\uff08\u7b2c ${fromLine + 1}-${fromLine + slice.length} \u884c\uff0c\u5171 ${allLines.length} \u884c\uff09`;
          return {
            content: [{ type: 'text' as const, text: `${header}\n\n${slice.join('\n')}` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `\u8bfb\u53d6\u6587\u4ef6\u65f6\u51fa\u9519\uff1a${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    ),
  ];
}
