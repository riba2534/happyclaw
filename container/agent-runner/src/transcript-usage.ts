import { readFileSync } from 'node:fs';

import {
  parseAssistantUsage,
  type CollectedAssistantUsage,
  type TranscriptUsageLoader,
} from './assistant-usage.js';

/**
 * Scans the session transcript JSONL and returns final usage per assistant
 * message ID (largest snapshot wins, matching the live collector contract).
 *
 * The CLI merges final usage numbers (from message_delta) into the assistant
 * messages it persists, while the live SDK messages may only carry the
 * all-zero message_start placeholder. Providers whose usage only arrives at
 * response completion (Codex gateway, GLM proxy, ...) therefore stream zero
 * snapshots end-to-end, and the transcript is the only source carrying the
 * real bill. Lines are pre-filtered by cheap substring checks before
 * JSON.parse to keep the scan proportional to I/O, not object allocation.
 */
export function loadTranscriptAssistantUsage(
  transcriptPath: string,
): Map<string, CollectedAssistantUsage> {
  const result = new Map<string, CollectedAssistantUsage>();
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return result;
  }
  for (const line of raw.split('\n')) {
    // Cheap line-level prefilter before paying JSON.parse per line.
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const usage = parseAssistantUsage(parsed as Record<string, unknown>);
    if (!usage) continue;
    const previous = result.get(usage.id);
    if (!previous || usage.total > previous.total) {
      result.set(usage.id, usage);
    }
  }
  return result;
}

/**
 * Builds a TranscriptUsageLoader bound to the current session's transcript
 * file. The first lookup performs one full-file scan and caches the complete
 * per-ID map, so the drain loop's per-message invocations share a single
 * read; a lookup for an ID absent from the cache triggers exactly one rescan
 * (the transcript is append-only and the message may have been flushed to
 * disk after the previous scan).
 */
export function createTranscriptUsageLoader(
  resolveTranscriptPath: () => string | undefined,
): TranscriptUsageLoader {
  let cached: {
    transcriptPath: string;
    usage: Map<string, CollectedAssistantUsage>;
  } | null = null;
  return (ids) => {
    const hits = new Map<string, CollectedAssistantUsage>();
    const transcriptPath = resolveTranscriptPath();
    if (!transcriptPath) return hits;
    if (cached && cached.transcriptPath === transcriptPath) {
      let allKnown = true;
      for (const id of ids) {
        const hit = cached.usage.get(id);
        if (hit) hits.set(id, hit);
        else allKnown = false;
      }
      if (allKnown) return hits;
    }
    const usage = loadTranscriptAssistantUsage(transcriptPath);
    cached = { transcriptPath, usage };
    for (const id of ids) {
      const hit = usage.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  };
}
