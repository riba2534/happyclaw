import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import {
  isPersistedUsageBaseline,
  type PersistedUsageBaseline,
} from './result-usage.js';

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Sidecar next to the session transcript holding the last cumulative
 * modelUsage this runner reconciled. Claude Code restores those totals when
 * the session is resumed, so the next process needs them as its baseline.
 */
export function usageBaselinePath(
  transcriptDir: string,
  sessionId: string,
): string | undefined {
  if (!SAFE_SESSION_ID.test(sessionId)) return undefined;
  return path.join(transcriptDir, `${sessionId}.happyclaw-usage.json`);
}

/**
 * Read the session's baseline. A missing file means the session has none. A
 * file that exists but cannot be read or recognised is moved aside: leaving
 * it would let a later process read it once the error clears and difference
 * against totals older than this process's billing, charging that usage
 * twice. Without it the session takes the clean re-baseline path.
 */
export function readUsageBaseline(
  transcriptDir: string,
  sessionId: string,
  warn?: (message: string) => void,
): PersistedUsageBaseline | null {
  const file = usageBaselinePath(transcriptDir, sessionId);
  if (!file) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    moveAside(file, `unreadable (${errorText(err)})`, warn);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (isPersistedUsageBaseline(parsed, sessionId)) return parsed;
  moveAside(file, 'unrecognised', warn);
  return null;
}

function errorText(err: unknown): string {
  return (
    (err as NodeJS.ErrnoException)?.code ||
    (err instanceof Error ? err.message : String(err))
  );
}

function moveAside(
  file: string,
  reason: string,
  warn: ((message: string) => void) | undefined,
): void {
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
    warn?.(
      `Usage baseline ${reason}; moved to ${path.basename(aside)}, the session re-baselines from its next result`,
    );
    return;
  } catch (renameErr) {
    try {
      fs.unlinkSync(file);
      warn?.(
        `Usage baseline ${reason}; could not move it aside (${errorText(renameErr)}), removed it`,
      );
    } catch (removeErr) {
      warn?.(
        `Usage baseline ${reason} and could not be moved aside (${errorText(renameErr)}) or removed (${errorText(removeErr)}); a later process may bill restored usage twice`,
      );
    }
  }
}

/** Atomic replace so a killed runner never leaves a torn baseline. */
export function writeUsageBaseline(
  transcriptDir: string,
  baseline: PersistedUsageBaseline,
): void {
  const file = usageBaselinePath(transcriptDir, baseline.sessionId);
  if (!file) return;
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(baseline)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already renamed */
    }
  }
}
