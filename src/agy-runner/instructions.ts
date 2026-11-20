import fs from 'node:fs';
import path from 'node:path';

const MAX_INSTRUCTION_FILE_BYTES = 64 * 1024;

function readMarkdownBounded(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length <= MAX_INSTRUCTION_FILE_BYTES) return trimmed;
    return `${trimmed.slice(0, MAX_INSTRUCTION_FILE_BYTES)}\n\n[...truncated]`;
  } catch {
    return null;
  }
}

function canonicalPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Collect HappyClaw's base instructions for a fresh `agy` session:
 *   1. Agent profile identityPrompt (if any)
 *   2. Session/global CLAUDE.md under CLAUDE_CONFIG_DIR (if any)
 *   3. Workspace CLAUDE.md and .claude/CLAUDE.md under cwd (if any)
 *
 * Files are deduplicated by realpath so symlinked layers are never injected twice.
 */
export function buildFreshSessionInstructions(options: {
  cwd: string;
  claudeConfigDir?: string;
  identityPrompt?: string;
}): string | undefined {
  const sections: string[] = [];
  const seenFiles = new Set<string>();

  if (options.identityPrompt?.trim()) {
    sections.push(options.identityPrompt.trim());
  }

  const candidates: Array<{ label: string; filePath: string }> = [];
  if (options.claudeConfigDir?.trim()) {
    candidates.push({
      label: 'Global/Session CLAUDE.md',
      filePath: path.join(options.claudeConfigDir.trim(), 'CLAUDE.md'),
    });
  }
  candidates.push(
    {
      label: 'Workspace CLAUDE.md',
      filePath: path.join(options.cwd, 'CLAUDE.md'),
    },
    {
      label: 'Workspace .claude/CLAUDE.md',
      filePath: path.join(options.cwd, '.claude', 'CLAUDE.md'),
    },
  );

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.filePath)) continue;
    const real = canonicalPath(candidate.filePath);
    if (seenFiles.has(real)) continue;
    seenFiles.add(real);

    const content = readMarkdownBounded(candidate.filePath);
    if (content) {
      sections.push(`<!-- ${candidate.label} -->\n${content}`);
    }
  }

  if (sections.length === 0) return undefined;
  return sections.join('\n\n---\n\n');
}
