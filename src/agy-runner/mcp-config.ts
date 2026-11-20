import fs from 'node:fs';
import path from 'node:path';

export interface McpConfigObject {
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Ensure `<workspaceDir>/.agents/mcp_config.json` registers the `happyclaw`
 * stdio MCP server while preserving any other user-configured MCP servers.
 *
 * The server entry intentionally omits per-runner IPC paths so concurrent
 * agents sharing a workspace inherit their own `HAPPYCLAW_WORKSPACE_IPC` and
 * `HAPPYCLAW_WORKSPACE_GROUP` from `agy`'s process environment.
 */
export function ensureAgyWorkspaceMcpConfig(options: {
  workspaceDir: string;
  nodeBinary: string;
  mcpServerEntrypoint: string;
}): string {
  const agentsDir = path.join(options.workspaceDir, '.agents');
  const configPath = path.join(agentsDir, 'mcp_config.json');
  fs.mkdirSync(agentsDir, { recursive: true });

  let existing: McpConfigObject = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as McpConfigObject;
      }
    } catch {
      existing = {};
    }
  }

  const nextServers: Record<string, Record<string, unknown>> = {
    ...(existing.mcpServers && typeof existing.mcpServers === 'object'
      ? existing.mcpServers
      : {}),
    happyclaw: {
      command: options.nodeBinary,
      args: [options.mcpServerEntrypoint],
    },
  };

  const nextConfig: McpConfigObject = {
    ...existing,
    mcpServers: nextServers,
  };

  const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
  let currentRaw = '';
  try {
    currentRaw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    // file does not exist yet
  }
  if (currentRaw !== serialized) {
    const tmpPath = `${configPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, serialized);
    fs.renameSync(tmpPath, configPath);
  }
  return configPath;
}

const MANAGED_SKILLS_MANIFEST = '.happyclaw-managed.json';

interface ManagedSkillRecord {
  source: string;
  skillMdMtimeMs: number;
}

/**
 * Mirror HappyClaw's effective skills from `<claudeConfigDir>/skills/` into
 * `<workspaceDir>/.agents/skills/` as real directories so `agy` natively
 * discovers and exposes them in its `<skills>` list (`agy` ignores symlinked
 * skill directories during workspace scanning).
 *
 * - Preserves any unmanaged user-created skill directories under `.agents/skills/`.
 * - Caches source path & SKILL.md mtime in `.happyclaw-managed.json` so
 *   unchanged skills are skipped in <1ms on subsequent launches.
 * - Prunes previously managed skills when they are disabled/uninstalled in HappyClaw.
 */
export function syncAgyWorkspaceSkills(options: {
  workspaceDir: string;
  claudeConfigDir?: string;
}): { synced: number; pruned: number } {
  const claudeConfigDir = options.claudeConfigDir?.trim();
  if (!claudeConfigDir) return { synced: 0, pruned: 0 };

  const sourceSkillsDir = path.join(claudeConfigDir, 'skills');
  if (!fs.existsSync(sourceSkillsDir)) return { synced: 0, pruned: 0 };

  const targetSkillsDir = path.join(options.workspaceDir, '.agents', 'skills');
  fs.mkdirSync(targetSkillsDir, { recursive: true });

  const manifestPath = path.join(targetSkillsDir, MANAGED_SKILLS_MANIFEST);
  let previousManaged: Record<string, ManagedSkillRecord> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (Array.isArray(parsed)) {
      // Migrate legacy v1 array manifest (symlink names)
      for (const name of parsed) {
        if (typeof name === 'string') {
          previousManaged[name] = { source: '', skillMdMtimeMs: 0 };
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      previousManaged = parsed as Record<string, ManagedSkillRecord>;
    }
  } catch {
    // fresh manifest
  }

  const nextManaged: Record<string, ManagedSkillRecord> = {};
  let synced = 0;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(sourceSkillsDir, { withFileTypes: true });
  } catch {
    return { synced: 0, pruned: 0 };
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const sourceEntry = path.join(sourceSkillsDir, entry.name);
    let realSource: string;
    let skillMdMtimeMs = 0;
    try {
      realSource = fs.realpathSync(sourceEntry);
      if (!fs.statSync(realSource).isDirectory()) continue;
      const skillMdPath = path.join(realSource, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      skillMdMtimeMs = fs.statSync(skillMdPath).mtimeMs;
    } catch {
      continue;
    }

    const targetEntry = path.join(targetSkillsDir, entry.name);
    let existingStat: fs.Stats | null = null;
    try {
      existingStat = fs.lstatSync(targetEntry);
    } catch {
      existingStat = null;
    }

    const wasManaged = Object.prototype.hasOwnProperty.call(
      previousManaged,
      entry.name,
    );

    // Never clobber an unmanaged real directory the user manually placed here
    if (existingStat && !existingStat.isSymbolicLink() && !wasManaged) {
      continue;
    }

    // Fast path: already materialized as a real dir with matching source & mtime
    const prev = previousManaged[entry.name];
    if (
      existingStat &&
      existingStat.isDirectory() &&
      !existingStat.isSymbolicLink() &&
      prev &&
      prev.source === realSource &&
      prev.skillMdMtimeMs === skillMdMtimeMs
    ) {
      nextManaged[entry.name] = prev;
      synced += 1;
      continue;
    }

    // Replace stale symlink or outdated managed directory with a real copy
    try {
      if (existingStat) {
        fs.rmSync(targetEntry, { recursive: true, force: true });
      }
      fs.cpSync(realSource, targetEntry, {
        recursive: true,
        dereference: true,
      });
      nextManaged[entry.name] = { source: realSource, skillMdMtimeMs };
      synced += 1;
    } catch {
      // skip if unable to copy
    }
  }

  // Prune previously managed skills that are no longer in the effective set
  let pruned = 0;
  for (const oldName of Object.keys(previousManaged)) {
    if (Object.prototype.hasOwnProperty.call(nextManaged, oldName)) continue;
    const stalePath = path.join(targetSkillsDir, oldName);
    try {
      if (fs.existsSync(stalePath) || fs.lstatSync(stalePath).isSymbolicLink()) {
        fs.rmSync(stalePath, { recursive: true, force: true });
        pruned += 1;
      }
    } catch {
      // already gone
    }
  }

  try {
    const tmpPath = `${manifestPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(nextManaged, null, 2)}\n`);
    fs.renameSync(tmpPath, manifestPath);
  } catch {
    // best effort
  }

  return { synced, pruned };
}
