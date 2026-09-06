// Skills management routes

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { DATA_DIR } from '../config.js';
import { listAgentProfilesForUser } from '../db.js';
import {
  userCapabilityLockKey,
  withCapabilityScopeLocks,
} from '../capability-lock.js';
import {
  CapabilityRuntimeCommitError,
  mutateCapabilityAroundRuntimeQuiesce,
  repairCapabilityRuntimeSafetyBlock,
} from '../capability-runtime-mutation.js';
import { WorkspaceRuntimeQuiesceError } from '../agent-profile-runtime.js';
import { getEffectiveExternalDir } from '../runtime-config.js';
import { validateSafeHttpsUrl } from '../url-safety.js';
import {
  skillArchiveUploadBodyLimit,
  SKILL_ARCHIVE_MAX_FILE_BYTES,
} from '../http-upload-policy.js';
import {
  importSkillsFromGit,
  importSkillsFromZip,
  installSkillDirectoriesTransactionally,
  runCommandWithDirectoryQuota,
} from '../skill-import-service.js';
import {
  parseFrontmatter,
  validateSkillId,
  validateSkillPath,
  listFiles,
  scanSkillDirectory,
} from '../skill-utils.js';
import { resolveEffectiveSkills } from '../effective-skill-resolver.js';
import {
  installSkillForUser as serviceInstallSkillForUser,
  deleteSkillForUser as serviceDeleteSkillForUser,
  getCapabilityMutationRequest,
  listPendingCapabilityMutations,
  applyPendingCapabilityMutations,
  type SkillInstallResult,
  type SkillDeleteResult,
} from '../skill-install-service.js';

const execFileAsync = promisify(execFile);
const MAX_SKILL_INSTALL_BYTES = 64 * 1024 * 1024;

interface SkillMutationLockState {
  tail: Promise<void>;
  references: number;
}

const skillMutationLocks = new Map<string, SkillMutationLockState>();

const skillsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project' | 'external';
  sourceKey: string;
  conflictSources: Array<'user' | 'project' | 'external'>;
  /** The highest-precedence enabled definition, or null when none are enabled. */
  effectiveSource: 'user' | 'project' | 'external' | null;
  effective: boolean;
  readonly: boolean;
  enabled: boolean;
  packageName?: string;
  installedAt?: string;
  installSource?: string;
  sourceUrl?: string;
  version?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

interface SkillDetail extends Skill {
  content: string;
}

interface SkillsManifest {
  skills: Record<
    string,
    {
      packageName?: string;
      installedAt: string;
      source: string;
      sourceUrl?: string;
      version?: string;
    }
  >;
}

interface SearchResult {
  package: string;
  url: string;
  description?: string;
  installs?: number;
  skillId?: string;
  source?: string;
}

// --- Utility Functions ---

function getUserSkillsDir(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId);
}

function getProjectSkillsDir(): string {
  return path.resolve(process.cwd(), 'container', 'skills');
}

function getSkillsManifestPath(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId, '.skills-manifest.json');
}

function readSkillsManifest(userId: string): SkillsManifest {
  try {
    const data = fs.readFileSync(getSkillsManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { skills: {} };
  }
}

function writeSkillsManifest(userId: string, manifest: SkillsManifest): void {
  const manifestPath = getSkillsManifestPath(userId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2));
    fs.renameSync(temporaryPath, manifestPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Update the skills manifest after installing skills.
 * Records packageName, installedAt, and source for each installed skill.
 */
function updateSkillsManifest(
  userId: string,
  packageName: string,
  installedSkillIds: string[],
): void {
  const manifest = readSkillsManifest(userId);
  const now = new Date().toISOString();
  for (const id of installedSkillIds) {
    manifest.skills[id] = {
      packageName,
      installedAt: now,
      source: 'skills.sh',
    };
  }
  writeSkillsManifest(userId, manifest);
}

function recordImportedSkills(
  userId: string,
  installedSkillIds: string[],
  metadata: Omit<SkillsManifest['skills'][string], 'installedAt'>,
): void {
  const manifest = readSkillsManifest(userId);
  const installedAt = new Date().toISOString();
  for (const id of installedSkillIds) {
    manifest.skills[id] = { ...metadata, installedAt };
  }
  writeSkillsManifest(userId, manifest);
}

function applyManifestMetadata(
  skill: Skill,
  meta: SkillsManifest['skills'][string],
): void {
  skill.packageName = meta.packageName;
  skill.installedAt = meta.installedAt;
  skill.installSource = meta.source;
  skill.sourceUrl = meta.sourceUrl;
  skill.version = meta.version;
}

/**
 * Remove a skill from the manifest when it is deleted.
 */
function removeFromSkillsManifest(userId: string, skillId: string): void {
  const manifest = readSkillsManifest(userId);
  if (skillId in manifest.skills) {
    delete manifest.skills[skillId];
    writeSkillsManifest(userId, manifest);
  }
}

// validateSkillId, validateSkillPath, parseFrontmatter, listFiles, scanSkillDirectory
// are imported from '../skill-utils.js'

function scanDirectory(rootDir: string, source: 'user' | 'project'): Skill[] {
  return (
    scanSkillDirectory(rootDir, source) as Omit<
      Skill,
      | 'sourceKey'
      | 'conflictSources'
      | 'effectiveSource'
      | 'effective'
      | 'readonly'
    >[]
  ).map((skill) => ({
    ...skill,
    sourceKey: `${source}:${skill.id}`,
    conflictSources: [],
    effectiveSource: null,
    effective: false,
    readonly: source !== 'user',
  }));
}

function discoverSkills(userId: string, userRole?: string): Skill[] {
  const userSkills = scanDirectory(getUserSkillsDir(userId), 'user');
  const projectSkills = scanDirectory(getProjectSkillsDir(), 'project');

  // 宿主机 ~/.claude/skills（仅 admin 可见）
  const externalSkills: Skill[] = [];
  if (userRole === 'admin') {
    const extSkillsDir = path.join(getEffectiveExternalDir(), 'skills');
    if (fs.existsSync(extSkillsDir)) {
      const scanned = scanDirectory(extSkillsDir, 'project');
      for (const s of scanned) {
        s.source = 'external';
        s.sourceKey = `external:${s.id}`;
        s.readonly = true;
      }
      externalSkills.push(...scanned);
    }
  }

  // 读取 skills manifest 补充安装元数据
  const skillsManifest = readSkillsManifest(userId);

  for (const skill of userSkills) {
    const meta = skillsManifest.skills[skill.id];
    if (meta) {
      applyManifestMetadata(skill, meta);
    }
  }

  // Preserve every source instead of silently dropping name collisions.
  // Runtime order is host → project → managed-user. Disabled definitions
  // remain inspectable, but cannot shadow an enabled lower-precedence source.
  const result = [...externalSkills, ...projectSkills, ...userSkills];
  const effectiveManifest = resolveEffectiveSkills({
    layers: [
      ...(userRole === 'admin'
        ? [
            {
              source: 'host' as const,
              root: path.join(getEffectiveExternalDir(), 'skills'),
            },
          ]
        : []),
      { source: 'project', root: getProjectSkillsDir() },
      { source: 'managed', root: getUserSkillsDir(userId) },
    ],
    managedPolicy: { mode: 'inherit' },
  });
  const selectedById = new Map(
    effectiveManifest.selected.map((skill) => [skill.id, skill]),
  );
  const sourcesById = new Map<string, Skill['source'][]>();
  for (const skill of result) {
    const sources = sourcesById.get(skill.id) ?? [];
    sources.push(skill.source);
    sourcesById.set(skill.id, sources);
  }
  for (const skill of result) {
    const sources = sourcesById.get(skill.id) ?? [];
    skill.conflictSources = sources.filter((source) => source !== skill.source);
    const effective = selectedById.get(skill.id);
    const effectiveSource =
      effective?.source === 'managed'
        ? 'user'
        : effective?.source === 'host'
          ? 'external'
          : effective?.source === 'project'
            ? 'project'
            : null;
    skill.effectiveSource = effectiveSource;
    skill.effective = effectiveSource === skill.source && skill.enabled;
  }
  return result;
}

function getSkillDetail(
  skillId: string,
  userId: string,
  userRole?: string,
  requestedSource?: string,
): SkillDetail | null {
  if (!validateSkillId(skillId)) return null;

  let searchDirs: Array<{
    rootDir: string;
    source: 'user' | 'project' | 'external';
  }> = [
    { rootDir: getUserSkillsDir(userId), source: 'user' },
    { rootDir: getProjectSkillsDir(), source: 'project' },
  ];
  if (userRole === 'admin') {
    const extSkillsDir = path.join(getEffectiveExternalDir(), 'skills');
    if (fs.existsSync(extSkillsDir)) {
      searchDirs.push({ rootDir: extSkillsDir, source: 'external' });
    }
  }
  if (requestedSource) {
    if (!['user', 'project', 'external'].includes(requestedSource)) return null;
    searchDirs = searchDirs.filter(({ source }) => source === requestedSource);
  }

  const skillsManifest = readSkillsManifest(userId);

  for (const { rootDir, source } of searchDirs) {
    const skillDir = path.join(rootDir, skillId);
    if (!fs.existsSync(skillDir)) continue;

    if (!validateSkillPath(rootDir, skillDir)) continue;

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const skillMdDisabledPath = path.join(skillDir, 'SKILL.md.disabled');

    let enabled = false;
    let skillFilePath: string | null = null;

    if (fs.existsSync(skillMdPath)) {
      enabled = true;
      skillFilePath = skillMdPath;
    } else if (fs.existsSync(skillMdDisabledPath)) {
      enabled = false;
      skillFilePath = skillMdDisabledPath;
    } else {
      continue;
    }

    try {
      const content = fs.readFileSync(skillFilePath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const stats = fs.statSync(skillDir);

      const discovered = discoverSkills(userId, userRole).find(
        (candidate) => candidate.id === skillId && candidate.source === source,
      );
      const detail: SkillDetail = {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || '',
        source,
        sourceKey: `${source}:${skillId}`,
        conflictSources: discovered?.conflictSources ?? [],
        effectiveSource: discovered?.effectiveSource ?? null,
        effective: discovered?.effective ?? false,
        readonly: source !== 'user',
        enabled,
        userInvocable:
          frontmatter['user-invocable'] === undefined
            ? true
            : frontmatter['user-invocable'] !== 'false',
        allowedTools: frontmatter['allowed-tools']
          ? frontmatter['allowed-tools'].split(',').map((t) => t.trim())
          : [],
        argumentHint: frontmatter['argument-hint'] || null,
        updatedAt: stats.mtime.toISOString(),
        files: listFiles(skillDir),
        content,
      };

      if (source === 'user') {
        const meta = skillsManifest.skills[skillId];
        if (meta) {
          applyManifestMetadata(detail, meta);
        }
      }

      return detail;
    } catch {
      // Skip malformed skill
    }
  }

  return null;
}

/**
 * Parse the output of `npx skills find <query>` to extract search results.
 * The output contains ANSI codes and formatted text like:
 *   owner/repo@skill-name
 *   https://skills.sh/owner/repo/skill
 */
function parseSearchOutput(output: string): SearchResult[] {
  // Strip ANSI escape codes
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const results: SearchResult[] = [];

  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match package pattern: owner/repo or owner/repo@skill
    const pkgMatch = line.match(/^([\w\-]+\/[\w\-.]+(?:@[\w\-.]+)?)$/);
    if (pkgMatch) {
      const pkg = pkgMatch[1];
      // Next line might be the URL (possibly prefixed with └ or similar chars)
      let url = '';
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].replace(/^[└├│─\s]+/, '');
        if (nextLine.startsWith('http')) {
          url = nextLine;
          i++;
        }
      }
      results.push({ package: pkg, url });
    }
  }

  return results;
}

// --- Search cache (LRU, 5min TTL, max 100 entries) ---

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map<string, CacheEntry<SearchResult[]>>();

function getCachedSearch(key: string): SearchResult[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedSearch(key: string, value: SearchResult[]): void {
  // Evict oldest if at capacity
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { value, expiresAt: Date.now() + SEARCH_CACHE_TTL });
}

/**
 * Search skills via skills.sh API.
 * Returns structured results with install counts.
 */
async function searchSkillsApi(query: string): Promise<SearchResult[]> {
  const cached = getCachedSearch(query);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) throw new Error(`skills.sh returned ${resp.status}`);

    const data = (await resp.json()) as {
      skills?: Array<{
        id: string;
        skillId: string;
        name: string;
        installs: number;
        source: string;
      }>;
    };

    const results: SearchResult[] = (data.skills || []).map((s) => ({
      package:
        s.source === s.skillId || !s.skillId
          ? s.source
          : `${s.source}@${s.skillId}`,
      url: `https://skills.sh/s/${s.id}`,
      description: '',
      installs: s.installs,
      skillId: s.skillId,
      source: s.source,
    }));

    setCachedSearch(query, results);
    return results;
  } catch {
    // Fallback to npx skills find
    return searchSkillsFallback(query);
  }
}

/**
 * Fallback search using npx skills find CLI.
 */
async function searchSkillsFallback(query: string): Promise<SearchResult[]> {
  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['-y', 'skills', 'find', query],
      { timeout: 30_000 },
    );
    return parseSearchOutput(stdout);
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      const results = parseSearchOutput((error as any).stdout || '');
      if (results.length > 0) return results;
    }
    return [];
  }
}

/**
 * Fetch SKILL.md content from GitHub for a given source repo and skill ID.
 * Tries multiple common directory layouts.
 */
async function fetchSkillMdFromGitHub(
  source: string,
  skillId: string,
): Promise<{ content: string; description: string; skillName: string } | null> {
  // Try common paths where SKILL.md might live
  const pathCandidates = [
    `skills/${skillId}/SKILL.md`,
    `${skillId}/SKILL.md`,
    `.claude/skills/${skillId}/SKILL.md`,
    `SKILL.md`,
  ];

  for (const branch of ['main', 'master']) {
    for (const filePath of pathCandidates) {
      try {
        const url = `https://raw.githubusercontent.com/${source}/${branch}/${filePath}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!resp.ok) continue;

        const content = await resp.text();
        // Verify it looks like a SKILL.md (has frontmatter)
        if (!content.startsWith('---')) continue;

        const frontmatter = parseFrontmatter(content);
        return {
          content,
          description: frontmatter.description || '',
          skillName: frontmatter.name || skillId,
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function withPrivateUserSkillMutationLock<T>(
  userId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  let state = skillMutationLocks.get(userId);
  if (!state) {
    state = { tail: Promise.resolve(), references: 0 };
    skillMutationLocks.set(userId, state);
  }
  state.references += 1;
  const previous = state.tail.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.tail = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    state.references -= 1;
    if (state.references === 0 && skillMutationLocks.get(userId) === state) {
      skillMutationLocks.delete(userId);
    }
  }
}

async function withUserSkillMutationLock<T>(
  userId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withCapabilityScopeLocks([userCapabilityLockKey(userId)], () =>
    withPrivateUserSkillMutationLock(userId, fn),
  );
}

async function withUserSkillRuntimeMutation<T>(
  userId: string,
  ids: string[] | undefined,
  reason: string,
  mutation: () => Promise<T> | T,
): Promise<{ value: T; invalidatedRuntimeJids: number }> {
  return withUserSkillMutationLock(userId, async () => {
    const impact = { kind: 'skills' as const, ownerUserId: userId, ids };
    await repairCapabilityRuntimeSafetyBlock(impact, reason);
    return mutateCapabilityAroundRuntimeQuiesce(impact, reason, mutation);
  });
}

function skillRuntimeMutationFailure(error: unknown, action: string) {
  if (error instanceof WorkspaceRuntimeQuiesceError) {
    return {
      error: error.persisted
        ? `${action} was saved, but runtime cleanup failed; retry the request`
        : `Failed to stop affected workspaces; ${action} was not saved`,
      persisted: error.persisted,
      retryable: true,
    };
  }
  if (error instanceof CapabilityRuntimeCommitError) {
    return {
      error: `${action} has an uncertain commit outcome; retry the request to finish fail-closed cleanup`,
      persisted: 'unknown',
      retryable: true,
    };
  }
  return null;
}

// --- Routes ---

skillsRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const skills = discoverSkills(authUser.id, authUser.role);
  return c.json({ skills });
});

skillsRoutes.get('/search', authMiddleware, async (c) => {
  const query = c.req.query('q')?.trim();
  if (!query) {
    return c.json({ results: [] });
  }

  const results = await searchSkillsApi(query);
  return c.json({ results });
});

skillsRoutes.get('/search/detail', authMiddleware, async (c) => {
  const source = c.req.query('source')?.trim();
  const skillId = c.req.query('skillId')?.trim();

  // Support legacy url-based lookup for backwards compat
  const url = c.req.query('url')?.trim();

  if (source && skillId) {
    // New path: fetch SKILL.md from GitHub using source/skillId
    const result = await fetchSkillMdFromGitHub(source, skillId);
    if (!result) {
      return c.json({ detail: null });
    }

    return c.json({
      detail: {
        description: result.description,
        skillName: result.skillName,
        readme: result.content,
        installs: '',
        age: '',
        features: [],
      },
    });
  }

  // Legacy: extract source/skillId from skills.sh URL
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'skills.sh') {
        // URL pattern: https://skills.sh/s/{owner}/{repo}/{skillId}
        const segments = parsed.pathname
          .replace(/^\/s\//, '')
          .split('/')
          .filter(Boolean);
        if (segments.length >= 3) {
          const srcFromUrl = `${segments[0]}/${segments[1]}`;
          const skillIdFromUrl = segments[2];
          const result = await fetchSkillMdFromGitHub(
            srcFromUrl,
            skillIdFromUrl,
          );
          if (result) {
            return c.json({
              detail: {
                description: result.description,
                skillName: result.skillName,
                readme: result.content,
                installs: '',
                age: '',
                features: [],
              },
            });
          }
        }
      }
    } catch {
      // fall through
    }
  }

  return c.json({ detail: null });
});

skillsRoutes.post('/import/git', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const ref = typeof body.ref === 'string' ? body.ref.trim() : undefined;
  const subdirectory =
    typeof body.subdirectory === 'string'
      ? body.subdirectory.trim()
      : undefined;
  if (!url) return c.json({ error: 'Git URL is required' }, 400);

  try {
    const runtimeResult = await withUserSkillRuntimeMutation(
      authUser.id,
      undefined,
      'Git Skill import changed managed capabilities',
      async () => {
        try {
          return {
            result: await importSkillsFromGit({
              url,
              ref: ref || undefined,
              subdirectory: subdirectory || undefined,
              targetRoot: getUserSkillsDir(authUser.id),
              replace: body.replace === true,
              commit: (imported) =>
                recordImportedSkills(authUser.id, imported.installed, {
                  source: 'git',
                  sourceUrl: imported.sourceUrl,
                  version: imported.version,
                }),
            }),
          };
        } catch (error) {
          // Import validation/conflict errors are transactional and therefore
          // safe to return after the runner snapshot has been quiesced.
          return { error };
        }
      },
    );
    if ('error' in runtimeResult.value) throw runtimeResult.value.error;
    return c.json({
      success: true,
      ...runtimeResult.value.result,
      invalidated_runtime_jids: runtimeResult.invalidatedRuntimeJids,
    });
  } catch (error) {
    const runtimeFailure = skillRuntimeMutationFailure(
      error,
      'Git Skill import',
    );
    if (runtimeFailure) return c.json(runtimeFailure, 503);
    const message =
      error instanceof Error ? error.message : 'Git import failed';
    return c.json(
      { error: message },
      message.startsWith('Skill already exists:') ? 409 : 400,
    );
  }
});

skillsRoutes.post(
  '/import/archive',
  authMiddleware,
  skillArchiveUploadBodyLimit,
  async (c) => {
    const authUser = c.get('user') as AuthUser;
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'A multipart ZIP archive is required' }, 400);
    }
    const archive = formData.get('archive');
    if (
      !(archive instanceof File) ||
      !archive.name.toLowerCase().endsWith('.zip')
    ) {
      return c.json({ error: 'archive must be a ZIP file' }, 400);
    }
    if (archive.size > SKILL_ARCHIVE_MAX_FILE_BYTES) {
      return c.json({ error: 'ZIP archive is too large (max 10MB)' }, 413);
    }
    try {
      const runtimeResult = await withUserSkillRuntimeMutation(
        authUser.id,
        undefined,
        'ZIP Skill import changed managed capabilities',
        async () => {
          try {
            return {
              result: await importSkillsFromZip({
                archive: Buffer.from(await archive.arrayBuffer()),
                archiveName: archive.name,
                targetRoot: getUserSkillsDir(authUser.id),
                replace: formData.get('replace') === 'true',
                commit: (imported) =>
                  recordImportedSkills(authUser.id, imported.installed, {
                    source: 'zip',
                    sourceUrl: imported.sourceUrl,
                  }),
              }),
            };
          } catch (error) {
            return { error };
          }
        },
      );
      if ('error' in runtimeResult.value) throw runtimeResult.value.error;
      return c.json({
        success: true,
        ...runtimeResult.value.result,
        invalidated_runtime_jids: runtimeResult.invalidatedRuntimeJids,
      });
    } catch (error) {
      const runtimeFailure = skillRuntimeMutationFailure(
        error,
        'ZIP Skill import',
      );
      if (runtimeFailure) return c.json(runtimeFailure, 503);
      const message =
        error instanceof Error ? error.message : 'ZIP import failed';
      return c.json(
        { error: message },
        message.startsWith('Skill already exists:') ? 409 : 400,
      );
    }
  },
);

skillsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const skill = getSkillDetail(
    id,
    authUser.id,
    authUser.role,
    c.req.query('source'),
  );

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  return c.json({ skill });
});

function referencedByCustomSkillProfiles(
  userId: string,
  skillIds: Iterable<string>,
): Array<{ id: string; name: string; skillIds: string[] }> {
  const candidates = new Set(skillIds);
  return listAgentProfilesForUser(userId)
    .filter((profile) => profile.runtime_policy.skills.mode === 'custom')
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      skillIds: profile.runtime_policy.skills.ids.filter((id) =>
        candidates.has(id),
      ),
    }))
    .filter((profile) => profile.skillIds.length > 0);
}

// Toggle enable/disable for user-level skills via SKILL.md ↔ SKILL.md.disabled rename.
// Project-level skills are read-only.
skillsRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  // 防 invalid JSON 把 hono 默认错误处理器返回 500 + 暴露栈。Catch 后单独
  // 校验 enabled 是 boolean。
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400);
  }
  const enabled = body.enabled;

  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);

  return withUserSkillMutationLock(authUser.id, async () => {
    const userDir = getUserSkillsDir(authUser.id);
    const skillDir = path.join(userDir, id);

    if (!fs.existsSync(skillDir)) {
      return c.json(
        { error: 'Skill not found or is not a user-level skill' },
        404,
      );
    }
    if (!enabled) {
      const referencedByProfiles = referencedByCustomSkillProfiles(
        authUser.id,
        [id],
      );
      if (referencedByProfiles.length > 0) {
        return c.json(
          {
            error: '一个或多个智能体正在使用该 Skill',
            referencedByProfiles,
          },
          409,
        );
      }
    }
    if (!validateSkillPath(userDir, skillDir)) {
      return c.json({ error: 'Invalid skill path' }, 400);
    }

    const srcPath = path.join(
      skillDir,
      enabled ? 'SKILL.md.disabled' : 'SKILL.md',
    );
    const dstPath = path.join(
      skillDir,
      enabled ? 'SKILL.md' : 'SKILL.md.disabled',
    );

    if (!fs.existsSync(srcPath)) {
      return c.json(
        { error: 'Skill not found or already in desired state' },
        404,
      );
    }

    const impact = {
      kind: 'skills' as const,
      ownerUserId: authUser.id,
      ids: [id],
    };
    try {
      await repairCapabilityRuntimeSafetyBlock(
        impact,
        `Skill ${id} toggle cleanup`,
      );
      const result = await mutateCapabilityAroundRuntimeQuiesce(
        impact,
        `Skill ${id} ${enabled ? 'enabled' : 'disabled'}`,
        () => fs.renameSync(srcPath, dstPath),
      );
      return c.json({
        success: true,
        invalidated_runtime_jids: result.invalidatedRuntimeJids,
      });
    } catch (error) {
      const failure = skillRuntimeMutationFailure(error, 'Skill toggle');
      if (failure) return c.json(failure, 503);
      throw error;
    }
  });
});

/**
 * Delete a user-level skill by ID.
 * Reusable by both the HTTP route and IPC handler.
 */
function deleteSkillForUserUnlocked(
  userId: string,
  skillId: string,
): { success: boolean; error?: string } {
  if (!validateSkillId(skillId)) {
    return { success: false, error: 'Invalid skill ID' };
  }

  const referencedByProfiles = referencedByCustomSkillProfiles(userId, [
    skillId,
  ]);
  if (referencedByProfiles.length > 0) {
    return {
      success: false,
      error: `以下智能体正在使用该 Skill：${referencedByProfiles
        .map((profile) => profile.name)
        .join(', ')}`,
    };
  }

  const userDir = getUserSkillsDir(userId);
  const skillDir = path.join(userDir, skillId);

  if (!fs.existsSync(skillDir)) {
    return {
      success: false,
      error: 'Skill not found or is a project-level skill',
    };
  }

  if (!validateSkillPath(userDir, skillDir)) {
    return { success: false, error: 'Invalid skill path' };
  }

  const backupDir = path.join(
    userDir,
    `.delete-${skillId}-${process.pid}-${Date.now()}`,
  );
  const previousManifest = readSkillsManifest(userId);
  try {
    fs.renameSync(skillDir, backupDir);
    const nextManifest = structuredClone(previousManifest);
    delete nextManifest.skills[skillId];
    writeSkillsManifest(userId, nextManifest);
    fs.rmSync(backupDir, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    try {
      if (fs.existsSync(backupDir) && !fs.existsSync(skillDir)) {
        fs.renameSync(backupDir, skillDir);
      }
      writeSkillsManifest(userId, previousManifest);
    } catch {
      // Preserve the original error; a leftover hidden backup remains recoverable.
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function deleteSkillForUser(
  userId: string,
  skillId: string,
  options?: {
    requestId?: string;
    sourceGroup?: string;
    groupFolder?: string;
    isAgentCaller?: boolean;
  },
): Promise<SkillDeleteResult> {
  return serviceDeleteSkillForUser(userId, skillId, options);
}

// 批量删除所有用户级技能（清理旧的同步副本）
skillsRoutes.delete('/user-all', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  return withUserSkillMutationLock(authUser.id, async () => {
    const userDir = getUserSkillsDir(authUser.id);
    const installedIds = fs.existsSync(userDir)
      ? fs
          .readdirSync(userDir, { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith('.'))
          .map((entry) => entry.name)
      : [];
    const referencedByProfiles = referencedByCustomSkillProfiles(
      authUser.id,
      installedIds,
    );
    if (referencedByProfiles.length > 0) {
      return c.json(
        {
          error: '一个或多个 Skill 正被智能体使用',
          referencedByProfiles,
        },
        409,
      );
    }
    try {
      const impact = {
        kind: 'skills' as const,
        ownerUserId: authUser.id,
        ids: installedIds,
      };
      await repairCapabilityRuntimeSafetyBlock(
        impact,
        'Bulk Skill deletion cleanup',
      );
      const result = await mutateCapabilityAroundRuntimeQuiesce(
        impact,
        'All managed user Skills deleted',
        () => {
          const previousManifest = readSkillsManifest(authUser.id);
          const transactionDir = path.join(
            userDir,
            `.delete-all-${process.pid}-${Date.now()}`,
          );
          const moved: Array<{ source: string; backup: string }> = [];
          try {
            fs.mkdirSync(transactionDir, { recursive: true });
            for (const entry of fs.readdirSync(userDir, {
              withFileTypes: true,
            })) {
              if (entry.name.startsWith('.')) continue;
              const source = path.join(userDir, entry.name);
              const backup = path.join(transactionDir, entry.name);
              fs.renameSync(source, backup);
              moved.push({ source, backup });
            }
            writeSkillsManifest(authUser.id, { skills: {} });
            fs.rmSync(transactionDir, { recursive: true, force: true });
            return { success: true as const, deleted: moved.length };
          } catch {
            for (const { source, backup } of moved.reverse()) {
              if (fs.existsSync(backup) && !fs.existsSync(source)) {
                fs.renameSync(backup, source);
              }
            }
            writeSkillsManifest(authUser.id, previousManifest);
            fs.rmSync(transactionDir, { recursive: true, force: true });
            return { success: false as const };
          }
        },
      );
      if (!result.value.success) {
        return c.json({ error: 'Failed to delete user skills' }, 500);
      }
      return c.json({
        success: true,
        deleted: result.value.deleted,
        invalidated_runtime_jids: result.invalidatedRuntimeJids,
      });
    } catch (error) {
      const failure = skillRuntimeMutationFailure(error, 'Bulk Skill deletion');
      if (failure) return c.json(failure, 503);
      throw error;
    }
  });
});

skillsRoutes.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const result = await deleteSkillForUser(authUser.id, id);

  if (!result.success) {
    const status = result.retryable
      ? 503
      : result.error === 'Invalid skill ID' ||
          result.error === 'Invalid skill path'
        ? 400
        : result.error?.includes('not found')
          ? 404
          : result.error?.startsWith('以下智能体正在使用该 Skill：')
            ? 409
            : 500;
    return c.json({ error: result.error }, status);
  }

  return c.json({
    success: true,
    invalidated_runtime_jids: result.invalidatedRuntimeJids ?? 0,
  });
});

/**
 * Install a skill package for a specific user.
 * Uses a temporary HOME directory to isolate `npx skills add --global` from
 * the real ~/.claude/skills, eliminating race conditions across concurrent installs.
 * Reusable by both the HTTP route and IPC handler.
 */
async function installSkillForUserUnlocked(
  userId: string,
  pkg: string,
): Promise<{ success: boolean; installed?: string[]; error?: string }> {
  const isNpmName = /^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg);
  const isUrl = /^https?:\/\//.test(pkg);
  if (!isNpmName && !isUrl) {
    return { success: false, error: 'Invalid package name format' };
  }
  // SSRF 防护：URL 形式的 skill package 必须是 HTTPS + 非内网 hostname。
  // 仅以 npm `<scope>/<name>` 形式不需要这层校验（npm 注册中心走 npx 自带管线）。
  if (isUrl) {
    const reason = validateSafeHttpsUrl(pkg);
    if (reason) {
      return { success: false, error: `Refused skill URL: ${reason}` };
    }
  }

  // Create an isolated temp directory to act as HOME so `--global` installs
  // into tempHome/.claude/skills/ instead of the real ~/.claude/skills/.
  // This avoids any race condition when multiple installs run concurrently.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));
  const tempSkillsDir = path.join(tempHome, '.claude', 'skills');
  fs.mkdirSync(tempSkillsDir, { recursive: true });

  try {
    await runCommandWithDirectoryQuota({
      command: 'npx',
      args: [
        '-y',
        'skills',
        'add',
        pkg,
        '--global',
        '--yes',
        '-a',
        'claude-code',
      ],
      watchDir: tempHome,
      maxBytes: MAX_SKILL_INSTALL_BYTES,
      timeoutMs: 60_000,
      label: 'Skill package installation',
      env: { ...process.env, HOME: tempHome },
    });

    // Discover all skill directories installed into the temp location
    const installedEntries: string[] = [];
    if (fs.existsSync(tempSkillsDir)) {
      for (const entry of fs.readdirSync(tempSkillsDir, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          installedEntries.push(entry.name);
        }
      }
    }

    if (installedEntries.length === 0) {
      return {
        success: false,
        error: 'No skills were installed — package may be invalid',
      };
    }

    // Install all directories and their manifest metadata as one transaction.
    const userDir = getUserSkillsDir(userId);
    installSkillDirectoriesTransactionally(
      installedEntries.map((id) => ({
        id,
        dir: fs.realpathSync(path.join(tempSkillsDir, id)),
      })),
      userDir,
      true,
      (installedIds) => updateSkillsManifest(userId, pkg, installedIds),
    );

    return { success: true, installed: installedEntries };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    // Always clean up the temp directory
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

async function installSkillForUser(
  userId: string,
  pkg: string,
  options?: {
    requestId?: string;
    sourceGroup?: string;
    groupFolder?: string;
    isAgentCaller?: boolean;
  },
): Promise<SkillInstallResult> {
  return serviceInstallSkillForUser(userId, pkg, options);
}

/**
 * Sync host-level skills (~/.claude/skills/) to a user's directory.
 * Standalone function usable from both the API route and the auto-sync timer.
 */
skillsRoutes.post('/install', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  if (typeof body.package !== 'string') {
    return c.json({ error: 'package field must be string' }, 400);
  }

  const pkg = body.package.trim();
  const result = await installSkillForUser(authUser.id, pkg);

  if (!result.success) {
    return c.json(
      { error: 'Failed to install skill', details: result.error },
      result.retryable
        ? 503
        : result.error === 'Invalid package name format'
          ? 400
          : 500,
    );
  }

  return c.json({
    success: true,
    installed: result.installed,
    invalidated_runtime_jids: result.invalidatedRuntimeJids ?? 0,
  });
});

// GET /api/skills/requests/:requestId - 查询能力变更执行状态
skillsRoutes.get('/requests/:requestId', authMiddleware, (c) => {
  const requestId = c.req.param('requestId');
  const authUser = c.get('user') as AuthUser;
  const request = getCapabilityMutationRequest(requestId);
  if (!request) {
    return c.json({ error: 'Mutation request not found' }, 404);
  }
  if (request.userId !== authUser.id && authUser.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return c.json({ success: true, request });
});

// Reinstall a skill by its ID — requires the skill to have a packageName in the manifest.
skillsRoutes.post('/:id/reinstall', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;

  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  return withUserSkillMutationLock(authUser.id, async () => {
    const impact = {
      kind: 'skills' as const,
      ownerUserId: authUser.id,
      // A package reinstall can add/remove sibling Skills across versions, so
      // conservatively invalidate every Agent that consumes managed Skills.
      ids: undefined,
    };
    try {
      await repairCapabilityRuntimeSafetyBlock(
        impact,
        `Skill ${id} reinstall cleanup`,
      );
    } catch (error) {
      const failure = skillRuntimeMutationFailure(error, 'Skill reinstall');
      if (failure) return c.json(failure, 503);
      throw error;
    }

    const manifest = readSkillsManifest(authUser.id);
    const meta = manifest.skills[id];
    if (!meta?.packageName) {
      return c.json(
        { error: 'Skill has no package info — cannot reinstall' },
        400,
      );
    }
    const packageName = meta.packageName;

    // A package can install MULTIPLE sibling skills, and installSkillForUser
    // rewrites EVERY skill dir the package ships (it rm's each destination before
    // copying). Backing up only `id` would let a failed reinstall permanently
    // destroy the live siblings it deleted. So back up every skill that shares
    // this packageName (including `id`) and restore them all on failure.
    const userDir = getUserSkillsDir(authUser.id);
    const siblingIds = Object.keys(manifest.skills).filter(
      (sid) => manifest.skills[sid]?.packageName === packageName,
    );
    if (!siblingIds.includes(id)) siblingIds.push(id);

    for (const sid of siblingIds) {
      if (!validateSkillPath(userDir, path.join(userDir, sid))) {
        return c.json({ error: 'Invalid skill path' }, 400);
      }
    }

    type SkillBackup = {
      sid: string;
      dir: string;
      // null when the sibling had a manifest entry but no on-disk dir (desync):
      // there is nothing to rename back, only the manifest entry to restore.
      backupDir: string | null;
      meta: SkillsManifest['skills'][string];
    };
    const backups: SkillBackup[] = [];
    // Restore every backed-up sibling (dir + manifest entry). Best-effort: a
    // failure here leaves the *.reinstall-bak dir on disk for manual recovery.
    const restoreBackups = (): boolean => {
      let restored = true;
      for (const b of backups) {
        try {
          if (b.backupDir) {
            fs.rmSync(b.dir, { recursive: true, force: true }); // clear partial install
            fs.renameSync(b.backupDir, b.dir);
          }
          const m = readSkillsManifest(authUser.id);
          m.skills[b.sid] = b.meta;
          writeSkillsManifest(authUser.id, m);
        } catch {
          restored = false;
        }
      }
      return restored;
    };

    try {
      const runtimeResult = await mutateCapabilityAroundRuntimeQuiesce(
        impact,
        `Skill package ${packageName} reinstalled`,
        async () => {
          // Back up each sibling dir (rename, don't delete) so a failed
          // reinstall can roll back instead of destroying live Skills.
          try {
            for (const sid of siblingIds) {
              const entry = manifest.skills[sid];
              const dir = path.join(userDir, sid);
              const backupDir = `${dir}.reinstall-bak`;
              let savedBackupDir: string | null = null;
              if (fs.existsSync(dir)) {
                fs.rmSync(backupDir, { recursive: true, force: true });
                fs.renameSync(dir, backupDir);
                savedBackupDir = backupDir;
              }
              if (entry) {
                backups.push({
                  sid,
                  dir,
                  backupDir: savedBackupDir,
                  meta: entry,
                });
              }
              removeFromSkillsManifest(authUser.id, sid);
            }
          } catch (error) {
            if (!restoreBackups()) {
              throw new Error('Failed to roll back Skill reinstall backup');
            }
            return {
              success: false as const,
              error: 'Failed to back up old skill',
              details: error instanceof Error ? error.message : 'Unknown error',
            };
          }

          const installResult = await installSkillForUserUnlocked(
            authUser.id,
            packageName,
          );
          if (!installResult.success) {
            if (!restoreBackups()) {
              throw new Error(
                'Failed to roll back unsuccessful Skill reinstall',
              );
            }
            return {
              success: false as const,
              error: 'Failed to reinstall skill',
              details: installResult.error,
            };
          }

          // Success — drop backups. A leftover hidden backup is harmless and
          // remains available for manual recovery if removal fails.
          for (const b of backups) {
            if (!b.backupDir) continue;
            try {
              fs.rmSync(b.backupDir, { recursive: true, force: true });
            } catch {
              /* retain recoverable backup */
            }
          }
          return {
            success: true as const,
            installed: installResult.installed,
          };
        },
      );

      if (!runtimeResult.value.success) {
        return c.json(
          {
            error: runtimeResult.value.error,
            details: runtimeResult.value.details,
          },
          500,
        );
      }
      return c.json({
        success: true,
        installed: runtimeResult.value.installed,
        invalidated_runtime_jids: runtimeResult.invalidatedRuntimeJids,
      });
    } catch (error) {
      const failure = skillRuntimeMutationFailure(error, 'Skill reinstall');
      if (failure) return c.json(failure, 503);
      throw error;
    }
  });
});

export {
  getUserSkillsDir,
  installSkillForUser,
  deleteSkillForUser,
  installSkillForUserUnlocked,
  deleteSkillForUserUnlocked,
  withUserSkillRuntimeMutation,
  withUserSkillMutationLock,
  skillRuntimeMutationFailure,
  getCapabilityMutationRequest,
  listPendingCapabilityMutations,
  applyPendingCapabilityMutations,
};
export default skillsRoutes;
