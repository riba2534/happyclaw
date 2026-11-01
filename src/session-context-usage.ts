/**
 * How full a conversation's context is, for the ring next to the composer.
 *
 * Read on the host from the SDK transcript of the conversation's current
 * session: the last main-thread request's prompt (input + cache read + cache
 * creation) is what the context held when the model last answered, the same
 * count Claude Code's own context indicator works from. No runner change is
 * needed, so container workspaces running an older image report it too.
 */
import fs from 'node:fs';

import {
  getJidsByFolder,
  getSession,
  getSessionModel,
  getSessionProviderId,
} from './db.js';
import {
  CLAUDE_CODE_DEFAULT_CONTEXT,
  effectiveProviderModels,
  resolveModelCapabilities,
  splitOneMillionSuffix,
  windowOf,
} from './model-providers.js';
import { latestSdkContextWindow } from './run-context-snapshot.js';
import { getProviderById } from './runtime-config.js';
import { sessionTranscriptPath } from './session-workflows.js';

export interface SessionContextUsage {
  usedTokens: number | null;
  contextWindow: number | null;
  /** usedTokens of contextWindow, in percent with one decimal. */
  percentage: number | null;
  /** The upstream model the last request ran on. */
  model: string | null;
  /** When that request's answer was written. */
  updatedAt: string | null;
}

export const NO_CONTEXT_USAGE: SessionContextUsage = {
  usedTokens: null,
  contextWindow: null,
  percentage: null,
  model: null,
  updatedAt: null,
};

/** Transcript bytes read from the end to find the last request. */
const RECENT_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

interface LastRequest {
  usedTokens: number;
  model: string;
  at: string | null;
}

function tokens(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Reads one transcript line: a main-thread answer with its usage, a
 * compaction (the context is now unknown until the next answer), or nothing
 * of interest.
 */
function readLine(line: string): LastRequest | 'compacted' | null {
  if (!line.trim()) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    return 'compacted';
  }
  if (entry.type !== 'assistant' || entry.isSidechain === true) return null;
  const message = entry.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  const model = typeof message?.model === 'string' ? message.model : '';
  if (!usage || !model || model === '<synthetic>') return null;
  const usedTokens =
    tokens(usage.input_tokens) +
    tokens(usage.cache_read_input_tokens) +
    tokens(usage.cache_creation_input_tokens);
  if (usedTokens === 0) return null;
  return {
    usedTokens,
    model,
    at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
  };
}

/**
 * The last `bytes` of a file as whole lines (a line cut at the start is
 * dropped), and whether that was the whole file. Read off the event loop:
 * a turn's push and every GET come here.
 */
async function tailLines(
  file: string,
  bytes: number,
): Promise<{ lines: string[]; whole: boolean }> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return { lines, whole: start === 0 };
  } finally {
    await handle.close();
  }
}

/**
 * The last main-thread request of a transcript, read from its end: the
 * recent tail first, a longer one only when long tool results pushed the
 * last answer further back.
 */
async function lastRequest(transcript: string): Promise<LastRequest | null> {
  for (const bytes of [RECENT_TAIL_BYTES, MAX_TAIL_BYTES]) {
    let tail: Awaited<ReturnType<typeof tailLines>>;
    try {
      tail = await tailLines(transcript, bytes);
    } catch {
      return null;
    }
    for (let index = tail.lines.length - 1; index >= 0; index -= 1) {
      const found = readLine(tail.lines[index]);
      if (found === 'compacted') return null;
      if (found) return found;
    }
    if (tail.whole) return null;
  }
  return null;
}

/**
 * The window Claude Code works with, best known first: what it reported for
 * this conversation's model in this process; else the window the launch
 * derived `[1m]` and the compact window from (windowOf: the connection
 * model's declared window, 1M for a name saved with `[1m]`); else Claude
 * Code's default.
 */
function contextWindowFor(
  groupFolder: string,
  agentId: string,
  model: string,
  launchModel: string | null,
): number {
  const reported = latestSdkContextWindow(
    getJidsByFolder(groupFolder),
    agentId,
    [model, ...(launchModel ? [launchModel] : [])],
  );
  if (reported) return reported;
  const providerId = getSessionProviderId(groupFolder, agentId);
  const provider = providerId ? getProviderById(providerId) : null;
  const models =
    provider && !provider.codexOAuthCredentials
      ? effectiveProviderModels(provider)
      : [];
  return windowOf(models, launchModel || model) ?? CLAUDE_CODE_DEFAULT_CONTEXT;
}

/**
 * How full one session's context is now. Everything is null when there is no
 * session (`agentId` null), it has no SDK session (nothing ran yet, or it was
 * cleared) or its context was just compacted.
 */
export async function readSessionContextUsage(
  groupFolder: string,
  agentId: string | null,
): Promise<SessionContextUsage> {
  if (!agentId) return NO_CONTEXT_USAGE;
  const sessionId = getSession(groupFolder, agentId);
  if (!sessionId) return NO_CONTEXT_USAGE;
  const transcript = sessionTranscriptPath(groupFolder, agentId, sessionId);
  const last = transcript ? await lastRequest(transcript) : null;
  // Cleared or replaced while the transcript was read: it is not this one's.
  if (!last || getSession(groupFolder, agentId) !== sessionId) {
    return NO_CONTEXT_USAGE;
  }
  const launchModel = getSessionModel(groupFolder, agentId);
  let contextWindow = contextWindowFor(
    groupFolder,
    agentId,
    last.model,
    launchModel,
  );
  // A prompt larger than the window proves the window larger: the model's
  // own is the next best guess.
  if (last.usedTokens > contextWindow) {
    contextWindow = Math.max(
      contextWindow,
      resolveModelCapabilities({
        id: splitOneMillionSuffix(launchModel || last.model).model,
      }).suggestedContextWindow ?? 0,
    );
  }
  return {
    usedTokens: last.usedTokens,
    contextWindow,
    // Still over: the real window is unknown here, so the ring is shown
    // full rather than past 100%.
    percentage: Math.min(
      100,
      Math.round((last.usedTokens / contextWindow) * 1000) / 10,
    ),
    model: last.model,
    updatedAt: last.at,
  };
}
