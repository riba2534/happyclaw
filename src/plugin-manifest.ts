/**
 * plugin-manifest.ts
 *
 * Read and validate `.claude-plugin/marketplace.json` and `.claude-plugin/
 * plugin.json` from a plugin directory tree, plus best-effort scanning of
 * commands / agents / skills / hooks / mcp-servers entry counts.
 *
 * Used by plugin-importer.ts when materializing a host marketplace into the
 * immutable catalog, and by plugin-catalog.ts for snapshot metadata.
 *
 * All filesystem reads are non-throwing — malformed manifests degrade to
 * `null` / warnings so that one bad plugin in a marketplace doesn't break
 * the whole scan.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

/**
 * Whitelisted name segment regex used for marketplace, plugin and snapshot
 * id directory components. Mirrors plugin-utils.ts so paths can never
 * contain `..`, slashes or other shell-meaningful characters.
 */
export const NAME_SEGMENT_RE = /^[\w.-]+$/;

export function isValidNameSegment(s: string): boolean {
  return typeof s === 'string' && NAME_SEGMENT_RE.test(s) && s !== '.' && s !== '..';
}

/**
 * A plugin's `source` in marketplace.json is either:
 *   - a relative string like `"./plugins/foo"` → inline (declared to live in
 *     this marketplace repo)
 *   - `{source: "url", ...}` / `{source: "git-subdir", ...}` → remote ref
 *
 * Source kind is exposed here as metadata only. The importer does NOT use
 * it to decide whether a missing local manifest is an error: in practice
 * Claude Code's CLI lays out a placeholder dir (LICENSE/README) for every
 * declared plugin regardless of source kind, and only writes
 * `.claude-plugin/plugin.json` after `/plugin install`. So "declared but
 * not yet installed" is a normal pre-install state for both inline and
 * remote — the importer's actual signal is presence/absence of a
 * marketplace.json declaration, not the source kind.
 */
export type PluginEntrySource = 'inline' | 'remote';

export interface MarketplaceManifest {
  name: string;
  version?: string;
  description?: string;
  owner?: string;
  /**
   * Map from plugin name → declared source kind from the manifest's
   * `plugins[]`. Exposed for surfacing in UI / catalog metadata; importer
   * decisions key off whether the name is declared at all, not its kind.
   */
  pluginSources: Record<string, PluginEntrySource>;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
}

export interface PluginAssetCounts {
  commands: number;
  agents: number;
  skills: number;
  hooks: number;
  mcpServers: number;
}

/** Read marketplace.json from `<mpDir>/.claude-plugin/marketplace.json`. */
export function readMarketplaceManifest(
  mpDir: string,
): MarketplaceManifest | null {
  const file = path.join(mpDir, '.claude-plugin', 'marketplace.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      { mpDir, err },
      'plugin-manifest: marketplace.json JSON parse failed',
    );
    return null;
  }
  const rec = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<
    string,
    unknown
  >;
  const name = typeof rec.name === 'string' ? rec.name : null;
  if (!name) return null;

  const meta = (rec.metadata && typeof rec.metadata === 'object'
    ? (rec.metadata as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const owner = (rec.owner && typeof rec.owner === 'object'
    ? (rec.owner as Record<string, unknown>)
    : null);

  // marketplace.json `plugins[]` declares each plugin's source. Inline sources
  // are shipped in the same repo and must have a local `.claude-plugin/plugin
  // .json`; remote sources (url / git-subdir) deliberately don't until the
  // user installs them through Claude Code's CLI. We classify each entry up
  // front so the importer can skip "remote without manifest" silently while
  // still warning on "inline without manifest" (a real authoring bug).
  const pluginSources: Record<string, PluginEntrySource> = {};
  const pluginsArr = Array.isArray(rec.plugins) ? rec.plugins : [];
  for (const raw of pluginsArr) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const pName = typeof entry.name === 'string' ? entry.name : null;
    if (!pName || !isValidNameSegment(pName)) continue;
    const src = entry.source;
    // String form `"./plugins/foo"` → inline; missing field also treated as
    // inline (the local-dir convention). Anything else (objects with `source`,
    // `url`, `git-subdir`) → remote.
    pluginSources[pName] =
      typeof src === 'string' || src === undefined ? 'inline' : 'remote';
  }

  return {
    name,
    version: typeof meta.version === 'string' ? meta.version : undefined,
    description:
      typeof meta.description === 'string' ? meta.description : undefined,
    owner: owner && typeof owner.name === 'string' ? owner.name : undefined,
    pluginSources,
  };
}

/** Read plugin.json from `<pluginDir>/.claude-plugin/plugin.json`. */
export function readPluginManifest(pluginDir: string): PluginManifest | null {
  const file = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      { pluginDir, err },
      'plugin-manifest: plugin.json JSON parse failed',
    );
    return null;
  }
  const rec = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<
    string,
    unknown
  >;
  const name = typeof rec.name === 'string' ? rec.name : null;
  if (!name) return null;
  return {
    name,
    version: typeof rec.version === 'string' ? rec.version : undefined,
    description:
      typeof rec.description === 'string' ? rec.description : undefined,
  };
}

/** Count `*.md` files in a directory (non-recursive). */
function countMarkdown(dir: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (name.endsWith('.md') && isValidNameSegment(name.slice(0, -3))) n += 1;
  }
  return n;
}

/** Count direct child directories with valid name segments. */
function countChildDirs(dir: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!isValidNameSegment(name)) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) n += 1;
  }
  return n;
}

/** Whether `dir` exists as a regular file (not directory). */
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Best-effort asset counts for UI display. Missing directories count as 0
 * — never throws. Counts are intentionally shallow (one level deep) since
 * Claude Code itself only loads top-level entries.
 */
export function scanPluginAssets(pluginDir: string): PluginAssetCounts {
  const commands = countMarkdown(path.join(pluginDir, 'commands'));
  const agents = countMarkdown(path.join(pluginDir, 'agents'));
  const skills = countChildDirs(path.join(pluginDir, 'skills'));
  // hooks: a single `hooks/hooks.json` registers all hooks
  const hooks = isFile(path.join(pluginDir, 'hooks', 'hooks.json')) ? 1 : 0;
  // mcp-servers: either a single `.mcp.json` (legacy) or a directory of configs
  let mcpServers = 0;
  if (isFile(path.join(pluginDir, '.mcp.json'))) mcpServers = 1;
  const mcpDir = path.join(pluginDir, 'mcp-servers');
  try {
    const ents = fs.readdirSync(mcpDir);
    for (const e of ents) {
      if (e.endsWith('.json') && isValidNameSegment(e.slice(0, -5))) {
        mcpServers += 1;
      }
    }
  } catch {
    /* directory missing — ok */
  }
  return { commands, agents, skills, hooks, mcpServers };
}
