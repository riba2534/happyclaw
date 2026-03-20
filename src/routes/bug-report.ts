import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { Hono } from 'hono';

import { DATA_DIR } from '../config.js';
import { getUserHomeGroup } from '../db.js';
import { logger } from '../logger.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  BugReportGenerateSchema,
  BugReportSubmitSchema,
} from '../schemas.js';
import type { AuthUser } from '../types.js';
import { type Variables, getWebDeps } from '../web-context.js';

const execFileAsync = promisify(execFile);

const bugReportRoutes = new Hono<{ Variables: Variables }>();

// --- Rate limiting (60s per user) ---

const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 60_000;

const generateCooldowns = new Map<string, number>();
const GENERATE_COOLDOWN_MS = 30_000;

function checkCooldown(userId: string, map: Map<string, number> = cooldowns, cooldownMs: number = COOLDOWN_MS): string | null {
  const last = map.get(userId);
  if (last) {
    const remaining = cooldownMs - (Date.now() - last);
    if (remaining > 0) {
      return `请等待 ${Math.ceil(remaining / 1000)} 秒后再试`;
    }
  }
  return null;
}

// --- Capability detection (cached 5min) ---

let capCache: {
  ghAvailable: boolean;
  ghUsername: string | null;
  claudeAvailable: boolean;
  checkedAt: number;
} | null = null;
const CAP_CACHE_TTL = 5 * 60 * 1000;

async function checkCapabilities(): Promise<{
  ghAvailable: boolean;
  ghUsername: string | null;
  claudeAvailable: boolean;
}> {
  if (capCache && Date.now() - capCache.checkedAt < CAP_CACHE_TTL) {
    return {
      ghAvailable: capCache.ghAvailable,
      ghUsername: capCache.ghUsername,
      claudeAvailable: capCache.claudeAvailable,
    };
  }

  const [gh, claude] = await Promise.all([
    execFileAsync('gh', ['auth', 'status'], { timeout: 5000 })
      .then(() => true)
      .catch(() => false),
    execFileAsync('claude', ['--version'], { timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  ]);

  // Get gh username if available
  let ghUsername: string | null = null;
  if (gh) {
    try {
      const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], { timeout: 5000 });
      ghUsername = stdout.trim() || null;
    } catch {
      // gh available but can't get username
    }
  }

  capCache = { ghAvailable: gh, ghUsername, claudeAvailable: claude, checkedAt: Date.now() };
  return { ghAvailable: gh, ghUsername, claudeAvailable: claude };
}

// --- Helpers ---

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'),
    );
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readRecentLogs(folder: string, maxLines = 50): string {
  const logsDir = path.join(DATA_DIR, 'groups', folder, 'logs');
  try {
    if (!fs.existsSync(logsDir)) return '(no logs directory)';
    const files = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .reverse();
    if (files.length === 0) return '(no log files)';

    const latestFile = path.join(logsDir, files[0]);
    const content = fs.readFileSync(latestFile, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '(failed to read logs)';
  }
}

/** Mask environment variable values in log text */
function sanitizeLogs(text: string): string {
  // Generic pattern matching any env var name containing sensitive keywords
  const sensitivePattern =
    /(\b\w*(?:token|password|passwd|secret|api[_-]?key|auth[_-]?token|authorization|cookie|credential|private[_-]?key|access[_-]?key|app[_-]?secret)\w*)[=:]\s*\S+/gi;
  return text.replace(sensitivePattern, '$1=***');
}

function buildGeneratePrompt(
  description: string,
  systemInfo: Record<string, string>,
  logs: string,
  screenshotCount: number,
): string {
  const sysInfoText = Object.entries(systemInfo)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const screenshotNote =
    screenshotCount > 0
      ? `\n\n## 附加截图\n用户附加了 ${screenshotCount} 张截图（截图内容无法在此展示）。请在 Issue 正文末尾添加提示：「报告者附加了 ${screenshotCount} 张截图，如需查看请联系报告者。」`
      : '';

  return `你是一个 Bug 报告助手，帮用户将 bug 描述整理为结构化的 GitHub Issue。

## 用户描述
${description}${screenshotNote}

## 系统信息
${sysInfoText}

## 最近日志（最后 50 行）
\`\`\`
${logs}
\`\`\`

请生成一个结构化的 GitHub Issue。输出**纯 JSON**（不要 markdown 代码块），包含两个字段：
- "title": 简洁的 issue 标题（不超过 80 字符），以类别开头如 "Bug:", "Crash:", "UI:" 等
- "body": 结构化的 Markdown 正文，包含以下章节：
  ## 问题描述
  （清晰总结 bug）

  ## 环境信息
  （系统信息表格）

  ## 重现步骤
  （如果能从描述和日志推断）

  ## 期望行为 vs 实际行为

  ## 相关日志
  （如有错误日志，摘录关键部分）

  ## 可能的原因分析
  （基于日志和描述的分析）

只输出 JSON，不要其他内容。`;
}

function buildFallbackReport(
  description: string,
  systemInfo: Record<string, string>,
  logs: string,
): { title: string; body: string } {
  const sysInfoTable = Object.entries(systemInfo)
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join('\n');

  const body = `## 问题描述

${description}

## 环境信息

| 项目 | 值 |
|------|-----|
${sysInfoTable}

## 相关日志

\`\`\`
${logs.slice(0, 3000)}
\`\`\`
`;

  return {
    title: `Bug: ${description.slice(0, 70)}`,
    body,
  };
}

/** Try multiple strategies to extract JSON { title, body } from Claude output */
function tryParseJsonOutput(raw: string): { title?: string; body?: string } | null {
  const candidates: string[] = [];

  // Strategy 1: strip markdown fencing (greedy to handle nested backticks)
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());

  // Strategy 2: extract first { ... } block
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);

  // Strategy 3: raw string as-is
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { title?: string; body?: string };
      if (typeof parsed === 'object' && parsed !== null && parsed.body) {
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ========== Routes ==========

/**
 * GET /api/bug-report/capabilities
 * Check what tools are available for bug reporting
 */
bugReportRoutes.get('/capabilities', authMiddleware, async (c) => {
  const caps = await checkCapabilities();
  return c.json(caps);
});

/**
 * POST /api/bug-report/generate
 * Analyze the bug with Claude and generate a structured report
 */
bugReportRoutes.post('/generate', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;

  // Rate limiting — 30s cooldown per user for generate
  const generateCooldownMsg = checkCooldown(user.id, generateCooldowns, GENERATE_COOLDOWN_MS);
  if (generateCooldownMsg) {
    return c.json({ error: generateCooldownMsg }, 429);
  }

  const parseResult = BugReportGenerateSchema.safeParse(await c.req.json());
  if (!parseResult.success) {
    return c.json(
      { error: 'Invalid request', details: parseResult.error.issues },
      400,
    );
  }
  const { description, screenshots } = parseResult.data;

  // Set cooldown immediately to prevent concurrent requests
  generateCooldowns.set(user.id, Date.now());

  // Collect system info
  const homeGroup = getUserHomeGroup(user.id);
  const folder = homeGroup?.folder || 'main';
  const deps = getWebDeps();
  const queueStatus = deps?.queue.getStatus();

  const systemInfo: Record<string, string> = {
    HappyClaw版本: getVersion(),
    'Node.js': process.version,
    操作系统: `${os.platform()} ${os.release()}`,
    架构: os.arch(),
    活跃容器数: String(queueStatus?.activeContainerCount ?? 'N/A'),
    活跃宿主机进程: String(queueStatus?.activeHostProcessCount ?? 'N/A'),
    等待队列: String(queueStatus?.waitingCount ?? 'N/A'),
    截图数量: String(screenshots?.length || 0),
  };

  // Read recent logs
  const rawLogs = readRecentLogs(folder);
  const logs = sanitizeLogs(rawLogs);

  // Try Claude analysis
  const caps = await checkCapabilities();
  if (!caps.claudeAvailable) {
    logger.info('bug-report: claude CLI not available, using fallback template');
    const fallback = buildFallbackReport(description, systemInfo, logs);
    return c.json({ ...fallback, systemInfo });
  }

  const prompt = buildGeneratePrompt(description, systemInfo, logs, screenshots?.length || 0);

  try {
    const result = await new Promise<string | null>((resolve) => {
      const model = process.env.RECALL_MODEL || '';
      const args = ['--print'];
      if (model) args.push('--model', model);

      logger.info(
        { promptLen: prompt.length, userId: user.id },
        'bug-report: invoking claude --print',
      );

      const child = execFile(
        'claude',
        args,
        {
          timeout: 60000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, CLAUDECODE: '' },
        },
        (err, stdout, stderr) => {
          if (err) {
            logger.warn(
              {
                message: (err as Error).message?.slice(0, 200),
                stderr: stderr?.slice(0, 300),
              },
              'bug-report: claude CLI failed',
            );
            resolve(null);
            return;
          }
          resolve(stdout.trim() || null);
        },
      );

      child.stdin?.write(prompt);
      child.stdin?.end();
    });

    if (!result) {
      const fallback = buildFallbackReport(description, systemInfo, logs);
      return c.json({ ...fallback, systemInfo });
    }

    // Try to parse Claude's JSON output
    const parsed = tryParseJsonOutput(result);
    if (parsed?.body) {
      return c.json({
        title: parsed.title || `Bug: ${description.slice(0, 70)}`,
        body: parsed.body,
        systemInfo,
      });
    }

    // Claude didn't return valid JSON, use raw output as body
    logger.info('bug-report: claude output was not valid JSON, using as raw body');
    return c.json({
      title: `Bug: ${description.slice(0, 70)}`,
      body: result,
      systemInfo,
    });
  } catch (err) {
    logger.error(
      { error: (err as Error).message },
      'bug-report: unexpected error during generation',
    );
    const fallback = buildFallbackReport(description, systemInfo, logs);
    return c.json({ ...fallback, systemInfo });
  }
});

/**
 * POST /api/bug-report/submit
 * Create a GitHub issue or return a pre-filled URL
 */
bugReportRoutes.post('/submit', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;

  // Rate limiting — only on actual issue submission
  const cooldownMsg = checkCooldown(user.id);
  if (cooldownMsg) {
    return c.json({ error: cooldownMsg }, 429);
  }

  const parseResult = BugReportSubmitSchema.safeParse(await c.req.json());
  if (!parseResult.success) {
    return c.json(
      { error: 'Invalid request', details: parseResult.error.issues },
      400,
    );
  }
  const { title, body } = parseResult.data;

  // Append submitter info
  const fullBody = `${body}\n\n---\n> Submitted via HappyClaw by ${user.display_name || user.username}`;

  // Try gh CLI first
  const caps = await checkCapabilities();
  if (caps.ghAvailable) {
    try {
      logger.info({ userId: user.id }, 'bug-report: attempting gh issue create');
      const result = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'gh',
          [
            'issue',
            'create',
            '--repo',
            'riba2534/happyclaw',
            '--title',
            title,
            '--body-file',
            '-',
          ],
          { timeout: 30000, maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              logger.warn(
                {
                  message: (err as Error).message?.slice(0, 200),
                  stderr: stderr?.slice(0, 300),
                },
                'bug-report: gh issue create failed',
              );
              reject(err);
              return;
            }
            resolve(stdout.trim());
          },
        );
        child.stdin?.write(fullBody);
        child.stdin?.end();
      });

      // gh outputs the issue URL on success
      const urlMatch = result.match(
        /https:\/\/github\.com\/[^\s]+\/issues\/\d+/,
      );
      const url = urlMatch ? urlMatch[0] : result;

      logger.info({ url, userId: user.id }, 'bug-report: issue created via gh');
      cooldowns.set(user.id, Date.now());
      return c.json({ method: 'created', url });
    } catch {
      // Fall through to manual URL
      logger.info('bug-report: gh failed, falling back to manual URL');
    }
  }

  // Fallback: pre-filled GitHub URL
  const maxBodyLen = 6000; // conservative limit for URL length
  const truncatedBody =
    fullBody.length > maxBodyLen
      ? fullBody.slice(0, maxBodyLen) + '\n\n...(内容过长已截断，请补充完整信息)'
      : fullBody;

  const url = `https://github.com/riba2534/happyclaw/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(truncatedBody)}`;

  logger.info({ userId: user.id }, 'bug-report: returning pre-filled URL');
  cooldowns.set(user.id, Date.now());
  return c.json({ method: 'manual', url });
});

export default bugReportRoutes;
