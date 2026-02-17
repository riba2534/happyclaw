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

const skillsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project';
  enabled: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

interface SkillDetail extends Skill {
  content: string;
}

interface SearchResult {
  package: string;
  url: string;
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
  const userDir = getUserSkillsDir(userId);
  const projectDir = getProjectSkillsDir();

  const userSkills = scanDirectory(userDir, 'user');
  const projectSkills = scanDirectory(projectDir, 'project');

  return [...userSkills, ...projectSkills];
}

function getSkillDetail(skillId: string, userId: string): SkillDetail | null {
  if (!validateSkillId(skillId)) return null;

  const userDir = getUserSkillsDir(userId);
  const projectDir = getProjectSkillsDir();

  for (const { rootDir, source } of [
    { rootDir: userDir, source: 'user' as const },
    { rootDir: projectDir, source: 'project' as const },
  ]) {
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

      return {
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
      // Next line might be the URL
      let url = '';
      if (i + 1 < lines.length && lines[i + 1].startsWith('http')) {
        url = lines[i + 1];
        i++;
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

  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['-y', 'skills', 'find', query],
      { timeout: 30_000 },
    );
    const results = parseSearchOutput(stdout);
    return c.json({ results });
  } catch (error) {
    // npx skills find may exit non-zero when no results found
    if (error && typeof error === 'object' && 'stdout' in error) {
      const results = parseSearchOutput((error as any).stdout || '');
      if (results.length > 0) {
        return c.json({ results });
      }
    }
    return c.json({ results: [] });
  }
});

skillsRoutes.get('/search/detail', authMiddleware, async (c) => {
  const url = c.req.query('url')?.trim();
  if (!url || !url.startsWith('https://skills.sh/')) {
    return c.json({ error: 'Invalid skills.sh URL' }, 400);
  }

  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'text/html' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return c.json({ detail: null });
    }
    const html = await resp.text();

    // Extract description from meta tag
    const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*?)"/i)
      || html.match(/<meta\s+content="([^"]*?)"\s+name="description"/i);
    const description = descMatch?.[1]?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"') || '';

    // Extract text content between skill-related sections
    // Strip HTML tags for a simple text extraction
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch?.[1] || html;

    // Extract visible text, collapsing whitespace
    const textContent = bodyHtml
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Extract weekly installs
    const installsLine = textContent.find((l) => /weekly installs?/i.test(l));
    const installs = installsLine?.match(/([\d,.]+[kKmM]?)\s*weekly/i)?.[1] || '';

    // Extract "first seen" / age
    const ageLine = textContent.find((l) => /first seen|ago/i.test(l));
    const age = ageLine || '';

    // Extract bullet points (lines starting with common patterns that look like features)
    const features: string[] = [];
    for (const line of textContent) {
      // Lines that look like feature descriptions (contain a dash or start with a quote)
      if (/^[""\u201c]/.test(line) || (/^[-\u2022\u2013]/.test(line) && line.length > 10)) {
        features.push(line.replace(/^[-\u2022\u2013""\u201c\u201d]\s*/, '').replace(/[""\u201d]$/, ''));
      }
    }

    return c.json({
      detail: {
        description: description || features.slice(0, 3).join('; ') || '',
        installs,
        age,
        features: features.slice(0, 6),
      },
    });
  } catch {
    return c.json({ detail: null });
  }
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

// Skills are read-only: host-level and project-level skills
// cannot be modified through the Web UI.
skillsRoutes.patch('/:id', authMiddleware, (c) => {
  return c.json({ error: 'Skills are read-only and cannot be toggled from the Web UI' }, 403);
});

skillsRoutes.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;

  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  const userDir = getUserSkillsDir(authUser.id);
  const skillDir = path.join(userDir, id);

  if (!fs.existsSync(skillDir)) {
    return c.json({ error: 'Skill not found or is a project-level skill' }, 404);
  }

  if (!validateSkillPath(userDir, skillDir)) {
    return c.json({ error: 'Invalid skill path' }, 400);
  }

  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    return c.json({ success: true });
  } catch (error) {
    return c.json(
      { error: 'Failed to delete skill', details: error instanceof Error ? error.message : 'Unknown error' },
      500,
    );
  }
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
    if (!/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg)) {
      return c.json({ error: 'Invalid package name format' }, 400);
    }

    const globalDir = getGlobalSkillsDir();
    fs.mkdirSync(globalDir, { recursive: true });

    // Record timestamp before install to detect new/modified dirs
    const beforeTime = Date.now();

    try {
      await execFileAsync(
        'npx',
        ['-y', 'skills', 'add', pkg, '--global', '--yes', '-a', 'claude-code'],
        { timeout: 60_000 },
      );

      // Find entries modified during install (handles symlinks and real dirs)
      const modifiedEntries = findModifiedEntries(globalDir, beforeTime);

      // Copy resolved skill content to per-user directory
      const userDir = getUserSkillsDir(authUser.id);
      fs.mkdirSync(userDir, { recursive: true });

      for (const name of modifiedEntries) {
        const src = path.join(globalDir, name);
        const dest = path.join(userDir, name);
        // Remove existing if present (reinstall)
        if (fs.existsSync(dest)) {
          fs.rmSync(dest, { recursive: true, force: true });
        }
        copySkillToUser(src, dest);
      }

      return c.json({ success: true, installed: modifiedEntries });
    } catch (error) {
      // Even on error, clean up any modified entries from global
      try {
        const modifiedEntries = findModifiedEntries(globalDir, beforeTime);
        for (const name of modifiedEntries) {
          fs.rmSync(path.join(globalDir, name), { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup errors
      }

      return c.json(
        {
          error: 'Failed to install skill',
          details: error instanceof Error ? error.message : 'Unknown error',
        },
        500,
      );
    }
  },
);

export { getUserSkillsDir };
export default skillsRoutes;
