// Pure session-history utilities — extracted from index.ts to enable
// unit testing without pulling in the full agent-runner module graph.

import fs from 'fs';
import path from 'path';

import type { ParsedMessage } from './types.js';

const RECOVERY_HISTORY_LIMIT = 20;
const RECOVERY_MESSAGE_TRUNCATE = 500;

// Strip lone (unpaired) surrogates while preserving valid surrogate pairs
// such as emoji. Must stay byte-for-byte aligned with the matching regex
// in src/index.ts (recoveryGroups path) — both sides feed the same Anthropic
// API and must produce identical strings to keep behavior consistent across
// the agent-runner-side and main-process-side recovery codepaths.
const LONE_SURROGATE_RE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g;

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Tolerate malformed JSONL lines silently — partial recovery is better
      // than failing the whole resume path on a single corrupt entry.
    }
  }

  return messages;
}

export interface ExtractSessionHistoryOptions {
  /** Directory containing the SDK transcript files (e.g. ~/.claude/projects/<encoded-cwd>) */
  transcriptDir: string;
  /** Session ID to extract history for. The function reads `${transcriptDir}/${sessionId}.jsonl`. */
  sessionId: string;
  /** Optional logger for debug breadcrumbs. Defaults to no-op. */
  log?: (msg: string) => void;
}

/**
 * Extract recent conversation history from a session's JSONL transcript and
 * format it as a `<system_context>` block suitable for prompt injection.
 *
 * Returns null when:
 * - the transcript file does not exist
 * - the transcript contains zero recoverable messages
 * - any I/O error occurs
 *
 * Behavior is intentionally tolerant — recovery is best-effort.
 */
export function extractSessionHistory(
  opts: ExtractSessionHistoryOptions,
): string | null {
  const { transcriptDir, sessionId, log = () => {} } = opts;

  try {
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) {
      log(`Session transcript not found at ${transcriptPath}`);
      return null;
    }

    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return null;

    const recentMessages = messages.slice(-RECOVERY_HISTORY_LIMIT);

    const historyLines = recentMessages.map((m) => {
      const role = m.role === 'user' ? 'User' : 'HappyClaw';
      const truncated =
        m.content.length > RECOVERY_MESSAGE_TRUNCATE
          ? m.content.slice(0, RECOVERY_MESSAGE_TRUNCATE) + '…'
          : m.content;
      const cleaned = truncated.replace(LONE_SURROGATE_RE, '');
      return `[${role}] ${cleaned}`;
    });

    log(
      `Extracted ${recentMessages.length} messages from old session ${sessionId} for context injection`,
    );

    return (
      '<system_context>\n' +
      '会话恢复失败，当前为新会话。以下是之前的对话记录，供你了解上下文（请基于这些上下文继续对话）：\n\n' +
      historyLines.join('\n') +
      '\n</system_context>\n\n'
    );
  } catch (err) {
    opts.log?.(
      `Failed to extract session history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// Test-only re-exports for assertions on internal constants.
export const __test__ = {
  RECOVERY_HISTORY_LIMIT,
  RECOVERY_MESSAGE_TRUNCATE,
  LONE_SURROGATE_RE,
};
