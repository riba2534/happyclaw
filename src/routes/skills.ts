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

const execFileAsync = promisify(execFile);
let skillInstallLock: Promise<void> = Promise.resolve();

const skillsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project';
  enabled: boolean;
  syncedFromHost?: boolean;
  packageName?: string;
  installedAt?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

interface SkillDetail extends Skill {
  content: string;
}

interface HostSyncManifest {
  syncedSkills: string[];
  lastSyncAt: string;
}

interface SkillsManifest {
  skills: Record<string, {
    packageName: string;
    installedAt: string;
    source: string;
  }>;
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

function getGlobalSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

function getProjectSkillsDir(): string {
  return path.resolve(process.cwd(), 'container', 'skills');
}

function getHostSyncManifestPath(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId, '.host-sync.json');
}

function readHostSyncManifest(userId: string): HostSyncManifest {
  try {
    const data = fs.readFileSync(getHostSyncManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { syncedSkills: [], lastSyncAt: '' };
  }
}

function writeHostSyncManifest(userId: string, manifest: HostSyncManifest): void {
  const manifestPath = getHostSyncManifestPath(userId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
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
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Update the skills manifest after installing skills.
 * Records packageName, installedAt, and source for each installed skill.
 */
function updateSkillsManifest(userId: string, packageName: string, installedSkillIds: string[]): void {
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

function validateSkillId(id: string): boolean {
  return /^[\w\-]+$/.test(id);
}

function validateSkillPath(skillsRoot: string, skillDir: string): boolean {
  try {
    const realSkillsRoot = fs.realpathSync(skillsRoot);
    const realSkillDir = fs.realpathSync(skillDir);
    const relative = path.relative(realSkillsRoot, realSkillDir);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex === -1) return {};

  const frontmatterLines = lines.slice(1, endIndex + 1);
  const result: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let multilineMode: 'folded' | 'literal' | null = null;

  for (const line of frontmatterLines) {
    const keyMatch = line.match(/^([\w\-]+):\s*(.*)$/);
    if (keyMatch) {
      // Save previous key if exists
      if (currentKey) {
        result[currentKey] = currentValue.join(
          multilineMode === 'literal' ? '\n' : ' ',
        );
      }

      currentKey = keyMatch[1];
      const value = keyMatch[2].trim();

      if (value === '>') {
        multilineMode = 'folded';
        currentValue = [];
      } else if (value === '|') {
        multilineMode = 'literal';
        currentValue = [];
      } else {
        result[currentKey] = value;
        currentKey = null;
        currentValue = [];
        multilineMode = null;
      }
    } else if (currentKey && multilineMode) {
      const trimmedLine = line.trimStart();
      if (trimmedLine) {
        currentValue.push(trimmedLine);
      }
    }
  }

  // Save last key
  if (currentKey) {
    result[currentKey] = currentValue.join(
      multilineMode === 'literal' ? '\n' : ' ',
    );
  }

  return result;
}

function listFiles(
  dir: string,
): Array<{ name: string; type: 'file' | 'directory'; size: number }> {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => {
        const fullPath = path.join(dir, entry.name);
        const stats = fs.statSync(fullPath);
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isDirectory() ? 0 : stats.size,
        };
      });
  } catch {
    return [];
  }
}

function scanDirectory(
  rootDir: string,
  source: 'user' | 'project',
): Skill[] {
  const skills: Skill[] = [];
  if (!fs.existsSync(rootDir)) return skills;

  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(rootDir, entry.name);
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

        skills.push({
          id: entry.name,
          name: frontmatter.name || entry.name,
          description: frontmatter.description || '',
          source,
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
        });
      } catch {
        // Skip malformed skills
      }
    }
  } catch {
    // Skip if directory is not readable
  }

  return skills;
}

function discoverSkills(userId: string): Skill[] {
  const userSkills = scanDirectory(getUserSkillsDir(userId), 'user');
  const projectSkills = scanDirectory(getProjectSkillsDir(), 'project');

  // 读取 host sync manifest 标记同步来源
  const hostManifest = readHostSyncManifest(userId);
  const syncedSet = new Set(hostManifest.syncedSkills);

  // 读取 skills manifest 补充安装元数据
  const skillsManifest = readSkillsManifest(userId);

  for (const skill of userSkills) {
    if (syncedSet.has(skill.id)) {
      skill.syncedFromHost = true;
    }
    const meta = skillsManifest.skills[skill.id];
    if (meta) {
      skill.packageName = meta.packageName;
      skill.installedAt = meta.installedAt;
    }
  }

  return [...userSkills, ...projectSkills];
}

function getSkillDetail(skillId: string, userId: string): SkillDetail | null {
  if (!validateSkillId(skillId)) return null;

  const searchDirs: Array<{ rootDir: string; source: 'user' | 'project' }> = [
    { rootDir: getUserSkillsDir(userId), source: 'user' },
    { rootDir: getProjectSkillsDir(), source: 'project' },
  ];

  const hostManifest = readHostSyncManifest(userId);
  const syncedSet = new Set(hostManifest.syncedSkills);
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

      const detail: SkillDetail = {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || '',
        source,
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
        if (syncedSet.has(skillId)) {
          detail.syncedFromHost = true;
        }
        const meta = skillsManifest.skills[skillId];
        if (meta) {
          detail.packageName = meta.packageName;
          detail.installedAt = meta.installedAt;
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

  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);

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

/**
 * Find skill entries under a path that were modified after the given timestamp.
 * Handles both real directories and symlinks (skills CLI creates symlinks in
 * ~/.claude/skills/ pointing to ~/.agents/skills/).
 * Returns entry names.
 */
function findModifiedEntries(dir: string, afterMs: number): string[] {
  const result: string[] = [];
  if (!fs.existsSync(dir)) return result;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        // Use lstat for symlinks, stat (follows symlink) for mtime of real target
        const lstat = fs.lstatSync(fullPath);

        if (lstat.isSymbolicLink()) {
          // Symlink: check both the symlink creation time and target mtime
          if (lstat.mtimeMs >= afterMs) {
            result.push(entry.name);
            continue;
          }
          // Also check the resolved target's mtime
          const realStat = fs.statSync(fullPath);
          if (realStat.mtimeMs >= afterMs) {
            result.push(entry.name);
          }
        } else if (lstat.isDirectory()) {
          if (lstat.mtimeMs >= afterMs) {
            result.push(entry.name);
          }
        }
      } catch {
        // skip broken symlinks etc.
      }
    }
  } catch {
    // ignore
  }
  return result;
}

/**
 * Copy a skill entry (directory or symlink target) to dest.
 * Resolves symlinks and copies the real content so the copy is self-contained.
 */
function copySkillToUser(src: string, dest: string): void {
  // Resolve symlink to get the real directory
  let realSrc = src;
  try {
    const lstat = fs.lstatSync(src);
    if (lstat.isSymbolicLink()) {
      realSrc = fs.realpathSync(src);
    }
  } catch {
    // use src as-is
  }

  fs.cpSync(realSrc, dest, { recursive: true });
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

    const data = await resp.json() as {
      skills?: Array<{
        id: string;
        skillId: string;
        name: string;
        installs: number;
        source: string;
      }>;
    };

    const results: SearchResult[] = (data.skills || []).map((s) => ({
      package: s.source === s.skillId || !s.skillId
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

async function withSkillInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = skillInstallLock.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  skillInstallLock = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// --- Routes ---

skillsRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const skills = discoverSkills(authUser.id);
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
        const segments = parsed.pathname.replace(/^\/s\//, '').split('/').filter(Boolean);
        if (segments.length >= 3) {
          const srcFromUrl = `${segments[0]}/${segments[1]}`;
          const skillIdFromUrl = segments[2];
          const result = await fetchSkillMdFromGitHub(srcFromUrl, skillIdFromUrl);
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

skillsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const skill = getSkillDetail(id, authUser.id);

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  return c.json({ skill });
});

// Toggle enable/disable for user-level skills via SKILL.md ↔ SKILL.md.disabled rename.
// Project-level skills are read-only.
skillsRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const { enabled } = await c.req.json<{ enabled: boolean }>();

  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);

  const userDir = getUserSkillsDir(authUser.id);
  const skillDir = path.join(userDir, id);

  if (!fs.existsSync(skillDir)) {
    return c.json({ error: 'Skill not found or is not a user-level skill' }, 404);
  }
  if (!validateSkillPath(userDir, skillDir)) {
    return c.json({ error: 'Invalid skill path' }, 400);
  }

  const srcPath = path.join(skillDir, enabled ? 'SKILL.md.disabled' : 'SKILL.md');
  const dstPath = path.join(skillDir, enabled ? 'SKILL.md' : 'SKILL.md.disabled');

  if (!fs.existsSync(srcPath)) {
    return c.json({ error: 'Skill not found or already in desired state' }, 404);
  }

  fs.renameSync(srcPath, dstPath);
  return c.json({ success: true });
});

/**
 * Delete a user-level skill by ID.
 * Reusable by both the HTTP route and IPC handler.
 */
function deleteSkillForUser(
  userId: string,
  skillId: string,
): { success: boolean; error?: string } {
  if (!validateSkillId(skillId)) {
    return { success: false, error: 'Invalid skill ID' };
  }

  const userDir = getUserSkillsDir(userId);
  const skillDir = path.join(userDir, skillId);

  if (!fs.existsSync(skillDir)) {
    return { success: false, error: 'Skill not found or is a project-level skill' };
  }

  if (!validateSkillPath(userDir, skillDir)) {
    return { success: false, error: 'Invalid skill path' };
  }

  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removeFromSkillsManifest(userId, skillId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

skillsRoutes.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const result = deleteSkillForUser(authUser.id, id);

  if (!result.success) {
    const status = result.error === 'Invalid skill ID' || result.error === 'Invalid skill path' ? 400
      : result.error?.includes('not found') ? 404 : 500;
    return c.json({ error: result.error }, status);
  }

  return c.json({ success: true });
});

/**
 * Install a skill package for a specific user.
 * Uses a temporary HOME directory to isolate `npx skills add --global` from
 * the real ~/.claude/skills, eliminating race conditions across concurrent installs.
 * Reusable by both the HTTP route and IPC handler.
 */
async function installSkillForUser(
  userId: string,
  pkg: string,
): Promise<{ success: boolean; installed?: string[]; error?: string }> {
  if (!/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg)) {
    return { success: false, error: 'Invalid package name format' };
  }

  // Create an isolated temp directory to act as HOME so `--global` installs
  // into tempHome/.claude/skills/ instead of the real ~/.claude/skills/.
  // This avoids any race condition when multiple installs run concurrently.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));
  const tempSkillsDir = path.join(tempHome, '.claude', 'skills');
  fs.mkdirSync(tempSkillsDir, { recursive: true });

  try {
    await execFileAsync(
      'npx',
      ['-y', 'skills', 'add', pkg, '--global', '--yes', '-a', 'claude-code'],
      {
        timeout: 60_000,
        env: { ...process.env, HOME: tempHome },
      },
    );

    // Discover all skill directories installed into the temp location
    const installedEntries: string[] = [];
    if (fs.existsSync(tempSkillsDir)) {
      for (const entry of fs.readdirSync(tempSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          installedEntries.push(entry.name);
        }
      }
    }

    if (installedEntries.length === 0) {
      return { success: false, error: 'No skills were installed — package may be invalid' };
    }

    // Copy resolved skill content to per-user directory
    const userDir = getUserSkillsDir(userId);
    fs.mkdirSync(userDir, { recursive: true });

    for (const name of installedEntries) {
      const src = path.join(tempSkillsDir, name);
      const dest = path.join(userDir, name);
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      copySkillToUser(src, dest);
    }

    // Write manifest metadata
    updateSkillsManifest(userId, pkg, installedEntries);

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
    } catch { /* ignore cleanup errors */ }
  }
}

// Sync host-level skills (~/.claude/skills/) to admin's user-level directory.
// Only admin can use this endpoint.
skillsRoutes.post('/sync-host', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can sync host skills' }, 403);
  }

  return withSkillInstallLock(async () => {
    const hostDir = getGlobalSkillsDir();
    const userDir = getUserSkillsDir(authUser.id);
    fs.mkdirSync(userDir, { recursive: true });

    // 1. 扫描宿主机 skills
    const hostSkillNames: string[] = [];
    if (fs.existsSync(hostDir)) {
      for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillDir = path.join(hostDir, entry.name);
        // 验证包含 SKILL.md 或 SKILL.md.disabled
        try {
          const realPath = fs.realpathSync(skillDir);
          if (
            fs.existsSync(path.join(realPath, 'SKILL.md')) ||
            fs.existsSync(path.join(realPath, 'SKILL.md.disabled'))
          ) {
            hostSkillNames.push(entry.name);
          }
        } catch {
          // 跳过 broken symlinks
        }
      }
    }

    // 2. 读取 manifest
    const manifest = readHostSyncManifest(authUser.id);
    const previouslySynced = new Set(manifest.syncedSkills);

    // 3. 检测用户目录中手动安装的 skills
    const existingUserSkills = new Set<string>();
    if (fs.existsSync(userDir)) {
      for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
        if (entry.isDirectory()) existingUserSkills.add(entry.name);
      }
    }

    const stats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
    const newSyncedList: string[] = [];

    // 4. 同步：新增/更新
    for (const name of hostSkillNames) {
      const isManuallyInstalled = existingUserSkills.has(name) && !previouslySynced.has(name);
      if (isManuallyInstalled) {
        // 手动安装的 skill，跳过不覆盖
        stats.skipped++;
        continue;
      }

      const src = path.join(hostDir, name);
      const dest = path.join(userDir, name);

      if (existingUserSkills.has(name)) {
        // 已存在且之前是同步来的 → 更新
        fs.rmSync(dest, { recursive: true, force: true });
        copySkillToUser(src, dest);
        stats.updated++;
      } else {
        // 全新的 → 新增
        copySkillToUser(src, dest);
        stats.added++;
      }
      newSyncedList.push(name);
    }

    // 5. 删除宿主机已移除的（仅清理之前同步来的）
    const hostSkillSet = new Set(hostSkillNames);
    for (const name of previouslySynced) {
      if (!hostSkillSet.has(name) && existingUserSkills.has(name)) {
        const dest = path.join(userDir, name);
        fs.rmSync(dest, { recursive: true, force: true });
        stats.deleted++;
      }
    }

    // 6. 更新 manifest
    writeHostSyncManifest(authUser.id, {
      syncedSkills: newSyncedList,
      lastSyncAt: new Date().toISOString(),
    });

    const total = hostSkillNames.length;
    return c.json({ stats, total });
  });
});

skillsRoutes.post(
  '/install',
  authMiddleware,
  async (c) => {
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
        result.error === 'Invalid package name format' ? 400 : 500,
      );
    }

    return c.json({ success: true, installed: result.installed });
  },
);

// Reinstall a skill by its ID — requires the skill to have a packageName in the manifest.
skillsRoutes.post('/:id/reinstall', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;

  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  const manifest = readSkillsManifest(authUser.id);
  const meta = manifest.skills[id];
  if (!meta?.packageName) {
    return c.json({ error: 'Skill has no package info — cannot reinstall' }, 400);
  }

  // Delete then reinstall
  const deleteResult = deleteSkillForUser(authUser.id, id);
  if (!deleteResult.success) {
    return c.json({ error: 'Failed to delete old skill', details: deleteResult.error }, 500);
  }

  const installResult = await installSkillForUser(authUser.id, meta.packageName);
  if (!installResult.success) {
    return c.json(
      { error: 'Failed to reinstall skill', details: installResult.error },
      500,
    );
  }

  return c.json({ success: true, installed: installResult.installed });
});

export { getUserSkillsDir, installSkillForUser, deleteSkillForUser };
export default skillsRoutes;
