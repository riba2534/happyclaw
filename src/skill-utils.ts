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
  // Use path.resolve (not fs.realpathSync) so symlinked skills whose targets
  // live outside skillsRoot still pass validation.  Path traversal is already
  // prevented by validateSkillId ([\w\-]+ only).
  const normalizedRoot = path.resolve(skillsRoot);
  const normalizedDir = path.resolve(skillDir);
  const relative = path.relative(normalizedRoot, normalizedDir);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

const FRONTMATTER_KEY = /^([\w\-]+):\s*(.*)$/;
// `|` / `>` with optional chomping (+/-) and indentation (1-9) indicators in
// either order, optionally followed by a comment.
const BLOCK_SCALAR_HEADER =
  /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?\s*(?:#.*)?$/;

const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: '\u00a0',
  L: '\u2028',
  P: '\u2029',
};

/**
 * Unquote a single-line YAML flow scalar. Returns null when the value is not
 * a complete quoted scalar (e.g. `"a" b` or an unterminated quote), so the
 * caller can keep the raw text like any other plain value.
 */
function unquoteScalar(value: string): string | null {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return null;

  let result = '';
  let index = 1;
  let closed = false;
  while (index < value.length) {
    const char = value[index];
    if (quote === "'") {
      if (char === "'") {
        if (value[index + 1] === "'") {
          result += "'";
          index += 2;
          continue;
        }
        closed = true;
        index += 1;
        break;
      }
      result += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      closed = true;
      index += 1;
      break;
    }
    if (char === '\\') {
      const next = value[index + 1];
      const hexLength =
        next === 'x' ? 2 : next === 'u' ? 4 : next === 'U' ? 8 : 0;
      if (hexLength > 0) {
        const hex = value.slice(index + 2, index + 2 + hexLength);
        if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === hexLength) {
          result += String.fromCodePoint(parseInt(hex, 16));
          index += 2 + hexLength;
          continue;
        }
      } else if (next !== undefined && next in DOUBLE_QUOTED_ESCAPES) {
        result += DOUBLE_QUOTED_ESCAPES[next];
        index += 2;
        continue;
      }
      // Unknown escape: keep it verbatim rather than failing the whole value.
      result += char;
      index += 1;
      continue;
    }
    result += char;
    index += 1;
  }

  if (!closed) return null;
  const rest = value.slice(index);
  if (rest && !/^\s+#/.test(rest) && rest.trim() !== '') return null;
  return result;
}

/**
 * Fold or keep the lines of a YAML block scalar. `lines` already have the
 * block indentation removed; blank lines are empty strings.
 */
function joinBlockScalar(lines: string[], style: '|' | '>'): string {
  if (style === '|') return lines.join('\n');

  let output = '';
  let previous: 'none' | 'text' | 'indented' = 'none';
  let blankLines = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankLines += 1;
      continue;
    }
    // More-indented lines keep their line breaks instead of being folded.
    const indented = /^[ \t]/.test(line);
    if (previous === 'none') {
      output += '\n'.repeat(blankLines);
    } else if (previous === 'text' && !indented) {
      output += blankLines > 0 ? '\n'.repeat(blankLines) : ' ';
    } else {
      output += '\n'.repeat(blankLines + 1);
    }
    output += line;
    previous = indented ? 'indented' : 'text';
    blankLines = 0;
  }
  return output;
}

/**
 * Parse the leading `---` frontmatter block of a SKILL.md into flat string
 * values. This is intentionally a lenient subset of YAML: top-level
 * `key: value` pairs, quoted scalars and `|` / `>` block scalars. Plain values
 * are kept verbatim (including text after `#`), since skill descriptions in
 * the wild often contain `: ` and `#` that strict YAML would reject.
 *
 * Block scalars accept chomping indicators, but leading blank lines and
 * trailing line breaks are always dropped: these values are shown as single
 * metadata strings, which matches the default (clip) and strip (`-`) display.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex === -1) return {};

  const frontmatterLines = lines.slice(1, endIndex + 1);
  const result: Record<string, string> = {};

  let index = 0;
  while (index < frontmatterLines.length) {
    const keyMatch = frontmatterLines[index].match(FRONTMATTER_KEY);
    index += 1;
    if (!keyMatch) continue;

    const key = keyMatch[1];
    const value = keyMatch[2].trim();
    const header = value.match(BLOCK_SCALAR_HEADER);
    if (!header) {
      result[key] = unquoteScalar(value) ?? value;
      continue;
    }

    // The block runs until the next top-level key.
    const blockLines: string[] = [];
    while (
      index < frontmatterLines.length &&
      !FRONTMATTER_KEY.test(frontmatterLines[index])
    ) {
      blockLines.push(frontmatterLines[index]);
      index += 1;
    }

    const explicitIndent = Number(header[3] ?? header[4] ?? 0);
    const firstContentLine = blockLines.find((line) => line.trim() !== '');
    const indent =
      explicitIndent ||
      (firstContentLine
        ? firstContentLine.length - firstContentLine.trimStart().length
        : 0);
    const dedented = blockLines.map((line) => {
      if (line.trim() === '') return '';
      const leading = line.length - line.trimStart().length;
      return leading >= indent ? line.slice(indent) : line.trimStart();
    });

    result[key] = joinBlockScalar(dedented, header[1] as '|' | '>')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
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
