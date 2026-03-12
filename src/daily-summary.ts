import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';

import { TIMEZONE } from './config.js';
import { getGroupsByOwner, getMessagesByTimeRange, listUsers } from './db.js';

export interface DailySummaryDeps {
  logger: Logger;
  dataDir: string;
}

let lastCheckTime = 0;
const CHECK_INTERVAL_MS = 55 * 60 * 1000; // 55 minutes

/**
 * Run daily summary generation if conditions are met.
 * Called from the scheduler loop every 60s.
 * Actually executes only once per hour, and only between 2:00-3:00 AM local time.
 */
export function runDailySummaryIfNeeded(deps: DailySummaryDeps): void {
  const now = Date.now();

  // Throttle: skip if checked less than 55 minutes ago
  if (now - lastCheckTime < CHECK_INTERVAL_MS) return;
  lastCheckTime = now;

  // Only run between 2:00-3:00 AM in the configured timezone
  const localHour = getLocalHour(now);
  if (localHour < 2 || localHour >= 3) return;

  deps.logger.info('Daily summary: starting generation');

  try {
    generateSummaries(deps, now);
  } catch (err) {
    deps.logger.error({ err }, 'Daily summary: generation failed');
  }
}

function getLocalHour(timestampMs: number): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: TIMEZONE,
  });
  return parseInt(formatter.format(new Date(timestampMs)), 10);
}

function getLocalDateString(timestampMs: number): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: TIMEZONE,
  });
  // sv-SE locale gives YYYY-MM-DD format
  return formatter.format(new Date(timestampMs));
}

/**
 * Get start and end timestamps (ms) for a given local date string (YYYY-MM-DD).
 */
function getDayBounds(dateStr: string): { startTs: number; endTs: number } {
  // Parse date components and create timestamps in the configured timezone
  const [year, month, day] = dateStr.split('-').map(Number);

  // Use a trick: format a known date to find the offset, then compute bounds
  // Create date at midnight UTC, then adjust for timezone
  const midnightUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  // Find the timezone offset by comparing UTC and local representations
  const localStr = midnightUtc.toLocaleString('en-US', { timeZone: TIMEZONE });
  const localDate = new Date(localStr);
  const offsetMs = midnightUtc.getTime() - localDate.getTime();

  const startTs = midnightUtc.getTime() + offsetMs;
  const endTs = startTs + 24 * 60 * 60 * 1000;

  return { startTs, endTs };
}

function generateSummaries(deps: DailySummaryDeps, nowMs: number): void {
  // Yesterday's date in local timezone
  const yesterdayMs = nowMs - 24 * 60 * 60 * 1000;
  const dateStr = getLocalDateString(yesterdayMs);
  const { startTs, endTs } = getDayBounds(dateStr);

  // Get all active users
  let page = 1;
  let processedUsers = 0;
  while (true) {
    const result = listUsers({ status: 'active', page, pageSize: 200 });
    for (const user of result.users) {
      try {
        const generated = generateUserSummary(
          deps,
          user.id,
          user.username,
          dateStr,
          startTs,
          endTs,
        );
        if (generated) processedUsers++;
      } catch (err) {
        deps.logger.error(
          { err, userId: user.id },
          'Daily summary: failed for user',
        );
      }
    }
    if (
      result.users.length < result.pageSize ||
      page * result.pageSize >= result.total
    )
      break;
    page++;
  }

  deps.logger.info(
    { date: dateStr, processedUsers },
    'Daily summary: generation complete',
  );
}

function generateUserSummary(
  deps: DailySummaryDeps,
  userId: string,
  username: string,
  dateStr: string,
  startTs: number,
  endTs: number,
): boolean {
  // Output path: data/groups/user-global/{userId}/daily-summary/YYYY-MM-DD.md
  const summaryDir = path.join(
    deps.dataDir,
    'groups',
    'user-global',
    userId,
    'daily-summary',
  );
  const summaryPath = path.join(summaryDir, `${dateStr}.md`);

  // Idempotent: skip if already exists
  if (fs.existsSync(summaryPath)) {
    deps.logger.debug(
      { userId, date: dateStr },
      'Daily summary: already exists, skipping',
    );
    return false;
  }

  // Get all groups owned by this user
  const groups = getGroupsByOwner(userId);
  if (groups.length === 0) return false;

  // Collect all chat_jids for the user's groups
  const chatJids = groups.map((g) => g.jid);

  // Fetch messages for all jids in the time range
  const sections: string[] = [];
  let totalCount = 0;

  for (const jid of chatJids) {
    const messages = getMessagesByTimeRange(jid, startTs, endTs);
    if (messages.length === 0) continue;

    totalCount += messages.length;
    const lines: string[] = [];

    let prevWasAgent = false;
    for (const msg of messages) {
      const isAgent = msg.is_from_me;
      const sender = isAgent
        ? 'Agent'
        : msg.sender_name || msg.sender || 'User';
      const content = truncate(msg.content || '', 200);

      // Merge consecutive Agent replies
      if (isAgent && prevWasAgent) continue;

      lines.push(`- **${sender}**: ${content}`);
      prevWasAgent = isAgent;
    }

    sections.push(`## ${jid}\n${lines.join('\n')}`);
  }

  if (totalCount === 0) return false;

  // Build markdown content
  const md = `# ${dateStr} 对话汇总\n\n用户: ${username} | 消息数: ${totalCount}\n\n${sections.join('\n\n')}\n`;

  // Write file
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(summaryPath, md, 'utf-8');
  deps.logger.info(
    { userId, date: dateStr, messageCount: totalCount },
    'Daily summary: generated',
  );

  // Update HEARTBEAT.md with latest summaries
  const userGlobalDir = path.join(
    deps.dataDir,
    'groups',
    'user-global',
    userId,
  );
  updateHeartbeat(userGlobalDir, username, deps.logger);

  return true;
}

function truncate(text: string, maxLen: number): string {
  // Replace newlines with spaces for single-line display
  const singleLine = text.replace(/\n/g, ' ').trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen) + '...';
}

const HEARTBEAT_MAX_CHARS = 4096;
const HEARTBEAT_PER_DAY_MAX_CHARS = 1024;
const HEARTBEAT_DAYS = 3;

/**
 * Update HEARTBEAT.md with the most recent daily summaries.
 * Called after a daily summary is generated for a user.
 */
function updateHeartbeat(
  userGlobalDir: string,
  username: string,
  logger: Logger,
): void {
  const summaryDir = path.join(userGlobalDir, 'daily-summary');
  if (!fs.existsSync(summaryDir)) return;

  // Read all .md files sorted by name (YYYY-MM-DD.md) descending, take latest 3
  let files: string[];
  try {
    files = fs
      .readdirSync(summaryDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, HEARTBEAT_DAYS);
  } catch {
    return;
  }

  if (files.length === 0) return;

  // Reverse back to chronological order (oldest first)
  files.reverse();

  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const sections: string[] = [];
  for (const file of files) {
    const dateLabel = file.replace(/\.md$/, '');
    try {
      let content = fs.readFileSync(path.join(summaryDir, file), 'utf-8');
      if (content.length > HEARTBEAT_PER_DAY_MAX_CHARS) {
        content =
          content.slice(0, HEARTBEAT_PER_DAY_MAX_CHARS) + '\n\n[...截断]';
      }
      sections.push(`### ${dateLabel}\n${content}`);
    } catch {
      continue;
    }
  }

  if (sections.length === 0) return;

  let md = `# 近期工作摘要\n\n> 自动生成，最近更新：${timestamp}\n\n## 最近 ${files.length} 天对话汇总\n\n${sections.join('\n\n')}\n`;

  if (md.length > HEARTBEAT_MAX_CHARS) {
    md = md.slice(0, HEARTBEAT_MAX_CHARS) + '\n\n[...截断]';
  }

  const heartbeatPath = path.join(userGlobalDir, 'HEARTBEAT.md');
  try {
    fs.writeFileSync(heartbeatPath, md, 'utf-8');
    logger.info({ username }, 'Daily summary: updated HEARTBEAT.md');
  } catch (err) {
    logger.error(
      { err, username },
      'Daily summary: failed to write HEARTBEAT.md',
    );
  }
}
