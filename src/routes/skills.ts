// Skills management routes

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';

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

// --- Utility Functions ---

function getUserSkillsDir(): string {
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

function discoverSkills(): Skill[] {
  const skills: Skill[] = [];
  const userDir = getUserSkillsDir();
  const projectDir = getProjectSkillsDir();

  const scanDirectory = (
    rootDir: string,
    source: 'user' | 'project',
  ): void => {
    if (!fs.existsSync(rootDir)) return;

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
  };

  scanDirectory(userDir, 'user');
  scanDirectory(projectDir, 'project');

  return skills;
}

function getSkillDetail(skillId: string): SkillDetail | null {
  if (!validateSkillId(skillId)) return null;

  const userDir = getUserSkillsDir();
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

// --- Routes ---

skillsRoutes.get('/', authMiddleware, (c) => {
  const skills = discoverSkills();
  return c.json({ skills });
});

skillsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const skill = getSkillDetail(id);

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  return c.json({ skill });
});

// Skills are read-only: host-level (~/.claude/skills/) and project-level skills
// cannot be modified through the Web UI.
skillsRoutes.patch('/:id', authMiddleware, systemConfigMiddleware, (c) => {
  return c.json({ error: 'Skills are read-only and cannot be toggled from the Web UI' }, 403);
});

skillsRoutes.delete('/:id', authMiddleware, systemConfigMiddleware, (c) => {
  return c.json({ error: 'Skills are read-only and cannot be deleted from the Web UI' }, 403);
});

skillsRoutes.post(
  '/install',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));

    if (typeof body.package !== 'string') {
      return c.json({ error: 'package field must be string' }, 400);
    }

    const pkg = body.package.trim();
    if (!/^[\w\-]+\/[\w\-]+([@#][\w\-.\/]+)?$/.test(pkg)) {
      return c.json({ error: 'Invalid package name format' }, 400);
    }

    try {
      await execFileAsync(
        'npx',
        ['-y', 'skills', 'add', pkg, '--global', '--yes'],
        { timeout: 60_000 },
      );
      return c.json({ success: true });
    } catch (error) {
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

export default skillsRoutes;
