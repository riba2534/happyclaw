import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { Hono } from 'hono';

import { getUserHomeGroup } from '../db.js';
import { getClaudeProviderConfig } from '../runtime-config.js';
import { sdkQuery } from '../sdk-query.js';
import { logger } from '../logger.js';
import { authMiddleware } from '../middleware/auth.js';
import { BugReportGenerateSchema, BugReportSubmitSchema } from '../schemas.js';
import type { AuthUser } from '../types.js';
import { type Variables, getWebDeps } from '../web-context.js';
import { workspaceLogsDirOf } from '../workspace-dir.js';

const execFileAsync = promisify(execFile);

const bugReportRoutes = new Hono<{ Variables: Variables }>();

// --- Rate limiting (60s per user) ---

const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 60_000;

const generateCooldowns = new Map<string, number>();
const GENERATE_COOLDOWN_MS = 30_000;

function checkCooldown(
  userId: string,
  map: Map<string, number> = cooldowns,
  cooldownMs: number = COOLDOWN_MS,
): string | null {
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

  const [gh] = await Promise.all([
    execFileAsync('gh', ['auth', 'status'], { timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  ]);
  // Claude availability is determined by provider config, not CLI presence
  const providerConfig = getClaudeProviderConfig();
  const claude = !!(
    providerConfig.anthropicApiKey ||
    providerConfig.claudeCodeOauthToken ||
    providerConfig.claudeOAuthCredentials
  );

  // Get gh username if available
  let ghUsername: string | null = null;
  if (gh) {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', 'user', '--jq', '.login'],
        { timeout: 5000 },
      );
      ghUsername = stdout.trim() || null;
    } catch {
      // gh available but can't get username
    }
  }

  capCache = {
    ghAvailable: gh,
    ghUsername,
    claudeAvailable: claude,
    checkedAt: Date.now(),
  };
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
  const logsDir = workspaceLogsDirOf(folder);
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

/**
 * Mask environment variable values, credentials, and absolute paths in log text
 * before it is embedded in a bug report. Exported for unit testing — this is a
 * security boundary and must keep a regression safety net.
 */
export function sanitizeLogs(text: string): string {
  let result = text;

  // Replace absolute paths to project root and home directory with placeholders.
  // Done BEFORE the per-line truncation below: replaceAll is a linear literal
  // match (no ReDoS risk on long input), and running it first ensures a path
  // straddling the truncation point isn't sliced mid-string and left unredacted.
  const projectRoot = path.resolve(process.cwd());
  const homeDir = os.homedir();
  // Replace longer path first to avoid partial replacement
  if (projectRoot.startsWith(homeDir)) {
    result = result.replaceAll(projectRoot, '<project>');
    result = result.replaceAll(homeDir, '<home>');
  } else {
    result = result.replaceAll(homeDir, '<home>');
    result = result.replaceAll(projectRoot, '<project>');
  }

  // Cap per-line length BEFORE the keyword regex runs. The credential pattern's
  // prefix `\b\w*(?:keyword)\w*` backtracks O(n²) on a long separator-less,
  // keyword-dense line (e.g. a member-influenced agent stdout dump written
  // untruncated on a failing run); a ~100KB line stalls the single-threaded
  // event loop for ~1-2s. Bug reports never need multi-KB single lines, so a
  // per-line cap keeps masking linear. Splitting per line also stops an
  // unterminated quote in one line from over-masking the lines that follow it.
  const MAX_LINE = 2000;
  result = result
    .split('\n')
    .map((line) =>
      line.length > MAX_LINE ? line.slice(0, MAX_LINE) + '…[truncated]' : line,
    )
    .join('\n');

  // Mask known credential FORMATS and Authorization schemes BEFORE the generic
  // keyword pattern below. The generic pattern's keyword list includes
  // "authorization", so on the standard `Authorization: Bearer <token>` header
  // it would match `Authorization: Bearer` (its value part `[^\s"',]+` stops at
  // the space, consuming only the scheme word) and rewrite it to
  // `Authorization=***`, leaving the real token after the space exposed. Running
  // the format-specific passes first guarantees the token itself is redacted
  // regardless of the keyword that precedes it.

  // Authorization scheme values: `Bearer <token>` / `Basic <creds>`.
  result = result.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***');

  // Known credential formats with no surrounding keyword (raw tokens dumped in
  // logs): Anthropic/OpenAI keys, GitHub tokens, JWTs, AWS access key ids.
  result = result
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_***')
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
      'eyJ***',
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***');

  // Generic pattern matching any env var name containing sensitive keywords.
  // Allow optional quotes and whitespace around the separator so JSON
  // ("apiKey": "v") and shell (APIKEY=v) forms are both covered. Runs AFTER the
  // format passes above, so a `Authorization: Bearer <token>` already has its
  // token masked and this only collapses the leftover `Authorization:` prefix.
  // The value part matches, in order: a double/single-quoted string with an
  // OPTIONAL closing quote (`"[^"\n]*"?`) — so a mid-line-truncated log such as
  // `"app_secret": "cli_abc` (readRecentLogs slices the buffer and routinely
  // cuts inside a quoted value) is still masked whole, and JSON values
  // containing commas are masked without leaking neighbours; OR an unquoted run
  // `[^\s"']+` that keeps comma-joined segments (`cookie=a,b,c` → `cookie=***`,
  // including a leading comma) but stops at whitespace so a space-separated
  // neighbour like `apikey=v, region=us` keeps `region=us`. The quoted classes
  // exclude `\n` so an unterminated quote over-masks only the rest of its OWN
  // line, never swallowing following log lines.
  const sensitivePattern =
    /(\b\w*(?:token|password|passwd|secret|api[_-]?key|auth[_-]?token|authorization|cookie|credential|private[_-]?key|access[_-]?key|app[_-]?secret)\w*)["']?\s*[=:]\s*(?:"[^"\n]*"?|'[^'\n]*'?|[^\s"']+)/gi;
  result = result.replace(sensitivePattern, '$1=***');

  return result;
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
- "title": 简洁的 issue 标题，格式为 "bug: 简要描述"（小写 bug: 前缀，不超过 80 字符）
- "body": 结构化的 Markdown 正文，严格按照以下模板：

  ## 用户现象
  （从用户视角描述看到了什么、体验上有什么异常）

  ## 问题描述
  （从技术视角简要说明发生了什么）

  ## 复现路径
  1. 步骤一
  2. 步骤二
  3. 期望行为 vs 实际行为
  （如果能从描述和日志推断出复现步骤就写，无法推断则省略此章节）

  ## 根因（可选）
  （如果能从日志分析出代码层面的原因就写，否则省略）

  ## 影响
  （对用户体验/数据/安全的影响）

  ## 环境信息
  （系统信息表格）

  ## 相关日志
  （如有错误日志，摘录关键部分）

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

  const body = `## 用户现象

${description}

## 问题描述

（待补充技术分析）

## 影响

（待补充）

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
    title: `bug: ${description.slice(0, 70)}`,
    body,
  };
}

/** Try multiple strategies to extract JSON { title, body } from Claude output */
function tryParseJsonOutput(
  raw: string,
): { title?: string; body?: string } | null {
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
  const generateCooldownMsg = checkCooldown(
    user.id,
    generateCooldowns,
    GENERATE_COOLDOWN_MS,
  );
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
    logger.info(
      'bug-report: claude CLI not available, using fallback template',
    );
    const fallback = buildFallbackReport(description, systemInfo, logs);
    return c.json({ ...fallback, systemInfo });
  }

  const prompt = buildGeneratePrompt(
    description,
    systemInfo,
    logs,
    screenshots?.length || 0,
  );

  try {
    logger.info(
      { promptLen: prompt.length, userId: user.id },
      'bug-report: invoking Claude SDK',
    );

    const model = process.env.RECALL_MODEL || undefined;
    const result = await sdkQuery(prompt, { model, timeout: 60_000 });

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
    logger.info(
      'bug-report: claude output was not valid JSON, using as raw body',
    );
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
      logger.info(
        { userId: user.id },
        'bug-report: attempting gh issue create',
      );
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
      ? fullBody.slice(0, maxBodyLen) +
        '\n\n...(内容过长已截断，请补充完整信息)'
      : fullBody;

  const url = `https://github.com/riba2534/happyclaw/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(truncatedBody)}`;

  logger.info({ userId: user.id }, 'bug-report: returning pre-filled URL');
  cooldowns.set(user.id, Date.now());
  return c.json({ method: 'manual', url });
});

export default bugReportRoutes;
