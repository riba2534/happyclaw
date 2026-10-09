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

export function readUsageBaseline(
  transcriptDir: string,
  sessionId: string,
): PersistedUsageBaseline | null {
  const file = usageBaselinePath(transcriptDir, sessionId);
  if (!file) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPersistedUsageBaseline(parsed, sessionId) ? parsed : null;
  } catch {
    return null;
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
