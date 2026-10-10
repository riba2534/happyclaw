import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { scanSkillDirectory } from './skill-utils.js';

export type EffectiveSkillSource =
  | 'builtin'
  | 'host'
  | 'project'
  | 'managed'
  | 'workspace'
  | 'plugin';

export type ManagedSkillPolicy =
  | { mode: 'inherit'; ids?: string[] }
  | { mode: 'disabled'; ids?: string[] }
  | { mode: 'custom'; ids: string[] };

export interface EffectiveSkillLayer {
  source: EffectiveSkillSource;
  root?: string;
  /** Plugin Skills use the SDK's stable `plugin:skill` qualified name. */
  idPrefix?: string;
  /**
   * The result of `scanSkillDirectory(root)` when the caller already scanned
   * it, so the same root is not listed and parsed twice per request.
   */
  skills?: ReadonlyArray<{ id: string; enabled: boolean }>;
}

export interface EffectiveSkillCandidate {
  id: string;
  source: EffectiveSkillSource;
  path: string;
  enabled: boolean;
  selected: boolean;
  precedence: number;
  definitionHash: string;
  excludedReason?: 'disabled' | 'profile_filtered' | 'shadowed';
}

export interface EffectiveSkillEntry {
  id: string;
  source: EffectiveSkillSource;
  path: string;
  definitionHash: string;
  overrides: EffectiveSkillSource[];
}

export interface EffectiveSkillManifest {
  schemaVersion: 1;
  hash: string;
  policy: { mode: ManagedSkillPolicy['mode']; ids: string[] };
  hostPolicy: { mode: ManagedSkillPolicy['mode']; ids: string[] };
  candidates: EffectiveSkillCandidate[];
  selected: EffectiveSkillEntry[];
  conflicts: string[];
  missingManagedSkillIds: string[];
  missingHostSkillIds: string[];
}

export function pluginSkillLayers(
  plugins: Array<{ type: 'local'; path: string }>,
): EffectiveSkillLayer[] {
  return plugins.map((plugin) => ({
    source: 'plugin',
    root: path.join(plugin.path, 'skills'),
    idPrefix: path.basename(plugin.path),
  }));
}

const SKILL_HASH_IGNORED_ENTRIES = new Set([
  '.DS_Store',
  '.cache',
  '.git',
  '__pycache__',
  'node_modules',
]);

/**
 * A file whose mtime/ctime is this close to the hash time may still change
 * within the same filesystem timestamp tick (2 s on FAT, coarse kernel clocks
 * elsewhere) without changing its stat signature, so it is never cached.
 */
const SKILL_HASH_RACY_WINDOW_MS = 3_000;
const SKILL_HASH_CACHE_MAX_ENTRIES = 2_000;

interface SkillHashCacheEntry {
  signature: string;
  hash: string;
}

/** Absolute Skill directory → payload hash and the stat signature it matched. */
const skillHashCache = new Map<string, SkillHashCacheEntry>();

interface SkillDirectoryWalk {
  /** Payload hash; only produced when contents were read. */
  hash?: string;
  /** Digest of the walked names, types, symlink targets and file stats. */
  signature: string;
  /** False when any entry was unreadable, so the result may be transient. */
  reliable: boolean;
  newestChangeMs: number;
}

/**
 * Walk the exact entry set that defines a Skill payload. With `readContents`
 * the walk yields the payload hash (format unchanged: warm runners and
 * capability snapshots compare it) plus a stat signature taken from the same
 * listing and the same open file descriptors, so the signature always
 * describes the bytes that were hashed. Without it the walk only lists
 * directories and stats files, producing the same signature for an unchanged
 * tree at a fraction of the cost.
 */
function walkSkillDirectory(
  skillDir: string,
  readContents: boolean,
): SkillDirectoryWalk {
  const hash = readContents ? createHash('sha256') : null;
  const signature = createHash('sha256');
  let reliable = true;
  let newestChangeMs = 0;
  const recordStats = (stats: fs.Stats): void => {
    newestChangeMs = Math.max(newestChangeMs, stats.mtimeMs, stats.ctimeMs);
    signature.update(
      `${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}\0`,
    );
  };
  const mark = (marker: string): void => {
    hash?.update(marker);
    signature.update(marker);
  };
  const visit = (directory: string, relativeRoot: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => !SKILL_HASH_IGNORED_ENTRIES.has(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      mark(`unreadable-directory\0${relativeRoot}\0`);
      reliable = false;
      return;
    }
    for (const entry of entries) {
      const relativePath = relativeRoot
        ? path.posix.join(relativeRoot, entry.name)
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target = 'unreadable';
        try {
          target = fs.readlinkSync(absolutePath);
        } catch {
          reliable = false;
        }
        mark(`symlink\0${relativePath}\0${target}\0`);
      } else if (entry.isDirectory()) {
        mark(`directory\0${relativePath}\0`);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        mark(`file\0${relativePath}\0`);
        if (!hash) {
          try {
            recordStats(fs.statSync(absolutePath));
          } catch {
            reliable = false;
          }
          continue;
        }
        let content: Buffer | null = null;
        let fd: number | null = null;
        try {
          fd = fs.openSync(absolutePath, 'r');
          recordStats(fs.fstatSync(fd));
          content = fs.readFileSync(fd);
        } catch {
          reliable = false;
        } finally {
          if (fd !== null) {
            try {
              fs.closeSync(fd);
            } catch {
              /* the descriptor is gone either way */
            }
          }
        }
        hash.update(content ?? 'unreadable');
        hash.update('\0');
      }
    }
  };
  visit(skillDir, '');
  return {
    ...(hash ? { hash: hash.digest('hex') } : {}),
    signature: signature.digest('hex'),
    reliable,
    newestChangeMs,
  };
}

/**
 * Hash the complete executable Skill payload, not only SKILL.md metadata.
 *
 * Results are memoized per absolute directory and revalidated on every call
 * with a stat-only walk (names, types, symlink targets, and dev/ino/mode/
 * size/mtime/ctime of every file), so unchanged trees skip reading and
 * hashing file contents while any edit, addition, removal, rename or
 * retarget forces a full rehash.
 */
export function hashSkillDirectory(skillDir: string): string {
  const key = path.resolve(skillDir);
  const cached = skillHashCache.get(key);
  if (cached) {
    const probe = walkSkillDirectory(key, false);
    if (probe.reliable && probe.signature === cached.signature) {
      skillHashCache.delete(key);
      skillHashCache.set(key, cached);
      return cached.hash;
    }
  }

  const startedAt = Date.now();
  const computed = walkSkillDirectory(key, true);
  skillHashCache.delete(key);
  if (
    computed.reliable &&
    computed.newestChangeMs < startedAt - SKILL_HASH_RACY_WINDOW_MS
  ) {
    skillHashCache.set(key, {
      signature: computed.signature,
      hash: computed.hash!,
    });
    while (skillHashCache.size > SKILL_HASH_CACHE_MAX_ENTRIES) {
      const oldest = skillHashCache.keys().next().value;
      if (oldest === undefined) break;
      skillHashCache.delete(oldest);
    }
  }
  return computed.hash!;
}

/**
 * Drop memoized Skill hashes for one Skill directory, every Skill below a
 * Skills root, or everything when called without an argument. The stat
 * signature already detects edits; mutation paths call this as well so a
 * finished mutation never relies on revalidation alone.
 */
export function invalidateSkillHashCache(directory?: string): void {
  if (directory === undefined) {
    skillHashCache.clear();
    return;
  }
  const target = path.resolve(directory);
  const prefix = target.endsWith(path.sep) ? target : `${target}${path.sep}`;
  for (const key of skillHashCache.keys()) {
    if (key === target || key.startsWith(prefix)) skillHashCache.delete(key);
  }
}

/**
 * Resolve every Skill consumer from one canonical precedence model.
 *
 * Layers must be supplied from lowest to highest precedence. A disabled
 * definition is removed before precedence is evaluated, so it never acts as
 * a tombstone for an enabled definition from a lower layer. AgentProfile
 * source policies independently filter managed-user and native host Skills.
 */
export function resolveEffectiveSkills(options: {
  layers: EffectiveSkillLayer[];
  managedPolicy?: ManagedSkillPolicy;
  hostPolicy?: ManagedSkillPolicy;
  /**
   * Listing views that never expose hashes may pass `false` to skip payload
   * hashing. Every `definitionHash` and the manifest `hash` are then empty
   * strings, so such a manifest must never serve as a runtime identity.
   */
  computeHashes?: boolean;
}): EffectiveSkillManifest {
  const computeHashes = options.computeHashes !== false;
  const policy = options.managedPolicy ?? { mode: 'inherit' as const, ids: [] };
  const policyIds = [...new Set(policy.ids ?? [])].sort();
  const requestedManagedIds = new Set(policyIds);
  const hostPolicy = options.hostPolicy ?? {
    mode: 'inherit' as const,
    ids: [],
  };
  const hostPolicyIds = [...new Set(hostPolicy.ids ?? [])].sort();
  const requestedHostIds = new Set(hostPolicyIds);
  const candidates: EffectiveSkillCandidate[] = [];

  options.layers.forEach((layer, precedence) => {
    if (!layer.root) return;
    for (const skill of layer.skills ??
      scanSkillDirectory(layer.root, layer.source)) {
      const candidateId = layer.idPrefix
        ? `${layer.idPrefix}:${skill.id}`
        : skill.id;
      const filteredByProfile =
        (layer.source === 'managed' &&
          (policy.mode === 'disabled' ||
            (policy.mode === 'custom' &&
              !requestedManagedIds.has(candidateId)))) ||
        (layer.source === 'host' &&
          (hostPolicy.mode === 'disabled' ||
            (hostPolicy.mode === 'custom' &&
              !requestedHostIds.has(candidateId))));
      const skillPath = path.join(layer.root, skill.id);
      candidates.push({
        id: candidateId,
        source: layer.source,
        path: skillPath,
        enabled: skill.enabled,
        selected: false,
        precedence,
        definitionHash: computeHashes ? hashSkillDirectory(skillPath) : '',
        ...(!skill.enabled
          ? { excludedReason: 'disabled' as const }
          : filteredByProfile
            ? { excludedReason: 'profile_filtered' as const }
            : {}),
      });
    }
  });

  const eligibleById = new Map<string, EffectiveSkillCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.enabled || candidate.excludedReason) continue;
    const current = eligibleById.get(candidate.id) ?? [];
    current.push(candidate);
    eligibleById.set(candidate.id, current);
  }

  const selected: EffectiveSkillEntry[] = [];
  const conflicts: string[] = [];
  for (const [id, eligible] of eligibleById) {
    eligible.sort((left, right) => left.precedence - right.precedence);
    const winner = eligible.at(-1)!;
    winner.selected = true;
    if (eligible.length > 1) conflicts.push(id);
    for (const shadowed of eligible.slice(0, -1)) {
      shadowed.excludedReason = 'shadowed';
    }
    selected.push({
      id,
      source: winner.source,
      path: winner.path,
      definitionHash: winner.definitionHash,
      overrides: eligible.slice(0, -1).map((candidate) => candidate.source),
    });
  }

  selected.sort((left, right) => left.id.localeCompare(right.id));
  conflicts.sort();
  candidates.sort(
    (left, right) =>
      left.id.localeCompare(right.id) || left.precedence - right.precedence,
  );

  const availableManagedIds = new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.source === 'managed' && candidate.enabled === true,
      )
      .map((candidate) => candidate.id),
  );
  const missingManagedSkillIds =
    policy.mode === 'custom'
      ? policyIds.filter((id) => !availableManagedIds.has(id))
      : [];
  const availableHostIds = new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.source === 'host' && candidate.enabled === true,
      )
      .map((candidate) => candidate.id),
  );
  const missingHostSkillIds =
    hostPolicy.mode === 'custom'
      ? hostPolicyIds.filter((id) => !availableHostIds.has(id))
      : [];
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        policy: { mode: policy.mode, ids: policyIds },
        hostPolicy: { mode: hostPolicy.mode, ids: hostPolicyIds },
        selected: selected.map(({ id, source, definitionHash, overrides }) => ({
          id,
          source,
          definitionHash,
          overrides,
        })),
        excluded: candidates
          .filter((candidate) => !candidate.selected)
          .map(({ id, source, definitionHash, excludedReason }) => ({
            id,
            source,
            definitionHash,
            excludedReason,
          })),
      }),
    )
    .digest('hex');

  return {
    schemaVersion: 1,
    hash: computeHashes ? hash : '',
    policy: { mode: policy.mode, ids: policyIds },
    hostPolicy: { mode: hostPolicy.mode, ids: hostPolicyIds },
    candidates,
    selected,
    conflicts,
    missingManagedSkillIds,
    missingHostSkillIds,
  };
}

export interface SkillReconcileResult {
  quarantineDir?: string;
  quarantined: string[];
}

/**
 * Rebuild the session Skill directory from a manifest. Real files/directories
 * left by a prior Agent are moved aside instead of deleted. Container mode
 * publishes an empty directory first; entrypoint then links the read-only
 * per-Skill mounts whose ids come from the same manifest.
 */
export function reconcileSessionSkills(
  sessionClaudeDir: string,
  manifest: EffectiveSkillManifest,
  options: { materializeLinks: boolean },
): SkillReconcileResult {
  fs.mkdirSync(sessionClaudeDir, { recursive: true });
  const skillsDir = path.join(sessionClaudeDir, 'skills');
  const quarantineRoot = path.join(sessionClaudeDir, 'orphaned-skills');
  const quarantined: string[] = [];
  let quarantineDir: string | undefined;

  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      quarantineDir ??= path.join(
        quarantineRoot,
        new Date().toISOString().replace(/[:.]/g, '-'),
      );
      fs.mkdirSync(quarantineDir, { recursive: true });
      let destination = path.join(quarantineDir, entry.name);
      if (fs.existsSync(destination)) destination += `-${randomUUID()}`;
      fs.renameSync(path.join(skillsDir, entry.name), destination);
      quarantined.push(entry.name);
    }
  }

  const staging = path.join(
    sessionClaudeDir,
    `.skills-staging-${randomUUID()}`,
  );
  const previous = path.join(
    sessionClaudeDir,
    `.skills-previous-${randomUUID()}`,
  );
  fs.mkdirSync(staging, { recursive: true });
  try {
    if (options.materializeLinks) {
      for (const skill of manifest.selected) {
        // Plugin definitions are loaded by options.plugins and only contribute
        // their qualified id to the SDK skills selector.
        if (skill.source === 'plugin') continue;
        fs.symlinkSync(skill.path, path.join(staging, skill.id));
      }
    }
    if (fs.existsSync(skillsDir)) fs.renameSync(skillsDir, previous);
    fs.renameSync(staging, skillsDir);
    fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(skillsDir) && fs.existsSync(previous)) {
      fs.renameSync(previous, skillsDir);
    }
    throw error;
  }

  return { quarantineDir, quarantined };
}
