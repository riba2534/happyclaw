import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveAgyBinary } from './models.js';
import { resolveAgyProfileHomeDir } from './oauth.js';

const execFileAsync = promisify(execFile);

export interface AgyQuotaWindow {
  label: string;
  windowKind: 'five_hour' | 'weekly' | 'other';
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
  resetsAtRaw: string | null;
}

export interface AgyQuotaGroup {
  group: string;
  fiveHour: AgyQuotaWindow | null;
  weekly: AgyQuotaWindow | null;
  others: AgyQuotaWindow[];
}

export interface AgyQuotaUsage {
  kind: 'agy_quotas';
  groups: AgyQuotaGroup[];
  fetchedAt: string;
  error?: string;
}

const CACHE_TTL_MS = 60_000;
const usageCache = new Map<string, { value: AgyQuotaUsage; expiresAt: number }>();

const QUOTA_ROW_RE = /^(.+?)\s{2,}(.+?)\s+(\d+(?:\.\d+)?)%(?:\s+(.+?))?\s*$/;

const TZ_OFFSETS: Readonly<Record<string, string>> = {
  UTC: '+00:00',
  GMT: '+00:00',
  CST: '+08:00',
  HKT: '+08:00',
  SGT: '+08:00',
  JST: '+09:00',
  KST: '+09:00',
  PST: '-08:00',
  PDT: '-07:00',
  EST: '-05:00',
  EDT: '-04:00',
};

/**
 * Parse timestamps like `2026-11-20 20:08 CST` or ISO strings into an ISO 8601
 * string so the frontend can display a countdown.
 */
export function parseAgyResetTimestamp(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const localTzMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\s+([A-Z]{2,5}|[+-]\d{2}:?\d{2}))?$/,
  );
  if (localTzMatch) {
    const [, date, hm, sec = '00', tz] = localTzMatch;
    if (tz) {
      const offset = TZ_OFFSETS[tz] ?? (tz.startsWith('+') || tz.startsWith('-') ? tz : null);
      if (offset) {
        const normalizedOffset =
          offset.length === 5 ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset;
        const parsed = Date.parse(`${date}T${hm}:${sec}${normalizedOffset}`);
        if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
      }
    }
    const localParsed = Date.parse(`${date}T${hm}:${sec}`);
    if (!Number.isNaN(localParsed)) return new Date(localParsed).toISOString();
  }

  const fallback = Date.parse(trimmed);
  return Number.isNaN(fallback) ? null : new Date(fallback).toISOString();
}

function classifyWindow(label: string): 'five_hour' | 'weekly' | 'other' {
  const lower = label.toLowerCase();
  if (lower.includes('five hour') || lower.includes('5 hour') || lower.includes('5h')) {
    return 'five_hour';
  }
  if (lower.includes('weekly') || lower.includes('week') || lower.includes('7d')) {
    return 'weekly';
  }
  return 'other';
}

/**
 * Parse `agy -p "/usage"` stdout into structured per-group 5-hour & weekly quotas.
 */
export function parseAgyUsageOutput(
  raw: string,
  fetchedAt = new Date().toISOString(),
): AgyQuotaUsage {
  const groupMap = new Map<string, AgyQuotaGroup>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!line || line === 'Quota:' || line.startsWith('Quota:')) continue;

    let groupName: string;
    let rawLabel: string;
    let pctStr: string;
    let resetRaw: string | undefined;

    if (line.includes('\t')) {
      const cols = line.split('\t').map((c) => c.trim());
      if (cols.length < 3) continue;
      const pctMatch = cols[2].match(/^(\d+(?:\.\d+)?)%$/);
      if (!pctMatch) continue;
      [groupName, rawLabel, , resetRaw] = cols;
      pctStr = pctMatch[1];
    } else {
      const match = line.match(QUOTA_ROW_RE);
      if (!match) continue;
      [, groupName, rawLabel, pctStr, resetRaw] = match;
    }

    const remaining = Math.max(0, Math.min(100, Number(pctStr)));
    if (!Number.isFinite(remaining)) continue;

    const used = Math.round((100 - remaining) * 10) / 10;
    const windowKind = classifyWindow(rawLabel);
    const window: AgyQuotaWindow = {
      label: rawLabel.trim(),
      windowKind,
      remainingPercent: remaining,
      usedPercent: used,
      resetsAt: parseAgyResetTimestamp(resetRaw),
      resetsAtRaw: resetRaw?.trim() || null,
    };

    const key = groupName.trim();
    let entry = groupMap.get(key);
    if (!entry) {
      entry = { group: key, fiveHour: null, weekly: null, others: [] };
      groupMap.set(key, entry);
    }

    if (windowKind === 'five_hour' && !entry.fiveHour) {
      entry.fiveHour = window;
    } else if (windowKind === 'weekly' && !entry.weekly) {
      entry.weekly = window;
    } else {
      entry.others.push(window);
    }
  }

  return {
    kind: 'agy_quotas',
    groups: [...groupMap.values()],
    fetchedAt,
  };
}

/**
 * Query live quota usage for an AGY provider using its isolated profile HOME
 * (cached for 60 seconds per provider).
 */
export async function fetchAgyProviderUsage(options: {
  providerId: string;
  agyProfileId?: string | null;
  forceRefresh?: boolean;
}): Promise<AgyQuotaUsage> {
  const now = Date.now();
  const cached = usageCache.get(options.providerId);
  if (!options.forceRefresh && cached && cached.expiresAt > now) {
    return cached.value;
  }

  const agyBin = resolveAgyBinary();
  const homeDir = resolveAgyProfileHomeDir(options.agyProfileId);
  const env: NodeJS.ProcessEnv = homeDir
    ? { ...process.env, HOME: homeDir }
    : process.env;

  try {
    const { stdout, stderr } = await execFileAsync(agyBin, ['-p', '/usage'], {
      timeout: 15_000,
      maxBuffer: 512 * 1024,
      env,
    });
    // `agy -p "/usage"` may emit the quota table on stdout or stderr depending
    // on TTY/CLI version; parse both streams together.
    const parsed = parseAgyUsageOutput(`${stdout}\n${stderr}`);
    usageCache.set(options.providerId, {
      value: parsed,
      expiresAt: now + CACHE_TTL_MS,
    });
    return parsed;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : '获取 AGY 配额信息失败';
    return {
      kind: 'agy_quotas',
      groups: cached?.value.groups ?? [],
      fetchedAt: new Date().toISOString(),
      error: message,
    };
  }
}
