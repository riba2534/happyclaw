import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import path from 'node:path';

import {
  parseAssistantUsage,
  type CollectedAssistantUsage,
  type TranscriptUsageLoader,
} from './assistant-usage.js';

/**
 * Scans a transcript JSONL and returns final usage per assistant message ID
 * (largest snapshot wins, matching the live collector contract).
 *
 * The CLI persists assistant messages with the final usage from
 * message_delta, while the live SDK messages carry message_start's
 * placeholder output count (and an all-zero snapshot on providers such as
 * the Codex gateway or GLM proxies that report usage only at completion).
 * Lines are pre-filtered by cheap substring checks before JSON.parse to keep
 * the scan proportional to I/O, not object allocation.
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
    if (line) ingestTranscriptLine(line, result);
  }
  return result;
}

const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Locate a subagent's sidechain transcript:
 * `<session>/subagents/agent-<agentId>.jsonl`, or the same file name nested
 * deeper (Workflow agents live under `subagents/workflows/<run>/`).
 */
export function resolveSidechainTranscriptPath(
  mainTranscriptPath: string,
  agentId: string,
): string | undefined {
  if (!SAFE_AGENT_ID.test(agentId)) return undefined;
  const root = path.join(
    mainTranscriptPath.replace(/\.jsonl$/, ''),
    'subagents',
  );
  const fileName = `agent-${agentId}.jsonl`;
  const direct = path.join(root, fileName);
  if (existsSync(direct)) return direct;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === fileName) return full;
    }
  }
  return undefined;
}

interface TranscriptScanState {
  ino: number;
  offset: number;
  remainder: Buffer;
  usage: Map<string, CollectedAssistantUsage>;
}

function ingestTranscriptLine(
  line: string,
  usageById: Map<string, CollectedAssistantUsage>,
): void {
  // Cheap line-level prefilter before paying JSON.parse per line.
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const usage = parseAssistantUsage(parsed as Record<string, unknown>);
  if (!usage) return;
  const previous = usageById.get(usage.id);
  if (!previous || usage.total > previous.total) usageById.set(usage.id, usage);
}

/**
 * Read only the bytes appended since the previous scan. A replaced file (new
 * inode, e.g. Claude Code's transcript GC) or a shorter one is rescanned
 * from the start; an unterminated last line is retried on the next scan
 * unless it already parses as a complete entry.
 */
function scanTranscript(
  transcriptPath: string,
  previous: TranscriptScanState | undefined,
): TranscriptScanState | undefined {
  let stat: Stats;
  try {
    stat = statSync(transcriptPath);
  } catch {
    return previous;
  }
  let state = previous;
  if (!state || state.ino !== stat.ino || stat.size < state.offset) {
    state = {
      ino: stat.ino,
      offset: 0,
      remainder: Buffer.alloc(0),
      usage: state?.usage ?? new Map(),
    };
  }
  if (stat.size === state.offset) return state;
  let chunk: Buffer;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      chunk = Buffer.alloc(stat.size - state.offset);
      let read = 0;
      while (read < chunk.length) {
        const bytes = readSync(
          fd,
          chunk,
          read,
          chunk.length - read,
          state.offset + read,
        );
        if (bytes <= 0) break;
        read += bytes;
      }
      chunk = chunk.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return state;
  }
  const buffer = Buffer.concat([state.remainder, chunk]);
  const lastNewline = buffer.lastIndexOf(10);
  const complete = buffer.subarray(0, lastNewline + 1).toString('utf8');
  for (const line of complete.split('\n')) {
    if (line) ingestTranscriptLine(line, state.usage);
  }
  const tail = buffer.subarray(lastNewline + 1);
  state.remainder = Buffer.alloc(0);
  if (tail.length > 0) {
    const tailText = tail.toString('utf8');
    let tailComplete = true;
    try {
      JSON.parse(tailText);
    } catch {
      tailComplete = false;
    }
    if (tailComplete) ingestTranscriptLine(tailText, state.usage);
    else state.remainder = Buffer.from(tail);
  }
  state.offset += chunk.length;
  return state;
}

/**
 * Builds a TranscriptUsageLoader bound to the current session's transcript.
 * Each lookup reads only what was appended since the previous one, so the
 * collector can consult the transcript for every flushed message without
 * rescanning a long session. Subagent lookups read the sidechain file.
 */
export function createTranscriptUsageLoader(
  resolveTranscriptPath: () => string | undefined,
): TranscriptUsageLoader {
  const states = new Map<string, TranscriptScanState>();
  return (ids, agentId) => {
    const hits = new Map<string, CollectedAssistantUsage>();
    const mainPath = resolveTranscriptPath();
    if (!mainPath) return hits;
    const transcriptPath = agentId
      ? resolveSidechainTranscriptPath(mainPath, agentId)
      : mainPath;
    if (!transcriptPath) return hits;
    const state = scanTranscript(transcriptPath, states.get(transcriptPath));
    if (!state) return hits;
    states.set(transcriptPath, state);
    for (const id of ids) {
      const hit = state.usage.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  };
}
