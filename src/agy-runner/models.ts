import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ModelEffort, ProviderModelEntry } from '../model-providers.js';

const execFileAsync = promisify(execFile);

const AGY_MODEL_LINE_RE = /^([a-zA-Z0-9._:/-]+)\s+(.+?)\s*$/;
const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i;

export const DEFAULT_AGY_MODEL = 'gemini-4-neon-medium';

/**
 * Resolve the `agy` CLI binary path. Checks explicit override, PATH, and
 * standard user install locations so process managers (pm2/launchd) work even
 * when their PATH omits `~/.gemini/antigravity-cli/bin`.
 */
export function resolveAgyBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HAPPYCLAW_AGY_BIN?.trim();
  if (override) return override;

  const home = env.HOME || os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy'),
    path.join(home, '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return 'agy';
}

function inferAgyContextWindow(slug: string): number | undefined {
  const lower = slug.toLowerCase();
  if (lower.startsWith('gemini-4-') || lower.startsWith('gemini-3')) {
    return 1_000_000;
  }
  if (lower.startsWith('claude-')) {
    return 200_000;
  }
  return undefined;
}

function inferAgyVendor(slug: string): string | undefined {
  const lower = slug.toLowerCase();
  if (lower.startsWith('gemini-')) return 'google';
  if (lower.startsWith('claude-')) return 'anthropic';
  if (lower.startsWith('gpt-')) return 'openai';
  return 'antigravity';
}

function inferAgyDefaultEffort(slug: string): ModelEffort | undefined {
  const match = slug.match(EFFORT_SUFFIX_RE);
  if (!match) return undefined;
  const level = match[1].toLowerCase() as ModelEffort;
  return level;
}

/**
 * Parse `agy models` stdout lines (`<slug>  <Display Name>`) into HappyClaw
 * `ProviderModelEntry` items.
 */
export function parseAgyModelsOutput(raw: string): ProviderModelEntry[] {
  const entries: ProviderModelEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of raw.split(/\r?\n/)) {
    // Strip ANSI escape codes and keep the last carriage-return frame (spinner)
    const lastFrame = rawLine.split('\r').pop() ?? '';
    const cleaned = lastFrame.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!cleaned) continue;

    const match = cleaned.match(AGY_MODEL_LINE_RE);
    if (!match) continue;
    const [, id, displayName] = match;
    if (seen.has(id)) continue;
    seen.add(id);

    const contextWindow = inferAgyContextWindow(id);
    const defaultEffort = inferAgyDefaultEffort(id);
    const vendor = inferAgyVendor(id);

    entries.push({
      id,
      displayName,
      ...(contextWindow ? { contextWindow } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(vendor ? { vendor } : {}),
      thinks: true,
    });
  }

  return entries;
}

/**
 * Discover available models from the `agy` CLI. When `homeDir` is provided,
 * runs with `HOME=homeDir` so an isolated per-provider AGY OAuth profile is used.
 */
export async function discoverAgyModels(
  options: number | { timeoutMs?: number; homeDir?: string } = 15_000,
): Promise<ProviderModelEntry[]> {
  const timeoutMs =
    typeof options === 'number' ? options : (options.timeoutMs ?? 15_000);
  const homeDir = typeof options === 'number' ? undefined : options.homeDir;
  const agyBin = resolveAgyBinary();
  const env: NodeJS.ProcessEnv = homeDir
    ? { ...process.env, HOME: homeDir }
    : process.env;
  const { stdout } = await execFileAsync(agyBin, ['models'], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env,
  });
  return parseAgyModelsOutput(stdout);
}
