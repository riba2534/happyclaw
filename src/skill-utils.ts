/**
 * Shared skill utility functions.
 * Used by both src/routes/skills.ts (user-level) and src/routes/workspace-config.ts (workspace-level).
 */
import fs from 'fs';
import path from 'path';

// --- Types ---

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

// --- Functions ---

export function validateSkillId(id: string): boolean {
  return /^[\w\-]+$/.test(id);
}

export function validateSkillPath(
  skillsRoot: string,
  skillDir: string,
): boolean {
  try {
    const realSkillsRoot = fs.realpathSync(skillsRoot);
    const realSkillDir = fs.realpathSync(skillDir);
    const relative = path.relative(realSkillsRoot, realSkillDir);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export function parseFrontmatter(content: string): Record<string, string> {
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

export function listFiles(
  dir: string,
): Array<{ name: string; type: 'file' | 'directory'; size: number }> {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result: Array<{
      name: string;
      type: 'file' | 'directory';
      size: number;
    }> = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);

      // 对 symlink 走 statSync 以穿透到目标类型；普通目录/文件直接用 Dirent，避免双 stat。
      if (entry.isSymbolicLink()) {
        try {
          const stats = fs.statSync(fullPath);
          const isDirectory = stats.isDirectory();
          result.push({
            name: entry.name,
            type: isDirectory ? 'directory' : 'file',
            size: isDirectory ? 0 : stats.size,
          });
        } catch {
          // dangling / unreadable
        }
        continue;
      }

      if (entry.isDirectory()) {
        result.push({ name: entry.name, type: 'directory', size: 0 });
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          // treat as size 0 on permission error
        }
        result.push({ name: entry.name, type: 'file', size });
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function scanSkillDirectory(
  rootDir: string,
  source: string,
): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (!fs.existsSync(rootDir)) return skills;

  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const skillDir = path.join(rootDir, entry.name);
      // Symlink must resolve to a directory
      if (entry.isSymbolicLink()) {
        try {
          if (!fs.statSync(skillDir).isDirectory()) continue;
        } catch {
          continue; // dangling symlink
        }
      }
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
