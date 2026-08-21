import fs from 'fs';

export type SessionTrimLogger = (message: string) => void;

const PENDING_LAUNCH_STATUSES = new Set(['async_launched', 'remote_launched']);

type TranscriptEntry = Record<string, unknown>;

function defaultLog(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'text' in item) {
        return typeof item.text === 'string' ? item.text : '';
      }
      if (item && typeof item === 'object' && 'content' in item) {
        return collectText(item.content);
      }
      return '';
    })
    .join('');
}

function transcriptText(parsed: TranscriptEntry): string {
  const message = parsed.message;
  if (message && typeof message === 'object' && 'content' in message) {
    const fromMessage = collectText((message as { content?: unknown }).content);
    if (fromMessage) return fromMessage;
  }
  return collectText(parsed.content);
}

function launchAgentId(parsed: TranscriptEntry): string | undefined {
  const result = parsed.toolUseResult;
  if (!result || typeof result !== 'object') return undefined;
  const status = (result as { status?: unknown }).status;
  if (typeof status !== 'string' || !PENDING_LAUNCH_STATUSES.has(status)) {
    return undefined;
  }
  const agentId = (result as { agentId?: unknown }).agentId;
  const taskId = (result as { taskId?: unknown }).taskId;
  if (typeof agentId === 'string' && agentId) return agentId;
  if (typeof taskId === 'string' && taskId) return taskId;
  return undefined;
}

/**
 * SDK resume treats `async_launched` / `remote_launched` without a matching
 * `<task-notification><task-id>…</task-id>` as an orphan. Keep those launch
 * records when they would otherwise be deleted before compact_boundary.
 */
function unfinishedLaunchLines(
  removedRegion: { line: string }[],
  allLines: { line: string }[],
): string[] {
  const pending: { agentId: string; line: string }[] = [];
  for (const entry of removedRegion) {
    try {
      const parsed = JSON.parse(entry.line) as TranscriptEntry;
      const agentId = launchAgentId(parsed);
      if (agentId) pending.push({ agentId, line: entry.line });
    } catch {
      /* skip unparseable */
    }
  }
  if (pending.length === 0) return [];

  const completed = new Set<string>();
  for (const entry of allLines) {
    try {
      const parsed = JSON.parse(entry.line) as TranscriptEntry;
      const content = transcriptText(parsed);
      if (!content.includes('<task-notification>')) continue;
      for (const launch of pending) {
        if (content.includes(`<task-id>${launch.agentId}</task-id>`)) {
          completed.add(launch.agentId);
        }
      }
    } catch {
      /* skip unparseable */
    }
  }

  return pending
    .filter((launch) => !completed.has(launch.agentId))
    .map((launch) => launch.line);
}

/**
 * Trim session JSONL file by removing all entries before the last compact_boundary.
 * After compaction, entries before the boundary are already summarized and no longer
 * needed for session reconstruction. This prevents unbounded file growth.
 *
 * Safety: uses atomic write (tmp + rename) to avoid data loss on crash.
 */
export function trimSessionJsonl(
  jsonlPath: string,
  log: SessionTrimLogger = defaultLog,
): void {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n');
    const nonEmptyLines: { index: number; line: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) nonEmptyLines.push({ index: i, line: lines[i] });
    }

    // Find the last compact_boundary entry (and any preserved segment it references)
    let lastBoundaryPos = -1;
    let preservedHeadUuid: string | undefined;
    let parseSkipped = 0;
    for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(nonEmptyLines[i].line);
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          lastBoundaryPos = i;
          preservedHeadUuid =
            entry.compact_metadata?.preserved_segment?.head_uuid;
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

    // partial compaction 时 boundary 带 preserved_segment{head_uuid, anchor_uuid, tail_uuid}：
    // 保留段内容是 head_uuid..tail_uuid，SDK 的 resume loader 会在 anchor_uuid 处把它拼回。
    // 若裁切越过 head_uuid，会连同这些消息及其 uuid 一起删掉，导致 loader 找不到锚点、resume
    // 丢上下文。因此把裁切起点回退到 head_uuid 所在行，保住整段保留消息。
    let trimStartPos = lastBoundaryPos;
    if (preservedHeadUuid) {
      const preservedPos = nonEmptyLines.findIndex((e) => {
        try {
          return JSON.parse(e.line).uuid === preservedHeadUuid;
        } catch {
          return false;
        }
      });
      if (preservedPos >= 0 && preservedPos < trimStartPos) {
        trimStartPos = preservedPos;
        log(
          `Session trim: preserving segment from head_uuid=${preservedHeadUuid.slice(0, 8)} (pos ${preservedPos} < boundary ${lastBoundaryPos})`,
        );
      }
    }

    const removedRegion = nonEmptyLines.slice(0, trimStartPos);
    const keptRegion = nonEmptyLines.slice(trimStartPos);
    const preservedLaunchLines = unfinishedLaunchLines(
      removedRegion,
      nonEmptyLines,
    );
    if (preservedLaunchLines.length > 0) {
      log(
        `Session trim: preserving ${preservedLaunchLines.length} pending async_launched entries to prevent orphan detection`,
      );
    }

    // Keep unfinished Task launch records + entries from trimStartPos onwards
    const trimmedLines = [
      ...preservedLaunchLines,
      ...keptRegion.map((e) => e.line),
    ];
    const historyBeforeBoundary = trimStartPos;
    const removedCount = historyBeforeBoundary - preservedLaunchLines.length;

    const TRIM_MIN_ENTRIES = 50; // Skip trimming if fewer entries before boundary (not worth the I/O)
    if (historyBeforeBoundary < TRIM_MIN_ENTRIES) {
      log(
        `Session trim: only ${historyBeforeBoundary} entries before boundary, skipping`,
      );
      return;
    }

    // Atomic write: temp file + rename
    const tmpPath = jsonlPath + '.trim-tmp';
    fs.writeFileSync(tmpPath, trimmedLines.join('\n') + '\n');
    fs.renameSync(tmpPath, jsonlPath);

    const sizeBefore = Buffer.byteLength(content, 'utf-8');
    const sizeAfter = fs.statSync(jsonlPath).size;
    log(
      `Session trim: ${nonEmptyLines.length} → ${trimmedLines.length} entries (removed ${removedCount}), ` +
        `${(sizeBefore / 1024 / 1024).toFixed(1)}MB → ${(sizeAfter / 1024 / 1024).toFixed(1)}MB`,
    );
  } catch (err) {
    log(
      `Session trim failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
