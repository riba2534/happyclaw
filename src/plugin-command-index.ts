/**
 * plugin-command-index.ts
 *
 * Per-user index of slash commands contributed by enabled Claude Code plugins.
 *
 * The agent-runner SDK transparently surfaces non-DMI plugin commands. Commands
 * marked `disable-model-invocation: true` are intentionally hidden from the
 * model — they are meant to be expanded by the CLI when a human types them.
 * In SDK mode we lose that expansion, so HappyClaw needs its own index to
 * resolve `/foo` and `/plugin:foo` slashes from IM / Web messages before they
 * reach the agent. PR2.b will build the expander on top of this index; PR2.a
 * (this module) only lists + resolves entries.
 *
 * Lookup strategy:
 *   - Each `commands/{name}.md` registers two aliases:
 *       /{name}              short
 *       /{plugin}:{name}     namespaced
 *   - When `{name}` collides with one of the 13 hardcoded built-in command
 *     names (clear / status / list / etc), we drop the short form so the
 *     built-in handler still wins on bare `/status`. The namespaced form
 *     remains addressable.
 *   - Both maps store arrays so we can detect:
 *       * short conflicts: 2+ plugins each offering `/foo`
 *       * namespaced conflicts: 2+ marketplaces both shipping the same
 *         `{plugin}` name with the same `{cmd}` name (e.g.
 *         codex@openai-codex and codex@another-mp both expose /codex:status)
 *
 * Cache lifecycle:
 *   - First `buildCommandIndex(userId)` after a process start hits disk; the
 *     result is memoized in a per-user Map.
 *   - `invalidateUserCommandIndex(userId)` is called by routes/plugins.ts on
 *     enable/disable + marketplace deletion so the next build re-reads disk.
 *   - There is no time-based TTL: enable state changes are the only mutations
 *     that affect command resolution, and we already invalidate on those.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

import { logger } from './logger.js';
import {
  readUserPluginsV2,
  getUserPluginRuntimePath,
} from './plugin-utils.js';
import { isValidNameSegment } from './plugin-manifest.js';

// --- Built-in command names ------------------------------------------------
//
// Mirrors the switch in src/index.ts:1082 (handleCommand). Listed in lower
// case; lookup is case-sensitive but we never normalize input slashes here —
// resolveCommand is the boundary.
const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'clear',
  'list',
  'ls',
  'status',
  'recall',
  'rc',
  'where',
  'unbind',
  'bind',
  'new',
  'require_mention',
  'owner_mention',
  'sw',
  'spawn',
  'allow',
  'disallow',
  'allowlist',
]);

/** Visible to tests / future debugging — not exported as part of the public API. */
export function isBuiltinCommandName(name: string): boolean {
  return BUILTIN_COMMAND_NAMES.has(name);
}

// --- Public types ----------------------------------------------------------

export interface PluginCommandIndexEntry {
  /** "<plugin>@<marketplace>" */
  fullId: string;
  marketplace: string;
  plugin: string;
  /** Snapshot id pinned in the user's enabled ref. */
  snapshot: string;
  /** Command file basename without `.md`. */
  commandName: string;
  /** Absolute host runtime path to the .md file. */
  commandFile: string;
  description?: string;
  argumentHint?: string;
  disableModelInvocation: boolean;
  /** All frontmatter fields parsed (including the typed ones above). */
  frontmatter: Record<string, unknown>;
  /** Markdown body without the frontmatter block. */
  body: string;
}

export interface CommandIndex {
  entries: PluginCommandIndexEntry[];
  /** "<plugin>:<cmd>" → entries (>1 == conflict across marketplaces). */
  byNamespaced: Map<string, PluginCommandIndexEntry[]>;
  /** "<cmd>" → entries (>1 == conflict; built-in collisions never enter). */
  byShort: Map<string, PluginCommandIndexEntry[]>;
  /** Deduplicated keys (short and namespaced) that resolve ambiguously. */
  conflicts: string[];
}

export type Resolution =
  | { kind: 'hit'; entry: PluginCommandIndexEntry }
  | { kind: 'conflict'; key: string; candidates: PluginCommandIndexEntry[] }
  | { kind: 'miss' };

// --- Frontmatter parsing ---------------------------------------------------

interface ParsedCommandFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Match a leading `---\n...---\n` frontmatter block. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Extract YAML frontmatter + body from a command markdown file. */
function parseCommandFile(raw: string, commandFile: string): ParsedCommandFile {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const yamlText = match[1];
  const body = raw.slice(match[0].length);
  let parsed: unknown;
  try {
    parsed = yaml.parse(yamlText);
  } catch (err) {
    logger.warn(
      { commandFile, err },
      'plugin-command-index: frontmatter YAML parse failed; treating as no-frontmatter',
    );
    return { frontmatter: {}, body };
  }
  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, body };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn(
      { commandFile, parsedType: Array.isArray(parsed) ? 'array' : typeof parsed },
      'plugin-command-index: frontmatter is not a mapping; treating as no-frontmatter',
    );
    return { frontmatter: {}, body };
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asBool(v: unknown): boolean {
  return v === true;
}

// --- Index construction ----------------------------------------------------

/** Module-level per-user cache. Cleared by invalidateUserCommandIndex. */
const cache = new Map<string, CommandIndex>();

/**
 * List `*.md` files in a commands directory, returning basenames (without
 * `.md`). Filters out names that would fail the path-segment whitelist.
 */
function listCommandFiles(commandsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(commandsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        { commandsDir, err },
        'plugin-command-index: failed to read commands dir',
      );
    }
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const base = name.slice(0, -3);
    if (!isValidNameSegment(base)) continue;
    out.push(base);
  }
  return out;
}

/**
 * Build a fresh command index for `userId` by walking all enabled plugin
 * runtime trees. Always reads disk; callers expecting a cached lookup should
 * use the cache wrapper below.
 */
async function buildCommandIndexUncached(
  userId: string,
): Promise<CommandIndex> {
  const empty: CommandIndex = {
    entries: [],
    byNamespaced: new Map(),
    byShort: new Map(),
    conflicts: [],
  };

  if (!isValidNameSegment(userId)) return empty;

  const v2 = readUserPluginsV2(userId);
  if (!v2) return empty;

  const entries: PluginCommandIndexEntry[] = [];

  for (const [fullId, ref] of Object.entries(v2.enabled)) {
    if (!ref || ref.enabled !== true) continue;
    if (
      !isValidNameSegment(ref.marketplace) ||
      !isValidNameSegment(ref.plugin) ||
      !isValidNameSegment(ref.snapshot)
    ) {
      continue;
    }

    const pluginDir = getUserPluginRuntimePath(
      userId,
      ref.snapshot,
      ref.marketplace,
      ref.plugin,
    );
    const manifestFile = path.join(pluginDir, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestFile)) {
      // Stale ref — runtime not materialized yet. Match loadUserPlugins.
      continue;
    }
    const commandsDir = path.join(pluginDir, 'commands');
    const cmdNames = listCommandFiles(commandsDir);
    for (const commandName of cmdNames) {
      const commandFile = path.join(commandsDir, `${commandName}.md`);
      let raw: string;
      try {
        raw = fs.readFileSync(commandFile, 'utf-8');
      } catch (err) {
        logger.warn(
          { userId, fullId, commandFile, err },
          'plugin-command-index: failed to read command file',
        );
        continue;
      }
      const { frontmatter, body } = parseCommandFile(raw, commandFile);
      entries.push({
        fullId,
        marketplace: ref.marketplace,
        plugin: ref.plugin,
        snapshot: ref.snapshot,
        commandName,
        commandFile,
        description: asString(frontmatter['description']),
        argumentHint: asString(frontmatter['argument-hint']),
        disableModelInvocation: asBool(frontmatter['disable-model-invocation']),
        frontmatter,
        body,
      });
    }
  }

  return indexEntries(entries);
}

/**
 * Pure helper that turns a list of entries into a `CommandIndex`. Exposed for
 * unit tests that want to verify alias rules without hitting disk.
 */
export function indexEntries(
  entries: PluginCommandIndexEntry[],
): CommandIndex {
  const byNamespaced = new Map<string, PluginCommandIndexEntry[]>();
  const byShort = new Map<string, PluginCommandIndexEntry[]>();

  for (const entry of entries) {
    const namespacedKey = `${entry.plugin}:${entry.commandName}`;
    const arr = byNamespaced.get(namespacedKey) ?? [];
    arr.push(entry);
    byNamespaced.set(namespacedKey, arr);

    if (!BUILTIN_COMMAND_NAMES.has(entry.commandName)) {
      const shortArr = byShort.get(entry.commandName) ?? [];
      shortArr.push(entry);
      byShort.set(entry.commandName, shortArr);
    }
  }

  const conflicts: string[] = [];
  for (const [key, arr] of byShort) {
    if (arr.length > 1) conflicts.push(key);
  }
  for (const [key, arr] of byNamespaced) {
    if (arr.length > 1) conflicts.push(key);
  }

  return { entries, byNamespaced, byShort, conflicts };
}

/**
 * Cached entry point. Rebuild on first call after invalidate, otherwise
 * return the memoized snapshot.
 */
export async function buildCommandIndex(
  userId: string,
): Promise<CommandIndex> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const fresh = await buildCommandIndexUncached(userId);
  cache.set(userId, fresh);
  return fresh;
}

/**
 * Drop the cached index for `userId`. Safe to call from any thread; called
 * by the plugins routes after enable/disable + marketplace removal.
 */
export function invalidateUserCommandIndex(userId: string): void {
  cache.delete(userId);
}

/** Test/debug only: nuke all cached entries. */
export function _resetCommandIndexCacheForTests(): void {
  cache.clear();
}

// --- Resolution ------------------------------------------------------------

/**
 * Resolve a slash command string to an entry, conflict, or miss.
 *
 * Accepts either bare ("status") or with a leading slash ("/status"). The
 * slash is stripped before lookup. A `:` separates plugin name from command
 * name in the namespaced form.
 *
 * No argument parsing happens here — callers should split on whitespace and
 * pass only the head token.
 */
export function resolveCommand(
  idx: CommandIndex,
  slash: string,
): Resolution {
  if (typeof slash !== 'string') return { kind: 'miss' };
  let token = slash.trim();
  if (token.startsWith('/')) token = token.slice(1);
  if (token.length === 0) return { kind: 'miss' };

  if (token.includes(':')) {
    const arr = idx.byNamespaced.get(token);
    if (!arr || arr.length === 0) return { kind: 'miss' };
    if (arr.length > 1) {
      return { kind: 'conflict', key: token, candidates: arr.slice() };
    }
    return { kind: 'hit', entry: arr[0] };
  }

  const arr = idx.byShort.get(token);
  if (!arr || arr.length === 0) return { kind: 'miss' };
  if (arr.length > 1) {
    return { kind: 'conflict', key: token, candidates: arr.slice() };
  }
  return { kind: 'hit', entry: arr[0] };
}
