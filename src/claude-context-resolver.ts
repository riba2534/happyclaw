import fs from 'fs';
import path from 'path';

import {
  CLAUDE_CREDENTIAL_SETTING_KEYS,
  HAPPYCLAW_OWNED_CLAUDE_ENV_KEYS,
} from './claude-provider-env.js';
import type { ClaudeContextAudit } from './stream-event.types.js';
import type { RegisteredGroup } from './types.js';
import { getRecordedWorkdir } from './workspace-dir.js';
import {
  reconcileSessionSkills,
  resolveEffectiveSkills,
  type EffectiveSkillManifest,
  type EffectiveSkillLayer,
  type ManagedSkillPolicy,
} from './effective-skill-resolver.js';

/**
 * Native Claude Code capability directories that belong to the user config
 * layer. Skills stay out of this list because HappyClaw governs them with an
 * independent, per-Agent policy.
 */
export const HOST_CLAUDE_NATIVE_DIRECTORIES = [
  'agents',
  'commands',
  'hooks',
  'workflows',
  'output-styles',
  'plugins',
] as const;

export const HOST_CLAUDE_NATIVE_FILES = ['keybindings.json'] as const;
export const HOST_CLAUDE_SETTINGS_FILES = [
  'settings.json',
  'settings.local.json',
] as const;

export interface ClaudeNativeConfigEntry {
  name: string;
  kind: 'file' | 'directory';
  sourcePath: string;
  runtimePath: string;
}

export interface ClaudeContextPlanArgs {
  executionMode: 'host' | 'container';
  group: RegisteredGroup;
  ownerHomeFolder?: string;
  externalClaudeDir: string;
  projectRoot: string;
  dataDir: string;
  groupSessionsDir?: string;
  /**
   * Explicit Agent policy opt-in for the administrator's native ~/.claude
   * context. Managed HappyClaw skills are resolved independently below.
   */
  includeHostClaudeContext?: boolean;
  /** Host ~/.claude/skills policy, independent of CLAUDE.md/rules. */
  hostSkillPolicy?: ManagedSkillPolicy;
  mountUserSkills?: boolean;
  userSkillsDirOverride?: string;
  managedSkillPolicy?: ManagedSkillPolicy;
  /**
   * Project Skill directories, lowest precedence first (see
   * resolveWorkspaceSkillRoots). Defaults to the workspace's own directory.
   */
  workspaceSkillRoots?: string[];
  pluginSkillLayers?: EffectiveSkillLayer[];
}

export interface ClaudeContextPlan {
  executionMode: 'host' | 'container';
  isAdminOwned: boolean;
  externalClaudeDir: string;
  claudeMdSource?: string;
  rulesSourceDir?: string;
  nativeConfigEntries: ClaudeNativeConfigEntry[];
  settingsSourceFiles: string[];
  externalSkillsDir?: string;
  builtinSkillsDir: string;
  projectSkillsDir: string;
  userSkillsDir?: string;
  /** Project Skill directories, lowest precedence first. */
  workspaceSkillRoots: string[];
  effectiveSkills: EffectiveSkillManifest;
  audit: ClaudeContextAudit;
}

export interface HostClaudeContextSyncResult {
  claudeMdStatus: ClaudeContextAudit['claudeMd']['status'];
  warnings: string[];
}

export interface SyncHostClaudeContextOptions {
  /**
   * Host mode materializes symlinks. Container mode only clears stale session
   * links because Docker supplies read-only nested mounts at the same paths.
   */
  materializeLinks?: boolean;
}

function exists(p: string | undefined): p is string {
  return !!p && fs.existsSync(p);
}

// 检测链接/文件本身是否已存在（不跟随 symlink），用于多来源合并时的同名冲突检测。
function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function countRuleFiles(dir: string | undefined): number {
  if (!exists(dir)) return 0;
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() || entry.isDirectory() || entry.isSymbolicLink(),
      ).length;
  } catch {
    return 0;
  }
}

function countConfigEntries(configPath: string): number | undefined {
  if (!exists(configPath)) return undefined;
  try {
    return fs.statSync(configPath).isDirectory()
      ? fs.readdirSync(configPath).length
      : undefined;
  } catch {
    return undefined;
  }
}

function fileTokenEstimate(filePath: string | undefined): number | undefined {
  if (!exists(filePath)) return undefined;
  try {
    const bytes = fs.statSync(filePath).size;
    return Math.ceil(bytes / 4);
  } catch {
    return undefined;
  }
}

function removePath(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeSettings(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key];
    merged[key] =
      isPlainRecord(previous) && isPlainRecord(value)
        ? mergeSettings(previous, value)
        : value;
  }
  return merged;
}

/**
 * Load the native user settings layer in Claude Code precedence order. The
 * caller applies HappyClaw's required env and effective MCP policy
 * afterward, so enabling native context cannot bypass those explicit controls.
 *
 * The layer is written into the session's settings.json, which a container
 * mounts read-write for the agent, and it outranks the process environment.
 * So everything HappyClaw owns leaves it: provider routing and credentials,
 * the session's effort, compaction and context
 * (HAPPYCLAW_OWNED_CLAUDE_ENV_KEYS), and the settings that run a command for
 * credentials. Everything else (hooks, permissions, other env) stays.
 */
export function loadHostClaudeSettings(
  plan: ClaudeContextPlan,
): Record<string, unknown> {
  if (!plan.isAdminOwned) return {};
  let merged: Record<string, unknown> = {};
  for (const settingsFile of plan.settingsSourceFiles) {
    if (!exists(settingsFile)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (isPlainRecord(parsed)) merged = mergeSettings(merged, parsed);
    } catch {
      // Invalid native settings are surfaced by Claude Code when used
      // directly. HappyClaw skips the invalid layer to keep startup usable.
    }
  }
  for (const key of CLAUDE_CREDENTIAL_SETTING_KEYS) delete merged[key];
  if (isPlainRecord(merged.env)) {
    const env = { ...merged.env };
    for (const key of HAPPYCLAW_OWNED_CLAUDE_ENV_KEYS) delete env[key];
    merged.env = env;
  }
  return merged;
}

function linkEntries(
  sourceDir: string | undefined,
  targetDir: string,
  include: (entry: fs.Dirent) => boolean,
  onConflict?: (name: string) => void,
): void {
  if (!exists(sourceDir)) return;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!include(entry)) continue;
    const linkPath = path.join(targetDir, entry.name);
    // 多来源合并进同一目录时，后序来源同名会覆盖前序；记录冲突供 audit 告警。
    if (onConflict && lexists(linkPath)) onConflict(entry.name);
    removePath(linkPath);
    try {
      fs.symlinkSync(path.join(sourceDir, entry.name), linkPath);
    } catch {
      /* best effort */
    }
  }
}

export function buildClaudeContextPlan(
  args: ClaudeContextPlanArgs,
): ClaudeContextPlan {
  const ownerId = args.group.created_by;
  // `host_claude` is authorized when the Agent policy is written: only an
  // admin can persist it, and workspaces can only bind an Agent owned by the
  // same user. Do not infer the role from folder === "main" here: additional
  // admins have owner-specific home folders and must receive the same policy.
  const includeHostClaudeContext = args.includeHostClaudeContext === true;
  const hostSkillPolicy =
    args.hostSkillPolicy ??
    (includeHostClaudeContext
      ? { mode: 'inherit' as const, ids: [] }
      : { mode: 'disabled' as const, ids: [] });
  const includeHostSkills = hostSkillPolicy.mode !== 'disabled';
  const isAdminOwned = includeHostClaudeContext;
  const claudeMdSource = includeHostClaudeContext
    ? path.join(args.externalClaudeDir, 'CLAUDE.md')
    : undefined;
  const rulesSourceDir = includeHostClaudeContext
    ? path.join(args.externalClaudeDir, 'rules')
    : undefined;
  const externalSkillsDir = includeHostSkills
    ? path.join(args.externalClaudeDir, 'skills')
    : undefined;
  const sessionConfigDir = args.groupSessionsDir;
  const nativeConfigEntries = includeHostClaudeContext
    ? [
        ...HOST_CLAUDE_NATIVE_DIRECTORIES.map((name) => ({
          name,
          kind: 'directory' as const,
          sourcePath: path.join(args.externalClaudeDir, name),
          runtimePath:
            args.executionMode === 'container'
              ? `/home/node/.claude/${name}`
              : path.join(sessionConfigDir ?? '', name),
        })),
        ...HOST_CLAUDE_NATIVE_FILES.map((name) => ({
          name,
          kind: 'file' as const,
          sourcePath: path.join(args.externalClaudeDir, name),
          runtimePath:
            args.executionMode === 'container'
              ? `/home/node/.claude/${name}`
              : path.join(sessionConfigDir ?? '', name),
        })),
      ]
    : [];
  const settingsSourceFiles = includeHostClaudeContext
    ? HOST_CLAUDE_SETTINGS_FILES.map((name) =>
        path.join(args.externalClaudeDir, name),
      )
    : [];
  const builtinSkillsDir = path.join(args.dataDir, 'builtin-skills');
  const projectSkillsDir = path.join(args.projectRoot, 'container', 'skills');
  const userSkillsDir =
    args.mountUserSkills !== false && ownerId
      ? (args.userSkillsDirOverride ??
        path.join(args.dataDir, 'skills', ownerId))
      : undefined;
  const workspaceSkillRoots = args.workspaceSkillRoots ?? [
    path.join(
      getRecordedWorkdir(args.group.folder) ??
        path.join(args.dataDir, 'groups', args.group.folder),
      '.claude',
      'skills',
    ),
  ];
  const hostClaudeRuntime = args.groupSessionsDir
    ? path.join(args.groupSessionsDir, 'CLAUDE.md')
    : undefined;
  const hostRulesRuntime = args.groupSessionsDir
    ? path.join(args.groupSessionsDir, 'rules')
    : undefined;
  const hostSkillsRuntime = args.groupSessionsDir
    ? path.join(args.groupSessionsDir, 'skills')
    : undefined;
  const effectiveSkills = resolveEffectiveSkills({
    layers: [
      { source: 'builtin', root: builtinSkillsDir },
      ...(externalSkillsDir
        ? [{ source: 'host' as const, root: externalSkillsDir }]
        : []),
      { source: 'project', root: projectSkillsDir },
      ...(userSkillsDir
        ? [{ source: 'managed' as const, root: userSkillsDir }]
        : []),
      ...workspaceSkillRoots.map((root) => ({
        source: 'workspace' as const,
        root,
      })),
      ...(args.pluginSkillLayers ?? []),
    ],
    managedPolicy: args.managedSkillPolicy,
    hostPolicy: hostSkillPolicy,
  });
  const skillAuditNames = {
    builtin: 'builtin',
    host: 'external',
    project: 'project',
    managed: 'managed',
    workspace: 'workspace',
    plugin: 'plugin',
  } as const;
  const skillSourceRoots = new Map<keyof typeof skillAuditNames, Set<string>>();
  for (const candidate of effectiveSkills.candidates) {
    const roots = skillSourceRoots.get(candidate.source) ?? new Set<string>();
    roots.add(path.dirname(candidate.path));
    skillSourceRoots.set(candidate.source, roots);
  }
  const configuredSkillRoots: Partial<
    Record<keyof typeof skillAuditNames, string[]>
  > = {
    builtin: [builtinSkillsDir],
    ...(externalSkillsDir ? { host: [externalSkillsDir] } : {}),
    project: [projectSkillsDir],
    ...(userSkillsDir ? { managed: [userSkillsDir] } : {}),
    workspace: workspaceSkillRoots,
    ...(args.pluginSkillLayers?.length
      ? {
          plugin: args.pluginSkillLayers.flatMap((layer) =>
            layer.root ? [layer.root] : [],
          ),
        }
      : {}),
  };
  const skillAuditSources = (
    Object.keys(configuredSkillRoots) as Array<keyof typeof skillAuditNames>
  ).map((source) => {
    const roots = [
      ...(skillSourceRoots.get(source) ?? []),
      ...(configuredSkillRoots[source] ?? []),
    ].filter((root, index, all) => all.indexOf(root) === index);
    return {
      name: skillAuditNames[source],
      ...(roots.length === 1 ? { sourcePath: roots[0] } : {}),
      runtimePath:
        args.executionMode === 'container'
          ? source === 'plugin'
            ? 'options.plugins'
            : '/workspace/effective-skills'
          : hostSkillsRuntime,
      count: effectiveSkills.selected.filter((skill) => skill.source === source)
        .length,
    };
  });

  const warnings: string[] = [];
  if (includeHostClaudeContext && !exists(claudeMdSource))
    warnings.push('CLAUDE.md missing');
  if (includeHostClaudeContext && !exists(rulesSourceDir))
    warnings.push('rules missing');
  if (includeHostSkills && !exists(externalSkillsDir))
    warnings.push('external skills missing');

  const audit: ClaudeContextAudit = {
    executionMode: args.executionMode,
    projectRoot: args.projectRoot,
    externalClaudeDir:
      includeHostClaudeContext || includeHostSkills
        ? args.externalClaudeDir
        : undefined,
    claudeMd: {
      sourcePath: claudeMdSource,
      runtimePath:
        args.executionMode === 'container'
          ? '/home/node/.claude/CLAUDE.md'
          : hostClaudeRuntime,
      status: exists(claudeMdSource)
        ? args.executionMode === 'container'
          ? 'mounted'
          : 'linked'
        : includeHostClaudeContext
          ? 'missing'
          : 'unavailable',
      tokens: fileTokenEstimate(claudeMdSource),
    },
    rules: {
      sourcePath: rulesSourceDir,
      runtimePath:
        args.executionMode === 'container'
          ? '/home/node/.claude/rules'
          : hostRulesRuntime,
      status: exists(rulesSourceDir)
        ? args.executionMode === 'container'
          ? 'mounted'
          : 'linked'
        : includeHostClaudeContext
          ? 'missing'
          : 'unavailable',
      fileCount: countRuleFiles(rulesSourceDir),
    },
    nativeConfig: {
      enabled: includeHostClaudeContext,
      settingSources: ['user', 'project', 'local'],
      entries: [
        ...HOST_CLAUDE_SETTINGS_FILES.map((name) => {
          const sourcePath = path.join(args.externalClaudeDir, name);
          return {
            name,
            kind: 'settings' as const,
            ...(includeHostClaudeContext ? { sourcePath } : {}),
            runtimePath:
              args.executionMode === 'container'
                ? '/home/node/.claude/settings.json'
                : sessionConfigDir
                  ? path.join(sessionConfigDir, 'settings.json')
                  : undefined,
            status: !includeHostClaudeContext
              ? ('unavailable' as const)
              : exists(sourcePath)
                ? ('merged' as const)
                : ('missing' as const),
          };
        }),
        ...nativeConfigEntries.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          sourcePath: entry.sourcePath,
          runtimePath: entry.runtimePath,
          status: exists(entry.sourcePath)
            ? args.executionMode === 'container'
              ? ('mounted' as const)
              : ('linked' as const)
            : ('missing' as const),
          entryCount: countConfigEntries(entry.sourcePath),
        })),
      ],
    },
    skills: {
      totalSkills: effectiveSkills.candidates.length,
      includedSkills: effectiveSkills.selected.length,
      manifestHash: effectiveSkills.hash,
      selectedSkillIds: effectiveSkills.selected.map((skill) => skill.id),
      sources: skillAuditSources,
    },
    happyclawPrompt: { totalBytes: 0, files: [] },
    warnings,
  };

  return {
    executionMode: args.executionMode,
    isAdminOwned,
    externalClaudeDir: args.externalClaudeDir,
    claudeMdSource,
    rulesSourceDir,
    nativeConfigEntries,
    settingsSourceFiles,
    externalSkillsDir,
    builtinSkillsDir,
    projectSkillsDir,
    userSkillsDir,
    workspaceSkillRoots,
    effectiveSkills,
    audit,
  };
}

export function syncHostClaudeContext(
  plan: ClaudeContextPlan,
  groupSessionsDir: string,
  options: SyncHostClaudeContextOptions = {},
): HostClaudeContextSyncResult {
  const materializeLinks = options.materializeLinks !== false;
  const warnings = [...plan.audit.warnings];
  const skillSync = reconcileSessionSkills(
    groupSessionsDir,
    plan.effectiveSkills,
    { materializeLinks },
  );
  for (const name of plan.effectiveSkills.conflicts) {
    warnings.push(`skill name conflict: ${name}（后序来源覆盖前序）`);
  }
  if (skillSync.quarantined.length > 0) {
    warnings.push(
      `quarantined unmanaged session skills: ${skillSync.quarantined.join(', ')}`,
    );
  }

  const rulesDir = path.join(groupSessionsDir, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.isFile() || entry.isDirectory()) {
      removePath(path.join(rulesDir, entry.name));
    }
  }
  linkEntries(
    materializeLinks ? plan.rulesSourceDir : undefined,
    rulesDir,
    (entry) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink(),
  );

  // These paths are HappyClaw-owned projections of the selected native user
  // config. Always remove a previous Agent's projection first so disabling or
  // changing the policy cannot leak stale capabilities into the next run.
  for (const name of [
    ...HOST_CLAUDE_NATIVE_DIRECTORIES,
    ...HOST_CLAUDE_NATIVE_FILES,
  ]) {
    removePath(path.join(groupSessionsDir, name));
  }
  if (materializeLinks) {
    for (const entry of plan.nativeConfigEntries) {
      if (!exists(entry.sourcePath)) continue;
      try {
        fs.symlinkSync(
          entry.sourcePath,
          path.join(groupSessionsDir, entry.name),
        );
      } catch {
        warnings.push(`failed to link native Claude config: ${entry.name}`);
      }
    }
  }

  let claudeMdStatus = plan.audit.claudeMd.status;
  const sessionClaudeMd = path.join(groupSessionsDir, 'CLAUDE.md');
  if (
    !materializeLinks ||
    !plan.claudeMdSource ||
    !fs.existsSync(plan.claudeMdSource)
  ) {
    // A previous host_claude Agent may have linked the native playbook into
    // this shared workspace session. Remove only resolver-owned symlinks when
    // the next Agent does not opt in; preserve real session-authored files.
    try {
      if (fs.lstatSync(sessionClaudeMd).isSymbolicLink()) {
        fs.unlinkSync(sessionClaudeMd);
      }
    } catch {
      /* absent is already the desired state */
    }
    return { claudeMdStatus, warnings };
  }

  try {
    const st = fs.lstatSync(sessionClaudeMd);
    if (st.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(sessionClaudeMd);
      if (currentTarget !== plan.claudeMdSource) {
        fs.unlinkSync(sessionClaudeMd);
        fs.symlinkSync(plan.claudeMdSource, sessionClaudeMd);
      }
      claudeMdStatus = 'linked';
    } else {
      claudeMdStatus = 'shadowed';
      warnings.push('CLAUDE.md shadowed by session file');
    }
  } catch {
    try {
      fs.symlinkSync(plan.claudeMdSource, sessionClaudeMd);
      claudeMdStatus = 'linked';
    } catch {
      warnings.push('failed to link CLAUDE.md');
    }
  }

  return { claudeMdStatus, warnings };
}
