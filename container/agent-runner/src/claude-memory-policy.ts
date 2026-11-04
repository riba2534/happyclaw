import path from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function contextSource(runtimePolicy: unknown): string | undefined {
  if (!isRecord(runtimePolicy) || !isRecord(runtimePolicy.context)) {
    return undefined;
  }
  return typeof runtimePolicy.context.source === 'string'
    ? runtimePolicy.context.source
    : undefined;
}

function isAbsolutePortable(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function pathApiFor(value: string): typeof path.posix | typeof path.win32 {
  return path.win32.isAbsolute(value) ? path.win32 : path.posix;
}

/** Claude Code treats these values as picomatch patterns on every platform. */
function toClaudePattern(value: string): string {
  return value.replace(/\\/g, '/');
}

function joinClaudePattern(root: string, ...segments: string[]): string {
  return toClaudePattern(pathApiFor(root).join(root, ...segments));
}

function normalizedRoot(value: string | undefined): string | undefined {
  if (!value || !isAbsolutePortable(value)) return undefined;
  return pathApiFor(value).normalize(value);
}

/**
 * Claude Code resolves user memory from the operating-system home directory,
 * even when CLAUDE_CONFIG_DIR points at HappyClaw's per-session directory.
 * Managed mode excludes those host instructions explicitly while keeping the
 * session's selected user-source Skills available.
 */
function hostUserMemoryExcludes(
  homeDir: string | undefined,
  externalClaudeDir: string | undefined,
): string[] {
  const roots = new Set<string>();
  for (const candidate of [
    homeDir ? path.join(homeDir, '.claude') : undefined,
    externalClaudeDir,
  ]) {
    const root = normalizedRoot(candidate);
    if (root) roots.add(root);
  }
  return [...roots].flatMap((root) => [
    joinClaudePattern(root, 'CLAUDE.md'),
    joinClaudePattern(root, 'rules', '**'),
  ]);
}

/**
 * Host agents run inside data/groups/<folder>, nested beneath the HappyClaw
 * install. Claude Code walks every parent directory, so it discovers the
 * install's own CLAUDE.md as Project memory. That file describes developing
 * HappyClaw and must not turn a business Agent into a codebase assistant,
 * whatever its context source. Only the platform root is excluded;
 * workspace-local CLAUDE.md files inside the group remain available.
 */
function platformProjectMemoryExcludes(
  projectRoot: string | undefined,
): string[] {
  const root = normalizedRoot(projectRoot);
  if (!root) return [];
  return [
    joinClaudePattern(root, 'CLAUDE.md'),
    joinClaudePattern(root, '.claude', 'CLAUDE.md'),
    joinClaudePattern(root, 'CLAUDE.local.md'),
    joinClaudePattern(root, '.claude', 'rules', '**'),
  ];
}

/**
 * `claudeMdExcludes` for a run. Host runs always exclude the platform
 * repository's memory, and exclude the person's own host memory only in
 * managed mode: `host_claude` deliberately inherits it. Container runs never
 * see either, so they get no exclusions.
 */
export function resolveHostClaudeMdExcludes(options: {
  executionMode: 'host' | 'container';
  runtimePolicy?: unknown;
  externalClaudeDir?: string;
  homeDir?: string;
  projectRoot?: string;
}): string[] {
  if (options.executionMode !== 'host') return [];
  const userMemory =
    contextSource(options.runtimePolicy) === 'host_claude'
      ? []
      : hostUserMemoryExcludes(options.homeDir, options.externalClaudeDir);
  // The Set matters when the external Claude dir is the project's .claude.
  return [
    ...new Set([
      ...userMemory,
      ...platformProjectMemoryExcludes(options.projectRoot),
    ]),
  ];
}

/** Return SDK-reported memory files that should have matched an exclusion. */
export function findClaudeMdExcludeLeaks(
  memoryFiles: Array<{ path: string }>,
  excludes: string[],
): string[] {
  return memoryFiles
    .map((file) => toClaudePattern(file.path))
    .filter((filePath) =>
      excludes.some((exclude) => {
        const normalized = toClaudePattern(exclude);
        if (!normalized.endsWith('/**')) {
          return filePath === normalized;
        }
        const root = normalized.slice(0, -'/**'.length);
        return filePath === root || filePath.startsWith(`${root}/`);
      }),
    );
}
