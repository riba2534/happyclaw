// Utility functions

import fs from 'fs';
import path from 'path';

import { DATA_DIR, TRUST_PROXY } from './config.js';

/**
 * Strip agent-internal XML tags from output text.
 * Removes `<internal>...</internal>` and `<process>...</process>` blocks
 * that the agent uses for internal reasoning / process tracking.
 */
export function stripAgentInternalTags(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<process>[\s\S]*?<\/process>/g, '')
    .trim();
}

/**
 * True when the agent deliberately answered with nothing but non-empty
 * `<internal>`/`<process>` blocks — a complete, intentionally silent final
 * (e.g. a scheduled pipeline stage confirming "done" without notifying).
 */
export function isInternalOnlyAgentOutput(
  text: string | null | undefined,
): boolean {
  if (!text?.trim() || stripAgentInternalTags(text) !== '') return false;
  // Nothing outside the blocks survived, so any non-tag text left is block
  // content. Empty or nested-empty blocks leave only whitespace.
  return text.replace(/<\/?(?:internal|process)>/g, '').trim() !== '';
}

/** Workspace notice for a scheduled run that ended silently on purpose. */
export const SCHEDULED_TASK_SILENT_COMPLETION_NOTICE =
  'Agent 已按任务要求以内部确认静默完成，没有面向用户的输出。';

/**
 * Detect whether an agent output is system-maintenance noise that should
 * be suppressed from IM delivery when sourceKind is 'auto_continue'.
 *
 * These are short acknowledgements that the agent generates when its session
 * transcript contains memory-flush / CLAUDE.md-update context from the
 * compaction pipeline (issue #275). Substantive user-facing continuations
 * (task resumption, actual replies) are NOT noise and must pass through.
 *
 * Heuristic: text is "noise" if it is short (<= 30 chars) AND matches a
 * known system-acknowledgement pattern after normalisation.
 */
const NOISE_PATTERNS = [
  /^ok[.。!！]?$/,
  /^好的[.。!！]?$/,
  /^已更新/,
  /^已完成/,
  /^已刷新/,
  /^记忆已/,
  /^claude\.md\s*已/,
  /^memory\s*(flush|updated)/i,
];

export function isSystemMaintenanceNoise(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length > 30) return false;
  return NOISE_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Strip virtual JID suffixes (#task:xxx, #agent:xxx) to get the base JID.
 */
export function stripVirtualJidSuffix(jid: string): string {
  const taskSep = jid.indexOf('#task:');
  if (taskSep >= 0) return jid.slice(0, taskSep);
  const agentSep = jid.indexOf('#agent:');
  if (agentSep >= 0) return jid.slice(0, agentSep);
  return jid;
}

/**
 * Escape a value for safe inclusion in a CSV cell. Covers two concerns:
 *  1. CSV/formula injection — spreadsheet apps execute a cell whose text starts
 *     with `= + - @` (or a leading tab/CR). Prefix a single quote so the value
 *     is treated as literal text. Must be applied to every user-controllable
 *     field exported to CSV.
 *  2. Delimiter quoting — wrap in double quotes (doubling any internal quote)
 *     when the value contains a comma, quote, or newline.
 */
export function escapeCsvField(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Resolve a path to its real (symlink-followed) form on a best-effort basis.
 * If the path doesn't exist yet, walk up to the nearest existing ancestor,
 * resolve THAT, then re-append the not-yet-existing tail — so a not-yet-created
 * leaf under a symlinked parent is still resolved correctly.
 */
function realpathBestEffort(p: string): string {
  let checkPath = path.resolve(p);
  const tail: string[] = [];
  while (checkPath !== path.dirname(checkPath)) {
    if (fs.existsSync(checkPath)) {
      const real = fs.realpathSync(checkPath);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    }
    tail.push(path.basename(checkPath));
    checkPath = path.dirname(checkPath);
  }
  return path.resolve(p);
}

/**
 * Whether `target` resolves (after following symlinks) to a location inside at
 * least one of `roots`. A lexical startsWith check is insufficient: a symlink
 * whose lexical path is inside a root can still point outside it. Both target
 * AND each root are resolved with realpathBestEffort so the comparison stays
 * symmetric even when a root is reached through a symlinked parent or does not
 * exist yet (resolving only one side caused a false-negative rejection).
 *
 * Single source of truth for the symlink-escape guard shared by IM file
 * delivery (index.ts) and memory read/write (routes/memory.ts). NOTE: this is a
 * point-in-time check; callers that then open the path by its lexical form
 * remain subject to a check-then-use (TOCTOU) race if a path component is
 * swapped between the check and the open.
 */
export function isRealpathInside(
  target: string,
  roots: string | string[],
): boolean {
  const rootList = Array.isArray(roots) ? roots : [roots];
  let realTarget: string;
  try {
    realTarget = realpathBestEffort(target);
  } catch {
    return false;
  }
  return rootList.some((root) => {
    let realRoot: string;
    try {
      realRoot = realpathBestEffort(root);
    } catch {
      return false;
    }
    return (
      realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)
    );
  });
}

export function getClientIp(c: any): string {
  if (TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const firstIp = xff.split(',')[0]?.trim();
      if (firstIp) return firstIp;
    }
    const realIp = c.req.header('x-real-ip');
    if (realIp) return realIp;
  }
  // Fallback: connection remote address (Hono + Node.js adapter)
  // Hono Node.js adapter 将 IncomingMessage 存于 c.env.incoming
  const connInfo =
    c.env?.incoming?.socket?.remoteAddress ||
    c.env?.remoteAddr ||
    c.req.raw?.socket?.remoteAddress;
  return connInfo || 'unknown';
}

/** Detect if the current request arrived over HTTPS (direct or behind proxy) */
export function isSecureRequest(c: any): boolean {
  if (TRUST_PROXY) {
    const proto = c.req.header('x-forwarded-proto');
    if (proto === 'https') return true;
  }
  try {
    const url = new URL(c.req.url, 'http://localhost');
    if (url.protocol === 'https:') return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Create IPC + session directories for an agent. */
export function ensureAgentDirectories(
  folder: string,
  agentId: string,
): string {
  const agentIpcDir = path.join(DATA_DIR, 'ipc', folder, 'agents', agentId);
  fs.mkdirSync(path.join(agentIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(
    path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, '.claude'),
    { recursive: true },
  );
  return agentIpcDir;
}
